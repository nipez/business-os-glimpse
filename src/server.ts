import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { buildSelfGuidedPlan, research, type SelfGuidedInput, type SelfGuidedPlan } from './anthropic.js'
import {
  attachEmailToLead,
  checkRateLimit,
  checkUniqueDomainScanLimit,
  deleteCache,
  getAdminSnapshot,
  getCache,
  insertLead,
  insertSelfGuidedPlan,
  setCache,
} from './supabase.js'

const app = new Hono()

const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+().\-\s]{7,32}$/
const SCAN_ADMIN_COOKIE = 'bos_scan_admin'

function clientIp(c: Context) {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  return (
    forwarded ||
    c.req.header('x-real-ip') ||
    c.req.header('cf-connecting-ip') ||
    'unknown'
  )
}

function normalizeUrl(input: unknown) {
  if (typeof input !== 'string') return null

  const raw = input.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/+$/g, '')
  if (!raw || raw.includes('@')) return null

  let parsed: URL
  try {
    parsed = new URL(`https://${raw}`)
  } catch {
    return null
  }

  const domain = parsed.hostname.replace(/^www\./, '')
  if (!DOMAIN_RE.test(domain)) return null

  return { domain, url: domain }
}

function textField(input: unknown, maxLength = 500) {
  if (typeof input !== 'string') return ''
  return input.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function selfGuidedInput(body: Record<string, unknown>): SelfGuidedInput | null {
  const input = {
    businessName: textField(body.businessName, 120),
    website: textField(body.website, 160),
    stage: textField(body.stage, 180),
    teamSize: textField(body.teamSize, 80),
    tools: textField(body.tools, 500),
    bottleneck: textField(body.bottleneck, 500),
    goal: textField(body.goal, 360),
    owner: textField(body.owner, 160),
  }

  if (
    !input.businessName ||
    !input.stage ||
    !input.teamSize ||
    !input.tools ||
    !input.bottleneck ||
    !input.goal ||
    !input.owner
  ) {
    return null
  }

  return input
}

function optionalEmail(input: unknown) {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (!email) return ''
  return EMAIL_RE.test(email) ? email : null
}

function fallbackSelfGuidedPlan(input: SelfGuidedInput): SelfGuidedPlan & { fallback: true } {
  const website = input.website ? ` for ${input.website}` : ''
  const owner = input.owner || 'the owner'

  return {
    fallback: true,
    title: `${input.businessName} Backend OS`,
    diagnosis: `${input.businessName}${website} needs a cleaner operating layer around ${input.bottleneck.toLowerCase()}. The priority is to turn the founder-dependent work into visible workflows, simple dashboards, and repeatable follow-up that ${owner.toLowerCase()} can run without rebuilding the system every week.`,
    backend: [
      `Operating source of truth: define the core records, owners, statuses, and handoffs for ${input.businessName} so the team knows where work lives and what happens next.`,
      `Workflow command center: map the current tools (${input.tools}) into one practical view for leads, delivery, reporting, and follow-up instead of checking every system manually.`,
      `Founder visibility dashboard: track the few numbers tied to the 90-day goal — ${input.goal} — with weekly review notes and clear next actions.`,
    ],
    automations: [
      `Stale-work alert: when an important lead, customer, or task has no activity for several days, create a reminder for ${owner.toLowerCase()} with context and the next best action.`,
      `Follow-up sequence: turn the most common manual follow-ups around ${input.bottleneck.toLowerCase()} into templated email or task steps that trigger from status changes.`,
      `Weekly operating brief: generate a short summary of open work, blockers, wins, and metrics so the business can be reviewed without manual reporting.`,
    ],
    buildOrder: [
      `Audit the current workflow in ${input.tools}: list every place work starts, moves, stalls, and gets reported.`,
      `Create the minimum backend schema: owner, status, due date, source, priority, next action, and outcome for the highest-leverage workflow.`,
      `Build one automation first: the stale-work alert tied to the bottleneck that costs the most founder time.`,
      `Install a weekly review cadence: dashboard, brief, owner, and one logged decision every week until the system becomes habit.`,
    ],
    firstWeek: [
      `Write down the 10 most recent examples of ${input.bottleneck.toLowerCase()} and mark exactly where each one stalled.`,
      `Choose one tool as the operating home for the first version instead of spreading the build across every app at once.`,
      `Draft the first follow-up template and the first weekly brief format so automation has good source material to work from.`,
    ],
    stack: [
      `Airtable or Notion database for the first operating layer if the current CRM is too messy to trust.`,
      `Zapier or Make to connect ${input.tools} and trigger the first alerts without custom engineering.`,
      `Looker Studio, HubSpot reporting, or a lightweight dashboard tied only to the metrics behind ${input.goal}.`,
    ],
  }
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/\.[a-z]{2,}$/i, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
}

function looksDomainGrounded(domain: string, glimpse: { company: string; overview: string }) {
  const domainTokens = tokenize(domain)
  const responseText = `${glimpse.company} ${glimpse.overview}`.toLowerCase()
  const compactDomain = domain.toLowerCase().replace(/\.[a-z]{2,}$/i, '').replace(/[^a-z0-9]/g, '')
  const compactCompany = glimpse.company.toLowerCase().replace(/[^a-z0-9]/g, '')

  if (
    domain === 'getholycow.com' &&
    /\b(beef|rinds|cowhide|snack|jerky|seattle|javan bangs)\b/i.test(responseText)
  ) {
    return false
  }

  return (
    domainTokens.some((token) => responseText.includes(token)) ||
    (compactCompany.length >= 4 && compactDomain.includes(compactCompany))
  )
}

function isAdmin(c: Context) {
  const password = process.env.ADMIN_PASSWORD
  if (!password) return false
  return c.req.header('x-admin-password') === password
}

function superadminEmails() {
  return new Set(
    (process.env.SUPERADMIN_EMAILS ?? 'nickperez@gmail.com')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

async function isScanAdmin(c: Context) {
  const password = process.env.ADMIN_PASSWORD
  if (!password) return false

  const email = await getSignedCookie(c, password, SCAN_ADMIN_COOKIE)
  if (!email || typeof email !== 'string') return false

  return superadminEmails().has(email.toLowerCase())
}

app.get('/admin', async (c) => {
  const html = await readFile(join(process.cwd(), 'public', 'admin.html'), 'utf8')
  return c.html(html)
})

app.get('/self-guided', async (c) => {
  const html = await readFile(join(process.cwd(), 'public', 'self-guided.html'), 'utf8')
  return c.html(html)
})

app.get('/nick', async (c) => {
  const html = await readFile(join(process.cwd(), 'public', 'nick.html'), 'utf8')
  return c.html(html)
})

app.get('/api/admin/snapshot', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)

  try {
    return c.json(await getAdminSnapshot())
  } catch (error) {
    console.error('admin snapshot failed', error)
    return c.json({ error: 'Unable to load admin snapshot' }, 500)
  }
})

app.post('/api/admin/scan-unlock', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)

  let body: { email?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Invalid email' }, 400)
  if (!superadminEmails().has(email)) return c.json({ error: 'Email is not a superadmin' }, 403)

  await setSignedCookie(c, SCAN_ADMIN_COOKIE, email, process.env.ADMIN_PASSWORD ?? '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })

  return c.json({ ok: true, email })
})

app.get('/api/glimpse-access', async (c) => {
  return c.json({ fullReport: await isScanAdmin(c) })
})

app.post('/api/admin/cache/delete', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Unauthorized' }, 401)

  let body: { url?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const normalized = normalizeUrl(body.url)
  if (!normalized) return c.json({ error: 'Invalid URL' }, 400)

  try {
    await deleteCache(normalized.domain)
    return c.json({ ok: true })
  } catch (error) {
    console.error('admin cache delete failed', error)
    return c.json({ error: 'Unable to delete cache' }, 500)
  }
})

app.post('/api/glimpse', async (c) => {
  let body: { url?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const normalized = normalizeUrl(body.url)
  if (!normalized) return c.json({ error: 'Invalid URL' }, 400)

  const ip = clientIp(c)
  const userAgent = c.req.header('user-agent') ?? ''

  try {
    const scanAdmin = await isScanAdmin(c)
    if (!scanAdmin) {
      const allowed = await checkRateLimit(ip)
      if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

      const allowedUniqueDomain = await checkUniqueDomainScanLimit(ip, normalized.domain)
      if (!allowedUniqueDomain) {
        return c.json(
          {
            error: 'Free scan limit reached',
            code: 'SCAN_LIMIT_REACHED',
            limit: Number(process.env.GLIMPSE_UNIQUE_DOMAINS_PER_DAY ?? 2),
          },
          429,
        )
      }
    }

    const cached = await getCache(normalized.domain)
    if (cached) {
      if (!looksDomainGrounded(normalized.domain, cached)) {
        console.error('cached glimpse failed domain grounding check', {
          domain: normalized.domain,
          company: cached.company,
        })
        await deleteCache(normalized.domain)
      } else {
        await insertLead({
          domain: normalized.domain,
          url: normalized.url,
          ip,
          user_agent: userAgent,
          glimpse: cached,
        })
        return c.json(cached)
      }
    }

    let glimpse
    try {
      glimpse = await research(normalized.url)
    } catch (error) {
      console.error('research failed', error)
      return c.json({ fallback: true })
    }

    if (!looksDomainGrounded(normalized.domain, glimpse)) {
      console.error('research failed domain grounding check', {
        domain: normalized.domain,
        company: glimpse.company,
      })
      return c.json({ fallback: true })
    }

    await insertLead({
      domain: normalized.domain,
      url: normalized.url,
      ip,
      user_agent: userAgent,
      glimpse,
    })
    await setCache(normalized.domain, glimpse)

    return c.json(glimpse)
  } catch (error) {
    console.error('glimpse route failed', error)
    return c.json({ fallback: true })
  }
})

app.post('/api/lead', async (c) => {
  let body: { url?: unknown; email?: unknown; phone?: unknown; glimpse?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const normalized = normalizeUrl(body.url)
  if (!normalized) return c.json({ error: 'Invalid URL' }, 400)

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Invalid email' }, 400)

  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  if (!PHONE_RE.test(phone)) return c.json({ error: 'Invalid phone' }, 400)

  const ip = clientIp(c)
  const userAgent = c.req.header('user-agent') ?? ''

  try {
    const allowed = await checkRateLimit(ip)
    if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

    await attachEmailToLead({
      domain: normalized.domain,
      url: normalized.url,
      email,
      phone,
      ip,
      user_agent: userAgent,
      glimpse:
        typeof body.glimpse === 'object' && body.glimpse !== null
          ? (body.glimpse as Record<string, unknown>)
          : undefined,
    })

    return c.json({ ok: true })
  } catch (error) {
    console.error('lead route failed', error)
    return c.json({ error: 'Unable to capture lead' }, 500)
  }
})

app.post('/api/self-guided-plan', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const input = selfGuidedInput(body)
  if (!input) return c.json({ error: 'Missing required fields' }, 400)
  const email = optionalEmail(body.email)
  if (email === null) return c.json({ error: 'Invalid email' }, 400)

  const ip = clientIp(c)
  const userAgent = c.req.header('user-agent') ?? ''

  try {
    const allowed = await checkRateLimit(ip)
    if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

    const plan = await buildSelfGuidedPlan(input)
    try {
      await insertSelfGuidedPlan({
        ...input,
        email: email || undefined,
        ip,
        user_agent: userAgent,
        plan,
      })
    } catch (error) {
      console.error('self-guided plan persistence failed', error)
    }

    return c.json(plan)
  } catch (error) {
    console.error('self-guided plan failed', error)
    return c.json(fallbackSelfGuidedPlan(input))
  }
})

app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Business OS Glimpse listening on http://localhost:${info.port}`)
})
