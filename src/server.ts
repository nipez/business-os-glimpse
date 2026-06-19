import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { research } from './anthropic.js'
import {
  attachEmailToLead,
  checkRateLimit,
  getCache,
  insertLead,
  setCache,
} from './supabase.js'

const app = new Hono()

const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
      await insertLead({
        domain: normalized.domain,
        url: normalized.url,
        ip,
        user_agent: userAgent,
        glimpse: cached,
      })
      return c.json(cached)
    }

    let glimpse
    try {
      glimpse = await research(normalized.url)
    } catch (error) {
      console.error('research failed', error)
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
  let body: { url?: unknown; email?: unknown; glimpse?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const normalized = normalizeUrl(body.url)
  if (!normalized) return c.json({ error: 'Invalid URL' }, 400)

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Invalid email' }, 400)

  const ip = clientIp(c)
  const userAgent = c.req.header('user-agent') ?? ''

  try {
    const allowed = await checkRateLimit(ip)
    if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429)

    await attachEmailToLead({
      domain: normalized.domain,
      url: normalized.url,
      email,
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

app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Business OS Glimpse listening on http://localhost:${info.port}`)
})
