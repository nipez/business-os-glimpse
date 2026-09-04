# Business OS Glimpse

Public landing feature for Business OS. A visitor submits a company website, the server researches it with Anthropic hosted web search, caches the result in Supabase, and captures the visitor as a lead.

## Local Development

1. Copy `.env.example` to `.env` and fill in the server-only secrets.
2. Install dependencies with `npm install`.
3. Run the service with `npm run dev`.

The Hono service serves `public/` and exposes the API routes described in `glimpse-build-spec.md`.

## Supabase Setup

1. Create a new Supabase project.
2. Open the Supabase SQL editor.
3. Run `src/schema.sql`.
4. In Project Settings → API, copy:
   - Project URL → `SUPABASE_URL`
   - Service role key → `SUPABASE_SERVICE_ROLE_KEY`
5. Do not add anon/public policies. Keep RLS effectively closed; the server uses the service-role key.

## Railway Setup

1. Push this repo to GitHub.
2. In Railway, create a new project from the GitHub repo.
3. Add these environment variables:

```bash
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GLIMPSE_CACHE_DAYS=7
GLIMPSE_UNIQUE_DOMAINS_PER_DAY=2
RATE_LIMIT_PER_MIN=5
RATE_LIMIT_PER_DAY=30
ADMIN_PASSWORD=
SUPERADMIN_EMAILS=nickperez@gmail.com
RESEND_API_KEY=
RECAP_FROM_EMAIL=Business OS <haig@updates.example.com>
RECAP_REPLY_TO=nickperez@gmail.com
LEAD_NOTIFY_EMAIL=nickperez@gmail.com
BOOKING_URL=
SITE_URL=
PORT=3000
```

4. Railway will install dependencies and run `npm start` after `npm run build`.
5. Confirm the service exposes Railway's `PORT`.
6. Push to `main` to auto-deploy.
7. Point a custom domain at the Railway service when ready.

Keep Anthropic and Supabase keys in Railway environment variables only. No API key belongs in client code.

Open `/admin` and enter `ADMIN_PASSWORD` to view domain runs, contact submissions, conversion ratio, cached domains, recap email status, and the glimpse JSON returned to users.

Superadmins listed in `SUPERADMIN_EMAILS` can use the `/admin` unlock control to allow unlimited scans in the current browser. The unlock uses a signed, HTTP-only cookie and does not expose any bypass in client code.

When a visitor submits email and phone, `POST /api/lead` stores the contact and sends one recap email through Resend: a one-line summary, the three plays, and a single **Book a call** CTA. The same email is never sent twice for the same address + domain. Self-guided plans with an email get a recap of the week-one build. If `LEAD_NOTIFY_EMAIL` is set, operators also get a one-line internal ping.

Lead capture still succeeds if Resend is unset or fails. Verify a sending domain in Resend and put that address in `RECAP_FROM_EMAIL`. `BOOKING_URL` should be the calendar or intro-call link; if it is empty, the CTA falls back to `SITE_URL#book` or a mailto.

If you already ran the schema before phone or recap tracking was added, run this once in the Supabase SQL editor:

```sql
alter table leads add column if not exists phone text;
alter table leads add column if not exists recap_sent_at timestamptz;
alter table self_guided_plans add column if not exists recap_sent_at timestamptz;
```
