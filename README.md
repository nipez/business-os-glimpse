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
RATE_LIMIT_PER_MIN=5
RATE_LIMIT_PER_DAY=30
PORT=3000
```

4. Railway will install dependencies and run `npm start` after `npm run build`.
5. Confirm the service exposes Railway's `PORT`.
6. Push to `main` to auto-deploy.
7. Point a custom domain at the Railway service when ready.

Keep Anthropic and Supabase keys in Railway environment variables only. No API key belongs in client code.

If you already ran the schema before phone capture was added, run this once in the Supabase SQL editor:

```sql
alter table leads add column if not exists phone text;
```
