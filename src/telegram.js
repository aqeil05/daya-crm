// ─── Telegram bot handler ─────────────────────────────────────────────────────
// Receives Telegram webhook updates, parses intent with Claude, executes
// HubSpot operations, and replies inline in chat.
//
// Routes (registered in index.js):
//   POST /telegram        — incoming bot messages
//   GET  /setup-telegram  — one-time: register Telegram webhook

import { sendMessage, escHtml } from "./notify.js";
import { parseBotIntent } from "./telegram-claude.js";
import {
  getPipelineStages,
  findDealsByCompanyName,
  listOpenDeals,
  updateDealStage,
  getDealContact,
  getClosedDealsInPeriod,
  getPresentedConversions,
} from "./hubspot.js";
import {
  getCachedStages,
  setCachedStages,
  getPending,
  setPending,
  deletePending,
} from "./dedup.js";

// ── Entry point: POST /telegram ────────────────────────────────────────────────

export async function handleTelegramUpdate(request, env, ctx) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Only handle regular text messages
  const message = update?.message;
  if (!message?.text) return new Response("OK", { status: 200 });

  const chatId = String(message.chat?.id || "");
  const text = message.text.trim();

  // Security: only respond to the configured chat
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.warn(`Ignored message from unauthorized chatId: ${chatId}`);
    return new Response("OK", { status: 200 });
  }

  // Process asynchronously so Telegram doesn't retry (5s timeout)
  const process = async () => {
    try {
      await dispatchMessage(env, chatId, text);
    } catch (err) {
      console.error(`Telegram handler error: ${err.stack || err.message}`);
      await reply(env, chatId, `⚠️ Something went wrong: ${escHtml(err.message)}`);
    }
  };

  // Use ctx.waitUntil so the Worker stays alive until processing completes
  // even after the 200 response is returned to Telegram
  ctx.waitUntil(process());

  return new Response("OK", { status: 200 });
}

// ── One-time setup: GET /setup-telegram ───────────────────────────────────────

