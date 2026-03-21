import type { WindField, WindGridPoint } from './types'

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'

// ─── Grid sizing ──────────────────────────────────────────────────────────────

function gridSize(distanceKm: number): { cols: number; rows: number } {
  if (distanceKm < 20)  return { cols: 3, rows: 3 }
  if (distanceKm < 80)  return { cols: 4, rows: 4 }
  return                       { cols: 5, rows: 5 }
}

// ─── Bbox expansion ───────────────────────────────────────────────────────────
// Expand by 0.5° so particles have wind data well beyond the route corridor.

function expandBbox(
  bbox: [number, number, number, number],
  pad = 0.5,
): [number, number, number, number] {
  return [
    Math.max(-180, bbox[0] - pad),
    Math.max(-90,  bbox[1] - pad),
    Math.min(180,  bbox[2] + pad),
    Math.min(90,   bbox[3] + pad),
  ]
}

// ─── Single-point Open-Meteo fetch ───────────────────────────────────────────

interface OpenMeteoHourly {
  time: string[]
  wind_u_10m: number[]
  wind_v_10m: number[]
}

async function fetchWindPoint(
  lat: number,
  lng: number,
  rideDate: string,
): Promise<WindGridPoint | null> {
  try {
    const url =
      `${OPEN_METEO}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=wind_u_10m,wind_v_10m` +
      `&start_date=${rideDate}&end_date=${rideDate}` +
      `&wind_speed_unit=ms&timezone=auto&forecast_days=1`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) return null

    const data: { hourly: OpenMeteoHourly } = await res.json()
    const { time, wind_u_10m, wind_v_10m } = data.hourly

    // Extract 24 values for the ride date, one per hour (0–23).
    // Open-Meteo with timezone=auto returns local-time hours.
    const hourly_u: number[] = new Array(24).fill(0)
    const hourly_v: number[] = new Array(24).fill(0)

    for (let i = 0; i < time.length; i++) {
      const t = time[i]
      if (!t.startsWith(rideDate)) continue
      const hour = parseInt(t.slice(11, 13), 10)
      if (hour >= 0 && hour < 24) {
        hourly_u[hour] = wind_u_10m[i] ?? 0
        hourly_v[hour] = wind_v_10m[i] ?? 0
      }
    }

    return { lat, lng, hourly_u, hourly_v }
  } catch {
    return null
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function buildWindGrid(
  routeBbox: [number, number, number, number],
  distanceKm: number,
  rideDate: string,
): Promise<WindField> {
  const bbox = expandBbox(routeBbox)
  const { cols, rows } = gridSize(distanceKm)

  const [minLng, minLat, maxLng, maxLat] = bbox
  const lngStep = (maxLng - minLng) / (cols - 1)
  const latStep = (maxLat - minLat) / (rows - 1)

  // Generate grid points in row-major order (row 0 = minLat)
  const points: { lat: number; lng: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        lat: minLat + r * latStep,
        lng: minLng + c * lngStep,
      })
    }
  }

  // Fetch all points in parallel; substitute calm wind on individual failure
  const results = await Promise.allSettled(
    points.map(p => fetchWindPoint(p.lat, p.lng, rideDate))
  )

  const grid: WindGridPoint[] = results.map((r, i) => {
    if (r.status === 'fulfilled' && r.value) return r.value
    // Fallback: calm wind at this grid point
    return { lat: points[i].lat, lng: points[i].lng, hourly_u: new Array(24).fill(0), hourly_v: new Array(24).fill(0) }
  })

  return { grid, grid_cols: cols, grid_rows: rows, bbox, ride_date: rideDate }
}
