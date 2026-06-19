# Business OS — "Glimpse" feature: build spec for Cursor / Codex

Paste this into Cursor or Codex as the task. A working **frontend prototype already exists** (`business-os-glimpse-demo.html`) — drop it into `/public` and refactor it per the "Frontend" section. Your job is to build the backend, wire the frontend to it, and make it deployable.

---

## What we're building

A public landing feature. A visitor enters their company website → an agent researches it live (web search + the company's own site) → the page shows a tailored **glimpse**: a 2-sentence overview, 3 sharp observations, and 3 "what we'd put our agents on first" plays, ending in a Book-a-call CTA. **Every URL entered is captured as a lead.**

Goal: a personalized hook ("here's what an agent already figured out about *your* business") that doubles as lead capture.

## Stack

- **GitHub** — single repo, auto-deploy to Railway on push to `main`.
- **Railway** — Node service (use **Hono**) that serves the static frontend *and* exposes `POST /api/glimpse`. Holds all secrets in env vars.
- **Supabase** — Postgres for leads, a glimpse cache, and rate limiting. Access via the **service-role key from the server only** (never the browser).
- **Model** — Anthropic Messages API with the **hosted web search tool**, called **server-side only**. Use `claude-sonnet-4-6` (good quality/cost); `claude-haiku-4-5` is a cheaper option if volume gets high. Confirm current model + web-search tool version strings at https://docs.claude.com.

## Repo structure

```
/
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ README.md
├─ src/
│  ├─ server.ts        # Hono app: serves /public + POST /api/glimpse
│  ├─ anthropic.ts     # research(url) -> {company, overview, observations[3], plays[3]}
│  ├─ supabase.ts      # client + helpers: insertLead, getCache, setCache, checkRateLimit
│  └─ schema.sql       # Supabase tables (run once in the SQL editor)
└─ public/
   └─ index.html       # the glimpse UI (from business-os-glimpse-demo.html)
```

## Backend: `POST /api/glimpse`

**Request:** `{ "url": "yourcompany.com" }`

**Flow:**
1. **Normalize** the URL — strip `http(s)://` and trailing slashes, lowercase, extract a bare `domain`. Reject anything that isn't a plausible domain (return 400).
2. **Rate limit** by IP via Supabase (e.g. 5/min and 30/day per IP). Over limit → `429`. This endpoint spends tokens and is public; this is not optional.
3. **Cache check** — `select` from `glimpse_cache` where `domain = ?` and `created_at > now() - interval '7 days'`. On hit, record the lead and return the cached glimpse immediately.
4. **Research** — call `research(url)` (see `anthropic.ts`). It calls the Anthropic API with the web search tool and a prompt that returns **strict JSON only**. Parse defensively: collect all `text` content blocks, find the first `{` to the last `}`, `JSON.parse`, and validate shape (`company` string; `observations` and `plays` arrays of 3). On failure, return `{ "fallback": true }` with HTTP 200 so the frontend can degrade gracefully.
5. **Persist** — insert a row into `leads` (domain, ip, user_agent, glimpse jsonb), and upsert `glimpse_cache`.
6. **Return** the glimpse JSON.

Request can take 10–25s (web search). Set a generous server timeout; streaming is not required.

### `research(url)` — the exact prompt to use

```
You are the research agent for "Business OS", a firm that embeds two senior operators
plus AI agents into companies to scale them. Research the company at this website and
produce a punchy "glimpse" for the owner. Use web search to ground it in real facts.

Website: https://{url}

Return ONLY valid JSON (no markdown, no code fences), exactly this shape:
{"company":"the brand name",
 "overview":"2 tight sentences: what they do and where they're at",
 "observations":["3 sharp, specific, true-and-slightly-flattering insights about their position — reference real details you found"],
 "plays":["3 concrete things our operating team + AI agents would run for THEM first, specific to this business"]}
```

Anthropic call shape: `messages: [{role:"user", content: <prompt>}]`, `max_tokens: 1000`, `tools: [{ type: "web_search_20250305", name: "web_search" }]`. Key from `process.env.ANTHROPIC_API_KEY`. Prefer the official `@anthropic-ai/sdk`.

## Backend: `POST /api/lead`

**Request:** `{ "url": "...", "email": "...", "glimpse": {...} }`

Validate the email, then attach it to the most recent `leads` row for that domain (or insert a new one). Fire the recap email (see Email recap below). Return `200 { ok: true }`. Rate-limit the same way as `/api/glimpse`.

## Supabase: `schema.sql`

```sql
create extension if not exists "pgcrypto";

create table leads (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  url text,
  email text,
  ip text,
  user_agent text,
  glimpse jsonb,
  created_at timestamptz default now()
);
create index on leads (domain);
create index on leads (created_at);

create table glimpse_cache (
  domain text primary key,
  glimpse jsonb not null,
  created_at timestamptz default now()
);

create table rate_limits (
  ip text not null,
  bucket timestamptz not null,   -- truncated to the minute
  count int default 1,
  primary key (ip, bucket)
);
```

Keep RLS effectively closed — all access is via the service-role key from the server. No anon/public policies.

## Frontend (`public/index.html`) — already wired

The prototype's `research(url)` **already calls `POST /api/glimpse` first** and only falls back to a preview-only in-browser path. Your job on the frontend is small:
1. Implement the `/api/glimpse` endpoint it's already calling.
2. **Delete the `researchDirect()` function** (the preview-only `api.anthropic.com` call) and its use — that path exists only so the demo works inside Claude's preview. In production the browser must never call the model directly.
3. The glimpse result has an email-capture form that does `POST /api/lead` with `{ url, email, glimpse }` — implement that endpoint too (see below).

Keep the terminal animation and glimpse rendering exactly as-is.

## `.env.example`

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GLIMPSE_CACHE_DAYS=7
RATE_LIMIT_PER_MIN=5
RATE_LIMIT_PER_DAY=30
PORT=3000
```

## Deploy

1. Push the repo to GitHub.
2. Supabase: create a project, run `schema.sql` in the SQL editor, copy the project URL + service-role key.
3. Railway: new project from the GitHub repo, add all env vars, expose `PORT`. It auto-deploys on push.
4. Point a custom domain at the Railway service.

## Acceptance criteria

- A real URL returns a specific, grounded glimpse within ~25s.
- Re-running the same domain returns instantly from cache.
- Every submission creates a `leads` row.
- More than the limit from one IP returns `429`.
- No secret appears in the client bundle (verify in the browser network/sources tab).
- If the API is down, the page still renders the fallback glimpse.

## Email recap (the conversion step)

The glimpse hooks attention; the recap email converts the people who didn't book on the spot. When a lead submits their email via `/api/lead`, send a short recap within ~1–2 min (use **Postmark** or **Resend**) containing: a one-line summary, the 3 plays we'd run first, and a single CTA.

**Positioning guardrails — this is a high-touch service, not self-serve SaaS:**
- The CTA is **"Book a call,"** never "subscribe."
- Do **not** promise a fully autonomous agent that runs unattended. We embed two operators *plus* agents.
- Tone: a senior operator who already did the homework, not an automated drip.

Store `email` on the lead row. Don't spam — one recap per lead, then it's a human follow-up.

## Out of scope (later)

Auth, a leads dashboard, multi-step nurture sequences, and the white-label "R3VY health agent" variant.