export async function handleSetupTelegram(env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${env.WORKER_URL}/telegram`,
      allowed_updates: ["message"],
    }),
  });

  const json = await res.json();
  return new Response(JSON.stringify(json, null, 2), {
    status: res.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
// Checks for a pending disambiguation first; otherwise parses fresh intent.

async function dispatchMessage(env, chatId, text) {
  // Check if this is a disambiguation reply (user picking "1", "2", etc.)
  const numericPick = /^\d+$/.test(text) ? parseInt(text, 10) : null;
  if (numericPick !== null) {
    const pending = await getPending(env.DAYA_KV, chatId);
    if (pending) {
      await deletePending(env.DAYA_KV, chatId);
      await resolvePending(env, chatId, pending, numericPick);
      return;
    }
    // No pending context — fall through to normal parsing
  }

  // Fetch (or refresh) pipeline stages from cache
  const stages = await getStages(env);
  const stageNames = stages.map((s) => s.label);
  const today = new Date().toISOString().slice(0, 10);

  const intent = await parseBotIntent(env, text, stageNames, today);
  console.log(`Bot intent: ${JSON.stringify(intent)}`);

  await executeIntent(env, chatId, intent, stages);
}

// ── Intent executor ───────────────────────────────────────────────────────────

async function executeIntent(env, chatId, intent, stages) {
  switch (intent.action) {

    case "show_deals": {
      const deals = await listOpenDeals(env);
      if (deals.length === 0) {
        return reply(env, chatId, "📭 No open deals found.");
      }
      return reply(env, chatId, formatDealList(deals, stages));
    }

    case "search_company": {
      if (!intent.company) return reply(env, chatId, "Please specify a company name.");
      const deals = await findDealsByCompanyName(env, intent.company);
      if (deals.length === 0) {
        return reply(env, chatId, `No deals found for <b>${escHtml(intent.company)}</b>.`);
      }
      if (deals.length === 1) {
        const contact = await getDealContact(env, deals[0].id);
        return reply(env, chatId, formatDealCard(deals[0], stages, contact));
      }
      // Multiple matches — show all as cards
      const cards = await Promise.all(
        deals.map(async (d) => {
          const contact = await getDealContact(env, d.id);
          return formatDealCard(d, stages, contact);
        })
      );
      return reply(env, chatId, cards.join("\n\n─────────────\n\n"));
    }

    case "move_deal": {
      if (!intent.company) return reply(env, chatId, "Please specify a company name.");
      if (!intent.stage)   return reply(env, chatId, "Please specify a target stage.");

      const targetStage = resolveStage(stages, intent.stage);
      if (!targetStage) {
        const stageList = stages.map((s) => `• ${s.label}`).join("\n");
        return reply(env, chatId, `Unknown stage "<b>${escHtml(intent.stage)}</b>". Valid stages:\n${stageList}`);
      }

      const deals = await findDealsByCompanyName(env, intent.company);
      return handleDealAction(env, chatId, deals, intent.company, {
        action: "move_deal",
        stageId: targetStage.id,
        stageLabel: targetStage.label,
      });
    }

    case "close_won": {
      if (!intent.company) return reply(env, chatId, "Please specify a company name.");
      const wonStage = stages.find((s) => s.label.toLowerCase().includes("closed won"));
      if (!wonStage) return reply(env, chatId, "Could not find Closed Won stage.");

      const deals = await findDealsByCompanyName(env, intent.company);
      return handleDealAction(env, chatId, deals, intent.company, {
        action: "move_deal",
        stageId: wonStage.id,
        stageLabel: wonStage.label,
      });
    }

    case "close_lost": {
      if (!intent.company) return reply(env, chatId, "Please specify a company name.");
      const lostStage = stages.find((s) => s.label.toLowerCase().includes("closed lost"));
      if (!lostStage) return reply(env, chatId, "Could not find Closed Lost stage.");

      const deals = await findDealsByCompanyName(env, intent.company);
      return handleDealAction(env, chatId, deals, intent.company, {
        action: "move_deal",
        stageId: lostStage.id,
        stageLabel: lostStage.label,
      });
    }

    case "report": {
      const from = intent.from || daysAgo(30);
      const to   = intent.to   || new Date().toISOString().slice(0, 10);
      return sendReport(env, chatId, from, to, stages);
    }

    default: {
      const stageList = stages.map((s) => `• ${s.label}`).join("\n");
      return reply(env, chatId,
        `🤖 <b>Available commands:</b>\n\n` +
        `<b>show deals</b> — list all open deals\n` +
        `<b>show [company]</b> — deal details for a company\n` +
        `<b>move [company] to [stage]</b> — update deal stage\n` +
        `<b>close [company]</b> — mark as Closed Won\n` +
        `<b>lose [company]</b> — mark as Closed Lost\n` +
        `<b>report</b> — 30-day pipeline summary\n` +
        `<b>report last 90 days</b> / <b>report March</b> — custom period\n\n` +
        `<b>Stages:</b>\n${stageList}`
      );
    }
  }
}

// ── Deal action with disambiguation ───────────────────────────────────────────
// If deals.length === 0 → not found message
// If deals.length === 1 → execute immediately
// If deals.length > 1  → send numbered list, store pending context

async function handleDealAction(env, chatId, deals, company, pendingAction) {
  if (deals.length === 0) {
    return reply(env, chatId, `No deals found for <b>${escHtml(company)}</b>.`);
  }

  if (deals.length === 1) {
    await updateDealStage(env, deals[0].id, pendingAction.stageId);
    return reply(env, chatId,
      `✅ Moved <b>${escHtml(deals[0].dealname)}</b> to <b>${escHtml(pendingAction.stageLabel)}</b>.`
    );
  }

  // Multiple matches — store context and ask user to pick
  await setPending(env.DAYA_KV, chatId, {
    ...pendingAction,
    deals: deals.map((d) => ({ id: d.id, dealname: d.dealname })),
  });

  const list = deals
    .map((d, i) => `${i + 1}. ${escHtml(d.dealname)}`)
    .join("\n");

  return reply(env, chatId,
    `Multiple deals found for <b>${escHtml(company)}</b>. Which one?\n\n${list}\n\n<i>Reply with a number. Selection expires in 5 minutes.</i>`
  );
}

// ── Resolve disambiguation pick ───────────────────────────────────────────────

async function resolvePending(env, chatId, pending, pick) {
  const deal = pending.deals?.[pick - 1];
  if (!deal) {
    return reply(env, chatId, `Invalid selection. Please try your command again.`);
  }

  await updateDealStage(env, deal.id, pending.stageId);
  return reply(env, chatId,
    `✅ Moved <b>${escHtml(deal.dealname)}</b> to <b>${escHtml(pending.stageLabel)}</b>.`
  );
}

// ── Report ────────────────────────────────────────────────────────────────────

async function sendReport(env, chatId, fromDate, toDate, stages) {
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso   = `${toDate}T23:59:59.999Z`;

  // Resolve stage IDs for filtering
  const wonStage  = stages.find((s) => s.label.toLowerCase().includes("closed won"));
  const lostStage = stages.find((s) => s.label.toLowerCase().includes("closed lost"));
  const presentedStage = stages.find((s) => s.label.toLowerCase().includes("presented"));

  // Run queries in parallel
  const [openDeals, closedDeals, presentedConversions] = await Promise.all([
    listOpenDeals(env),
    getClosedDealsInPeriod(env, fromIso, toIso),
    presentedStage
      ? getPresentedConversions(env, presentedStage.id, fromIso, toIso)
      : Promise.resolve([]),
  ]);

  // Pipeline snapshot — group open deals by stage
  const openByStage = {};
  for (const deal of openDeals) {
    openByStage[deal.dealstage] = (openByStage[deal.dealstage] || 0) + 1;
  }

  // Closed stats
  const wonCount  = closedDeals.filter((d) => d.dealstage === wonStage?.id).length;
  const lostCount = closedDeals.filter((d) => d.dealstage === lostStage?.id).length;
  const totalClosed = wonCount + lostCount;
  const winRate = totalClosed > 0 ? Math.round((wonCount / totalClosed) * 100) : null;

  // Presented → outcome
  const presWon  = presentedConversions.filter((d) => d.dealstage === wonStage?.id).length;
  const presLost = presentedConversions.filter((d) => d.dealstage === lostStage?.id).length;
  const presTotal = presWon + presLost;
  const presConversion = presTotal > 0 ? Math.round((presWon / presTotal) * 100) : null;

  // Avg close time (days)
  const closedWithDates = closedDeals.filter((d) => d.createdate && d.closedate);
  let avgCloseDays = null;
  if (closedWithDates.length > 0) {
    const totalMs = closedWithDates.reduce((sum, d) => {
      return sum + (new Date(d.closedate) - new Date(d.createdate));
    }, 0);
    avgCloseDays = Math.round(totalMs / closedWithDates.length / (1000 * 60 * 60 * 24));
  }

  // Format dates for header
  const fromLabel = formatDate(fromDate);
  const toLabel   = formatDate(toDate);

  // Build message
  const lines = [
    `📊 <b>Report: ${fromLabel} – ${toLabel}</b>`,
    "",
    "<b>Pipeline (current)</b>",
    ...stages
      .filter((s) => !s.label.toLowerCase().includes("closed"))
      .map((s) => {
        const count = openByStage[s.id] || 0;
        return `• ${escHtml(s.label)}: ${count}`;
      }),
    `• <b>Total open: ${openDeals.length}</b>`,
    "",
    "<b>Closed this period</b>",
    `• Won:  ${wonCount} ✅`,
    `• Lost: ${lostCount} ❌`,
    winRate !== null
      ? `• Win rate: ${winRate}%`
      : "• Win rate: — (no closed deals)",
    "",
  ];

  if (presentedStage) {
    lines.push(
      `<b>Presented → Outcome</b>`,
      `• → Closed Won:  ${presWon}`,
      `• → Closed Lost: ${presLost}`,
      presConversion !== null
        ? `• Conversion: ${presConversion}%`
        : "• Conversion: — (no data)",
      "",
    );
  }

  if (avgCloseDays !== null) {
    lines.push(`⏱ Avg. time to close: ${avgCloseDays} days`);
  }

  return reply(env, chatId, lines.join("\n"));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function reply(env, chatId, text) {
  return sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
}

async function getStages(env) {
  const cached = await getCachedStages(env.DAYA_KV);
  if (cached) return cached;

  const stages = await getPipelineStages(env);
  await setCachedStages(env.DAYA_KV, stages);
  console.log(`HubSpot stages fetched: ${JSON.stringify(stages.map((s) => s.label))}`);
  return stages;
}

// Find a stage by fuzzy label match (case-insensitive)
function resolveStage(stages, label) {
  if (!label) return null;
  const norm = label.toLowerCase().trim();
  return (
    stages.find((s) => s.label.toLowerCase() === norm) ||
    stages.find((s) => s.label.toLowerCase().includes(norm)) ||
    stages.find((s) => norm.includes(s.label.toLowerCase()))
  );
}

function formatDealCard(deal, stages, contact) {
  const stageLabel = stages.find((s) => s.id === deal.dealstage)?.label || deal.dealstage;
  const lines = [
    `🏢 <b>${escHtml(deal.dealname)}</b>`,
    `Stage: ${escHtml(stageLabel)}`,
  ];
  if (contact?.name)        lines.push(`Contact: ${escHtml(contact.name)}`);
  if (contact?.email)       lines.push(`Email: ${escHtml(contact.email)}`);
  if (deal.lastActivity)    lines.push(`Last activity: ${relativeDate(deal.lastActivity)}`);
  lines.push(`ID: ${deal.id}`);
  return lines.join("\n");
}

function formatDealList(deals, stages) {
  if (deals.length === 0) return "📭 No open deals.";

  // Group by stage in pipeline order
  const grouped = {};
  for (const stage of stages) {
    const stageDeals = deals.filter((d) => d.dealstage === stage.id);
    if (stageDeals.length > 0) grouped[stage.label] = stageDeals;
  }

  const lines = [`📋 <b>Open deals (${deals.length})</b>`, ""];
  for (const [stageLabel, stageDeals] of Object.entries(grouped)) {
    lines.push(`<b>${escHtml(stageLabel)}</b>`);
    for (const d of stageDeals) {
      const activity = d.lastActivity ? `  <i>${relativeDate(d.lastActivity)}</i>` : "";
      lines.push(`  • ${escHtml(d.dealname)}${activity}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatDate(isoDate) {
  // "2026-03-01" → "1 Mar 2026"
  const d = new Date(isoDate + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// "2026-04-03T10:00:00Z" → "3 Apr 2026"
function relativeDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
