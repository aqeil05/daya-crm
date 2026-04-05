// ─── Daya CRM Worker ──────────────────────────────────────────────────────────
// Entry point for Cloudflare Workers.
//
// Routes:
//   POST /webhook        — Microsoft Graph change notification (new email)
//   POST /telegram       — Telegram bot incoming messages
//   GET  /setup          — One-time: register Graph subscriptions for all 3 inboxes
//   GET  /setup-telegram — One-time: register Telegram webhook
//   POST /retry          — Retry failed pipeline runs
//   GET  /health         — Liveness check
// Scheduled (cron):  Renew Graph subscriptions every 12 hours

import { pipeline } from "./pipeline.js";
import { registerSubscription, renewSubscriptions, INBOXES } from "./graph.js";
import { getSubscription, listFailed, getFailed, deleteFailed } from "./dedup.js";
import { handleTelegramUpdate, handleSetupTelegram } from "./telegram.js";

// ── Secrets that must be present for the worker to function ──────────────────
const REQUIRED_SECRETS = [
  "HUBSPOT_PRIVATE_APP_TOKEN",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "GRAPH_CLIENT_STATE",
  "WORKER_URL",
];

function getMissingSecrets(env) {
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}

export default {
  // ── HTTP handler ────────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      const missing = getMissingSecrets(env);
      if (missing.length > 0) {
        return new Response(`Missing secrets: ${missing.join(", ")}`, { status: 500 });
      }
      return new Response("Daya CRM Worker is running.", { status: 200 });
    }

    // ── Validate required secrets before any functional endpoint ─────────────
    const missing = getMissingSecrets(env);
    if (missing.length > 0) {
      return new Response(`Worker misconfigured. Missing secrets: ${missing.join(", ")}`, { status: 500 });
    }

    // ── One-time setup: register Graph webhook subscriptions ──────────────────
    if (url.pathname === "/setup" && request.method === "GET") {
      return handleSetup(env);
    }

    // ── Retry failed pipeline runs ────────────────────────────────────────────
    if (url.pathname === "/retry" && request.method === "POST") {
      return handleRetry(env);
    }

    // ── Telegram bot messages ─────────────────────────────────────────────────
    // Skips rate limiter — Telegram sends from known IPs, auth is via TELEGRAM_CHAT_ID
    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegramUpdate(request, env, ctx);
    }

    // ── One-time Telegram webhook registration ────────────────────────────────
    if (url.pathname === "/setup-telegram" && request.method === "GET") {
      return handleSetupTelegram(env);
    }

    // ── Graph webhook notifications ───────────────────────────────────────────
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  // ── Scheduled handler (cron) ─────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log("Cron: renewing Graph subscriptions");
    ctx.waitUntil(renewSubscriptions(env));
  },
};

// ── /retry ────────────────────────────────────────────────────────────────────

async function handleRetry(env) {
  const keys = await listFailed(env.DAYA_KV);
  if (keys.length === 0) {
    return new Response(JSON.stringify({ message: "No failed messages to retry." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = [];
  for (const { name } of keys) {
    const data = await getFailed(env.DAYA_KV, name);
    if (!data) continue;

    try {
      // Clear the conversation dedup mark so the pipeline can re-process it
      if (data.conversationId && env.DAYA_KV) {
        await env.DAYA_KV.delete(`conv:${data.conversationId}`);
      }

      await pipeline(env, data.messageId, data.inboxEmail);
      await deleteFailed(env.DAYA_KV, name);
      results.push({ messageId: data.messageId, from: data.from, status: "retried" });
    } catch (err) {
      results.push({ messageId: data.messageId, from: data.from, status: "failed_again", error: err.message });
    }
  }

  return new Response(JSON.stringify({ total: results.length, results }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── /webhook ──────────────────────────────────────────────────────────────────

async function handleWebhook(request, env, ctx) {
  const url = new URL(request.url);

  // Graph validation handshake — must respond within 10 seconds
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Rate limit: max 30 requests per minute per IP
  if (!await checkRateLimit(env, request)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const notifications = body?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return new Response("OK", { status: 200 });
  }

  // Respond to Graph immediately — process async so we don't time out
  const processAll = notifications.map(async (notification) => {
    try {
      // Verify clientState to reject spoofed notifications
      if (env.GRAPH_CLIENT_STATE && notification.clientState !== env.GRAPH_CLIENT_STATE) {
        console.warn("Rejected notification with invalid clientState");
        return;
      }

      const messageId = notification.resourceData?.id;
      if (!messageId) {
        console.warn("Notification missing resourceData.id — skipping");
        return;
      }

      // Derive which inbox this subscription belongs to
      const inboxEmail = await resolveInboxBySubId(env, notification.subscriptionId)
        || resolveInbox(notification.resource);
      if (!inboxEmail) {
        console.warn(`Could not resolve inbox from resource: ${notification.resource}`);
        return;
      }

      const result = await pipeline(env, messageId, inboxEmail);
      console.log(`Pipeline result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`Pipeline error for notification: ${err.stack || err.message}`);
    }
  });

  ctx.waitUntil(Promise.all(processAll).catch((err) => console.error("Unhandled pipeline error:", err)));

  return new Response("OK", { status: 200 });
}

// ── /setup ────────────────────────────────────────────────────────────────────

async function handleSetup(env) {
  if (!env.WORKER_URL) {
    return new Response(
      "WORKER_URL secret is not set. Run: wrangler secret put WORKER_URL",
      { status: 500 }
    );
  }

  const results = [];
  for (const email of INBOXES) {
    try {
      const subscriptionId = await registerSubscription(env, email);
      results.push({ email, subscriptionId, status: "ok" });
    } catch (err) {
      results.push({ email, error: err.message, status: "error" });
    }
  }

  const allOk = results.every((r) => r.status === "ok");
  return new Response(JSON.stringify(results, null, 2), {
    status: allOk ? 200 : 207,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Simple KV-based counter: max 30 requests per IP per minute.
// Note: KV writes are not atomic, so the limit is approximate (acceptable for this use case).

async function checkRateLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${ip}:${minute}`;

  const count = parseInt(await env.DAYA_KV.get(key) || "0");
  if (count >= 30) return false;

  await env.DAYA_KV.put(key, String(count + 1), { expirationTtl: 120 }); // 2-min TTL
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Look up inbox email by subscriptionId stored in KV
async function resolveInboxBySubId(env, subscriptionId) {
  if (!subscriptionId) return null;
  for (const inbox of INBOXES) {
    const sub = await getSubscription(env.DAYA_KV, inbox);
    if (sub?.subscriptionId === subscriptionId) return inbox;
  }
  return null;
}

// Graph resource path: "users/peter.k@wearedaya.com/mailFolders/Inbox/messages"
// Extract the email address from it.
function resolveInbox(resource) {
  if (!resource) return null;
  const match = resource.match(/users\/([^/]+)\//);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  return INBOXES.find((inbox) => inbox.toLowerCase() === candidate) || candidate;
}
