// ─── Tender Telegram Notifications ────────────────────────────────────────────

import { sendMessage, escHtml } from "../notify.js";

const PORTAL_LABELS = {
  monaqasat:          "Monaqasat (MoF Qatar)",
  biddetail:          "BidDetail Qatar",
  "biddetail-p2":     "BidDetail Qatar",
  "qatar-foundation": "Qatar Foundation",
  tenderdetail:       "TenderDetail Qatar",
};

export async function notifyTenderScanSummary(env, results) {
  const chatId     = env.TENDER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  const ok         = results.filter(r => r.status === "ok");
  const errors     = results.filter(r => r.status === "error");
  const totalNew    = ok.reduce((s, r) => s + (r.newCount   || 0), 0);
  const totalAlerts = ok.reduce((s, r) => s + (r.alertCount || 0), 0);

  const icon = errors.length > 0 ? "⚠️" : "✅";
  const lines = [
    `${icon} <b>Tender scan complete</b>`,
    `Portals: ${results.length} checked (${ok.length} ok${errors.length > 0 ? `, ${errors.length} failed` : ""})`,
    `New tenders seen: ${totalNew}`,
    `Alerts sent: ${totalAlerts}`,
    ...errors.map(r => `• ${escHtml(r.portal)}: ${escHtml(r.error || "unknown error")}`),
  ];

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"));
}

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
