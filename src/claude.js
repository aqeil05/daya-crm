// ─── Claude AI ────────────────────────────────────────────────────────────────
// Uses claude-haiku-4-5 for all classification and extraction.
// filterEmail  → "LEAD" | "SUPPLIER" | "NO"
// extractLead  → structured JSON for lead pipeline
// extractSupplier → structured JSON for supplier pipeline

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// Valid values mirrored from HubSpot custom properties
const VALID_ENQUIRY_TYPES = ["Fit Out", "Supply & Install", "Project Management", "Carpentry"];

const VALID_MAIN_INDUSTRIES = [
  "Furniture & Joinery", "Finishes", "Window & Glass", "Ceiling & Partitions",
  "MEP", "ELV & Technology", "Landscaping", "Construction Materials",
  "Logistics", "Structural",
];

const VALID_SUB_INDUSTRIES = [
  "Office Workstations", "Custom Joinery & Millwork", "Loose Furniture & Seating",
  "Flooring - Carpet & Vinyl", "Flooring - Stone Marble & Tiles", "Wall & Ceiling Paints",
  "Signage & Wayfinding", "Roller Blinds & Window Coverings", "Glass Partitions & Doors",
  "Smart Glass & Switchable Film", "Window Film & Graphics", "Gypsum / Drywall Systems",
  "Metal Sheet Ceilings", "Acoustic Panels & Stretch Ceilings", "Fire-Rated Doors & Frames",
  "Electrical Works & Final Fix", "Electrical Materials Supply", "HVAC & Mechanical",
  "Plumbing & Sanitary Fittings", "Coring & Specialist Civil", "CCTV & Surveillance",
  "Access Control & Smart Locks", "IT & ELV Infrastructure", "AV & Meeting Room Systems",
  "Indoor Plants & Planting", "GRP Planters & Lining", "Waterproofing & Chemical Treatments",
  "Galvanizing & Metal Finishing", "Steel Supply & Fabrication", "Masonry & Building Materials",
  "Freight & Warehousing", "Shipping & Freight Forwarding", "Structural Engineering",
];

const VALID_RELATIONSHIPS = [
  "Client", "Supplier", "Contractor", "Consultant", "Supervising consultant", "Vendor",
];

// ── Low-level call ────────────────────────────────────────────────────────────

async function claudeCall(apiKey, systemPrompt, userContent, maxTokens) {
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.content[0].text.trim();
}

// ── Email classification ──────────────────────────────────────────────────────

const FILTER_SYSTEM = `You are an email classifier for Daya Interior Design, a company in Doha, Qatar specialising in office fit-outs, interior design, supply & install, project management, and carpentry/joinery.

Classify the incoming email as exactly one of: LEAD, SUPPLIER, or NO

Rules:
- LEAD: The sender wants to hire Daya or enquire about Daya's services (fit-out, design, project management, carpentry, supply & install). Could be a new client or a consultant/developer requesting a quote.
- SUPPLIER: The sender is a vendor, manufacturer, or supplier pitching products or services TO Daya (materials, furniture, MEP, flooring, etc.).
- NO: Spam, newsletters, job applications, irrelevant marketing, automated notifications, or anything that is neither a potential client nor a supplier pitch.

If the email is FROM a @wearedaya.com address, it means a Daya staff member is forwarding or CCing this inbox on something. Classify as LEAD only if the content clearly indicates a new client enquiry or opportunity. If it looks like internal project admin, meeting notes, or ongoing work — classify as NO.

Respond with ONLY the single word: LEAD, SUPPLIER, or NO. No explanation.`;

export async function filterEmail(env, from, subject, bodyText) {
  const userContent = `FROM: ${from}
SUBJECT: ${subject}
BODY:
${bodyText.slice(0, 2000)}`;

  return claudeCall(env.ANTHROPIC_API_KEY, FILTER_SYSTEM, userContent, 10);
}

// ── Lead extraction ───────────────────────────────────────────────────────────

const LEAD_SYSTEM = `You are a data extractor for Daya Interior Design CRM. Extract structured information from the lead email and return ONLY valid JSON with no markdown fences, no extra text.

Return this exact JSON structure:
{
  "first_name": "string or empty string",
  "last_name": "string or empty string",
  "email": "email address",
  "company_name": "company name or empty string",
  "contact_number": "phone number or empty string",
  "job_title": "job title or empty string",
  "project_description": "1–3 sentence summary of what they need",
  "office_location": "city or area mentioned or empty string",
  "enquiry_type": "one of: Fit Out, Supply & Install, Project Management, Carpentry — or empty string",
  "main_industry": "one of: Furniture & Joinery, Finishes, Window & Glass, Ceiling & Partitions, MEP, ELV & Technology, Landscaping, Construction Materials, Logistics, Structural — or empty string (leave empty for client leads unless obvious)",
  "sub_industries": [],
  "relationship": "one of: Client, Contractor, Consultant, Supervising consultant — choose the most likely based on context"
}

Rules:
- enquiry_type must be one of the listed values or empty string — do not invent values
- main_industry and sub_industries are usually empty for client leads (they apply to suppliers) — only fill if clearly stated
- sub_industries must be an array of values from this list only: Office Workstations, Custom Joinery & Millwork, Loose Furniture & Seating, Flooring - Carpet & Vinyl, Flooring - Stone Marble & Tiles, Wall & Ceiling Paints, Signage & Wayfinding, Roller Blinds & Window Coverings, Glass Partitions & Doors, Smart Glass & Switchable Film, Window Film & Graphics, Gypsum / Drywall Systems, Metal Sheet Ceilings, Acoustic Panels & Stretch Ceilings, Fire-Rated Doors & Frames, Electrical Works & Final Fix, Electrical Materials Supply, HVAC & Mechanical, Plumbing & Sanitary Fittings, Coring & Specialist Civil, CCTV & Surveillance, Access Control & Smart Locks, IT & ELV Infrastructure, AV & Meeting Room Systems, Indoor Plants & Planting, GRP Planters & Lining, Waterproofing & Chemical Treatments, Galvanizing & Metal Finishing, Steel Supply & Fabrication, Masonry & Building Materials, Freight & Warehousing, Shipping & Freight Forwarding, Structural Engineering
- Return empty array [] for sub_industries if unsure
- Never return null — use empty string or empty array`;

