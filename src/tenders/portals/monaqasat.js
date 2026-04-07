// ─── Monaqasat Portal Scraper ──────────────────────────────────────────────────
// Qatar Ministry of Finance e-tendering portal.
// Public listings accessible without authentication.
// Note: The portal may be geo-restricted from some Cloudflare PoPs.
// URL: https://monaqasat.mof.gov.qa

export const PORTAL_ID = "monaqasat";

// Try the English listing page first; fall back to the Arabic paginated URL.
const LISTING_URLS = [
  "https://monaqasat.mof.gov.qa/Tenders/OpenTenders",
  "https://monaqasat.mof.gov.qa/TendersOnlineServices/AvailableMinistriesTenders/1",
];

const HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function fetchTenders() {
  let lastError;

  for (const url of LISTING_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: controller.signal }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        continue;
      }

      const text = await extractBodyText(res);

      if (text.trim().length < 100) {
        lastError = new Error(`Response from ${url} appears empty or JS-rendered`);
        continue;
      }

      return text;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Monaqasat: all listing URLs failed");
}

// Use HTMLRewriter to collect all visible text from the page body.
// This is portal-agnostic — Claude will parse the structure.
async function extractBodyText(res) {
  let text = "";
  let insideSkip = 0;

  const rewriter = new HTMLRewriter()
    // Track entry/exit of non-visible elements so we can skip their text
    .on("script, style, noscript", {
      element(el) {
        insideSkip++;
        el.onEndTag(() => { insideSkip--; });
      },
    })
    // Capture text from content elements only
    .on("p, h1, h2, h3, h4, li, td, th, a, span, div", {
      text(chunk) {
        if (insideSkip > 0) return;
        const t = chunk.text.trim();
        if (t) text += t + " ";
      },
    });

  // Must drain the transformed stream — do NOT call res.text() first
  await rewriter.transform(res).arrayBuffer();

  // Collapse whitespace
  return text.replace(/\s{3,}/g, "\n").trim();
}
