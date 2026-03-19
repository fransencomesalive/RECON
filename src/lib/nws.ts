import type { HourlyPeriod, RoutePoint, WeatherAlert, WeatherResult, WeatherRisk, WeatherSegment } from './types'

const NWS_BASE   = 'https://api.weather.gov'
const USER_AGENT = 'RECON/1.0 (recon.mettlecycling.com)'

const REFERENCE_SPEED_KPH = 16 / 0.621371  // 16 mph — default analysis speed
const REFERENCE_START_HOUR = 9              // default start hour (9 AM)

// ─── NWS API types ────────────────────────────────────────────────────────────

interface NwsPointResponse {
  properties: {
    forecast: string
    forecastHourly: string
    gridId: string
    gridX: number
    gridY: number
  }
}

interface NwsForecastPeriod {
  number: number
  startTime: string
  endTime: string
  isDaytime: boolean
  temperature: number
  temperatureUnit: string
  windSpeed: string
  windDirection: string
  shortForecast: string
  probabilityOfPrecipitation?: { value: number | null }
}

interface NwsForecastResponse {
  properties: { periods: NwsForecastPeriod[] }
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
  const desc   = period.shortForecast.toLowerCase()
  const precip = period.probabilityOfPrecipitation?.value ?? 0
  const wind   = parseInt(period.windSpeed) || 0

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
  const match = windSpeed.match(/(\d+)(?:\s+to\s+(\d+))?\s+mph/i)
  if (!match) return 0
  const low  = parseInt(match[1])
  const high = match[2] ? parseInt(match[2]) : low
  return Math.round((low + high) / 2)
}

function periodToHourly(p: NwsForecastPeriod): HourlyPeriod {
  return {
    start_time:           p.startTime,
    temp_c:               fahrenheitToCelsius(p.temperature),
    wind_speed_kph:       mphToKph(parseWindSpeed(p.windSpeed)),
    wind_dir:             p.windDirection,
    precipitation_chance: p.probabilityOfPrecipitation?.value ?? 0,
    description:          p.shortForecast,
    risk:                 classifyRisk(p),
  }
}

// ─── NWS fetch helper ─────────────────────────────────────────────────────────

async function nwsFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`NWS ${res.status}: ${url}`)
  return res
}

// ─── Naismith arrival time ─────────────────────────────────────────────────────
// Returns fractional hours from ride start to reach a given point.
// Formula: distance / speed  +  climbing / 600 m·h⁻¹

function naisimithHours(distanceKm: number, cumulativeGainM: number, speedKph: number): number {
  return distanceKm / speedKph + cumulativeGainM / 600
}

// Compute cumulative elevation gain (m) from start to each sample point.
function cumulativeGains(points: RoutePoint[]): number[] {
  const gains: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].elevation_m - points[i - 1].elevation_m
    gains.push(gains[i - 1] + Math.max(0, delta))
  }
  return gains
}

// ─── Get weather for a single point ──────────────────────────────────────────
// arrivalHour: fractional hour-of-day when cyclist is expected to reach this point.
// rideDate: 'YYYY-MM-DD' — used to filter forecast periods to the ride day.

