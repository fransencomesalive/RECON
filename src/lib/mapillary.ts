import type { CanonicalRoute, RouteImage } from './types'

const MAPILLARY_API = 'https://graph.mapillary.com/images'
const MAX_SAMPLES = 6

export async function enrichMapillaryImagery(route: CanonicalRoute): Promise<RouteImage[]> {
  const token = process.env.MAPILLARY_ACCESS_TOKEN
  if (!token) return []

  const points = route.sample_points
  const step = Math.max(1, Math.floor(points.length / MAX_SAMPLES))
  const samples = points.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLES)

  const results = await Promise.allSettled(
    samples.map(pt => fetchNearestImage(pt.lat, pt.lng, pt.distance_km, token))
  )

  const seen = new Set<string>()
  return results
    .filter((r): r is PromiseFulfilledResult<RouteImage | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((img): img is RouteImage => {
      if (!img || seen.has(img.id)) return false
      seen.add(img.id)
      return true
    })
}

async function fetchNearestImage(
  lat: number,
  lng: number,
  distance_km: number,
  token: string,
): Promise<RouteImage | null> {
  try {
    const params = new URLSearchParams({
      fields: 'id,thumb_256_url,thumb_1024_url,captured_at,geometry',
      closeto: `${lng},${lat}`,
      limit: '1',
      access_token: token,
    })
    const res = await fetch(`${MAPILLARY_API}?${params}`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const img = data.data?.[0]
    if (!img?.thumb_256_url) return null
    return {
      id: img.id,
      lat: img.geometry?.coordinates?.[1] ?? lat,
      lng: img.geometry?.coordinates?.[0] ?? lng,
      distance_km,
      thumb_url: img.thumb_256_url,
      full_url: `https://www.mapillary.com/app/?focus=photo&pKey=${img.id}`,
      captured_at: img.captured_at,
      source: 'mapillary',
    }
  } catch {
    return null
  }
}
