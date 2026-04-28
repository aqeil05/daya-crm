// ─── Notification Gate helper ─────────────────────────────────────────────────
// Shared by pipeline.js and tenders/index.js.
// Returns true if this invocation should send the notification (first claimer),
// false if another concurrent instance already claimed it.

export async function claimNotification(env, key, ttlSeconds = 300) {
  const id = env.NOTIFICATION_GATE.idFromName("global");
  const stub = env.NOTIFICATION_GATE.get(id);
  const res = await stub.fetch("https://gate/claim", {
    method: "POST",
    body: JSON.stringify({ key, ttlSeconds }),
    headers: { "Content-Type": "application/json" },
  });
  return res.status === 201;
}
