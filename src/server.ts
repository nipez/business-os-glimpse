import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { buildSelfGuidedPlan, research, type SelfGuidedInput } from './anthropic.js'
import {
  attachEmailToLead,
  checkRateLimit,
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

app.get('/admin', async (c) => {
  const html = await readFile(join(process.cwd(), 'public', 'admin.html'), 'utf8')
  return c.html(html)
})

app.get('/self-guided', async (c) => {
  const html = await readFile(join(process.cwd(), 'public', 'self-guided.html'), 'utf8')
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
    const allowed = await checkRateLimit(ip)
    if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

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
    await insertSelfGuidedPlan({
      ...input,
      email: email || undefined,
      ip,
      user_agent: userAgent,
      plan,
    })

    return c.json(plan)
  } catch (error) {
    console.error('self-guided plan failed', error)
    return c.json({ error: 'Unable to build plan' }, 500)
  }
})

app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Business OS Glimpse listening on http://localhost:${info.port}`)
})
