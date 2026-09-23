# Fraaash Ads Dashboard

Live Meta ads performance for Fraaash at `ads.fraaash.com`.

The dashboard never talks to Meta. The nightly ads agent pulls from Meta and writes
to Airtable; this server reads Airtable and serves the page. That is deliberate — it
means no Meta app, no system-user token, and nothing to rotate every 60 days.

```
Meta ──▶ nightly agent ──▶ Airtable ──▶ this server ──▶ ads.fraaash.com
```

## What it shows

Blended CAC against the three thresholds that actually matter for this business,
daily CAC and spend, ad set performance aggregated over any date range, and the
agent's nightly log of what it changed and why.

| CAC | Meaning |
|---|---|
| ≤ RM20 | The goal |
| RM20–42 | First order still pays for itself (first-order GP RM42.17) |
| RM42–55 | Only profitable on repeat orders (lifetime GP ≈ RM57.63) |
| > RM55 | Unprofitable even over the customer's lifetime |

## Data source

Airtable base **Fraaash Ads** (`appp3bMk7dH0pD5XO`):

| Table | Grain | Written by |
|---|---|---|
| `Daily Metrics` | one row per day | nightly agent + 3-hourly refresh |
| `Ad Set Performance` | one row per ad set per day | nightly agent + 3-hourly refresh |
| `Agent Log` | one row per nightly run | nightly agent |

`Ad Set Performance` stores Impressions and Clicks alongside CTR on purpose: when
the dashboard aggregates a date range it recomputes CTR as clicks ÷ impressions.
Averaging the stored daily CTRs would weight a RM5 day the same as a RM300 day.
Same reasoning for CAC (spend ÷ purchases) and ROAS (revenue ÷ spend).

## Local development

```bash
npm install
cp .env.example .env     # then paste your real Airtable token into .env
node --env-file=.env server.js
```

Open http://localhost:3000.

Without a token the server still starts and every endpoint returns a clean
`no_token` error, which the page renders as "Server not configured". That is the
expected state before deployment, not a bug.

## Deploying to Render

1. Push this repo to GitHub (private).
2. Render → **New → Web Service** → connect the repo.
   - Runtime **Node**, build `npm install`, start `node server.js`
   - Instance type **Free** to begin with. Free sleeps after ~15 min idle, so the
     first load after a quiet spell takes 30–60s. Switch to **Starter** (~$7/mo)
     if that becomes irritating — it is a dropdown, no migration.
3. **Environment** tab → add:

   | Key | Value |
   |---|---|
   | `AIRTABLE_TOKEN` | your personal access token |
   | `AIRTABLE_BASE_ID` | `appp3bMk7dH0pD5XO` |

   Create the token at <https://airtable.com/create/tokens> with
   `data.records:read`, `data.records:write` and `schema.bases:read`, scoped to the
   **Fraaash Ads base only**. Render supplies `PORT` itself.
4. Deploy, then check `https://<service>.onrender.com/api/health`. It should report
   `tokenConfigured: true`.

## Custom domain

Order matters — the service must exist before it can be given a domain.

1. Render → your service → **Settings → Custom Domains → Add** → `ads.fraaash.com`.
   Render shows the `*.onrender.com` hostname to point at.
2. Cloudflare (DNS for `fraaash.com` is on Cloudflare, not Shopify) → **DNS →
   Records → Add record**:
   - Type `CNAME`, Name `ads`, Target = the Render hostname
   - **Proxy status: DNS only (grey cloud)**
3. Wait for Render to report the certificate as issued. **Then** optionally switch
   the record to Proxied (orange cloud).

Step 2's grey cloud matters: with Cloudflare proxying, Render cannot reach the
domain to validate it and certificate issuance fails. Verify first, proxy after.

Do **not** point `ads` at `shops.myshopify.com` — that is the storefront's record
and would serve a Shopify 404.

## Access control

The page has no login of its own. Put **Cloudflare Access** (Zero Trust) in front of
`ads.fraaash.com` — email one-time-code, free up to 50 users. Without it, anyone who
guesses the URL can read the account's spend and CAC.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/health` | service status, whether the token is configured |
| `GET /api/daily?since=&until=` | daily rows plus correctly-weighted totals |
| `GET /api/adsets?since=&until=` | ad sets aggregated across the range |
| `GET /api/log?limit=` | agent log, newest first |

Dates are `YYYY-MM-DD`, Malaysia time. Responses are cached in-process for 60s to
stay inside Airtable's 5 req/sec per-base limit.

Errors come back as `{ error: { code, message } }`. The page branches on `code` so
a missing token and a rate limit produce different, actionable messages rather than
one generic failure banner.
