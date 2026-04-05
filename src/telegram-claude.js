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
