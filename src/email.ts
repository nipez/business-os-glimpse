import type { Glimpse, SelfGuidedPlan } from './anthropic.js'

export type RecapStatus = 'sent' | 'skipped' | 'failed' | 'disabled'

export type EmailMessage = {
  from: string
  to: string
  replyTo?: string
  subject: string
  html: string
  text: string
}

export type EmailConfig = {
  apiKey: string
  from: string
  replyTo: string
  notify: string
  bookingUrl: string
  siteUrl: string
}

export function emailConfig(): EmailConfig {
  return {
    apiKey: (process.env.RESEND_API_KEY ?? '').trim(),
    from: (process.env.RECAP_FROM_EMAIL ?? '').trim(),
    replyTo: (process.env.RECAP_REPLY_TO ?? process.env.LEAD_NOTIFY_EMAIL ?? '').trim(),
    notify: (process.env.LEAD_NOTIFY_EMAIL ?? '').trim(),
    bookingUrl: (process.env.BOOKING_URL ?? '').trim(),
    siteUrl: (process.env.SITE_URL ?? '').trim().replace(/\/+$/, ''),
  }
}

export function isEmailConfigured(config = emailConfig()) {
  return Boolean(config.apiKey && config.from)
}

export function bookingHref(config = emailConfig()) {
  if (config.bookingUrl) return config.bookingUrl
  if (config.siteUrl) return `${config.siteUrl}#book`
  const inbox = config.replyTo || config.notify || 'nickperez@gmail.com'
  return `mailto:${inbox}?subject=${encodeURIComponent('Business OS intro call')}`
}

export function isBlockedGlimpse(value: unknown) {
  return Boolean(value && typeof value === 'object' && (value as { blocked?: unknown }).blocked === true)
}

