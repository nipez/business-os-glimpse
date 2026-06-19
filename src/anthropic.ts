import Anthropic from '@anthropic-ai/sdk'

export type Glimpse = {
  company: string
  overview: string
  observations: [string, string, string]
  plays: [string, string, string]
}

const MODEL = 'claude-sonnet-4-6'
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

function promptFor(url: string) {
  return `You are the research agent for "Business OS", a firm that embeds two senior operators
plus AI agents into companies to scale them. Research the company at this website and
produce a punchy "glimpse" for the owner. Use web search to ground it in real facts.

Website: https://${url}

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

Return ONLY valid JSON (no markdown, no code fences), exactly this shape:
{"company":"the brand name",
 "overview":"2 tight sentences: what they do and where they're at",
 "observations":["3 sharp, specific, true-and-slightly-flattering insights about their position — reference real details you found"],
 "plays":["3 concrete things our operating team + AI agents would run for THEM first, specific to this business"]}`
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

export async function research(url: string): Promise<Glimpse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: promptFor(url) }],
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search' } as any],
  })

  return parseGlimpse(response.content as unknown[])
}
