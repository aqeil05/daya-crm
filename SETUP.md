# Daya CRM Worker — Setup Guide

## Prerequisites

- Node.js 18+ installed
- Cloudflare account (free tier is sufficient)
- Microsoft 365 Business Basic licences activated for the 3 monitored inboxes
- Azure AD access to register an app (any M365 admin can do this)
- HubSpot account with Private App token
- Google Cloud service account with Sheets access
- Telegram bot token + chat/group ID

---

## Step 1 — Install dependencies

```bash
cd /Users/aqeil/development/crm
npm install
```

---

## Step 2 — Create Cloudflare KV namespace

```bash
npx wrangler kv:namespace create DAYA_KV
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DAYA_KV"
id = "PASTE_ID_HERE"
```

---

## Step 3 — Azure App Registration

This gives the worker permission to read and send email on behalf of the 3 M365 inboxes.

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**
2. Name: `daya-crm-bot` | Supported account types: **Single tenant** → Register
3. Copy the **Application (client) ID** → this is your `AZURE_CLIENT_ID`
4. Copy the **Directory (tenant) ID** → this is your `AZURE_TENANT_ID`
5. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**
   - Add: `Mail.Read`
   - Add: `Mail.Send`
   - Add: `Mail.ReadWrite` *(optional — allows marking as read)*
6. Click **Grant admin consent** → confirm
7. Go to **Certificates & secrets** → **New client secret**
   - Description: `crm-worker` | Expiry: 24 months → Add
   - Copy the **Value** immediately (shown once) → this is your `AZURE_CLIENT_SECRET`

---

## Step 4 — Google Service Account

Skip this step if you already have a service account from the timesheet worker — you can reuse it.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **IAM & Admin** → **Service accounts** → **Create service account**
2. Name: `daya-crm` → Create
3. Go to the service account → **Keys** → **Add key** → **Create new key** → JSON → Download
4. Open the JSON file:
   - `client_email` → this is your `GOOGLE_SA_EMAIL`
   - `private_key` → this is your `GOOGLE_SA_PRIVATE_KEY`
5. Open each Google Sheet (CRM Log, Supplier Log) → **Share** → share with the service account email, **Editor** role

---

## Step 5 — HubSpot Private App Token

1. In HubSpot → **Settings** → **Integrations** → **Private Apps** → **Create private app**
2. Name: `daya-crm-worker`
3. Scopes required:
   - `crm.objects.contacts.write`
   - `crm.objects.contacts.read`
   - `crm.objects.companies.write`
   - `crm.objects.companies.read`
   - `crm.objects.deals.write`
   - `crm.objects.deals.read`
   - `crm.schemas.contacts.read`
   - `crm.schemas.companies.read`
   - `crm.schemas.deals.read`
   - `engagements` *(for creating notes)*
4. Create app → copy the token → this is your `HUBSPOT_PRIVATE_APP_TOKEN`

### Get your Pipeline ID and Stage ID

In HubSpot → **Settings** → **CRM** → **Deals** → **Pipelines** → open your pipeline → click the **Inquiry received** stage.

The pipeline ID and stage ID appear in the URL:
```
/sales/pipelines/{PIPELINE_ID}/stages/{STAGE_ID}
```

Alternatively, call the API:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.hubapi.com/crm/v3/pipelines/deals"
```

### Get your HubSpot Portal ID

It's the number in your HubSpot URL: `app.hubspot.com/contacts/PORTAL_ID/...`

---

## Step 6 — Telegram Bot + Chat ID

Skip if you are reusing the timesheet bot.

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts → copy the **token** → `TELEGRAM_BOT_TOKEN`
2. Add the bot to your team group or channel
3. Get the chat ID:
   ```bash
   curl "https://api.telegram.org/botYOUR_TOKEN/getUpdates"
   ```
   Send any message to the group, then look for `"chat":{"id":...}` in the response → `TELEGRAM_CHAT_ID`

---

## Step 7 — Set all secrets

Run each command and paste the value when prompted:

```bash
cd /Users/aqeil/development/crm

