// ─── HubSpot CRM API v3 ───────────────────────────────────────────────────────
// All requests use the Private App token (not OAuth2).
// Key quirks:
//   - Contact upsert returns vid (not id)
//   - Create Company returns companyId (not id)
//   - Company search uses CONTAINS_TOKEN (not EQ)
//   - Association type must be numeric 1 (not a string label)
//   - Dropdown/multi-select fields must never be null — use "" or []
//   - URL must be api.hubapi.com (without api. prefix returns HTML)

import { notifyAdminEnum } from "./notify.js";

const HS_BASE = "https://api.hubapi.com";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function hsRequest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${method} ${url} → ${res.status}: ${text}`);
  }

  // 204 No Content on some endpoints (e.g. associations)
  if (res.status === 204) return null;
  return res.json();
}

// ── Contact upsert ────────────────────────────────────────────────────────────
// Returns vid (HubSpot contact ID)

export async function upsertContact(env, { email, firstName, lastName, phone, jobTitle, lifecycleStage }) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const properties = {
    email: email || "",
    firstname: firstName || "",
    lastname: lastName || "",
    phone: phone || "",
    jobtitle: jobTitle || "",
    lifecyclestage: lifecycleStage || "lead",
  };

  // Upsert by email — POST to contacts/v1 (supports upsert via email)
  const res = await fetch(`${HS_BASE}/contacts/v1/contact/createOrUpdate/email/${encodeURIComponent(email)}/`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      properties: Object.entries(properties).map(([property, value]) => ({ property, value })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upsertContact failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.vid; // vid, not id
}

// ── Company name normalization ────────────────────────────────────────────────
// Strips common suffixes so "Acme Inc" and "Acme" match the same company.
// Used only for the search term — the stored name keeps its original form.

function normalizeForSearch(name) {
  if (!name) return name;
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s,]+\b(inc\.?|ltd\.?|llc\.?|co\.?|corp\.?|limited|company|group)$/i, "")
    .trim();
}

// ── Company search ────────────────────────────────────────────────────────────
// Returns company ID string or null

export async function searchCompany(env, companyName) {
  if (!companyName) return null;

  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const data = await hsRequest("POST", `${HS_BASE}/crm/v3/objects/companies/search`, token, {
    filterGroups: [{
      filters: [{
        propertyName: "name",
        operator: "CONTAINS_TOKEN",
        value: normalizeForSearch(companyName),
      }],
    }],
    properties: ["name"],
    limit: 1,
  });

  if (data?.total > 0) {
    return data.results[0].id;
  }
  return null;
}

// ── Enum validation helpers ───────────────────────────────────────────────────

// Fetch live picklist options for a company property.
// Returns [{label, value}] — the source of truth from HubSpot.
async function fetchPropertyOptions(token, propertyName) {
  const data = await hsRequest(
    "GET",
    `${HS_BASE}/crm/v3/properties/companies/${encodeURIComponent(propertyName)}`,
    token,
  );
  return (data?.options || []).filter(o => !o.hidden).map(o => ({ label: o.label, value: o.value }));
}

// Jaccard similarity on word tokens (no deps, runs in Workers).
// Splits on whitespace, hyphens, ampersands, commas so that
// "Flooring - Stone Marble & Tiles" and "Flooring - Stone, Marble & Tiles"
// both tokenise to {flooring, stone, marble, tiles} → score 1.0.
function stringSimilarity(a, b) {
  const tokenise = s => new Set(s.toLowerCase().split(/[\s\-&,]+/).filter(Boolean));
  const ta = tokenise(a);
  const tb = tokenise(b);
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Returns the closest option object if score >= threshold, else null.
function findClosestOption(value, options, threshold = 0.6) {
  let best = null;
  let bestScore = 0;
  for (const opt of options) {
    const score = stringSimilarity(value, opt.label);
    if (score > bestScore) { bestScore = score; best = opt; }
  }
  return bestScore >= threshold ? best : null;
}

// Adds a new option to a HubSpot company picklist property.
// Fetches current options first so the PATCH is non-destructive.
// Returns the new option's value string on success.
async function addPropertyOption(token, propertyName, newLabel) {
  const existing = await fetchPropertyOptions(token, propertyName);
  const newOption = { label: newLabel, value: newLabel, displayOrder: -1, hidden: false };
  await hsRequest("PATCH", `${HS_BASE}/crm/v3/properties/companies/${encodeURIComponent(propertyName)}`, token, {
    options: [...existing.map(o => ({ ...o, displayOrder: o.displayOrder ?? -1, hidden: false })), newOption],
  });
  return newLabel;
}

// For each INVALID_OPTION error in validationResults, resolve the rejected value
// by fuzzy-matching against live HubSpot options, auto-adding if needed, or
// nullifying and alerting admin as a last resort.
// Returns corrected { mainIndustry, subIndustries }.
async function resolveInvalidEnumFields(env, { mainIndustry, subIndustries }, validationResults) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  let resolvedMain = mainIndustry;
  let resolvedSubs = [...(subIndustries || [])];

  for (const result of validationResults) {
    if (result.error !== "INVALID_OPTION") continue;

    const propName = result.name; // e.g. "sub_industry" or "main_industry"
    // Extract the rejected value from the message: "{value} was not one of the allowed options..."
    const rejectedValue = (result.message || "").replace(/ was not one of the allowed options.*$/i, "").trim();
    if (!rejectedValue) continue;

    let options;
    try {
      options = await fetchPropertyOptions(token, propName);
    } catch {
      // Can't fetch options — alert admin and blank the field
      await notifyAdminEnum(env, { action: "needs_admin", propertyName: propName, rejectedValue }).catch(() => {});
      if (propName === "main_industry") resolvedMain = "";
      else resolvedSubs = resolvedSubs.filter(v => v !== rejectedValue);
      continue;
    }

    const match = findClosestOption(rejectedValue, options);

    if (match) {
      // Close enough — substitute silently with a warning
      await notifyAdminEnum(env, { action: "matched", propertyName: propName, rejectedValue, resolvedValue: match.value }).catch(() => {});
      if (propName === "main_industry") resolvedMain = match.value;
      else resolvedSubs = resolvedSubs.map(v => v === rejectedValue ? match.value : v);
    } else {
      // No match — try to create the new option
      try {
        await addPropertyOption(token, propName, rejectedValue);
        await notifyAdminEnum(env, { action: "added", propertyName: propName, rejectedValue }).catch(() => {});
        // Value stays as-is — it's now valid in HubSpot
      } catch {
        // Can't add — blank the field and alert admin to do it manually
        await notifyAdminEnum(env, { action: "needs_admin", propertyName: propName, rejectedValue }).catch(() => {});
        if (propName === "main_industry") resolvedMain = "";
        else resolvedSubs = resolvedSubs.filter(v => v !== rejectedValue);
      }
    }
  }

  return { mainIndustry: resolvedMain, subIndustries: resolvedSubs };
}

// ── Create company ────────────────────────────────────────────────────────────
// Returns company ID string

export async function createCompany(env, { companyName, domain, mainIndustry, subIndustries, relationship }) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const buildProps = (mi, si) => [
    { name: "name", value: companyName || "" },
    { name: "domain", value: domain || "" },
    { name: "main_industry", value: mi || "" },
    { name: "sub_industry", value: (si || []).join(";") },
    { name: "relationship", value: relationship || "" },
  ];

  let res = await fetch(`${HS_BASE}/companies/v2/companies/`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ properties: buildProps(mainIndustry, subIndustries) }),
  });

  // On INVALID_OPTION errors, resolve each bad value and retry once
  if (res.status === 400) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* not JSON — fall through */ }

    const hasInvalidOption = parsed?.validationResults?.some(r => r.error === "INVALID_OPTION");
    if (hasInvalidOption) {
      const { mainIndustry: mi, subIndustries: si } = await resolveInvalidEnumFields(
        env, { mainIndustry, subIndustries }, parsed.validationResults,
      );
      res = await fetch(`${HS_BASE}/companies/v2/companies/`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ properties: buildProps(mi, si) }),
      });
      if (!res.ok) {
        const retryText = await res.text();
        throw new Error(`createCompany failed: ${res.status} ${retryText}`);
      }
    } else {
      throw new Error(`createCompany failed: 400 ${text}`);
    }
  } else if (!res.ok) {
    const text = await res.text();
    throw new Error(`createCompany failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.companyId?.toString() || data.properties?.hs_object_id?.value || null;
}

