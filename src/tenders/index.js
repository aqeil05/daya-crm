// ─── Tender Portal Scanner ─────────────────────────────────────────────────────
// Runs every 6 hours via cron. Fetches tender listings from configured portals,
// extracts structured data via Claude, deduplicates with KV, and sends Telegram
// alerts for new tenders that match Daya's business keywords.

import { matchesKeywords } from "./keywords.js";
import { extractTenders } from "./extract.js";
import { notifyTender } from "./notify.js";
import { fetchTenders as fetchMonaqasat, PORTAL_ID as MONAQASAT_ID } from "./portals/monaqasat.js";
import { fetchTenders as fetchBidDetail, PORTAL_ID as BIDDETAIL_ID } from "./portals/biddetail.js";
// Ashghal retired: migrated to Monaqasat (Qatar unified procurement).
// biddetail-p2 retired: BidDetail pagination is JS-driven; page 2 returns same data as page 1.

// Add new portals here as objects with { id, fetch }
const PORTALS = [
  { id: MONAQASAT_ID, fetch: fetchMonaqasat },
  { id: BIDDETAIL_ID, fetch: fetchBidDetail },
];

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runTenderScan(env) {
  const results = [];

  for (const portal of PORTALS) {
    try {
      console.log(`[tenders] Scanning ${portal.id}...`);
      const rawText = await portal.fetch();

      if (rawText.trim().length > 500 === false) {
        console.warn(`[tenders] ${portal.id}: page text suspiciously short (${rawText.length} chars) — may be geo-blocked or JS-rendered`);
      }

      const allTenders = await extractTenders(env, portal.id, rawText);
      console.log(`[tenders] ${portal.id}: extracted ${allTenders.length} tenders`);

      if (allTenders.length === 0 && rawText.trim().length > 500) {
        console.warn(`[tenders] ${portal.id}: Claude found 0 tenders from ${rawText.length} chars — check prompt or page structure`);
      }

      // Only process tenders from Qatar
      const tenders = allTenders.filter(t => isQatar(t.country));
      const filtered = allTenders.length - tenders.length;
      if (filtered > 0) {
        console.log(`[tenders] ${portal.id}: filtered out ${filtered} non-Qatar tender(s)`);
      }

      let newCount = 0;
      let alertCount = 0;

      for (const tender of tenders) {
        const tenderId = tender.id || await stableId(tender.title, tender.deadline);

        // Skip tenders already seen
        if (await isKnownTender(env.DAYA_KV, portal.id, tenderId)) continue;

        // Mark as seen BEFORE keyword check so future runs don't re-evaluate it
        await markTender(env.DAYA_KV, portal.id, tenderId);
        newCount++;

        // Only alert on tenders relevant to Daya's business
        if (!matchesKeywords(tender.title, tender.description)) continue;

        try {
          await notifyTender(env, portal.id, tender);
          alertCount++;
        } catch (err) {
          console.error(`[tenders] ${portal.id}: Telegram notify failed — ${err.message}`);
        }
      }

      console.log(`[tenders] ${portal.id}: ${newCount} new, ${alertCount} alerts sent`);
      results.push({ portal: portal.id, status: "ok", newCount, alertCount });

    } catch (err) {
      // Log per-portal errors but do not abort other portals.
      // No Telegram error alert here — a chronically unavailable portal
      // (e.g. geo-blocked Monaqasat) would spam every 6 hours.
      console.error(`[tenders] ${portal.id} failed: ${err.message}`);
      results.push({ portal: portal.id, status: "error", error: err.message });
    }
  }

  return results;
}

// ── KV helpers ────────────────────────────────────────────────────────────────
// Key schema: tender:{portalId}:{tenderId} → "1" (90-day TTL)

const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

async function isKnownTender(kv, portalId, tenderId) {
  return (await kv.get(`tender:${portalId}:${tenderId}`)) !== null;
}

async function markTender(kv, portalId, tenderId) {
  await kv.put(`tender:${portalId}:${tenderId}`, "1", {
    expirationTtl: TTL_SECONDS,
  });
}

// Returns true if the country field indicates Qatar (or is absent, which means
// the portal itself is Qatar-only so we give it the benefit of the doubt).
function isQatar(country) {
  if (!country || country.trim() === "") return true; // portal is Qatar-specific
  return country.trim().toLowerCase().includes("qatar");
}

// Derives a stable 8-hex-char ID from title + deadline when the portal
// provides no reference number. Uses Web Crypto (available in Workers).
async function stableId(title = "", deadline = "") {
  const input = `${title}::${deadline}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