export async function extractLead(env, from, fromName, subject, bodyText) {
  const userContent = `FROM: ${fromName} <${from}>
SUBJECT: ${subject}
BODY:
${bodyText.slice(0, 3000)}`;

  const raw = await claudeCall(env.ANTHROPIC_API_KEY, LEAD_SYSTEM, userContent, 500);

  // Strip markdown fences if Claude wraps the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`extractLead JSON parse failed: ${err.message}\nRaw: ${raw}`);
  }

  // Validate / sanitise enum fields so HubSpot never receives bad values
  if (!VALID_ENQUIRY_TYPES.includes(parsed.enquiry_type)) parsed.enquiry_type = "";
  if (!VALID_MAIN_INDUSTRIES.includes(parsed.main_industry)) parsed.main_industry = "";
  if (!VALID_RELATIONSHIPS.includes(parsed.relationship)) parsed.relationship = "Client";
  parsed.sub_industries = (parsed.sub_industries || []).filter(v => VALID_SUB_INDUSTRIES.includes(v));

  return parsed;
}

// ── Supplier extraction ───────────────────────────────────────────────────────

const SUPPLIER_SYSTEM = `You are a data extractor for Daya Interior Design CRM. Extract structured information from the supplier email and return ONLY valid JSON with no markdown fences, no extra text.

Return this exact JSON structure:
{
  "contact_name": "full name or empty string",
  "first_name": "string or empty string",
  "last_name": "string or empty string",
  "email": "email address",
  "company_name": "supplier company name or empty string",
  "contact_number": "phone number or empty string",
  "job_title": "job title or empty string",
  "product_service": "1–2 sentence description of what they supply or offer",
  "enquiry_type": "one of: Fit Out, Supply & Install, Project Management, Carpentry — or empty string",
  "main_industry": "one of: Furniture & Joinery, Finishes, Window & Glass, Ceiling & Partitions, MEP, ELV & Technology, Landscaping, Construction Materials, Logistics, Structural — or empty string",
  "sub_industries": [],
  "relationship": "one of: Supplier, Contractor, Vendor — choose the most likely"
}

Rules:
- main_industry must be one of the listed values or empty string
- sub_industries must be an array using only values from: Office Workstations, Custom Joinery & Millwork, Loose Furniture & Seating, Flooring - Carpet & Vinyl, Flooring - Stone Marble & Tiles, Wall & Ceiling Paints, Signage & Wayfinding, Roller Blinds & Window Coverings, Glass Partitions & Doors, Smart Glass & Switchable Film, Window Film & Graphics, Gypsum / Drywall Systems, Metal Sheet Ceilings, Acoustic Panels & Stretch Ceilings, Fire-Rated Doors & Frames, Electrical Works & Final Fix, Electrical Materials Supply, HVAC & Mechanical, Plumbing & Sanitary Fittings, Coring & Specialist Civil, CCTV & Surveillance, Access Control & Smart Locks, IT & ELV Infrastructure, AV & Meeting Room Systems, Indoor Plants & Planting, GRP Planters & Lining, Waterproofing & Chemical Treatments, Galvanizing & Metal Finishing, Steel Supply & Fabrication, Masonry & Building Materials, Freight & Warehousing, Shipping & Freight Forwarding, Structural Engineering
- Never return null — use empty string or empty array`;

export async function extractSupplier(env, from, fromName, subject, bodyText) {
  const userContent = `FROM: ${fromName} <${from}>
SUBJECT: ${subject}
BODY:
${bodyText.slice(0, 3000)}`;

  const raw = await claudeCall(env.ANTHROPIC_API_KEY, SUPPLIER_SYSTEM, userContent, 500);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`extractSupplier JSON parse failed: ${err.message}\nRaw: ${raw}`);
  }

  if (!VALID_ENQUIRY_TYPES.includes(parsed.enquiry_type)) parsed.enquiry_type = "";
  if (!VALID_MAIN_INDUSTRIES.includes(parsed.main_industry)) parsed.main_industry = "";
  if (!VALID_RELATIONSHIPS.includes(parsed.relationship)) parsed.relationship = "Supplier";
  parsed.sub_industries = (parsed.sub_industries || []).filter(v => VALID_SUB_INDUSTRIES.includes(v));

  return parsed;
}
