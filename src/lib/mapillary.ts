import type { CanonicalRoute, RouteImage } from './types'

const MAPILLARY_API = 'https://graph.mapillary.com/images'
const MAX_DISPLAY   = 9   // images shown in gallery + map
const QUERY_INTERVAL_KM = 10  // one query per 10 km of route
const MAX_QUERIES   = 40  // hard cap on parallel API calls

export async function enrichMapillaryImagery(route: CanonicalRoute): Promise<RouteImage[]> {
  const token = process.env.MAPILLARY_ACCESS_TOKEN
  if (!token) { console.log('[mapillary] No MAPILLARY_ACCESS_TOKEN — skipping'); return [] }

  const points = route.sample_points
  if (!points.length) return []

  // Query at ~10 km intervals across the full route, capped at MAX_QUERIES
  const numQueries = Math.min(MAX_QUERIES, Math.max(6, Math.ceil(route.distance_km / QUERY_INTERVAL_KM)))
  const step = Math.max(1, Math.floor(points.length / numQueries))
  const samples = points.filter((_, i) => i % step === 0).slice(0, numQueries)

  console.log(`[mapillary] Querying ${samples.length} points over ${route.distance_km.toFixed(0)} km`)

  const results = await Promise.allSettled(
    samples.map(pt => fetchNearestImage(pt.lat, pt.lng, pt.distance_km, token))
  )

  const seen = new Set<string>()
  const found = results
    .filter((r): r is PromiseFulfilledResult<RouteImage | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((img): img is RouteImage => {
      if (!img || seen.has(img.id)) return false
      seen.add(img.id)
      return true
    })
    .sort((a, b) => a.distance_km - b.distance_km)

  console.log(`[mapillary] Found ${found.length} unique images from ${samples.length} queries`)

  // Select up to MAX_DISPLAY evenly distributed along the route
  if (found.length <= MAX_DISPLAY) return found
  const stride = found.length / MAX_DISPLAY
  return Array.from({ length: MAX_DISPLAY }, (_, i) =>
    found[Math.min(Math.floor(i * stride), found.length - 1)]
  )
}

async function fetchNearestImage(
  lat: number,
  lng: number,
  distance_km: number,
  token: string,
): Promise<RouteImage | null> {
  try {
    // bbox is reliable; closeto consistently returns empty.
    // Request several candidates per point and pick highest quality_score.
    const D = 0.045  // ~5 km at mid-latitudes
    const bbox = `${lng - D},${lat - D},${lng + D},${lat + D}`
    const params = new URLSearchParams({
      fields: 'id,thumb_256_url,thumb_1024_url,captured_at,geometry,quality_score,is_pano',
      bbox,
      limit: '10',
      access_token: token,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    let res: Response
    try {
      res = await fetch(`${MAPILLARY_API}?${params}`, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) { console.log(`[mapillary] API error ${res.status} at ${lat},${lng}`); return null }
    const data = await res.json()
    // Filter out panoramas, sort by quality_score descending, take best
    const candidates: typeof data.data = (data.data ?? [])
      .filter((i: { is_pano?: boolean; thumb_256_url?: string }) => !i.is_pano && i.thumb_256_url)
      .sort((a: { quality_score?: number }, b: { quality_score?: number }) =>
        (b.quality_score ?? 0) - (a.quality_score ?? 0)
      )
    const img = candidates[0]
    console.log(`[mapillary] ${lat.toFixed(4)},${lng.toFixed(4)} → ${img ? `${img.id} (q=${img.quality_score?.toFixed(2)})` : 'no result'}`)
    if (!img?.thumb_256_url) return null
    return {
      id: img.id,
      lat: img.geometry?.coordinates?.[1] ?? lat,
      lng: img.geometry?.coordinates?.[0] ?? lng,
      distance_km,
      thumb_url: img.thumb_1024_url ?? img.thumb_256_url,
      full_url: `https://www.mapillary.com/app/?focus=photo&pKey=${img.id}`,
      captured_at: img.captured_at,
      source: 'mapillary',
    }
  } catch {
    return null
  }
}
