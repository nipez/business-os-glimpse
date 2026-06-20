import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import type { Glimpse, SelfGuidedInput, SelfGuidedPlan } from './anthropic.js'

export const GLIMPSE_CACHE_VERSION = 2

type LeadInsert = {
  domain: string
  url?: string
  email?: string
  phone?: string
  ip?: string
  user_agent?: string
  glimpse?: Glimpse | Record<string, unknown>
}

type SelfGuidedPlanInsert = SelfGuidedInput & {
  email?: string
  ip?: string
  user_agent?: string
  plan: SelfGuidedPlan
}

let supabase: SupabaseClient | null = null

function requireSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }

  supabase ??= createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket as never,
    },
  })

  return supabase
}

function minuteBucket(date = new Date()) {
  const bucket = new Date(date)
  bucket.setSeconds(0, 0)
  return bucket.toISOString()
}

export async function checkRateLimit(ip: string) {
  const client = requireSupabase()

  const perMinute = Number(process.env.RATE_LIMIT_PER_MIN ?? 5)
  const perDay = Number(process.env.RATE_LIMIT_PER_DAY ?? 30)
  const bucket = minuteBucket()
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: current, error: currentError } = await client
    .from('rate_limits')
    .select('count')
    .eq('ip', ip)
    .eq('bucket', bucket)
    .maybeSingle()

  if (currentError) throw currentError

  const nextCount = Number(current?.count ?? 0) + 1
  if (nextCount > perMinute) return false

  const { data: recent, error: recentError } = await client
    .from('rate_limits')
    .select('count')
    .eq('ip', ip)
    .gte('bucket', dayAgo)

  if (recentError) throw recentError

  const dayCount = (recent ?? []).reduce((sum, row) => sum + Number(row.count ?? 0), 0)
  if (dayCount + 1 > perDay) return false

  const { error: upsertError } = await client
    .from('rate_limits')
    .upsert({ ip, bucket, count: nextCount }, { onConflict: 'ip,bucket' })

  if (upsertError) throw upsertError

  return true
}

export async function checkUniqueDomainScanLimit(ip: string, domain: string) {
  const client = requireSupabase()

  const maxUniqueDomains = Number(process.env.GLIMPSE_UNIQUE_DOMAINS_PER_DAY ?? 2)
  if (maxUniqueDomains <= 0) return true

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await client
    .from('leads')
    .select('domain')
    .eq('ip', ip)
    .gte('created_at', dayAgo)

  if (error) throw error

  const domains = new Set((data ?? []).map((row) => String(row.domain)))
  return domains.has(domain) || domains.size < maxUniqueDomains
}

