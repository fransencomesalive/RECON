import type { RoutePoint, CoverageSegment } from './types'

// ─── FCC Coverage via broadbandmap.com ────────────────────────────────────────
// broadbandmap.com is a third-party API backed by FCC BDC data (Nov 2025 release)
// augmented with crowdsourced signal measurements. No auth required (alpha phase).
// Rate limit: 60 req/hour per IP — fine for single-user use.
// API docs: https://broadbandmap.com/developers/
// ─────────────────────────────────────────────────────────────────────────────

const CELL_API    = 'https://broadbandmap.com/api/v1/location/cell'
const BATCH_SIZE  = 5    // concurrent requests per batch
const BATCH_DELAY = 300  // ms between batches
const TIMEOUT_MS  = 8000

// Signal levels returned by the API, ranked best→worst
const SIGNAL_RANK: Record<string, number> = {
  'Excellent': 5,
  'Strong':    4,
  'Good':      3,
  'Fair':      2,
  'Weak':      1,
  'Very Weak': 0,
}

interface CellRecord {
  network:       string
  signal_level:  string
  rsrp_dbm?:     number
}

interface CellResponse {
  coverage: CellRecord[]
  count:    number
}

async function queryCellCoverage(lat: number, lng: number): Promise<CoverageSegment['confidence']> {
  // Explicit AbortController — AbortSignal.timeout is unreliable on Vercel
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${CELL_API}?lat=${lat}&lng=${lng}`, {
      signal: controller.signal,
    })

    if (res.status === 429) {
      console.warn('[coverage] rate limited by broadbandmap.com')
      return 'unknown'
    }
    if (!res.ok) return 'unknown'

    let response: CellResponse
    try { response = await res.json() } catch { return 'unknown' }
    const data = response.coverage ?? []
    if (data.length === 0) return 'none'

    // Best signal level across all carriers at this point
    const bestRank = Math.max(...data.map(d => SIGNAL_RANK[d.signal_level] ?? -1))

    if (bestRank >= 3) return 'good'   // Good, Strong, or Excellent
    if (bestRank === 2) return 'fair'  // Fair
    if (bestRank >= 0) return 'poor'   // Weak or Very Weak
    return 'none'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichCoverage(
  samplePoints: RoutePoint[],
): Promise<CoverageSegment[]> {
  const results: CoverageSegment[] = []

  for (let i = 0; i < samplePoints.length; i += BATCH_SIZE) {
    const batch = samplePoints.slice(i, i + BATCH_SIZE)

    const confidences = await Promise.all(
      batch.map(p => queryCellCoverage(p.lat, p.lng))
    )

    for (let j = 0; j < batch.length; j++) {
      results.push({
        distance_km: batch[j].distance_km,
        confidence:  confidences[j],
      })
    }

    if (i + BATCH_SIZE < samplePoints.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY))
    }
  }

  return results
}