npx wrangler secret put AZURE_TENANT_ID
npx wrangler secret put AZURE_CLIENT_ID
npx wrangler secret put AZURE_CLIENT_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put HUBSPOT_PRIVATE_APP_TOKEN
npx wrangler secret put HUBSPOT_PIPELINE_ID
npx wrangler secret put HUBSPOT_STAGE_ID
npx wrangler secret put HUBSPOT_PORTAL_ID
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SHEETS_CRM_LOG_ID
npx wrangler secret put SHEETS_SUPPLIER_LOG_ID
npx wrangler secret put GRAPH_CLIENT_STATE
```

For `GRAPH_CLIENT_STATE` use any random string, e.g. `daya-crm-2026`. This is used to verify that webhook notifications are genuinely from Microsoft and not spoofed.

For `SHEETS_CRM_LOG_ID` and `SHEETS_SUPPLIER_LOG_ID` — the ID is the long string in the Google Sheets URL:
```
https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit
```

**Do not set `WORKER_URL` yet — deploy first.**

---

## Step 8 — First deploy

```bash
npx wrangler deploy
```

The output will show your worker URL, something like:
```
https://daya-crm-worker.YOUR_SUBDOMAIN.workers.dev
```

Now set `WORKER_URL`:
```bash
npx wrangler secret put WORKER_URL
# paste: https://daya-crm-worker.YOUR_SUBDOMAIN.workers.dev
```

---

## Step 9 — Register Graph webhook subscriptions

This registers Microsoft Graph to push notifications to your worker whenever a new email arrives in any of the 3 inboxes.

```bash
curl https://daya-crm-worker.YOUR_SUBDOMAIN.workers.dev/setup
```

Expected response:
```json
[
  { "email": "peter.k@wearedaya.com", "subscriptionId": "...", "status": "ok" },
  { "email": "hello@wearedaya.com",   "subscriptionId": "...", "status": "ok" },
  { "email": "procurement@wearedaya.com", "subscriptionId": "...", "status": "ok" }
]
```

If any show `"status": "error"`, check `wrangler tail` for the error message. Common causes: Azure permissions not granted, `WORKER_URL` not set, or `AZURE_*` secrets wrong.

---

## Step 10 — End-to-end test

Open a second terminal and start log streaming:
```bash
npx wrangler tail
```

Send a test email from a personal/external email address to `peter.k@wearedaya.com` with a subject like "Office fit-out enquiry".

In the tail logs you should see:
```
Processing message from you@example.com | subject: "Office fit-out enquiry" | conv: AAQ...
Classification: LEAD
Lead extracted: {...}
Pipeline result: {"status":"processed","classification":"LEAD","dealId":"..."}
```

Then verify:
- HubSpot: new contact + company + deal created
- Google Sheets CRM Log: new row appended
- Telegram: notification received
- Your email: auto-reply received from peter.k@wearedaya.com

**Test dedup:** Reply to your own test email. The worker should receive the notification and log `Skipping — conversationId already processed`.

**Test internal filter:** Send from `sharyfie@wearedaya.com` with internal content → should classify as NO.

**Test supplier:** Send a pitch email ("We supply office furniture...") → should classify as SUPPLIER, log to Supplier Log, no auto-reply sent.

**Test hello@ and procurement@:** Send test emails to each inbox.

---

## Maintenance

### View live logs
```bash
npx wrangler tail
```

### Redeploy after code changes
```bash
npx wrangler deploy
```

### Subscription renewal
The cron trigger (`0 */12 * * *`) automatically renews Graph subscriptions every 12 hours. Graph mail subscriptions expire after 3 days — the cron keeps them alive indefinitely.

To manually trigger renewal, redeploy and the next cron will fire within 12 hours. Or call `/setup` again — it will renew existing subscriptions rather than creating duplicates.

### Update a secret
```bash
npx wrangler secret put SECRET_NAME
```

### List all secrets
```bash
npx wrangler secret list
```

### Invalidate cached tokens
KV tokens expire automatically (55 min for Google/Graph). If you rotate a secret, simply wait for the cache to expire or delete the KV entry:
```bash
npx wrangler kv:key delete --binding DAYA_KV "cache:google_token"
npx wrangler kv:key delete --binding DAYA_KV "cache:graph_token"
```

---

## Secrets reference

| Secret | Where to get it |
|--------|----------------|
| `AZURE_TENANT_ID` | Azure Portal → App registrations → Overview |
| `AZURE_CLIENT_ID` | Azure Portal → App registrations → Overview |
| `AZURE_CLIENT_SECRET` | Azure Portal → App registrations → Certificates & secrets |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |
| `HUBSPOT_PRIVATE_APP_TOKEN` | HubSpot → Settings → Integrations → Private Apps |
| `HUBSPOT_PIPELINE_ID` | HubSpot deal pipeline URL or API |
| `HUBSPOT_STAGE_ID` | HubSpot deal stage URL or API |
| `HUBSPOT_PORTAL_ID` | HubSpot URL: app.hubspot.com/contacts/**ID**/... |
| `GOOGLE_SA_EMAIL` | Google Cloud → Service account → `client_email` in JSON key |
| `GOOGLE_SA_PRIVATE_KEY` | Google Cloud → Service account → `private_key` in JSON key |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_CHAT_ID` | Telegram getUpdates API |
| `SHEETS_CRM_LOG_ID` | Google Sheets URL: `/spreadsheets/d/ID/edit` |
| `SHEETS_SUPPLIER_LOG_ID` | Google Sheets URL: `/spreadsheets/d/ID/edit` |
| `GRAPH_CLIENT_STATE` | Any random string you choose — keep it private |
| `WORKER_URL` | Cloudflare Workers dashboard or `wrangler deploy` output |
