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
//   GET  /tenders/test   — Manually trigger a tender scan (dev/ops use)
//   POST /test/pipeline  — Dry-run stress test with synthetic emails (no HubSpot/Telegram)
// Scheduled (cron 0 */12 * * *): Renew Graph subscriptions every 12 hours
// Scheduled (cron 0 */6  * * *): Scan tender portals every 6 hours
// Scheduled (* * * * *)        : Auto-retry rate-limited (deferred) messages every minute

import { pipeline, pipelineFromMessage } from "./pipeline.js";
import { registerSubscription, renewSubscriptions, stripQuotedReplies, INBOXES } from "./graph.js";
import { getSubscription, listFailed, getFailed, deleteFailed, listDeferred, getDeferred, deleteDeferred } from "./dedup.js";
import { handleTelegramUpdate, handleSetupTelegram } from "./telegram.js";
import { FIXTURES } from "./test-fixtures.js";

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

    // ── Manual tender scan trigger (dev / ops) ────────────────────────────────
    if (url.pathname === "/tenders/test" && request.method === "GET") {
      return handleTendersTest(env);
    }

    // ── Fire a fake Telegram tender alert (notification format test) ──────────
    if (url.pathname === "/tenders/notify-test" && request.method === "GET") {
      return handleTendersNotifyTest(env);
    }

    // ── Tender scrape debugger: shows raw extracted text per portal ───────────
    // Usage: GET /tenders/debug?portal=protenders
    if (url.pathname === "/tenders/debug" && request.method === "GET") {
      return handleTendersDebug(env, url);
    }

    // ── Pipeline stress test (dry-run — no HubSpot / Sheets / Telegram) ─────────
    if (url.pathname === "/test/pipeline" && request.method === "POST") {
      return handleTestPipeline(request, env);
    }

    // ── Graph webhook notifications ───────────────────────────────────────────
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  // ── Scheduled handler (cron) ─────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    if (event.cron === "0 */12 * * *") {
      console.log("Cron: renewing Graph subscriptions");
      ctx.waitUntil(renewSubscriptions(env));
    }

    if (event.cron === "0 */6 * * *") {
      console.log("Cron: scanning tender portals");
      const { runTenderScan } = await import("./tenders/index.js");
      ctx.waitUntil(runTenderScan(env));
    }

    if (event.cron === "* * * * *") {
      ctx.waitUntil(processDeferred(env));
    }
  },
};

// ── /test/pipeline ────────────────────────────────────────────────────────────
// Dry-run endpoint for stress testing — accepts a named scenario or a custom
// email body and runs Claude classification + extraction without touching
// HubSpot, Sheets, auto-reply, or Telegram.
//
// POST body (named scenario):  { "scenario": "arabic-lead" }
// POST body (custom):          { "from", "fromName", "subject", "body", "inboxEmail" }
//
// Response: { scenario, originalBodyLength, strippedBodyLength,
//             classification, extracted, approxInputTokens, status }

function approxInputTokens(text) {
  // ASCII chars ≈ 4 chars/token; non-ASCII (Arabic, etc.) ≈ 1.5 chars/token
  let ascii = 0, nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    text.charCodeAt(i) < 128 ? ascii++ : nonAscii++;
  }
  return Math.round(ascii / 4 + nonAscii / 1.5);
}