// ── Update company ────────────────────────────────────────────────────────────

export async function updateCompany(env, companyId, { domain, mainIndustry, subIndustries, relationship }) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const buildProps = (mi, si) => [
    { name: "domain", value: domain || "" },
    { name: "main_industry", value: mi || "" },
    { name: "sub_industry", value: (si || []).join(";") },
    { name: "relationship", value: relationship || "" },
  ];

  const url = `${HS_BASE}/companies/v2/companies/${companyId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({ properties: buildProps(mainIndustry, subIndustries) }),
  });

  if (res.status === 400) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    const hasInvalidOption = parsed?.validationResults?.some(r => r.error === "INVALID_OPTION");
    if (hasInvalidOption) {
      const { mainIndustry: mi, subIndustries: si } = await resolveInvalidEnumFields(
        env, { mainIndustry, subIndustries }, parsed.validationResults,
      );
      const retry = await fetch(url, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ properties: buildProps(mi, si) }),
      });
      if (!retry.ok) {
        const retryText = await retry.text();
        throw new Error(`HubSpot PUT ${url} → ${retry.status}: ${retryText}`);
      }
    } else {
      throw new Error(`HubSpot PUT ${url} → 400: ${text}`);
    }
  } else if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot PUT ${url} → ${res.status}: ${text}`);
  }
}