async function getSegmentWeather(
  point: RoutePoint,
  cumulativeGainM: number,
  arrivalHour: number,
  rideDate: string,
): Promise<WeatherSegment | null> {
  try {
    const pointRes  = await nwsFetch(`${NWS_BASE}/points/${point.lat.toFixed(4)},${point.lng.toFixed(4)}`)
    const pointData: NwsPointResponse = await pointRes.json()

    // Use hourly endpoint for time-aware forecasting
    const hourlyRes  = await nwsFetch(pointData.properties.forecastHourly)
    const hourlyData: NwsForecastResponse = await hourlyRes.json()

    const allPeriods = hourlyData.properties.periods

    // Filter to periods on the ride date (NWS startTime is local ISO, date is the prefix)
    const dayPeriods = allPeriods.filter(p => p.startTime.startsWith(rideDate))
    // Fall back to first available periods if ride date is in the past or unavailable
    const periods = dayPeriods.length > 0 ? dayPeriods : allPeriods.slice(0, 12)

    if (periods.length === 0) return null

    const hourlyForecast: HourlyPeriod[] = periods.map(periodToHourly)

    // Pick the period closest to the estimated arrival hour
    const targetHour = Math.floor(arrivalHour)
    const match = hourlyForecast.find(p => {
      const h = new Date(p.start_time).getHours()
      return h >= targetHour
    }) ?? hourlyForecast[hourlyForecast.length - 1]

    return {
      lat:                  point.lat,
      lng:                  point.lng,
      distance_km:          point.distance_km,
      cumulative_gain_m:    cumulativeGainM,
      temp_c:               match.temp_c,
      wind_speed_kph:       match.wind_speed_kph,
      wind_dir:             match.wind_dir,
      precipitation_chance: match.precipitation_chance,
      description:          match.description,
      risk:                 match.risk,
      hourly_forecast:      hourlyForecast,
    }
  } catch (err) {
    console.error('[nws] getSegmentWeather failed for', point.lat.toFixed(4), point.lng.toFixed(4), (err as Error).message)
    return null
  }
}

// ─── Get active alerts for route bbox ────────────────────────────────────────

async function getAlerts(
  minLat: number, minLng: number, maxLat: number, maxLng: number
): Promise<WeatherAlert[]> {
  try {
    const url = `${NWS_BASE}/alerts/active?status=actual&` +
      `point=${((minLat + maxLat) / 2).toFixed(4)},${((minLng + maxLng) / 2).toFixed(4)}`
    const res  = await nwsFetch(url)
    const data: NwsAlertsResponse = await res.json()
    return (data.features ?? []).map(f => ({
      severity:    normalizeSeverity(f.properties.severity),
      title:       f.properties.event,
      description: f.properties.headline || f.properties.description.slice(0, 300),
      areas:       f.properties.areaDesc,
      onset:       f.properties.onset,
      expires:     f.properties.expires,
      source:      'nws' as const,
    }))
  } catch (err) {
    console.error('[nws] getAlerts failed:', (err as Error).message)
    return []
  }
}

function normalizeSeverity(s: string): WeatherAlert['severity'] {
  const l = s.toLowerCase()
  if (l.includes('extreme'))  return 'extreme'
  if (l.includes('severe'))   return 'severe'
  if (l.includes('moderate')) return 'moderate'
  return 'minor'
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function enrichWeather(
  samplePoints: RoutePoint[],
  bbox: [number, number, number, number],
  rideDate: string,
): Promise<WeatherResult> {
  const [minLng, minLat, maxLng, maxLat] = bbox

  // Limit to max 6 points to respect NWS rate limits
  const MAX_POINTS = 6
  const step   = Math.max(1, Math.floor(samplePoints.length / MAX_POINTS))
  const points = samplePoints.filter((_, i) => i % step === 0).slice(0, MAX_POINTS)

  // Compute cumulative gain for the selected subset
  const gains = cumulativeGains(points)

  // Compute estimated arrival hour for each selected point
  const arrivalHours = points.map((p, i) =>
    REFERENCE_START_HOUR + naisimithHours(p.distance_km, gains[i], REFERENCE_SPEED_KPH)
  )

  // Fetch hourly weather for each point in parallel
  const segmentResults = await Promise.all(
    points.map((p, i) => getSegmentWeather(p, gains[i], arrivalHours[i], rideDate))
  )
  const segments = segmentResults.filter((s): s is WeatherSegment => s !== null)

  const alerts = await getAlerts(minLat, minLng, maxLat, maxLng)

  return {
    segments,
    alerts,
    provider:             'nws',
    reference_speed_kph:  REFERENCE_SPEED_KPH,
    ride_start_hour:      REFERENCE_START_HOUR,
  }
}
