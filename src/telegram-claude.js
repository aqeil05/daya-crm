// ─── Telegram bot intent parser ───────────────────────────────────────────────
// Parses natural language bot commands into structured intents using Claude Haiku.
// Kept separate from claude.js to avoid mixing email-classification concerns
// with bot-specific prompts.

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const MODEL = "claude-haiku-4-5-20251001";

// ── parseBotIntent ────────────────────────────────────────────────────────────
// userText:   raw message from Telegram user
// stageNames: array of stage label strings from HubSpot (e.g. ["Inquiry received", "Preparing Pitch", ...])
// today:      ISO date string (YYYY-MM-DD) used to resolve relative date ranges
//
// Returns:
//   { action: "move_deal",     company, stage }
//   { action: "show_deals"                    }
//   { action: "search_company", company       }
//   { action: "close_won",      company       }
//   { action: "close_lost",     company       }
//   { action: "report",         from, to      }  — ISO date strings
//   { action: "unknown"                        }

// ── resolveReportStages ───────────────────────────────────────────────────────
// Maps pipeline stages to won/lost/presented semantics.
// First tries fast substring matching; falls back to Haiku if labels are unusual.

export async function resolveReportStages(env, stages) {
  const tryFind = (...keywords) =>
    keywords.reduce((found, kw) => found || stages.find((s) => s.label.toLowerCase().includes(kw)), null);

  const wonStage       = tryFind("closed won", "won");
  const lostStage      = tryFind("closed lost", "lost");
  const presentedStage = tryFind("presented", "pitch", "proposal");

  if (wonStage && lostStage) {
    return { wonStage, lostStage, presentedStage };
  }

  // Haiku fallback: ask the model to identify stages from actual labels
  const labels = stages.map((s) => `${s.id}: ${s.label}`).join("\n");

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 120,
      system: `You are mapping CRM pipeline stages. Given a list of stage IDs and labels, return JSON identifying which stage represents each outcome.
Return ONLY: {"won":"<id>","lost":"<id>","presented":"<id or null>"}
Use null if no stage clearly matches. No markdown, no explanation.`,
      messages: [{ role: "user", content: labels }],
    }),
  });

  if (res.ok) {
    const data = await res.json();
    let raw = data.content?.[0]?.text?.trim() || "";
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      const mapping = JSON.parse(raw);
      return {
        wonStage:       stages.find((s) => s.id === mapping.won)       || wonStage,
        lostStage:      stages.find((s) => s.id === mapping.lost)      || lostStage,
        presentedStage: stages.find((s) => s.id === mapping.presented) || presentedStage,
      };
    } catch {
      console.error("resolveReportStages: failed to parse Haiku response:", raw);
    }
  }

  return { wonStage, lostStage, presentedStage };
}

// ── formatReportWithClaude ────────────────────────────────────────────────────
// Passes raw report metrics to Haiku to produce a nicely formatted Telegram
// HTML message. Falls back to a plain-text summary if the API call fails.

export async function formatReportWithClaude(env, reportData) {
  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      system: `You are a CRM assistant formatting a sales pipeline report for Telegram.

Rules:
- Use Telegram HTML only: <b>, <i>, <a>. No other tags. No markdown.
- Be concise and scannable. Use emojis meaningfully.
- Structure: period header → pipeline snapshot (open deals by stage) → closed period stats → conversion if available → avg close time if available.
- For win rate and conversion, show percentage with emoji indicator (✅ if >= 50%, ⚠️ if < 50%).
- If a metric is null, omit that line rather than showing "—".
- Return ONLY the formatted HTML string. No explanation, no code fences.`,
      messages: [{ role: "user", content: JSON.stringify(reportData) }],
    }),
  });

  if (!res.ok) {
    console.error(`formatReportWithClaude: API error ${res.status}`);
    return null;
  }

  const data = await res.json();
  return data.content?.[0]?.text?.trim() || null;
}

export async function parseBotIntent(env, userText, stageNames, today) {
  const stageList = stageNames.join(", ");

  const systemPrompt = `You are a CRM bot intent parser. Parse the user's message into a JSON intent.

Today's date: ${today}

Valid actions and their required fields:
- move_deal:     { "action": "move_deal",     "company": "<name>", "stage": "<stage label>" }
- show_deals:    { "action": "show_deals" }
- search_company:{ "action": "search_company","company": "<name>" }
- close_won:     { "action": "close_won",     "company": "<name>" }
- close_lost:    { "action": "close_lost",    "company": "<name>" }
- report:        { "action": "report",        "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
- unknown:       { "action": "unknown" }

Valid stage labels (use exact label for "stage" field, fuzzy-match from user input):
${stageList}

Rules:
- "show deals", "show all", "list deals" → show_deals
- "show [company]", "search [company]", "find [company]" → search_company
- "move [company] to [stage]" → move_deal (normalize stage to exact label)
- "close [company]", "won [company]", "[company] won" → close_won
- "lose [company]", "lost [company]", "[company] lost" → close_lost
- "report", "report last 30 days", "report March", "report March 2026" → report
  For report: compute from/to based on today. If no period stated, use last 30 days.
  "report March" or "report last month" → first and last day of that month.
  "report last N days" → today minus N days to today.
- If message is a plain number (e.g. "1", "2") → unknown (handled separately by dispatcher)

Return ONLY the JSON object. No markdown fences, no explanation.`;

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 120,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude intent parse failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  let raw = data.content?.[0]?.text?.trim() || "";

  // Strip markdown fences if present
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    console.error(`parseBotIntent: failed to parse JSON: ${raw}`);
    return { action: "unknown" };
  }
}