// ── Create or update company (orchestrator) ───────────────────────────────────
// Returns company ID

export async function createOrUpdateCompany(env, { companyName, email, mainIndustry, subIndustries, relationship }) {
  const domain = email?.split("@")[1] || "";

  const existingId = await searchCompany(env, companyName);
  if (existingId) {
    await updateCompany(env, existingId, { domain, mainIndustry, subIndustries, relationship });
    return existingId;
  }

  return createCompany(env, { companyName, domain, mainIndustry, subIndustries, relationship });
}

// ── Associate contact with company ────────────────────────────────────────────

export async function associateContactCompany(env, contactVid, companyId) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  // Association type 1 = contact → company (numeric, not string)
  await hsRequest(
    "PUT",
    `${HS_BASE}/crm/v3/objects/contacts/${contactVid}/associations/companies/${companyId}/1`,
    token,
  );
}

// ── Create deal ───────────────────────────────────────────────────────────────
// Returns deal ID

export async function createDeal(env, { dealName, contactVid, companyId, enquiryType, sourceInbox }) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const res = await fetch(`${HS_BASE}/deals/v1/deal`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      associations: {
        associatedVids: [contactVid],
        associatedCompanyIds: companyId ? [parseInt(companyId)] : [],
      },
      properties: [
        { name: "dealname", value: dealName || "" },
        { name: "pipeline", value: env.HUBSPOT_PIPELINE_ID || "default" },
        { name: "dealstage", value: env.HUBSPOT_STAGE_ID || "" },
        { name: "type_of_enquiry", value: enquiryType || "" },
        { name: "deal_source_inbox", value: sourceInbox || "" },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createDeal failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.dealId?.toString() || null;
}

// ── Get pipeline stages (dynamic, bot uses this for stage name→ID resolution) ─
// Returns [{ id, label, displayOrder }] sorted by displayOrder.
// Caller is responsible for caching (see dedup.js getCachedStages/setCachedStages).

export async function getPipelineStages(env) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const data = await hsRequest(
    "GET",
    `${HS_BASE}/crm/v3/pipelines/deals/${encodeURIComponent(env.HUBSPOT_PIPELINE_ID)}/stages`,
    token,
  );
  return (data?.results || [])
    .map(({ id, label, displayOrder }) => ({ id, label, displayOrder }))
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

// ── Find deals by company name ────────────────────────────────────────────────
// Two-step: search company by name → search deals by company association.
// Returns [{ id, dealname, dealstage }]

export async function findDealsByCompanyName(env, companyName) {
  const companyId = await searchCompany(env, companyName);
  if (!companyId) return [];

  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const data = await hsRequest("POST", `${HS_BASE}/crm/v3/objects/deals/search`, token, {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline",             operator: "EQ", value: env.HUBSPOT_PIPELINE_ID },
        { propertyName: "associations.company", operator: "EQ", value: companyId },
      ],
    }],
    properties: ["dealname", "dealstage", "hs_last_activity_date", "hs_lastmodifieddate"],
    limit: 10,
  });

  return (data?.results || []).map((d) => ({
    id: d.id,
    dealname:     d.properties?.dealname     || "",
    dealstage:    d.properties?.dealstage    || "",
    lastActivity: d.properties?.hs_last_activity_date || d.properties?.hs_lastmodifieddate || null,
  }));
}

