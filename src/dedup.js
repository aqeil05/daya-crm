// ─── KV helpers ───────────────────────────────────────────────────────────────
// KV key layout:
//   conv:{conversationId}       → "1"          (90-day TTL) — dedup
//   cache:google_token          → access token  (55-min TTL)
//   cache:graph_token           → access token  (55-min TTL)
//   sub:{email}                 → JSON string   (3-day TTL)  — Graph subscription
//   failed:{messageId}          → JSON string   (7-day TTL)  — failed pipeline runs
//   cache:stages                → JSON array    (1-hour TTL) — HubSpot pipeline stages
//   tg:pending:{chatId}         → JSON object   (5-min TTL)  — Telegram disambiguation state

const TTL = {
  CONVERSATION: 60 * 60 * 24 * 90,   // 90 days
  GOOGLE_TOKEN:  60 * 55,             // 55 minutes
  GRAPH_TOKEN:   60 * 55,             // 55 minutes
  SUBSCRIPTION:  60 * 60 * 24 * 3,   // 3 days
  FAILED:        60 * 60 * 24 * 7,   // 7 days
  STAGES:        60 * 60,             // 1 hour
  PENDING:       60 * 5,              // 5 minutes
};

// ── Conversation dedup ────────────────────────────────────────────────────────

export async function isKnownConversation(kv, conversationId) {
  const val = await kv.get(`conv:${conversationId}`);
  return val !== null;
}

export async function markConversation(kv, conversationId) {
  await kv.put(`conv:${conversationId}`, "1", { expirationTtl: TTL.CONVERSATION });
}

// ── Google Sheets token cache ─────────────────────────────────────────────────

export async function getCachedGoogleToken(kv) {
  return kv.get("cache:google_token");
}

export async function setCachedGoogleToken(kv, token) {
  await kv.put("cache:google_token", token, { expirationTtl: TTL.GOOGLE_TOKEN });
}

// ── Microsoft Graph token cache ───────────────────────────────────────────────

export async function getCachedGraphToken(kv) {
  return kv.get("cache:graph_token");
}

export async function setCachedGraphToken(kv, token) {
  await kv.put("cache:graph_token", token, { expirationTtl: TTL.GRAPH_TOKEN });
}

// ── Graph subscription state ──────────────────────────────────────────────────

export async function getSubscription(kv, email) {
  const val = await kv.get(`sub:${email}`);
  return val ? JSON.parse(val) : null;
}

export async function setSubscription(kv, email, data) {
  await kv.put(`sub:${email}`, JSON.stringify(data), { expirationTtl: TTL.SUBSCRIPTION });
}

// ── Failed pipeline runs ──────────────────────────────────────────────────────

export async function saveFailed(kv, messageId, data) {
  await kv.put(`failed:${messageId}`, JSON.stringify(data), { expirationTtl: TTL.FAILED });
}

export async function listFailed(kv) {
  const list = await kv.list({ prefix: "failed:" });
  return list.keys;
}

export async function getFailed(kv, key) {
  const val = await kv.get(key);
  return val ? JSON.parse(val) : null;
}

export async function deleteFailed(kv, key) {
  await kv.delete(key);
}

// ── HubSpot pipeline stages cache ─────────────────────────────────────────────

export async function getCachedStages(kv) {
  const val = await kv.get("cache:stages");
  return val ? JSON.parse(val) : null;
}

export async function setCachedStages(kv, stages) {
  await kv.put("cache:stages", JSON.stringify(stages), { expirationTtl: TTL.STAGES });
}

// ── Telegram disambiguation state ─────────────────────────────────────────────
// Stores the context when a command matches multiple deals and we're waiting
// for the user to pick one (e.g. reply "1" or "2").

export async function getPending(kv, chatId) {
  const val = await kv.get(`tg:pending:${chatId}`);
  return val ? JSON.parse(val) : null;
}

export async function setPending(kv, chatId, data) {
  await kv.put(`tg:pending:${chatId}`, JSON.stringify(data), { expirationTtl: TTL.PENDING });
}

export async function deletePending(kv, chatId) {
  await kv.delete(`tg:pending:${chatId}`);
}