export async function getCache(domain: string) {
  const client = requireSupabase()

  const cacheDays = Number(process.env.GLIMPSE_CACHE_DAYS ?? 7)
  const cutoff = new Date(Date.now() - cacheDays * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await client
    .from('glimpse_cache')
    .select('glimpse, created_at')
    .eq('domain', domain)
    .gt('created_at', cutoff)
    .maybeSingle()

  if (error) throw error
  const glimpse = data?.glimpse as (Glimpse & { _cache_version?: number }) | null | undefined
  if (!glimpse) return null
  if (glimpse._cache_version !== GLIMPSE_CACHE_VERSION) {
    await deleteCache(domain)
    return null
  }
  return glimpse
}

export async function setCache(domain: string, glimpse: Glimpse) {
  const client = requireSupabase()

  const { error } = await client
    .from('glimpse_cache')
    .upsert(
      {
        domain,
        glimpse: { ...glimpse, _cache_version: GLIMPSE_CACHE_VERSION },
        created_at: new Date().toISOString(),
      },
      { onConflict: 'domain' },
    )

  if (error) throw error
}

export async function deleteCache(domain: string) {
  const client = requireSupabase()

  const { error } = await client.from('glimpse_cache').delete().eq('domain', domain)
  if (error) throw error
}

export async function insertLead(lead: LeadInsert) {
  const client = requireSupabase()

  const { error } = await client.from('leads').insert(lead)
  if (error) throw error
}

export async function attachEmailToLead(lead: LeadInsert & { email: string }) {
  const client = requireSupabase()

  const { data: existing, error: findError } = await client
    .from('leads')
    .select('id')
    .eq('domain', lead.domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (findError) throw findError

  if (existing?.id) {
    const { error } = await client
      .from('leads')
      .update({
        email: lead.email,
        phone: lead.phone,
        url: lead.url,
        ip: lead.ip,
        user_agent: lead.user_agent,
        glimpse: lead.glimpse,
      })
      .eq('id', existing.id)

    if (error) throw error
    return
  }

  await insertLead(lead)
}

export async function insertSelfGuidedPlan(input: SelfGuidedPlanInsert) {
  const client = requireSupabase()

  const { error } = await client.from('self_guided_plans').insert({
    business_name: input.businessName,
    website: input.website,
    email: input.email,
    stage: input.stage,
    team_size: input.teamSize,
    tools: input.tools,
    bottleneck: input.bottleneck,
    goal: input.goal,
    owner: input.owner,
    ip: input.ip,
    user_agent: input.user_agent,
    plan: input.plan,
  })

  if (error) throw error
}

export async function getAdminSnapshot() {
  const client = requireSupabase()

  const { data: leads, error: leadsError } = await client
    .from('leads')
    .select('id, domain, url, email, phone, ip, user_agent, glimpse, created_at')
    .order('created_at', { ascending: false })
    .limit(500)

  if (leadsError) throw leadsError

  const { data: cache, error: cacheError } = await client
    .from('glimpse_cache')
    .select('domain, glimpse, created_at')
    .order('created_at', { ascending: false })
    .limit(500)

  if (cacheError) throw cacheError

  const { data: selfGuided, error: selfGuidedError } = await client
    .from('self_guided_plans')
    .select('id, business_name, website, email, stage, team_size, tools, bottleneck, goal, owner, ip, user_agent, plan, created_at')
    .order('created_at', { ascending: false })
    .limit(500)

  if (selfGuidedError) throw selfGuidedError

  const rows = leads ?? []
  const cacheRows = cache ?? []
  const selfGuidedRows = selfGuided ?? []
  const domainMap = new Map<string, {
    domain: string
    runs: number
    submissions: number
    last_entered_at?: string
    last_submitted_at?: string
    latest_email?: string
    latest_phone?: string
    latest_glimpse?: unknown
    cached_at?: string
  }>()

  for (const row of rows) {
    const domain = String(row.domain)
    const item = domainMap.get(domain) ?? { domain, runs: 0, submissions: 0 }
    item.runs += 1
    item.last_entered_at ??= row.created_at
    item.latest_glimpse ??= row.glimpse

    if (row.email && row.phone) {
      item.submissions += 1
      item.last_submitted_at ??= row.created_at
      item.latest_email ??= row.email
      item.latest_phone ??= row.phone
    }

    domainMap.set(domain, item)
  }

  for (const row of cacheRows) {
    const domain = String(row.domain)
    const item = domainMap.get(domain) ?? { domain, runs: 0, submissions: 0 }
    item.cached_at = row.created_at
    item.latest_glimpse ??= row.glimpse
    domainMap.set(domain, item)
  }

  const domainRuns = rows.length
  const uniqueDomains = new Set(rows.map((row) => row.domain)).size
  const contactSubmits = rows.filter((row) => row.email && row.phone).length
  const selfGuidedPlans = selfGuidedRows.length
  const selfGuidedEmails = selfGuidedRows.filter((row) => row.email).length

  return {
    summary: {
      domain_runs: domainRuns,
      unique_domains: uniqueDomains,
      contact_submits: contactSubmits,
      submit_rate: domainRuns ? contactSubmits / domainRuns : 0,
      cached_domains: cacheRows.length,
      repeat_runs: domainRuns - uniqueDomains,
      self_guided_plans: selfGuidedPlans,
      self_guided_emails: selfGuidedEmails,
      self_guided_email_rate: selfGuidedPlans ? selfGuidedEmails / selfGuidedPlans : 0,
    },
    domains: [...domainMap.values()].sort((a, b) => {
      return String(b.last_entered_at ?? b.cached_at ?? '').localeCompare(String(a.last_entered_at ?? a.cached_at ?? ''))
    }),
    leads: rows,
    cache: cacheRows,
    self_guided: selfGuidedRows,
  }
}
