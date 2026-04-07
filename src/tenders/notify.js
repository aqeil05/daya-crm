// ─── Tender Telegram Notifications ────────────────────────────────────────────

import { sendMessage, escHtml } from "../notify.js";

const PORTAL_LABELS = {
  monaqasat:               "Monaqasat (MoF Qatar)",
  biddetail:               "BidDetail Qatar",
  "biddetail-p2":           "BidDetail Qatar",
  "qatar-foundation":      "Qatar Foundation",
};

export async function notifyTender(env, portalId, tender) {
  const portalLabel = PORTAL_LABELS[portalId] || portalId;

  // Use a dedicated chat ID for tender alerts if configured, otherwise fall
  // back to the main ops chat.
  const chatId = env.TENDER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;

  const lines = [
    `🏗 <b>New Tender Opportunity</b>`,
    `Portal: ${escHtml(portalLabel)}`,
    `<b>${escHtml(tender.title || "Untitled")}</b>`,
    tender.issuer      ? `Issuer: ${escHtml(tender.issuer)}`                         : "",
    tender.description ? `Scope: ${escHtml(tender.description.slice(0, 200))}`       : "",
    tender.deadline    ? `Deadline: ${escHtml(tender.deadline)}`                     : "Deadline: Not specified",
    tender.value       ? `Value: ${escHtml(tender.value)}`                           : "",
    tender.url         ? `<a href="${escHtml(tender.url)}">View &amp; Apply ↗</a>`   : "",
  ].filter(Boolean).join("\n");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines);
}
