import { v4 as uuidv4 } from 'uuid'
import { parseRouteFile } from '@/lib/parse-route'
import { enrichFromOverpass } from '@/lib/overpass'
import { enrichWeather } from '@/lib/nws'
import { enrichPublicLands } from '@/lib/lands'
import { enrichCoverage } from '@/lib/coverage'
import { enrichMapillaryImagery } from '@/lib/mapillary'
import { storeResult } from '@/lib/store'
import type { ReconResult, AnalyzeRequest } from '@/lib/types'

export const maxDuration = 60 // seconds

// ─── POST /api/analyze ────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const body: AnalyzeRequest = await req.json()

    const { file_data, file_name, url, ride_date } = body

    if (!file_data && !url) {
      return Response.json({ error: 'No route file provided.' }, { status: 400 })
    }

    if (!ride_date) {
      return Response.json({ error: 'Ride date is required.' }, { status: 400 })
    }

    // ── 1. Parse route ──────────────────────────────────────────────────────
    let fileContent: string
    let resolvedFileName: string

    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`Failed to fetch route URL: ${res.status}`)
      fileContent = await res.text()
      // Detect HTML response (Strava/MapMyRide login walls, etc.)
      const trimmed = fileContent.trimStart()
      if (trimmed.startsWith('<!') || trimmed.toLowerCase().startsWith('<html')) {
        throw new Error('STRAVA_AUTH_REQUIRED')
      }
      const pathPart = new URL(url).pathname.split('/').pop() ?? 'route.gpx'
      // If the path has no recognizable extension, assume GPX
      resolvedFileName = /\.(gpx|tcx)$/i.test(pathPart) ? pathPart : `${pathPart}.gpx`
    } else {
      fileContent = Buffer.from(file_data!, 'base64').toString('utf-8')
      resolvedFileName = file_name!
    }
    const route = await parseRouteFile(fileContent, resolvedFileName, ride_date)

    // ── 2. Fan out to data sources in parallel ──────────────────────────────
    const errors: Record<string, string> = {}

    const [osmResult, weatherResult, landsResult, coverageResult, imageryResult] = await Promise.allSettled([
      enrichFromOverpass(route),
      enrichWeather(route.sample_points, route.bbox, route.ride_date),
      enrichPublicLands(route),
      enrichCoverage(route.sample_points),
      enrichMapillaryImagery(route),
    ])

    const { surfaces, surface_segments, pois, supply_gaps, bailouts } =
      osmResult.status === 'fulfilled'
        ? osmResult.value
        : (() => { errors['osm'] = osmResult.reason?.message ?? 'OSM enrichment failed'; return { surfaces: [], surface_segments: [], pois: [], supply_gaps: [], bailouts: [] } })()

    const weather =
      weatherResult.status === 'fulfilled'
        ? weatherResult.value
        : (() => { errors['weather'] = weatherResult.reason?.message ?? 'Weather fetch failed'; return { segments: [], alerts: [], provider: 'nws' as const, reference_speed_kph: 16 / 0.621371, ride_start_hour: 9 } })()

    const lands =
      landsResult.status === 'fulfilled'
        ? landsResult.value
        : (() => { errors['lands'] = landsResult.reason?.message ?? 'Public lands fetch failed'; return [] })()

    const coverage =
      coverageResult.status === 'fulfilled'
        ? coverageResult.value
        : (() => { errors['coverage'] = coverageResult.reason?.message ?? 'Coverage fetch failed'; return [] })()

    const imagery =
      imageryResult.status === 'fulfilled'
        ? imageryResult.value
        : (() => { errors['imagery'] = imageryResult.reason?.message ?? 'Imagery fetch failed'; return [] })()

    // ── 3. AI narrative (if Anthropic key is configured) ───────────────────
    let narrative = ''
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        narrative = await Promise.race([
          generateNarrative({ route, surfaces, pois, supply_gaps, weather, lands }),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('narrative timeout')), 3_000)),
        ])
      } catch (e) {
        errors['narrative'] = (e as Error).message
      }
    }

    // ── 4. Assemble and store result ────────────────────────────────────────
    const result: ReconResult = {
      id: uuidv4(),
      created_at: new Date().toISOString(),
      route,
      surfaces,
      surface_segments,
      pois,
      supply_gaps,
      bailouts,
      weather,
      lands,
      coverage,
      imagery,
      narrative,
      errors,
    }

    await storeResult(result)

    return Response.json({ id: result.id })
  } catch (err) {
    console.error('[analyze]', err)
    return Response.json(
      { error: (err as Error).message ?? 'Analysis failed.' },
      { status: 500 },
    )
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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
Distance: ${data.route.distance_km} km (${(data.route.distance_km * 0.621371).toFixed(1)} mi)
Elevation gain: ${data.route.elevation_gain_m} m (${(data.route.elevation_gain_m * 3.28084).toFixed(0)} ft)
Ride date: ${data.route.ride_date}

Surface breakdown: ${surfaceSummary || 'unknown'}
Points of interest: ${poiSummary || 'none found'}
Supply gaps: ${gapSummary || 'none'}
Weather: ${weatherSummary}
Land management: ${landSummary}

Write from the perspective of an experienced route scout. Cover: terrain and surface character, weather considerations, resupply and water strategy, any bailout points or emergency access, and overall ride readiness. Be specific and actionable. Do not use bullet points or headers — flowing paragraphs only.`

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })

  const block = message.content[0]
  return block.type === 'text' ? block.text : ''
}
