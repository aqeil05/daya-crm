// ─── Microsoft Graph API ──────────────────────────────────────────────────────

import { getCachedGraphToken, setCachedGraphToken, getSubscription, setSubscription } from "./dedup.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export const INBOXES = [
  "peterkimani@wearedaya.com",
  "hello@wearedaya.com",
  "procurement@wearedaya.com",
];

// ── Access token (client credentials, cached 55 min) ─────────────────────────

export async function getAccessToken(env) {
  const cached = await getCachedGraphToken(env.DAYA_KV);
  if (cached) return cached;

  const tokenUrl = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      scope: GRAPH_SCOPE,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph token fetch failed: ${res.status} ${body}`);
  }

  const { access_token } = await res.json();
  await setCachedGraphToken(env.DAYA_KV, access_token);
  return access_token;
}

// ── Fetch full email message ──────────────────────────────────────────────────

export async function fetchMessage(env, userEmail, messageId) {
  const token = await getAccessToken(env);
  const select = "id,subject,body,from,conversationId,receivedDateTime";
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/messages/${messageId}?$select=${select}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fetchMessage failed: ${res.status} ${body}`);
  }

  const msg = await res.json();
  const rawHtml = msg.body?.content || "";
  const bodyText = msg.body?.contentType?.toLowerCase() === "text"
    ? rawHtml
    : stripHtml(rawHtml);

  return {
    id: msg.id,
    subject: msg.subject || "",
    bodyText,
    from: msg.from?.emailAddress?.address || "",
    fromName: msg.from?.emailAddress?.name || "",
    conversationId: msg.conversationId || "",
    receivedAt: msg.receivedDateTime || "",
  };
}

// ── Send auto-reply via sendMail ──────────────────────────────────────────────

export async function sendReply(env, fromInbox, toAddress, originalSubject, bodyText) {
  const token = await getAccessToken(env);
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(fromInbox)}/sendMail`;

  const replySubject = /^re:/i.test(originalSubject)
    ? originalSubject
    : `RE: ${originalSubject}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: replySubject,
        body: { contentType: "Text", content: bodyText },
        toRecipients: [{ emailAddress: { address: toAddress } }],
      },
    }),
  });

  // 202 Accepted = success for sendMail
  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    throw new Error(`sendReply failed: ${res.status} ${body}`);
  }
}

// ── Subscription management ───────────────────────────────────────────────────

export async function registerSubscription(env, userEmail) {
  // Check for existing subscription in KV — renew if found
  const existing = await getSubscription(env.DAYA_KV, userEmail);
  if (existing?.subscriptionId) {
    try {
      await patchSubscription(env, existing.subscriptionId);
      console.log(`Renewed existing subscription for ${userEmail}`);
      return existing.subscriptionId;
    } catch (err) {
      console.warn(`Renew failed for ${userEmail}, creating new: ${err.message}`);
    }
  }

  const token = await getAccessToken(env);
  // Graph mail subscriptions expire after max 4230 minutes (~3 days)
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString();

  const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: `${env.WORKER_URL}/webhook`,
      resource: `users/${userEmail}/mailFolders/Inbox/messages`,
      expirationDateTime: expiresAt,
      clientState: env.GRAPH_CLIENT_STATE,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`registerSubscription failed for ${userEmail}: ${res.status} ${body}`);
  }

  const { id: subscriptionId } = await res.json();
  await setSubscription(env.DAYA_KV, userEmail, { subscriptionId, expiresAt });
  console.log(`Registered new subscription for ${userEmail}: ${subscriptionId}`);
  return subscriptionId;
}

export async function renewSubscriptions(env) {
  for (const email of INBOXES) {
    const sub = await getSubscription(env.DAYA_KV, email);
    if (!sub?.subscriptionId) {
      console.warn(`No subscription in KV for ${email} — run /setup to register`);
      continue;
    }
    try {
      await patchSubscription(env, sub.subscriptionId);
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString();
      await setSubscription(env.DAYA_KV, email, { subscriptionId: sub.subscriptionId, expiresAt });
      console.log(`Renewed subscription for ${email}`);
    } catch (err) {
      console.error(`Failed to renew subscription for ${email}: ${err.message}`);
    }
  }
}

async function patchSubscription(env, subscriptionId) {
  const token = await getAccessToken(env);
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString();

  const res = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime: expiresAt }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`patchSubscription failed: ${res.status} ${body}`);
  }
}

// ── Strip HTML ────────────────────────────────────────────────────────────────
// Preserves paragraph structure so Claude receives readable text.

function stripHtml(html) {
  return html
    // Remove style and script blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Convert block-level/line-break elements to newlines before stripping
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote)[^>]*>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Normalize whitespace: collapse spaces/tabs but preserve paragraph breaks
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
