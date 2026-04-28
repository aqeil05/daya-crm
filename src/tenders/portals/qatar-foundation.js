// ─── Qatar Foundation Supplier Portal Scraper ──────────────────────────────────
// Uses Cloudflare Browser Rendering (Puppeteer) with a 14-day trusted session.
//
// ── First-time setup (and renewal every 14 days) ─────────────────────────────
// 1. GET /qf/start-setup        → Puppeteer submits your credentials, OTP SMS sent
// 2. GET /qf/complete-setup?otp=XXXX → enter the SMS code within 5 minutes
// Done — cookies stored in KV for 14 days.
//
// When the session expires the scan summary Telegram message will say:
//   "QF session expired — call GET /qf/start-setup to renew"

import puppeteer from "@cloudflare/puppeteer";

export const PORTAL_ID  = "qatar-foundation";
const LISTINGS_URL      = "https://suppliers.qf.org.qa/abstract";
const LOGIN_URL         = "https://login.qf.org.qa/signin.html";
const COOKIE_KV_KEY     = "qf:cookies";

// ── Used by /qf/start-setup ───────────────────────────────────────────────────

export async function startLoginFlow(env) {
  if (!env.QF_USERNAME) throw new Error("QF_USERNAME secret not set");
  if (!env.QF_PASSWORD) throw new Error("QF_PASSWORD secret not set");

  const browser = await puppeteer.launch(env.MYBROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Step 1: Load login page and submit credentials (triggers OTP SMS)
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForSelector(
      "input[type='email'], input[name='username'], #username",
      { timeout: 10_000 }
    );
    await page.type("input[type='email'], input[name='username'], #username", env.QF_USERNAME);
    await page.type("input[type='password'], input[name='password'], #password", env.QF_PASSWORD);
    await page.click("button[type='submit'], input[type='submit']");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }).catch(() => {});

    // Step 2: Poll KV for the OTP — user calls /qf/complete-setup?otp=XXXX
    // Polls every 5 seconds, waits up to 5 minutes
    let otp = null;
    for (let i = 0; i < 60; i++) {
      otp = await env.DAYA_KV.get("qf:pending_otp");
      if (otp) break;
      await new Promise(r => setTimeout(r, 5_000));
    }
    if (!otp) throw new Error("Timed out waiting for OTP (5 min) — try /qf/start-setup again");

    // Step 3: Ensure "Trust this device for 14 days" is checked
    const trustCheckbox = await page.$("input[type='checkbox']");
    if (trustCheckbox) {
      const checked = await page.evaluate(el => el.checked, trustCheckbox);
      if (!checked) await trustCheckbox.click();
    }

    // Step 4: Enter OTP and submit
    await page.waitForSelector(
      "input[name='passcode'], input[placeholder*='OTP'], input[placeholder*='code'], #passcode",
      { timeout: 10_000 }
    );
    await page.type(
      "input[name='passcode'], input[placeholder*='OTP'], input[placeholder*='code'], #passcode",
      otp
    );
    await page.click("button[type='submit'], #verify-btn, #submitButton");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }).catch(() => {});

    // Step 5: Save all cookies (including httpOnly) to KV for 14 days
    const cookies = await page.cookies();
    await env.DAYA_KV.put(COOKIE_KV_KEY, JSON.stringify(cookies), {
      expirationTtl: 14 * 24 * 60 * 60,
    });
    await env.DAYA_KV.delete("qf:pending_otp");

    return { ok: true, cookieCount: cookies.length };

  } finally {
    await browser.close();
  }
}

// ── Used every scan run (every 6 hours) ──────────────────────────────────────

export async function fetchTenders(env) {
  const stored = await env.DAYA_KV.get(COOKIE_KV_KEY);
  if (!stored) {
    throw new Error("QF session not set up — call GET /qf/start-setup");
  }

  const cookies = JSON.parse(stored);
  const browser = await puppeteer.launch(env.MYBROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Restore trusted session cookies
    await page.setCookie(...cookies);

    // Navigate to listings — no OTP required with trusted session
    await page.goto(LISTINGS_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // Detect session expiry: Oracle redirects to login page
    if (page.url().includes("login")) {
      await env.DAYA_KV.delete(COOKIE_KV_KEY);
      throw new Error("QF session expired — call GET /qf/start-setup to renew (takes ~2 min)");
    }

    // Oracle ADF renders content late — give it extra time
    await page.waitForTimeout(3_000);

    const text = await page.evaluate(() => document.body.innerText);
    if (!text || text.trim().length < 100) {
      throw new Error("QF page rendered but appears empty — check listings URL");
    }

    return text;

  } finally {
    await browser.close();
  }
}
