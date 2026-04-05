// ─── Google Sheets ────────────────────────────────────────────────────────────
// Appends rows to CRM Log and Supplier Log sheets via Sheets API v4 REST.
// No SDK — uses service account JWT auth from google-auth.js.
//
// CRM Log columns:     threadId | source | dealName | contactEmail | hubspotDealId | executiveSummary | enquiryType | timestamp
// Supplier Log columns: threadId | source | companyName | contactEmail | mainIndustry | subIndustries | relationship | enquiryType | projectDescription | timestamp

import { getGoogleToken } from "./google-auth.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEZONE = "Asia/Qatar";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sheetsAppend(token, sheetId, range, row) {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${text}`);
  }
  return res.json();
}

function today() {
  return new Date().toLocaleString("en-CA", { timeZone: TIMEZONE }).split(",")[0];
}

// ── CRM Log (Lead pipeline) ───────────────────────────────────────────────────
// Columns: threadId | source | dealName | contactEmail | hubspotDealId | executiveSummary | enquiryType | timestamp

export async function appendCrmLog(kv, env, {
  threadId,
  source,
  dealName,
  contactEmail,
  hubspotDealId,
  executiveSummary,
  enquiryType,
}) {
  const token = await getGoogleToken(kv, env);
  const row = [
    threadId || "",
    source || "",
    dealName || "",
    contactEmail || "",
    hubspotDealId || "",
    executiveSummary || "",
    enquiryType || "",
    today(),
  ];
  await sheetsAppend(token, env.SHEETS_CRM_LOG_ID, "Leads Log!A:H", row);
}

// ── Supplier Log ──────────────────────────────────────────────────────────────
// Columns: threadId | source | companyName | contactEmail | mainIndustry | subIndustries | relationship | enquiryType | projectDescription | timestamp

export async function appendSupplierLog(kv, env, {
  threadId,
  source,
  companyName,
  contactEmail,
  mainIndustry,
  subIndustries,
  relationship,
  enquiryType,
  projectDescription,
}) {
  const token = await getGoogleToken(kv, env);
  const row = [
    threadId || "",
    source || "",
    companyName || "",
    contactEmail || "",
    mainIndustry || "",
    Array.isArray(subIndustries) ? subIndustries.join("; ") : (subIndustries || ""),
    relationship || "",
    enquiryType || "",
    projectDescription || "",
    today(),
  ];
  await sheetsAppend(token, env.SHEETS_SUPPLIER_LOG_ID, "Supplier Log!A:J", row);
}
