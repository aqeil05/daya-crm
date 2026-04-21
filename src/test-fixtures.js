// ─── Stress test email fixtures ───────────────────────────────────────────────
// Ten realistic email scenarios covering the key failure modes and edge cases.
// Used by POST /test/pipeline to exercise the pipeline without a real Graph
// message ID.
//
// Shape:
//   id          — stable slug used as part of the synthetic conversationId
//   description — what the scenario is testing
//   from        — sender email address
//   fromName    — sender display name
//   subject     — email subject line
//   body        — raw email body (plain text, may include reply-chain markers)
//   inboxEmail  — which monitored inbox received this email
//   expectedClassification — "LEAD" | "SUPPLIER" | "NO"

export const FIXTURES = {

  // ── 1. Baseline English LEAD ────────────────────────────────────────────────
  "english-lead": {
    id: "english-lead",
    description: "Clean English LEAD — baseline classification and full lead extraction",
    from: "james.thornton@qatardev.com",
    fromName: "James Thornton",
    subject: "Enquiry – Office Fit-Out for New HQ",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "LEAD",
    body: `Hi,

My name is James Thornton and I am the Facilities Manager at Qatar Development Holdings. We are relocating our headquarters to a new 1,200 sqm space in West Bay and are looking for a specialist fit-out contractor to manage the full interior works.

The project scope includes partitioning, flooring, joinery, MEP coordination, and furniture supply. We would like to receive your company profile and a proposal for the works. Our target move-in date is September 2026.

Please get in touch at your earliest convenience.

Best regards,
James Thornton | Facilities Manager | Qatar Development Holdings
+974 5511 4422 | james.thornton@qatardev.com`,
  },

  // ── 2. Pure Arabic LEAD ─────────────────────────────────────────────────────
  "arabic-lead": {
    id: "arabic-lead",
    description: "Pure Arabic LEAD — tests high token density (3–5× English); approxInputTokens shows real budget cost",
    from: "m.alsaeed@alfardan.qa",
    fromName: "محمد السعيد",
    subject: "استفسار عن تصميم وتجهيز مكاتب",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "LEAD",
    body: `السادة دايا للتصميم الداخلي،
تحية طيبة وبعد،

نحن شركة الفردان للتطوير العقاري، ونعمل حالياً على تطوير مشروع مكاتب تجارية جديدة في منطقة اللؤلؤة بالدوحة. تبلغ مساحة المشروع الإجمالية ألفي متر مربع تقريباً، وتشمل مناطق العمل المفتوحة، وغرف الاجتماعات، واستقبال الضيوف، وغرف المديرين التنفيذيين.

نرغب في التواصل معكم للحصول على عرض سعر شامل لأعمال التصميم الداخلي والتجهيز الكامل، بما في ذلك: أعمال الجبس والتقسيمات، والأرضيات، والأثاث المكتبي، والإضاءة، والتكييف، وأعمال النجارة والديكور.

يُرجى التواصل معنا في أقرب وقت ممكن لترتيب موعد للاجتماع وزيارة الموقع.

مع تحياتي،
محمد السعيد | مدير المشاريع | شركة الفردان للتطوير العقاري
+974 5522 4411 | m.alsaeed@alfardan.qa`,
  },

  // ── 3. English Outlook reply chain ──────────────────────────────────────────
  "english-reply-chain": {
    id: "english-reply-chain",
    description: "Long Outlook reply chain in English — tests stripQuotedReplies(); strippedBodyLength should be ~80 chars vs ~1000 original",
    from: "sarah.mills@cbre.com",
    fromName: "Sarah Mills",
    subject: "RE: RE: RE: Daya Proposal – Media City Office",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "LEAD",
    body: `Hi team,

Please confirm receipt and share the updated BOQ when ready.

Thanks,
Sarah

________________________________________
From: Peter Kimani <peterkimani@wearedaya.com>
Sent: Thursday, April 10, 2026 2:15 PM
To: Sarah Mills <sarah.mills@cbre.com>
Subject: RE: RE: Daya Proposal – Media City Office

Hi Sarah,

Thank you for your feedback on the proposal. We are revising the BOQ to reflect the updated partition layout and will send it across by end of week.

Best,
Peter

________________________________________
From: Sarah Mills <sarah.mills@cbre.com>
Sent: Wednesday, April 9, 2026 10:40 AM
To: Peter Kimani <peterkimani@wearedaya.com>
Subject: RE: Daya Proposal – Media City Office

Peter,

We reviewed the proposal internally and have a few comments. The partition layout on floors 3 and 4 needs to be revisited — the open-plan zone is too small per the client's brief. Could you also provide a breakdown of the flooring costs separately?

Regards,
Sarah Mills | Project Manager | CBRE Qatar

________________________________________
From: Peter Kimani <peterkimani@wearedaya.com>
Sent: Tuesday, April 8, 2026 9:00 AM
To: Sarah Mills <sarah.mills@cbre.com>
Subject: Daya Proposal – Media City Office

Dear Sarah,

Please find attached our proposal for the Media City Office fit-out project. The scope covers 1,800 sqm across floors 3 and 4, including full MEP coordination.

Best regards,
Peter Kimani | Daya Interior Design`,
  },

  // ── 4. Arabic Outlook reply chain ───────────────────────────────────────────
  "arabic-reply-chain": {
    id: "arabic-reply-chain",
    description: "Arabic reply chain — tests both issues combined: high token density AND quote stripping",
    from: "k.almohannadi@qatargas.com.qa",
    fromName: "خالد المهندي",
    subject: "رد: رد: رد: عرض أسعار – مشروع مبنى الإدارة",
    inboxEmail: "procurement@wearedaya.com",
    expectedClassification: "LEAD",
    body: `السادة دايا،
نأمل منكم تأكيد الاستلام وإرسال جدول الكميات المحدّث في أقرب وقت.
تحياتي، خالد

________________________________________
من: بيتر كيماني <peterkimani@wearedaya.com>
تاريخ الإرسال: الخميس، ١٠ أبريل ٢٠٢٦
إلى: خالد المهندي

خالد، شكراً لملاحظاتك على العرض. نحن نعمل على مراجعة جدول الكميات وسيتم إرساله بنهاية الأسبوع. مع تحياتي، بيتر

________________________________________
من: خالد المهندي <k.almohannadi@qatargas.com.qa>
تاريخ الإرسال: الأربعاء، ٩ أبريل ٢٠٢٦
إلى: بيتر كيماني <peterkimani@wearedaya.com>

بيتر، راجعنا العرض وتوجد ملاحظات على تصميم التقسيمات في الطابق الثاني والثالث. كما نطلب تفاصيل منفصلة لأعمال الأرضيات والأسقف المستعارة.
تحياتي، خالد المهندي | مدير المشتريات | قطر غاز

________________________________________
من: بيتر كيماني <peterkimani@wearedaya.com>
تاريخ الإرسال: الثلاثاء، ٨ أبريل ٢٠٢٦

خالد، يسعدنا تقديم عرض أسعار شامل لمشروع تجهيز مبنى الإدارة. يشمل النطاق أعمال التصميم الداخلي الكامل لمساحة ألفين وخمسمئة متر مربع. مع تحياتي، بيتر كيماني | دايا للتصميم الداخلي`,
  },

  // ── 5. UNITECH invoice — the actual production failure ───────────────────────
  "unitech-invoice": {
    id: "unitech-invoice",
    description: "Invoice email with line-item table — the exact scenario that triggered the original 429 failure",
    from: "accounts@unitechqatar.com",
    fromName: "UNITECH Accounts",
    subject: "Invoice INV-2026-0412 – Supply of Office Furniture",
    inboxEmail: "procurement@wearedaya.com",
    expectedClassification: "SUPPLIER",
    body: `Dear Procurement Team,

Please find below our invoice details for the supply of office furniture to the Al Rayyan project site.

UNITECH Trading & Contracting WLL
P.O. Box 14772, Doha, Qatar | VAT No: 300123456700003

INVOICE NO: INV-2026-0412 | DATE: 12 April 2026 | DUE DATE: 12 May 2026

ITEM                                   QTY  UNIT PRICE (QAR)  TOTAL (QAR)
Executive Chair (Mesh, High-Back)       20           850.00    17,000.00
L-Shaped Executive Desk (1800x1200mm)   10         2,200.00    22,000.00
Mobile Pedestal 3-Drawer (Lockable)     20           450.00     9,000.00
4-Person Meeting Table (1600x800mm)      5         1,800.00     9,000.00
Waiting Area Sofa (3-Seater, Fabric)     4         3,500.00    14,000.00
Bookshelf Unit (5-Tier, Melamine)       10           620.00     6,200.00

SUBTOTAL: QAR 77,200.00
VAT (5%): QAR 3,860.00
GRAND TOTAL: QAR 81,060.00

Payment Terms: Net 30 days
Bank: Qatar National Bank | IBAN: QA57QNBA000000000012345678901
Account Name: UNITECH Trading & Contracting WLL

For queries: +974 4433 5566 | accounts@unitechqatar.com

Thank you for your business.
UNITECH Trading & Contracting WLL`,
  },

  // ── 6. English SUPPLIER ──────────────────────────────────────────────────────
  "english-supplier": {
    id: "english-supplier",
    description: "English vendor pitch — tests SUPPLIER classification and sub-industry extraction",
    from: "info@glasstech-me.com",
    fromName: "GlassTech Middle East",
    subject: "Smart Glass & Switchable Film Solutions – Product Introduction",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "SUPPLIER",
    body: `Dear Daya Interior Design Team,

My name is Marcus Reeves and I am the Regional Sales Manager for GlassTech Middle East, a specialist supplier of smart glass and switchable film solutions for high-end commercial interiors across the GCC.

Our product range includes PDLC switchable privacy film, electrochromic glass panels for conference rooms, decorative window film in frosted/gradient/custom print finishes, and self-adhesive solar control film that reduces heat gain by up to 70%.

We have recently supplied the Qatar Financial Centre, The Gate Mall in Lusail, and several Marriott properties in Doha. I would be happy to arrange a brief product presentation at your office at a time convenient for you.

Marcus Reeves | Regional Sales Manager – GCC | GlassTech Middle East LLC
+974 5500 1122 | info@glasstech-me.com | www.glasstech-me.com`,
  },

  // ── 7. Arabic SUPPLIER ───────────────────────────────────────────────────────
  "arabic-supplier": {
    id: "arabic-supplier",
    description: "Arabic vendor pitch — tests Arabic SUPPLIER classification and industry extraction",
    from: "sales@alwatanflooring.qa",
    fromName: "الوطن للأرضيات",
    subject: "عرض تعريفي – أرضيات السجاد والفينيل للمشاريع التجارية",
    inboxEmail: "procurement@wearedaya.com",
    expectedClassification: "SUPPLIER",
    body: `السادة دايا للتصميم الداخلي المحترمين،
تحية طيبة وبعد،

نحن شركة الوطن للأرضيات والديكور، المتخصصة في توريد وتركيب أرضيات السجاد التجاري والفينيل لمشاريع التجهيز الداخلي في دولة قطر منذ أكثر من خمس عشرة سنة.

نقدم لكم مجموعة واسعة من المنتجات تشمل: سجاد مكتبي من ماركات عالمية (Interface, Burmatex, Milliken)، أرضيات فينيل LVT وSPC مقاومة للرطوبة، وخدمات القياس والتركيب والصيانة الكاملة.

قمنا بتوريد وتركيب أرضيات في مشاريع بارزة منها: مبنى برج الدوحة، مجمع لوسيل بلازا، والعديد من المكاتب الحكومية. يسعدنا تزويدكم بكتالوج المنتجات وعينات مجانية لمشاريعكم القادمة.

أحمد المنصوري | مدير المبيعات | الوطن للأرضيات والديكور
+974 5511 4455 | sales@alwatanflooring.qa`,
  },

  // ── 8. Spam / newsletter — NO ────────────────────────────────────────────────
  "spam-no": {
    id: "spam-no",
    description: "Newsletter / spam — confirms NO classification; nothing should be written to HubSpot",
    from: "noreply@designweekly.net",
    fromName: "Design Weekly Newsletter",
    subject: "This Week in Interior Design: 10 Trends Transforming Offices in 2026",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "NO",
    body: `Design Weekly | April 2026 Edition

THIS WEEK'S TOP STORIES:
1. Biophilic design hits mainstream — plants and natural light reduce burnout in offices.
2. The 15-minute office — hybrid work reshaping floor plate sizes across the GCC.
3. Material spotlight: Micro-cement surfaces — durable, minimal, and easy to specify.
4. Product roundup: 8 acoustic panel systems that won't blow your budget.
5. Interview: Doha-based designer Layla Ahmad on blending Islamic geometry with open-plan layouts.

You are receiving this email because you subscribed to Design Weekly.
© 2026 Design Weekly Publications. All rights reserved. | Unsubscribe | View in browser`,
  },

  // ── 9a. CC dedup pair — hello inbox ─────────────────────────────────────────
  // Run cc-lead-hello then cc-lead-peter back to back.
  // The second call should return { status: "deduped" } because the first call
  // marks conv-fixture-cc-lead in KV before the second check runs.
  "cc-lead-hello": {
    id: "fixture-cc-lead",
    description: "CC dedup pair — first inbox (hello@). Run this THEN cc-lead-peter to test sequential dedup",
    from: "claire.watson@lusailrealty.com",
    fromName: "Claire Watson",
    subject: "Office Fit-Out Enquiry – Tower 5, Lusail Marina",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "LEAD",
    body: `Dear Daya Team,

I am reaching out on behalf of Lusail Realty Holdings regarding a potential office fit-out project at Tower 5, Lusail Marina District. We are planning to fit out floors 12 through 14 (approximately 2,400 sqm combined) as premium grade-A offices for a government-linked tenant.

We are currently in the pre-qualification stage and would appreciate receiving your company profile, relevant project portfolio, and an indication of your rate schedule for fit-out works of this scale.

Please feel free to contact me directly to discuss further.

Claire Watson | Head of Asset Management | Lusail Realty Holdings
+974 5544 3311 | claire.watson@lusailrealty.com`,
  },

  // ── 9b. CC dedup pair — peter inbox ─────────────────────────────────────────
  "cc-lead-peter": {
    id: "fixture-cc-lead",  // Same id as cc-lead-hello — shared conversationId
    description: "CC dedup pair — second inbox (peterkimani@). Should return { status: 'deduped' } if called after cc-lead-hello",
    from: "claire.watson@lusailrealty.com",
    fromName: "Claire Watson",
    subject: "Office Fit-Out Enquiry – Tower 5, Lusail Marina",
    inboxEmail: "peterkimani@wearedaya.com",
    expectedClassification: "LEAD",
    body: `Dear Daya Team,

I am reaching out on behalf of Lusail Realty Holdings regarding a potential office fit-out project at Tower 5, Lusail Marina District. We are planning to fit out floors 12 through 14 (approximately 2,400 sqm combined) as premium grade-A offices for a government-linked tenant.

We are currently in the pre-qualification stage and would appreciate receiving your company profile, relevant project portfolio, and an indication of your rate schedule for fit-out works of this scale.

Please feel free to contact me directly to discuss further.

Claire Watson | Head of Asset Management | Lusail Realty Holdings
+974 5544 3311 | claire.watson@lusailrealty.com`,
  },

  // ── 10. Mixed Arabic/English ─────────────────────────────────────────────────
  "mixed-arabic-english": {
    id: "mixed-arabic-english",
    description: "Bilingual Arabic/English email — the most common format in Qatar business",
    from: "n.ibrahim@qatarfinance.com",
    fromName: "Nada Ibrahim",
    subject: "استفسار / Enquiry – مكاتب الشركة / New Company Offices",
    inboxEmail: "hello@wearedaya.com",
    expectedClassification: "LEAD",
    body: `Dear Daya Team / السادة دايا،

We are Qatar Finance Group / نحن شركة قطر فاينانس جروب.

We plan to fit out our new offices at Al Maha Tower, West Bay (900 sqm, 2 floors).
نخطط لتجهيز مكاتبنا الجديدة في برج المها، الخليج الغربي (٩٠٠ م٢، طابقان).

Scope / النطاق:
- Full fit-out: partitions, flooring, ceilings, joinery
- أعمال كاملة: تقسيمات، أرضيات، أسقف، نجارة
- Furniture supply and installation / توريد وتركيب الأثاث
- MEP coordination / تنسيق أعمال الميكانيكا والكهرباء والسباكة

Please provide your company profile and a rough cost estimate.
يرجى تزويدنا بملف الشركة وتقدير أولي للتكاليف.

Nada Ibrahim / ندى إبراهيم | Office Manager | Qatar Finance Group
+974 5566 7788 | n.ibrahim@qatarfinance.com`,
  },

};
