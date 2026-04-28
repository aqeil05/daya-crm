// ─── NotificationGate Durable Object ─────────────────────────────────────────
// Provides atomic check-and-set to prevent duplicate Telegram notifications
// when two concurrent Worker instances process the same email or tender.
//
// Cloudflare KV is eventually consistent — two Workers can both read a key as
// null before either write propagates. A Durable Object's storage is strongly
// consistent and transactional, which closes this race window.
//
// API: POST with JSON body { key: string, ttlSeconds?: number }
//   → 201 "new"    — key was unclaimed; caller should proceed with notification
//   → 200 "exists" — key was already claimed; caller should skip notification

export class NotificationGate {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { key, ttlSeconds = 86400 } = await request.json();

    const existing = await this.state.storage.get(key);
    if (existing) {
      return new Response("exists", { status: 200 });
    }

    await this.state.storage.put(key, 1, { expirationTtl: ttlSeconds });
    return new Response("new", { status: 201 });
  }
}
