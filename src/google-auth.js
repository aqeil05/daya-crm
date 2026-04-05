// ─── Google Auth ─────────────────────────────────────────────────────────────
// Cloudflare Workers cannot use googleapis SDK.
// Instead: sign a JWT manually with Web Crypto (RS256), exchange for access token,
// and cache it in KV for 55 min (tokens last 60 min).

import { getCachedGoogleToken, setCachedGoogleToken } from "./dedup.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ── JWT construction ──────────────────────────────────────────────────────────

function b64url(str) {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlFromBytes(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function buildJWT(serviceAccountEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: serviceAccountEmail,
      scope: SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      exp: now + 3600,
      iat: now,
    })
  );

  const signingInput = `${header}.${payload}`;

  // Strip PEM envelope and decode base64 to DER bytes.
  // Handle both actual newlines and literal \n (from wrangler secret paste).
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")   // literal backslash-n from some secret stores
    .replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${b64urlFromBytes(signature)}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function fetchNewToken(serviceAccountEmail, privateKeyPem) {
  const jwt = await buildJWT(serviceAccountEmail, privateKeyPem);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${body}`);
  }

  const { access_token } = await res.json();
  return access_token;
}

// ── Public: get a valid token (from KV cache or fresh) ────────────────────────

export async function getGoogleToken(kv, env) {
  const cached = await getCachedGoogleToken(kv);
  if (cached) return cached;

  const token = await fetchNewToken(env.GOOGLE_SA_EMAIL, env.GOOGLE_SA_PRIVATE_KEY);
  await setCachedGoogleToken(kv, token);
  return token;
}