export function asGlimpse(value: unknown): Glimpse | null {
  if (!value || typeof value !== 'object') return null

  const glimpse = value as Partial<Glimpse>
  if (typeof glimpse.company !== 'string' || !glimpse.company.trim()) return null
  if (typeof glimpse.overview !== 'string' || !glimpse.overview.trim()) return null
  if (!Array.isArray(glimpse.plays) || glimpse.plays.filter(Boolean).length < 1) return null

  return {
    company: glimpse.company.trim(),
    overview: glimpse.overview.trim(),
    observations: (Array.isArray(glimpse.observations) ? glimpse.observations : ['', '', '']).map(String) as Glimpse['observations'],
    plays: glimpse.plays.map(String) as Glimpse['plays'],
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function numbered(items: string[]) {
  return items.filter(Boolean).map((item, index) => `${index + 1}. ${item}`)
}

function htmlList(items: string[]) {
  return `<ol style="margin:0;padding-left:22px;color:#3A3F4B;">${items
    .filter(Boolean)
    .map((item) => `<li style="margin:0 0 10px;">${escapeHtml(item)}</li>`)
    .join('')}</ol>`
}

function wrapEmail(title: string, inner: string) {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#F4F5F8;font-family:Georgia,Times,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F8;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #E4E6EC;border-radius:12px;">
          <tr>
            <td style="padding:28px 32px 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5B7CFF;">
              Business OS
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 8px;font-size:26px;line-height:1.2;color:#14171F;">
              ${escapeHtml(title)}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px;font-size:16px;line-height:1.6;color:#3A3F4B;">
              ${inner}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function ctaBlock(href: string, label = 'Book a call') {
  return `<p style="margin:28px 0 8px;">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:#5B7CFF;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;padding:12px 18px;border-radius:8px;">
      ${escapeHtml(label)}
    </a>
  </p>
  <p style="margin:0;font-size:13px;color:#6A7180;">One conversation with operators. Not a self-serve drip.</p>`
}

export function buildGlimpseRecap(input: {
  domain: string
  email: string
  glimpse?: unknown
}): EmailMessage {
  const config = emailConfig()
  const href = bookingHref(config)
  const blocked = isBlockedGlimpse(input.glimpse)
  const glimpse = asGlimpse(input.glimpse)
  const company = glimpse?.company || input.domain
  const plays = glimpse?.plays?.filter(Boolean).slice(0, 3) ?? []

  if (blocked || !glimpse) {
    const subject = `We have ${input.domain} — next step from Business OS`
    const text = [
      `We logged ${input.domain}.`,
      '',
      'An operator will review the domain and follow up with the right next step.',
      `If you want to talk sooner, book a call: ${href}`,
    ].join('\n')

    return {
      from: config.from,
      to: input.email,
      replyTo: config.replyTo || undefined,
      subject,
      text,
      html: wrapEmail(
        `We have ${input.domain}`,
        `<p>An operator will review the domain and follow up with the right next step. This is not an automated subscribe sequence.</p>${ctaBlock(href)}`,
      ),
    }
  }

  const subject = `Your Business OS glimpse for ${company}`
  const text = [
    glimpse.overview,
    '',
    'The first three things we would put operators and agents on:',
    ...numbered(plays),
    '',
    `Book a call: ${href}`,
  ].join('\n')

  return {
    from: config.from,
    to: input.email,
    replyTo: config.replyTo || undefined,
    subject,
    text,
    html: wrapEmail(
      `Your glimpse for ${company}`,
      `<p>${escapeHtml(glimpse.overview)}</p>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6A7180;margin:24px 0 10px;">What we would put operators and agents on first</p>
       ${htmlList(plays)}
       ${ctaBlock(href)}`,
    ),
  }
}

export function buildSelfGuidedRecap(input: {
  email: string
  businessName: string
  plan: SelfGuidedPlan
}): EmailMessage {
  const config = emailConfig()
  const href = bookingHref(config)
  const title = input.plan.title || `${input.businessName} backend plan`
  const week = input.plan.firstWeek?.filter(Boolean).slice(0, 3) ?? []
  const automations = input.plan.automations?.filter(Boolean).slice(0, 3) ?? []

  const subject = `Your ${title}`
  const text = [
    input.plan.diagnosis,
    '',
    'This week:',
    ...numbered(week),
    '',
    'First automations:',
    ...numbered(automations),
    '',
    `If you want operators to install this with you, book a call: ${href}`,
  ].join('\n')

  return {
    from: config.from,
    to: input.email,
    replyTo: config.replyTo || undefined,
    subject,
    text,
    html: wrapEmail(
      title,
      `<p>${escapeHtml(input.plan.diagnosis)}</p>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6A7180;margin:24px 0 10px;">This week</p>
       ${htmlList(week)}
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6A7180;margin:24px 0 10px;">First automations</p>
       ${htmlList(automations)}
       ${ctaBlock(href)}`,
    ),
  }
}

export function buildLeadNotify(input: {
  domain?: string
  businessName?: string
  email: string
  phone?: string
  kind: 'glimpse' | 'self_guided'
  summary: string
}): EmailMessage {
  const config = emailConfig()
  const label = input.kind === 'glimpse' ? input.domain || 'unknown domain' : input.businessName || 'self-guided plan'
  const subject = `New ${input.kind === 'glimpse' ? 'glimpse lead' : 'self-guided plan'} — ${label}`
  const lines = [
    `Kind: ${input.kind}`,
    `Email: ${input.email}`,
    input.phone ? `Phone: ${input.phone}` : '',
    input.domain ? `Domain: ${input.domain}` : '',
    input.businessName ? `Business: ${input.businessName}` : '',
    '',
    input.summary,
  ].filter((line, index, all) => line || all[index - 1])

  return {
    from: config.from,
    to: config.notify,
    replyTo: input.email,
    subject,
    text: lines.join('\n'),
    html: wrapEmail(subject, `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:14px;color:#3A3F4B;">${escapeHtml(lines.join('\n'))}</pre>`),
  }
}

export async function deliverEmail(
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<Exclude<RecapStatus, 'skipped'>> {
  const config = emailConfig()
  if (!isEmailConfigured(config) || !message.to || !message.from) return 'disabled'

  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        reply_to: message.replyTo || undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    })

    if (!response.ok) {
      console.error('resend failed', response.status, await response.text().catch(() => ''))
      return 'failed'
    }

    return 'sent'
  } catch (error) {
    console.error('resend request failed', error)
    return 'failed'
  }
}

export async function sendGlimpseRecap(
  input: {
    domain: string
    email: string
    phone?: string
    glimpse?: unknown
    alreadySent?: boolean
  },
  fetchImpl: typeof fetch = fetch,
): Promise<RecapStatus> {
  if (input.alreadySent) return 'skipped'

  const recap = buildGlimpseRecap(input)
  const status = await deliverEmail(recap, fetchImpl)

  const config = emailConfig()
  if (status === 'sent' && config.notify && config.notify !== input.email) {
    const glimpse = asGlimpse(input.glimpse)
    await deliverEmail(
      buildLeadNotify({
        kind: 'glimpse',
        domain: input.domain,
        email: input.email,
        phone: input.phone,
        summary: glimpse?.overview || (isBlockedGlimpse(input.glimpse) ? 'Scan limit / blocked domain capture' : 'Lead captured without a full glimpse'),
      }),
      fetchImpl,
    )
  }

  return status
}

export async function sendSelfGuidedRecap(
  input: {
    email: string
    businessName: string
    plan: SelfGuidedPlan
    alreadySent?: boolean
  },
  fetchImpl: typeof fetch = fetch,
): Promise<RecapStatus> {
  if (!input.email) return 'skipped'
  if (input.alreadySent) return 'skipped'

  const status = await deliverEmail(buildSelfGuidedRecap(input), fetchImpl)
  const config = emailConfig()
  if (status === 'sent' && config.notify && config.notify !== input.email) {
    await deliverEmail(
      buildLeadNotify({
        kind: 'self_guided',
        businessName: input.businessName,
        email: input.email,
        summary: input.plan.diagnosis,
      }),
      fetchImpl,
    )
  }

  return status
}
