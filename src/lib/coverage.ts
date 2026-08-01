import type {
  CoverageConfidence,
  CoverageNetwork,
  CoverageSegment,
  RoutePoint,
} from './types'

// Broadband Map combines FCC Broadband Data Collection availability with
// crowdsourced signal observations. Results are planning evidence, not a
// guarantee that a phone will connect at a specific time or location.
const CELL_API = 'https://broadbandmap.com/api/v1/location/cell'
const BATCH_SIZE = 5
const BATCH_DELAY_MS = 600
const REQUEST_TIMEOUT_MS = 8_000
const ENRICHMENT_BUDGET_MS = 24_000
const DEFAULT_RETRY_AFTER_MS = 1_000
const MAX_RETRY_AFTER_MS = 2_000

const SIGNAL_RANK: Record<string, number> = {
  Excellent: 5,
  Strong: 4,
  Good: 3,
  Fair: 2,
  Weak: 1,
  'Very Weak': 0,
}

interface CellRecord {
  network?: unknown
  network_slug?: unknown
  technology?: unknown
  signal_level?: unknown
  rsrp_dbm?: unknown
}

interface CellResponse {
  coverage?: unknown
}

interface ProviderErrorBody {
  error?: unknown
  code?: unknown
}

interface PointCoverage {
  confidence: CoverageConfidence
  networks: CoverageNetwork[]
  succeeded: boolean
}

class CoverageProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CoverageProviderError'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function retryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds * 1_000, 0), MAX_RETRY_AFTER_MS)
  }

  const date = Date.parse(value)
  if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_MS
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS)
}

async function readProviderError(res: Response): Promise<{ message: string; code: string }> {
  let body: ProviderErrorBody = {}
  try {
    body = await res.json() as ProviderErrorBody
  } catch {
    // The status code still gives us enough information to degrade safely.
  }

  return {
    message: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
    code: typeof body.code === 'string' ? body.code : `http_${res.status}`,
  }
}

function isCredentialOrQuotaError(status: number, code: string): boolean {
  return status === 401 || status === 403 || code.includes('quota') || code === 'key_inactive'
}

function normalizeNetworks(records: unknown): CoverageNetwork[] {
  if (!Array.isArray(records)) return []

  return records.flatMap((record: CellRecord) => {
    if (
      !record ||
      typeof record.network !== 'string' ||
      typeof record.signal_level !== 'string'
    ) {
      return []
    }

    const networkSlug = typeof record.network_slug === 'string'
      ? record.network_slug
      : record.network.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    return [{
      network: record.network,
      network_slug: networkSlug,
      technology: typeof record.technology === 'string' ? record.technology : 'unknown',
      signal_level: record.signal_level,
      ...(typeof record.rsrp_dbm === 'number' && Number.isFinite(record.rsrp_dbm)
        ? { rsrp_dbm: record.rsrp_dbm }
        : {}),
    }]
  })
}

function confidenceForNetworks(networks: CoverageNetwork[]): CoverageConfidence {
  if (networks.length === 0) return 'none'

  const bestRank = Math.max(...networks.map(network => SIGNAL_RANK[network.signal_level] ?? -1))
  if (bestRank >= 3) return 'good'
  if (bestRank === 2) return 'fair'
  if (bestRank >= 0) return 'poor'
  return 'none'
}

async function queryCellCoverage(
  lat: number,
  lng: number,
  apiKey: string,
  retryBurst = true,
): Promise<PointCoverage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const query = new URLSearchParams({ lat: String(lat), lng: String(lng) })
    const res = await fetch(`${CELL_API}?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })

    if (!res.ok) {
      const providerError = await readProviderError(res)

      if (isCredentialOrQuotaError(res.status, providerError.code)) {
        throw new CoverageProviderError(
          'Mobile coverage authentication or quota is unavailable.',
          providerError.code,
        )
      }

      if (res.status === 429 && retryBurst) {
        console.warn('[coverage] burst rate limit reached; retrying once')
        await delay(retryAfterMs(res.headers.get('retry-after')))
        return queryCellCoverage(lat, lng, apiKey, false)
      }

      console.warn(`[coverage] point query failed (${providerError.code})`)
      return { confidence: 'unknown', networks: [], succeeded: false }
    }

    let response: CellResponse
    try {
      response = await res.json() as CellResponse
    } catch {
      return { confidence: 'unknown', networks: [], succeeded: false }
    }

    const networks = normalizeNetworks(response.coverage)
    return {
      confidence: confidenceForNetworks(networks),
      networks,
      succeeded: true,
    }
  } catch (error) {
    if (error instanceof CoverageProviderError) throw error
    return { confidence: 'unknown', networks: [], succeeded: false }
  } finally {
    clearTimeout(timer)
  }
}

export async function enrichCoverage(
  samplePoints: RoutePoint[],
): Promise<CoverageSegment[]> {
  if (samplePoints.length === 0) return []

  const apiKey = process.env.BROADBANDMAP_API_KEY?.trim()
  if (!apiKey) {
    throw new CoverageProviderError(
      'Mobile coverage is unavailable because BROADBANDMAP_API_KEY is not configured.',
      'missing_key',
    )
  }

  const results: CoverageSegment[] = []
  const startedAt = Date.now()
  let successfulPoints = 0
  let nextIndex = 0

  for (; nextIndex < samplePoints.length; nextIndex += BATCH_SIZE) {
    if (Date.now() - startedAt >= ENRICHMENT_BUDGET_MS) break

    const batch = samplePoints.slice(nextIndex, nextIndex + BATCH_SIZE)
    const pointResults = await Promise.all(
      batch.map(point => queryCellCoverage(point.lat, point.lng, apiKey)),
    )

    for (let index = 0; index < batch.length; index++) {
      const pointResult = pointResults[index]
      if (pointResult.succeeded) successfulPoints++
      results.push({
        distance_km: batch[index].distance_km,
        confidence: pointResult.confidence,
        networks: pointResult.networks,
      })
    }

    if (nextIndex + BATCH_SIZE < samplePoints.length) {
      await delay(BATCH_DELAY_MS)
    }
  }

  for (; nextIndex < samplePoints.length; nextIndex++) {
    results.push({
      distance_km: samplePoints[nextIndex].distance_km,
      confidence: 'unknown',
      networks: [],
    })
  }

  if (successfulPoints === 0) {
    throw new CoverageProviderError('Mobile coverage provider is unavailable.', 'provider_unavailable')
  }

  return results
}
