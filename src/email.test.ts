import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { SelfGuidedPlan } from './anthropic.js'
import {
  asGlimpse,
  bookingHref,
  buildGlimpseRecap,
  buildSelfGuidedRecap,
  deliverEmail,
  isBlockedGlimpse,
  sendGlimpseRecap,
} from './email.js'

const envKeys = [
  'RESEND_API_KEY',
  'RECAP_FROM_EMAIL',
  'RECAP_REPLY_TO',
  'LEAD_NOTIFY_EMAIL',
  'BOOKING_URL',
  'SITE_URL',
] as const

const previous = new Map<string, string | undefined>()

function setEnv(values: Partial<Record<(typeof envKeys)[number], string>>) {
  for (const key of envKeys) {
    if (!previous.has(key)) previous.set(key, process.env[key])
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  previous.clear()
})

const glimpse = {
  company: 'Holy Cow!',
  overview: 'A DTC lactose-intolerance brand past proof-of-concept.',
  observations: ['Wedge is defensible.', 'Support still runs through the founder.', 'Reviews are unused.'] as [string, string, string],
  plays: [
    'Stand up a retention agent on subscription data.',
    'Put a support agent on the repetitive questions.',
    'Loop reviews back into Meta ad language.',
  ] as [string, string, string],
}

const plan: SelfGuidedPlan = {
  title: 'Holy Cow Backend OS',
  diagnosis: 'The founder is still the operating system.',
  backend: ['Source of truth', 'Workflow command center', 'Visibility dashboard'] as [string, string, string],
  automations: ['Stale-work alert', 'Follow-up sequence', 'Weekly brief'] as [string, string, string],
  buildOrder: ['Audit tools', 'Schema', 'First alert', 'Weekly review'] as [string, string, string, string],
  firstWeek: ['List stalled work', 'Pick one home tool', 'Draft the first template'] as [string, string, string],
  stack: ['Airtable', 'Zapier', 'Looker Studio'] as [string, string, string],
}

test('asGlimpse and blocked detection', () => {
  assert.equal(asGlimpse(glimpse)?.company, 'Holy Cow!')
  assert.equal(asGlimpse({ blocked: true }), null)
  assert.equal(isBlockedGlimpse({ blocked: true, reason: 'scan_limit_reached' }), true)
  assert.equal(isBlockedGlimpse(glimpse), false)
})

test('glimpse recap uses operator tone, three plays, and a book-a-call CTA', () => {
  setEnv({
    RECAP_FROM_EMAIL: 'Haig <haig@updates.businessos.dev>',
    BOOKING_URL: 'https://cal.com/business-os/intro',
  })

  const message = buildGlimpseRecap({
    domain: 'getholycow.com',
    email: 'founder@getholycow.com',
    glimpse,
  })

  assert.equal(message.subject, 'Your Business OS glimpse for Holy Cow!')
  assert.match(message.text, /A DTC lactose-intolerance brand/)
  assert.match(message.text, /1\. Stand up a retention agent/)
  assert.match(message.text, /2\. Put a support agent/)
  assert.match(message.text, /3\. Loop reviews back/)
  assert.match(message.text, /Book a call: https:\/\/cal.com\/business-os\/intro/)
  assert.match(message.html, /Book a call/)
  assert.doesNotMatch(message.text, /subscribe/i)
  assert.doesNotMatch(message.html, /subscribe/i)
  assert.doesNotMatch(message.text, /fully autonomous/i)
})

test('blocked glimpse recap does not invent plays', () => {
  setEnv({ BOOKING_URL: 'https://cal.com/business-os/intro' })

  const message = buildGlimpseRecap({
    domain: 'acme.com',
    email: 'pat@acme.com',
    glimpse: { blocked: true, reason: 'scan_limit_reached' },
  })

  assert.match(message.subject, /acme.com/)
  assert.match(message.text, /We logged acme.com/)
  assert.doesNotMatch(message.text, /1\. /)
  assert.match(message.html, /Book a call/)
})

test('self-guided recap includes week-one actions and a single CTA', () => {
  setEnv({ BOOKING_URL: 'https://cal.com/business-os/intro' })

  const message = buildSelfGuidedRecap({
    email: 'founder@getholycow.com',
    businessName: 'Holy Cow',
    plan,
  })

  assert.equal(message.subject, 'Your Holy Cow Backend OS')
  assert.match(message.text, /This week:/)
  assert.match(message.text, /List stalled work/)
  assert.match(message.html, /Book a call/)
  assert.doesNotMatch(message.text, /subscribe/i)
})

test('booking href falls back to site or mailto', () => {
  setEnv({ SITE_URL: 'https://businessos.dev/' })
  assert.equal(bookingHref(), 'https://businessos.dev#book')

  setEnv({ RECAP_REPLY_TO: 'ops@businessos.dev' })
  assert.match(bookingHref(), /^mailto:ops@businessos.dev/)
})

test('deliverEmail is disabled without secrets and reports Resend failures', async () => {
  setEnv({})
  assert.equal(await deliverEmail(buildGlimpseRecap({ domain: 'x.com', email: 'a@b.com', glimpse })), 'disabled')

  setEnv({
    RESEND_API_KEY: 're_test',
    RECAP_FROM_EMAIL: 'Haig <haig@updates.businessos.dev>',
  })

  const failed = await deliverEmail(
    buildGlimpseRecap({ domain: 'x.com', email: 'a@b.com', glimpse }),
    async () => new Response('nope', { status: 401 }),
  )
  assert.equal(failed, 'failed')

  const sent = await deliverEmail(
    buildGlimpseRecap({ domain: 'x.com', email: 'a@b.com', glimpse }),
    async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }),
  )
  assert.equal(sent, 'sent')
})

test('sendGlimpseRecap skips duplicates and can notify operators', async () => {
  setEnv({
    RESEND_API_KEY: 're_test',
    RECAP_FROM_EMAIL: 'Haig <haig@updates.businessos.dev>',
    LEAD_NOTIFY_EMAIL: 'nickperez@gmail.com',
  })

  assert.equal(
    await sendGlimpseRecap({
      domain: 'getholycow.com',
      email: 'founder@getholycow.com',
      glimpse,
      alreadySent: true,
    }),
    'skipped',
  )

  const urls: string[] = []
  const status = await sendGlimpseRecap(
    {
      domain: 'getholycow.com',
      email: 'founder@getholycow.com',
      phone: '555-0100',
      glimpse,
    },
    async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 })
    },
  )

  assert.equal(status, 'sent')
  assert.equal(urls.length, 2)
})
