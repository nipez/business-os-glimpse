import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Glimpse } from './anthropic.js'

type LeadInsert = {
  domain: string
  url?: string
  email?: string
  phone?: string
  ip?: string
  user_agent?: string
  glimpse?: Glimpse | Record<string, unknown>
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
  return data?.glimpse as Glimpse | null | undefined
}

export async function setCache(domain: string, glimpse: Glimpse) {
  const client = requireSupabase()

  const { error } = await client
    .from('glimpse_cache')
    .upsert({ domain, glimpse, created_at: new Date().toISOString() }, { onConflict: 'domain' })

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