async function handleTestPipeline(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  let fixture;
  let scenarioKey = "custom";

  if (body.scenario) {
    fixture = FIXTURES[body.scenario];
    if (!fixture) {
      return new Response(JSON.stringify({
        error: `Unknown scenario "${body.scenario}". Available: ${Object.keys(FIXTURES).join(", ")}`,
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    scenarioKey = body.scenario;
  } else {
    const { from, subject, body: emailBody, inboxEmail } = body;
    if (!from || !subject || !emailBody || !inboxEmail) {
      return new Response(JSON.stringify({
        error: "Custom mode requires: from, subject, body, inboxEmail",
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    fixture = {
      id: "custom",
      from,
      fromName: body.fromName || from,
      subject,
      body: emailBody,
      inboxEmail,
    };
  }

  // Apply quote stripping (same as fetchMessage does for real emails) and
  // capture before/after lengths so the test shows how much it's cutting.
  const originalBodyLength = fixture.body.length;
  const strippedBody = stripQuotedReplies(fixture.body);
  const strippedBodyLength = strippedBody.length;

  // Build a synthetic message object matching the shape fetchMessage returns.
  // Use a timestamp suffix on conversationId so repeated calls don't collide
  // in KV — EXCEPT for the CC pair, which share a stable id intentionally.
  const isStableCcFixture = fixture.id === "fixture-cc-lead";
  const conversationId = isStableCcFixture
    ? `conv-${fixture.id}`
    : `conv-${fixture.id}-${Date.now()}`;

  const msg = {
    id: `test-${fixture.id}-${Date.now()}`,
    subject: fixture.subject,
    bodyText: strippedBody,
    from: fixture.from,
    fromName: fixture.fromName,
    conversationId,
    receivedAt: new Date().toISOString(),
  };

  try {
    const result = await pipelineFromMessage(env, msg, fixture.inboxEmail, { dryRun: true });

    return new Response(JSON.stringify({
      scenario: scenarioKey,
      expectedClassification: fixture.expectedClassification || null,
      originalBodyLength,
      strippedBodyLength,
      classification: result.classification ?? result.status,
      extracted: result.extracted ?? null,
      approxInputTokens: approxInputTokens(strippedBody),
      status: result.status,
    }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Deferred queue processor (runs every minute via cron) ────────────────────
// Processes one deferred message per invocation to avoid re-triggering rate limits.

async function processDeferred(env) {
  const keys = await listDeferred(env.DAYA_KV);
  if (keys.length === 0) return;

  const { name } = keys[0];
  const data = await getDeferred(env.DAYA_KV, name);
  if (!data) return;

  console.log(`[deferred] Retrying ${data.messageId} for ${data.inboxEmail}`);

  try {
    const result = await pipeline(env, data.messageId, data.inboxEmail);
    if (result?.status !== "deferred") {
      // Processed successfully (or skipped as dedup) — remove from deferred queue
      await deleteDeferred(env.DAYA_KV, name);
      console.log(`[deferred] Done: ${data.messageId} → ${result?.status}`);
    }
    // If result.status === "deferred": pipeline already saved new deferred entry
    // with the same key — don't delete, it will be retried next minute
  } catch (err) {
    // Real pipeline failure — pipeline already saved to failed: and sent Telegram alert
    await deleteDeferred(env.DAYA_KV, name);
    console.error(`[deferred] Pipeline failed for ${data.messageId}: ${err.message}`);
  }
}

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

  // Respond to Graph immediately — process async so we don't time out.
  // Sequential (not parallel) so that CC'd emails to multiple inboxes in the
  // same batch are deduplicated: the first notification marks the conversation
  // before the second one checks it.
  ctx.waitUntil(
    (async () => {
      for (const notification of notifications) {
        try {
          // Verify clientState to reject spoofed notifications
          if (env.GRAPH_CLIENT_STATE && notification.clientState !== env.GRAPH_CLIENT_STATE) {
            console.warn("Rejected notification with invalid clientState");
            continue;
          }

          const messageId = notification.resourceData?.id;
          if (!messageId) {
            console.warn("Notification missing resourceData.id — skipping");
            continue;
          }

          // Derive which inbox this subscription belongs to
          const inboxEmail = await resolveInboxBySubId(env, notification.subscriptionId)
            || resolveInbox(notification.resource);
          if (!inboxEmail) {
            console.warn(`Could not resolve inbox from resource: ${notification.resource}`);
            continue;
          }

          const result = await pipeline(env, messageId, inboxEmail);
          console.log(`Pipeline result: ${JSON.stringify(result)}`);
        } catch (err) {
          console.error(`Pipeline error for notification: ${err.stack || err.message}`);
        }
      }
    })().catch((err) => console.error("Unhandled pipeline error:", err))
  );

  return new Response("OK", { status: 200 });
}

// ── /tenders/notify-test ─────────────────────────────────────────────────────

async function handleTendersNotifyTest(env) {
  const { notifyTender } = await import("./tenders/notify.js");

  const fakeTender = {
    id: "111339452",
    title: "Interior Fit-Out Works for Gift Shops at Student Affairs Building",
    description: "Interior finishing and furnishing of retail gift shop spaces within the Student Affairs Building at Qatar University. Tender bond: QAR 35,000. Document cost: QAR 500.",
    deadline: "2026-04-29",
    issuer: "Qatar University",
    url: "https://www.biddetail.com/latest-tenders/111339452$17f204cc-0d1b-4e38-93df-00cdaf61f9fe",
    value: "",
  };

  try {
    await notifyTender(env, "biddetail", fakeTender);
    return new Response(JSON.stringify({ ok: true, tender: fakeTender }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── /tenders/debug ───────────────────────────────────────────────────────────

async function handleTendersDebug(env, url) {
  const portalId = url.searchParams.get("portal");

  const FETCHERS = {
    monaqasat: () => import("./tenders/portals/monaqasat.js").then(m => m.fetchTenders()),
    biddetail:  () => import("./tenders/portals/biddetail.js").then(m => m.fetchTenders()),
  };

  if (!portalId || !FETCHERS[portalId]) {
    return new Response(
      JSON.stringify({ error: `?portal= must be one of: ${Object.keys(FETCHERS).join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const rawText = await FETCHERS[portalId]();
    const { extractTenders } = await import("./tenders/extract.js");
    const tenders = await extractTenders(env, portalId, rawText);
    return new Response(
      JSON.stringify({
        portal: portalId,
        rawTextLength: rawText.length,
        rawTextPreview: rawText.slice(0, 800),
        tendersExtracted: tenders.length,
        tenders,
      }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ portal: portalId, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ── /tenders/test ────────────────────────────────────────────────────────────

async function handleTendersTest(env) {
  const { runTenderScan } = await import("./tenders/index.js");
  try {
    const results = await runTenderScan(env);
    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
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
