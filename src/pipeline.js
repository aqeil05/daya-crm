// ─── Email processing pipeline ────────────────────────────────────────────────
// Orchestrates classification → extraction → HubSpot → Sheets → reply → notify.
// Called once per Graph webhook notification.

import { fetchMessage, sendReply } from "./graph.js";
import { isKnownConversation, markConversation, saveFailed } from "./dedup.js";
import { filterEmail, extractLead, extractSupplier } from "./claude.js";
import { upsertContact, createOrUpdateCompany, associateContactCompany, createDeal, createNote } from "./hubspot.js";
import { appendCrmLog, appendSupplierLog } from "./sheets.js";
import { notifyLead, notifySupplier, notifyError } from "./notify.js";

const REPLY_BODY = `Thank you for your enquiry. We have received your message and a member of our team will be in touch with you shortly.

Best regards,
Daya Interior Design
Tel: +974 4444 0000
www.wearedaya.com`;

export async function pipeline(env, messageId, inboxEmail) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const log = (msg) => console.log(`[${runId}] ${msg}`);
  const logErr = (msg) => console.error(`[${runId}] ${msg}`);

  // Capture context for failure reporting as it becomes available
  let from = "", subject = "", conversationId = "";

  try {
  // ── Step 1: Fetch full message from Graph ─────────────────────────────────
  const msg = await fetchMessage(env, inboxEmail, messageId);
  ({ from, subject, conversationId } = msg);
  const { fromName, bodyText } = msg;

  log(`Processing message from ${from} | subject: "${subject}" | conv: ${conversationId}`);

  // ── Step 2: Skip if this conversationId was already processed ─────────────
  if (conversationId && await isKnownConversation(env.DAYA_KV, conversationId)) {
    log(`Skipping — conversationId already processed: ${conversationId}`);
    return { status: "deduped", conversationId };
  }

  // Mark immediately — before classification — to close the race window where
  // two inboxes receive the same email (e.g. To + CC) and both pass the dedup
  // check before either marks it, causing duplicate replies.
  if (conversationId) await markConversation(env.DAYA_KV, conversationId);

  // ── Step 3: Classify email ────────────────────────────────────────────────
  const classification = await filterEmail(env, from, subject, bodyText);
  log(`Classification: ${classification}`);

  if (classification === "NO") {
    return { status: "skipped", classification };
  }

  // ── Step 5a: LEAD pipeline ────────────────────────────────────────────────
  if (classification === "LEAD") {
    const lead = await extractLead(env, from, fromName, subject, bodyText);
    log(`Lead extracted: ${JSON.stringify(lead)}`);

    // HubSpot
    const contactVid = await upsertContact(env, {
      email: lead.email || from,
      firstName: lead.first_name || "",
      lastName: lead.last_name || "",
      phone: lead.contact_number || "",
      jobTitle: lead.job_title || "",
      lifecycleStage: "lead",
    });

    const companyId = await createOrUpdateCompany(env, {
      companyName: lead.company_name || "",
      email: lead.email || from,
      mainIndustry: lead.main_industry || "",
      subIndustries: lead.sub_industries || [],
      relationship: lead.relationship || "Client",
    });

    if (companyId) {
      await associateContactCompany(env, contactVid, companyId);
    }

    const dealId = await createDeal(env, {
      dealName: lead.company_name || lead.first_name || from,
      contactVid,
      companyId,
      enquiryType: lead.enquiry_type || "",
      sourceInbox: inboxEmail,
    });

    // Sheets
    await appendCrmLog(env.DAYA_KV, env, {
      threadId: conversationId || messageId,
      source: inboxEmail,
      dealName: lead.company_name || lead.first_name || from,
      contactEmail: lead.email || from,
      hubspotDealId: dealId || "",
      executiveSummary: lead.project_description || "",
      enquiryType: lead.enquiry_type || "",
    });

    // Auto-reply
    await sendReply(env, inboxEmail, from, subject, REPLY_BODY);

    // Telegram
    await notifyLead(env, {
      fromName,
      from,
      company: lead.company_name || "",
      sourceInbox: inboxEmail,
      subject,
      dealId,
    });

    return { status: "processed", classification: "LEAD", dealId, contactVid };
  }

  // ── Step 5b: SUPPLIER pipeline ────────────────────────────────────────────
  if (classification === "SUPPLIER") {
    const supplier = await extractSupplier(env, from, fromName, subject, bodyText);
    log(`Supplier extracted: ${JSON.stringify(supplier)}`);

    // HubSpot
    const contactVid = await upsertContact(env, {
      email: supplier.email || from,
      firstName: supplier.first_name || "",
      lastName: supplier.last_name || "",
      phone: supplier.contact_number || "",
      jobTitle: supplier.job_title || "",
      lifecycleStage: "other",
    });

    const companyId = await createOrUpdateCompany(env, {
      companyName: supplier.company_name || "",
      email: supplier.email || from,
      mainIndustry: supplier.main_industry || "",
      subIndustries: supplier.sub_industries || [],
      relationship: supplier.relationship || "Supplier",
    });

    if (companyId) {
      await associateContactCompany(env, contactVid, companyId);
    }

    const noteBody = [
      `Product/Service: ${supplier.product_service || "—"}`,
      `Main Industry: ${supplier.main_industry || "—"}`,
      `Sub Industries: ${(supplier.sub_industries || []).join(", ") || "—"}`,
      `Source Inbox: ${inboxEmail}`,
      `Subject: ${subject}`,
    ].join("\n");

    await createNote(env, contactVid, noteBody);

    // Sheets
    await appendSupplierLog(env.DAYA_KV, env, {
      threadId: conversationId || messageId,
      source: inboxEmail,
      companyName: supplier.company_name || "",
      contactEmail: supplier.email || from,
      mainIndustry: supplier.main_industry || "",
      subIndustries: supplier.sub_industries || [],
      relationship: supplier.relationship || "",
      enquiryType: supplier.enquiry_type || "",
      projectDescription: supplier.product_service || "",
    });

    // Telegram
    await notifySupplier(env, {
      fromName,
      from,
      company: supplier.company_name || "",
      productService: supplier.product_service || "",
      sourceInbox: inboxEmail,
    });

    return { status: "processed", classification: "SUPPLIER", contactVid };
  }

  return { status: "unknown_classification", classification };

  } catch (err) {
    logErr(`Pipeline failed: ${err.stack || err.message}`);

    // Persist failure so it can be retried via /retry
    await saveFailed(env.DAYA_KV, messageId, {
      messageId,
      inboxEmail,
      conversationId,
      from,
      subject,
      error: err.message,
      failedAt: new Date().toISOString(),
    }).catch((kvErr) => logErr(`Failed to save failure record: ${kvErr.message}`));

    // Alert the team via Telegram
    await notifyError(env, { from, subject, error: err.message, messageId })
      .catch((tgErr) => logErr(`Failed to send error notification: ${tgErr.message}`));

    throw err;
  }
}