// ── List open deals ────────────────────────────────────────────────────────────
// Returns all non-closed deals in the configured pipeline.
// Returns [{ id, dealname, dealstage }]

export async function listOpenDeals(env) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const data = await hsRequest("POST", `${HS_BASE}/crm/v3/objects/deals/search`, token, {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline",    operator: "EQ", value: env.HUBSPOT_PIPELINE_ID },
        { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
      ],
    }],
    properties: ["dealname", "dealstage", "hs_last_activity_date", "hs_lastmodifieddate"],
    limit: 100,
  });

  return (data?.results || []).map((d) => ({
    id: d.id,
    dealname:     d.properties?.dealname     || "",
    dealstage:    d.properties?.dealstage    || "",
    lastActivity: d.properties?.hs_last_activity_date || d.properties?.hs_lastmodifieddate || null,
  }));
}

// ── Update deal stage ─────────────────────────────────────────────────────────

export async function updateDealStage(env, dealId, stageId) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  return hsRequest("PATCH", `${HS_BASE}/crm/v3/objects/deals/${dealId}`, token, {
    properties: { dealstage: stageId },
  });
}

// ── Get deal's primary contact ────────────────────────────────────────────────
// Returns { name, email } or null.

export async function getDealContact(env, dealId) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const assocData = await hsRequest(
    "GET",
    `${HS_BASE}/crm/v3/objects/deals/${dealId}/associations/contacts`,
    token,
  );
  const contactId = assocData?.results?.[0]?.id;
  if (!contactId) return null;

  const contact = await hsRequest(
    "GET",
    `${HS_BASE}/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email`,
    token,
  );

  const p = contact?.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || null;
  return { name, email: p.email || null };
}

// ── Get closed deals in a date range ─────────────────────────────────────────
// Returns [{ id, dealname, dealstage, createdate, closedate }]

export async function getClosedDealsInPeriod(env, startIso, endIso) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const data = await hsRequest("POST", `${HS_BASE}/crm/v3/objects/deals/search`, token, {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline",  operator: "EQ",           value: env.HUBSPOT_PIPELINE_ID },
        { propertyName: "closedate", operator: "GTE",          value: startIso },
        { propertyName: "closedate", operator: "LTE",          value: endIso },
        { propertyName: "hs_is_closed", operator: "EQ",        value: "true" },
      ],
    }],
    properties: ["dealname", "dealstage", "createdate", "closedate"],
    limit: 200,
  });

  return (data?.results || []).map((d) => ({
    id: d.id,
    dealname:   d.properties?.dealname   || "",
    dealstage:  d.properties?.dealstage  || "",
    createdate: d.properties?.createdate || null,
    closedate:  d.properties?.closedate  || null,
  }));
}

// ── Get deals that reached a specific stage and then closed ───────────────────
// Uses HubSpot's automatic hs_date_entered_{stageId} property.
// Returns [{ id, dealstage }]

export async function getPresentedConversions(env, presentedStageId, startIso, endIso) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  const enteredProp = `hs_date_entered_${presentedStageId}`;

  const data = await hsRequest("POST", `${HS_BASE}/crm/v3/objects/deals/search`, token, {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline",    operator: "EQ",    value: env.HUBSPOT_PIPELINE_ID },
        { propertyName: enteredProp,   operator: "HAS_PROPERTY" },
        { propertyName: "closedate",   operator: "GTE",   value: startIso },
        { propertyName: "closedate",   operator: "LTE",   value: endIso },
        { propertyName: "hs_is_closed", operator: "EQ",  value: "true" },
      ],
    }],
    properties: ["dealstage"],
    limit: 200,
  });

  return (data?.results || []).map((d) => ({
    id: d.id,
    dealstage: d.properties?.dealstage || "",
  }));
}

// ── Create note (for supplier) ────────────────────────────────────────────────

export async function createNote(env, contactVid, noteBody) {
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;

  const engagement = await hsRequest("POST", `${HS_BASE}/engagements/v1/engagements`, token, {
    engagement: {
      active: true,
      type: "NOTE",
      timestamp: Date.now(),
    },
    associations: {
      contactIds: [contactVid],
    },
    metadata: {
      body: noteBody,
    },
  });

  return engagement?.engagementId || null;
}
