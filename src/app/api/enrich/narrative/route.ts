import { getRoute } from '@/lib/store'
import type { NarrativeRequest, ReconResult } from '@/lib/types'

export const maxDuration = 30

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ narrative: '' })
  }

  try {
    const body: NarrativeRequest = await req.json()
    const { id, surfaces, pois, supply_gaps, weather, lands } = body
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const narrative = await Promise.race([
      generateNarrative({ route, surfaces, pois, supply_gaps, weather, lands }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('narrative timeout')), 25_000)),
    ])

    return Response.json({ narrative })
  } catch (err) {
    console.error('[enrich/narrative]', err)
    return Response.json({ error: (err as Error).message ?? 'Narrative generation failed.' }, { status: 500 })
  }
}

// ─── AI narrative generation ──────────────────────────────────────────────────

async function generateNarrative(data: {
  route: ReconResult['route']
  surfaces: ReconResult['surfaces']
  pois: ReconResult['pois']
  supply_gaps: ReconResult['supply_gaps']
  weather: ReconResult['weather']
  lands: ReconResult['lands']
}): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 0,
  })

  const surfaceSummary = data.surfaces
    .map(s => `${s.pct}% ${s.type} (${s.km} km)`)
    .join(', ')

  const poiSummary = data.pois
    .slice(0, 12)
    .map(p => `${p.type} "${p.name}" at km ${p.distance_km}${p.potable === false ? ' (non-potable)' : ''}`)
    .join('; ')

  const gapSummary = data.supply_gaps
    .map(g => `km ${g.from_km}–${g.to_km}: ${g.description}`)
    .join('; ')

  const weatherSummary = data.weather.alerts.length
    ? data.weather.alerts.map(a => `${a.severity.toUpperCase()}: ${a.title}`).join('; ')
    : data.weather.segments.length
    ? `Conditions along route: ${data.weather.segments.map(s => s.description).join(' → ')}`
    : 'No weather data available.'

  const landSummary = data.lands
    .map(l => `${l.name} (${l.agency})`)
    .join(', ') || 'No federal land crossings identified.'

  const prompt = `You are a cycling route analyst. Write a concise 3–4 paragraph plain-language planning summary for a cyclist preparing for this route.

Route: "${data.route.name}"
Distance: ${data.route.distance_km} km
Elevation gain: ${data.route.elevation_gain_m} m
Ride date: ${data.route.ride_date}

Surface breakdown: ${surfaceSummary || 'unknown'}
Points of interest: ${poiSummary || 'none found'}
Supply gaps: ${gapSummary || 'none'}
Weather: ${weatherSummary}
Land management: ${landSummary}

Write from the perspective of an experienced route scout. Cover: terrain and surface character, weather considerations, resupply and water strategy, any bailout points or emergency access, and overall ride readiness. Be specific and actionable. Do not use bullet points or headers — flowing paragraphs only.`

  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 20_000)
  let message
  try {
    message = await client.messages.create(
      { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
      { signal: controller.signal },
    )
  } finally {
    clearTimeout(abortTimer)
  }

  const block = message!.content[0]
  return block.type === 'text' ? block.text : ''
}
