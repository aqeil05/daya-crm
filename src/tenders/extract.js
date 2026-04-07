// ─── Claude-based Tender Extractor ────────────────────────────────────────────
// Sends raw scraped page text to Claude Haiku and returns a structured array
// of tender objects. Designed to be portal-agnostic — Claude handles Arabic
// content, varied HTML layouts, and unknown structure.

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a tender data extractor for Daya Interior Design, a Qatar-based fit-out and interior design company.

You will receive raw text scraped from a Qatar government or commercial tender portal. Extract ALL tender listings visible in the text.

Return ONLY a JSON array. Each element must have exactly this structure:
{
  "id": "reference number or unique code shown on the portal, or empty string if none visible",
  "title": "full tender title in English (translate from Arabic if needed)",
  "description": "brief description of the scope of work, or empty string if not available",
  "deadline": "closing or submission deadline in YYYY-MM-DD format, or empty string if not found",
  "issuer": "name of the issuing authority, ministry, or organisation in English",
  "country": "country where the tender is based, in English (e.g. Qatar, UAE, Saudi Arabia)",
  "url": "direct URL link to this specific tender if visible in the text, or empty string",
  "value": "estimated contract value or budget if stated, or empty string"
}

Rules:
- If no tenders are found in the text, return an empty array: []
- Translate Arabic titles and issuer names to English
- Do NOT invent or guess data — use empty string for any missing field
- For portals "biddetail" and "monaqasat": all tenders are Qatar-based — always set country to "Qatar" unless a different country is explicitly stated in the tender text
- For portal "biddetail": if id is a numeric string and url is empty, set url to "https://www.biddetail.com/latest-tenders/{id}" (substitute the actual id)
- Return ONLY the JSON array with no markdown fences, no explanation, no preamble`;

export async function extractTenders(env, portalId, rawText) {
  if (!rawText || rawText.trim().length < 50) {
    console.warn(`extractTenders(${portalId}): raw text too short, skipping Claude call`);
    return [];
  }

  const userContent = `Portal: ${portalId}\n\nScraped page text:\n${rawText.slice(0, 6000)}`;

  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude tender extraction failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  let raw = data.content[0].text.trim();

  // Strip markdown fences if Claude wraps the response anyway
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let tenders;
  try {
    tenders = JSON.parse(raw);
  } catch (err) {
    console.error(`extractTenders(${portalId}): JSON parse failed — ${err.message}\nRaw: ${raw.slice(0, 300)}`);
    return [];
  }

  if (!Array.isArray(tenders)) {
    console.error(`extractTenders(${portalId}): Claude returned non-array`);
    return [];
  }

  return tenders;
}
