import Anthropic from '@anthropic-ai/sdk'

export type Glimpse = {
  company: string
  overview: string
  observations: [string, string, string]
  plays: [string, string, string]
}

export type SelfGuidedInput = {
  businessName: string
  website?: string
  stage: string
  teamSize: string
  tools: string
  bottleneck: string
  goal: string
  owner: string
}

export type SelfGuidedPlan = {
  title: string
  diagnosis: string
  backend: [string, string, string]
  automations: [string, string, string]
  buildOrder: [string, string, string, string]
  firstWeek: [string, string, string]
  stack: [string, string, string]
}

const MODEL = 'claude-sonnet-4-6'
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

async function fetchHomepageText(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(`https://${url}`, {
      signal: controller.signal,
      headers: {
        'user-agent': 'BusinessOS-Glimpse/1.0',
      },
    })

    if (!response.ok) return ''

    const html = await response.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000)
  } catch {
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

function promptFor(url: string, homepageText: string) {
  return `You are the research agent for "Business OS", a firm that embeds two senior operators
plus AI agents into companies to scale them. Research the company at this website and
produce a punchy "glimpse" for the owner. Use web search to ground it in real facts.

Website: https://${url}

Exact-domain homepage text:
${homepageText || '(Homepage text unavailable. Use web search, but only facts tied to the exact domain.)'}

Critical accuracy rules:
- Identify the company from the exact domain above first. Do not substitute a different
  company with a similar name.
- If web search finds multiple companies with the same or similar brand name, use only
  facts that clearly refer to https://${url} or pages that explicitly mention this exact
  domain.
- If a fact conflicts with the website at https://${url}, trust the exact website and
  ignore the conflicting source.
- The overview, observations, and plays must be specific to the business on this exact
  domain, not a similarly named business.
- If the exact-domain homepage text indicates a different category than a search result,
  the search result is for the wrong company and must be ignored.

Return ONLY valid JSON (no markdown, no code fences), exactly this shape:
{"company":"the brand name",
 "overview":"2 tight sentences: what they do and where they're at",
 "observations":["3 sharp, specific, true-and-slightly-flattering insights about their position — reference real details you found"],
 "plays":["3 concrete things our operating team + AI agents would run for THEM first, specific to this business"]}`
}

function selfGuidedPrompt(input: SelfGuidedInput) {
  return `You are designing a self-guided backend operating system build for a founder.
The product is Business OS Self-Guided: it gives founders a practical build plan they
can execute without hiring hands-on operators.

Business:
- Name: ${input.businessName}
- Website: ${input.website || 'not provided'}
- Stage/revenue: ${input.stage}
- Team size: ${input.teamSize}
- Current tools: ${input.tools}
- Biggest bottleneck: ${input.bottleneck}
- 90-day goal: ${input.goal}
- Main owner/user: ${input.owner}

Write like a senior operator and product builder. Be specific, but do not pretend to
know details the founder did not provide. The plan should feel premium, clear, and
more useful than a generic automation checklist.

Return ONLY valid JSON (no markdown, no code fences), exactly this shape:
{"title":"short name for the build",
 "diagnosis":"2 tight sentences on what their backend is missing and why it matters",
 "backend":["3 backend modules they need, each specific and concrete"],
 "automations":["3 automations or agent workflows to build first"],
 "buildOrder":["4 ordered implementation steps, written as commands"],
 "firstWeek":["3 concrete actions they can complete this week"],
 "stack":["3 recommended tool/data layers or system components"]}`
}

function asTriple(value: unknown): [string, string, string] | null {
  if (!Array.isArray(value) || value.length < 3) return null

  const items = value.slice(0, 3)
  if (!items.every((item) => typeof item === 'string' && item.trim())) return null

  return [items[0], items[1], items[2]]
}

function parseGlimpse(content: unknown[]): Glimpse {
  const text = content
    .filter((block): block is { type: string; text: string } => {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        'text' in block &&
        block.type === 'text' &&
        typeof block.text === 'string'
      )
    })
    .map((block) => block.text)
    .join('\n')

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Anthropic response did not include JSON')

  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    company?: unknown
    overview?: unknown
    observations?: unknown
    plays?: unknown
  }

  const observations = asTriple(parsed.observations)
  const plays = asTriple(parsed.plays)

  if (
    typeof parsed.company !== 'string' ||
    !parsed.company.trim() ||
    typeof parsed.overview !== 'string' ||
    !parsed.overview.trim() ||
    !observations ||
    !plays
  ) {
    throw new Error('Anthropic response did not match glimpse shape')
  }

  return {
    company: parsed.company,
    overview: parsed.overview,
    observations,
    plays,
  }
}

function parseSelfGuidedPlan(content: unknown[]): SelfGuidedPlan {
  const text = content
    .filter((block): block is { type: string; text: string } => {
      return (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        'text' in block &&
        block.type === 'text' &&
        typeof block.text === 'string'
      )
    })
    .map((block) => block.text)
    .join('\n')

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Anthropic response did not include JSON')

  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    title?: unknown
    diagnosis?: unknown
    backend?: unknown
    automations?: unknown
    buildOrder?: unknown
    firstWeek?: unknown
    stack?: unknown
  }

  const backend = asTriple(parsed.backend)
  const automations = asTriple(parsed.automations)
  const firstWeek = asTriple(parsed.firstWeek)
  const stack = asTriple(parsed.stack)
  const buildOrder =
    Array.isArray(parsed.buildOrder) &&
    parsed.buildOrder.length >= 4 &&
    parsed.buildOrder.slice(0, 4).every((item) => typeof item === 'string' && item.trim())
      ? (parsed.buildOrder.slice(0, 4) as [string, string, string, string])
      : null

  if (
    typeof parsed.title !== 'string' ||
    !parsed.title.trim() ||
    typeof parsed.diagnosis !== 'string' ||
    !parsed.diagnosis.trim() ||
    !backend ||
    !automations ||
    !buildOrder ||
    !firstWeek ||
    !stack
  ) {
    throw new Error('Anthropic response did not match self-guided plan shape')
  }

  return {
    title: parsed.title,
    diagnosis: parsed.diagnosis,
    backend,
    automations,
    buildOrder,
    firstWeek,
    stack,
  }
}

export async function research(url: string): Promise<Glimpse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const anthropic = new Anthropic({ apiKey })
  const homepageText = await fetchHomepageText(url)
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: promptFor(url, homepageText) }],
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search' } as any],
  })

  return parseGlimpse(response.content as unknown[])
}

export async function buildSelfGuidedPlan(input: SelfGuidedInput): Promise<SelfGuidedPlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: selfGuidedPrompt(input) }],
  })

  return parseSelfGuidedPlan(response.content as unknown[])
}
