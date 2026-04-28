// ─── TenderDetail Portal Scraper ───────────────────────────────────────────────
// TenderDetail.com is a publicly accessible tender aggregator covering Qatar
// and the wider GCC region. No login required to browse listings.
// URL: https://www.tenderdetail.com/qatar-tenders

export const PORTAL_ID = "tenderdetail";

const LISTING_URL = "https://www.tenderdetail.com/qatar-tenders";

const HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function fetchTenders() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  const res = await fetch(LISTING_URL, {
    headers: HEADERS,
    redirect: "follow",
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) throw new Error(`TenderDetail HTTP ${res.status}`);

  const text = await extractBodyText(res);

  if (text.trim().length < 100) {
    throw new Error("TenderDetail response appears empty or client-side rendered");
  }

  return text;
}

async function extractBodyText(res) {
  let text = "";
  let insideSkip = 0;

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript", {
      element(el) {
        insideSkip++;
        el.onEndTag(() => { insideSkip--; });
      },
    })
    .on("p, h1, h2, h3, h4, li, td, th, a, span, div", {
      text(chunk) {
        if (insideSkip > 0) return;
        const t = chunk.text.trim();
        if (t) text += t + " ";
      },
    });

  await rewriter.transform(res).arrayBuffer();
  return text.replace(/\s{3,}/g, "\n").trim();
}
