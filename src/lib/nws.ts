import type { RoutePoint, WeatherResult, WeatherSegment, WeatherAlert, WeatherRisk } from './types'

const NWS_BASE = 'https://api.weather.gov'
const USER_AGENT = 'RECON/1.0 (recon.mettlecycling.com)'

// ─── NWS API types ────────────────────────────────────────────────────────────

interface NwsPointResponse {
  properties: {
    forecast: string
    forecastHourly: string
    gridId: string
    gridX: number
    gridY: number
    relativeLocation?: {
      properties: { city: string; state: string }
    }
  }
}

interface NwsForecastPeriod {
  number: number
  name: string
  startTime: string
  endTime: string
  isDaytime: boolean
  temperature: number
  temperatureUnit: string
  windSpeed: string
  windDirection: string
  shortForecast: string
  detailedForecast: string
  probabilityOfPrecipitation?: { value: number | null }
}

interface NwsForecastResponse {
  properties: {
    periods: NwsForecastPeriod[]
  }
}

interface NwsAlertFeature {
  properties: {
    event: string
    headline: string
    description: string
    severity: string
    areaDesc: string
    onset?: string
    expires?: string
  }
}

interface NwsAlertsResponse {
  features: NwsAlertFeature[]
}

// ─── Risk classification ──────────────────────────────────────────────────────

function classifyRisk(period: NwsForecastPeriod): WeatherRisk {
  const desc = period.shortForecast.toLowerCase()
  const precip = period.probabilityOfPrecipitation?.value ?? 0
  const wind = parseInt(period.windSpeed) || 0

  if (desc.includes('thunderstorm') || desc.includes('severe') || wind > 50) return 'red'
  if (precip > 60 || desc.includes('storm') || desc.includes('heavy') || wind > 30) return 'amber'
  return 'green'
}

function fahrenheitToCelsius(f: number): number {
  return Math.round((f - 32) * 5 / 9 * 10) / 10
}

function mphToKph(mph: number): number {
  return Math.round(mph * 1.60934 * 10) / 10
}

function parseWindSpeed(windSpeed: string): number {
  // NWS returns e.g. "10 mph" or "10 to 15 mph"
  const match = windSpeed.match(/(\d+)(?:\s+to\s+(\d+))?\s+mph/i)
  if (!match) return 0
  const low = parseInt(match[1])
  const high = match[2] ? parseInt(match[2]) : low
  return Math.round((low + high) / 2)
}

// ─── NWS point fetch (with retry + timeout) ───────────────────────────────────

async function nwsFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`NWS ${res.status}: ${url}`)
  return res
}

// ─── Get weather for a single point ──────────────────────────────────────────

async function getSegmentWeather(point: RoutePoint): Promise<WeatherSegment | null> {
  try {
    const pointRes = await nwsFetch(
      `${NWS_BASE}/points/${point.lat.toFixed(4)},${point.lng.toFixed(4)}`
    )
    const pointData: NwsPointResponse = await pointRes.json()
    const forecastUrl = pointData.properties.forecast

    const forecastRes = await nwsFetch(forecastUrl)
    const forecastData: NwsForecastResponse = await forecastRes.json()

    // Use the first daytime period (or first period if none)
    const periods = forecastData.properties.periods
    const period = periods.find(p => p.isDaytime) ?? periods[0]
    if (!period) return null

    const tempF = period.temperature
    const windMph = parseWindSpeed(period.windSpeed)

    return {
      lat: point.lat,
      lng: point.lng,
      distance_km: point.distance_km,
      temp_c: fahrenheitToCelsius(tempF),
      wind_speed_kph: mphToKph(windMph),
      wind_dir: period.windDirection,
      precipitation_chance: period.probabilityOfPrecipitation?.value ?? 0,
      description: period.shortForecast,
      risk: classifyRisk(period),
    }
  } catch {
    return null
  }
}

// ─── Get active alerts for route bbox ────────────────────────────────────────

async function getAlerts(
  minLat: number, minLng: number, maxLat: number, maxLng: number
): Promise<WeatherAlert[]> {
  try {
    const url = `${NWS_BASE}/alerts/active?status=actual&area=&point=` +
      // Use center point for alerts
      `${((minLat + maxLat) / 2).toFixed(4)},${((minLng + maxLng) / 2).toFixed(4)}`

    const res = await nwsFetch(url)
    const data: NwsAlertsResponse = await res.json()

    return (data.features ?? []).map(f => ({
      severity: normalizeSeverity(f.properties.severity),
      title: f.properties.event,
      description: f.properties.headline || f.properties.description.slice(0, 300),
      areas: f.properties.areaDesc,
      onset: f.properties.onset,
      expires: f.properties.expires,
      source: 'nws' as const,
    }))
  } catch {
    return []
  }
}

function normalizeSeverity(s: string): WeatherAlert['severity'] {
  const l = s.toLowerCase()
  if (l.includes('extreme')) return 'extreme'
  if (l.includes('severe')) return 'severe'
  if (l.includes('moderate')) return 'moderate'
  return 'minor'
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function enrichWeather(
  samplePoints: RoutePoint[],
  bbox: [number, number, number, number],
): Promise<WeatherResult> {
  const [minLng, minLat, maxLng, maxLat] = bbox

  // Limit to max 6 points to respect NWS rate limits
  const MAX_POINTS = 6
  const step = Math.max(1, Math.floor(samplePoints.length / MAX_POINTS))
  const points = samplePoints.filter((_, i) => i % step === 0).slice(0, MAX_POINTS)

  // Fetch weather for each point in parallel (with graceful failure per point)
  const segmentResults = await Promise.all(points.map(getSegmentWeather))
  const segments = segmentResults.filter((s): s is WeatherSegment => s !== null)

  const alerts = await getAlerts(minLat, minLng, maxLat, maxLng)

  return {
    segments,
    alerts,
    provider: 'nws',
  }
}
