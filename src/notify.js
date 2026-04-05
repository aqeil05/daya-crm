// ─── Telegram Notifications ───────────────────────────────────────────────────

export function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error("Telegram sendMessage error:", JSON.stringify(json));
  }
  return json;
}

// ── Lead notification ─────────────────────────────────────────────────────────

export async function notifyLead(env, { fromName, from, company, sourceInbox, subject, dealId }) {
  const hubspotUrl = dealId
    ? `https://app.hubspot.com/contacts/${encodeURIComponent(env.HUBSPOT_PORTAL_ID || "")}/deal/${dealId}`
    : "";

  const text = [
    `🟢 <b>New Lead</b>`,
    `From: ${escHtml(fromName || from)} &lt;${escHtml(from)}&gt;`,
    `Company: ${escHtml(company || "Unknown")}`,
    `Inbox: ${escHtml(sourceInbox)}`,
    `Subject: ${escHtml(subject)}`,
    hubspotUrl ? `Deal: ${hubspotUrl}` : "",
  ].filter(Boolean).join("\n");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
}

// ── Supplier notification ─────────────────────────────────────────────────────

export async function notifySupplier(env, { fromName, from, company, productService, sourceInbox }) {
  const text = [
    `🔵 <b>New Supplier</b>`,
    `Contact: ${escHtml(fromName || from)} &lt;${escHtml(from)}&gt;`,
    `Company: ${escHtml(company || "Unknown")}`,
    `Product/Service: ${escHtml(productService || "—")}`,
    `Inbox: ${escHtml(sourceInbox)}`,
  ].join("\n");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
}

// ── Pipeline failure notification ─────────────────────────────────────────────

export async function notifyError(env, { from, subject, error, messageId }) {
  const text = [
    `🔴 <b>Pipeline Failed</b>`,
    from ? `From: ${escHtml(from)}` : "",
    subject ? `Subject: ${escHtml(subject)}` : "",
    `Error: ${escHtml(error)}`,
    messageId ? `Message ID: <code>${escHtml(messageId)}</code>` : "",
    `<i>Use /retry to reprocess failed messages.</i>`,
  ].filter(Boolean).join("\n");

  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
}
