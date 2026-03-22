import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point, polygon } from '@turf/helpers'
import type { CanonicalRoute, LandCrossing } from './types'

// PAD-US via Esri USA Federal Lands FeatureServer (supports polyline queries, ~150ms)
const ESRI_FEDERAL_LANDS =
  'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Federal_Lands/FeatureServer/0/query'

// ─── Esri response types ──────────────────────────────────────────────────────

interface EsriGeometry {
  rings: [number, number][][]
}

interface EsriFeature {
  attributes: {
    unit_name?: string
    Agency?: string
    Mang_Name?: string
    agbur?: string
    AGBUR?: string
    [key: string]: unknown
  }
  geometry?: EsriGeometry
}

interface EsriQueryResponse {
  features?: EsriFeature[]
  error?: { message: string }
}

// ─── Agency name normalization ────────────────────────────────────────────────

const AGENCY_LABELS: Record<string, string> = {
  FS:    'USDA Forest Service',
  USFS:  'USDA Forest Service',
  BLM:   'Bureau of Land Management',
  NPS:   'National Park Service',
  FWS:   'US Fish & Wildlife Service',
  BOR:   'Bureau of Reclamation',
  USBR:  'Bureau of Reclamation',
  DOD:   'Dept. of Defense',
  USACE: 'Army Corps of Engineers',
  NWR:   'National Wildlife Refuge',
}

function normalizeAgency(raw: string | undefined): string {
  if (!raw) return 'Federal Land'
  return AGENCY_LABELS[raw.trim()] ?? raw
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────

function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// ─── Point-in-polygon crossing detection ─────────────────────────────────────

function findCrossing(
  route: CanonicalRoute,
  feature: EsriFeature,
  routeCoordDistances: number[],
): { entry_km: number; exit_km: number } | null {
  if (!feature.geometry?.rings?.length) return null

  const rings = feature.geometry.rings
    .filter(r => r.length >= 4)
    .map(ring => {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng
        if (lat < minLat) minLat = lat
        if (lng > maxLng) maxLng = lng
        if (lat > maxLat) maxLat = lat
      }
      return { ring, minLng, minLat, maxLng, maxLat }
    })

  if (rings.length === 0) return null

  const coords = route.geometry.coordinates
  let entry: number | null = null
  let exit: number | null = null

  for (let i = 0; i < coords.length; i++) {
    const lng = coords[i][0]
    const lat = coords[i][1]
    const cumKm = routeCoordDistances[i]

    const pt = point([lng, lat])
    const inside = rings.some(({ ring, minLng, minLat, maxLng, maxLat }) => {
      if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) return false
      try { return booleanPointInPolygon(pt, polygon([ring])) }
      catch { return false }
    })

    if (inside) {
      if (entry === null) entry = cumKm
      exit = cumKm
    }
  }

  if (entry === null) return null
  return { entry_km: entry, exit_km: exit! }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function enrichPublicLands(route: CanonicalRoute): Promise<LandCrossing[]> {
  const coords = route.geometry.coordinates

  // Subsample route to ~150 points for the Esri polyline intersection query
  const stride = Math.max(1, Math.floor(coords.length / 150))
  const pathPoints = coords
    .filter((_, i) => i % stride === 0 || i === coords.length - 1)
    .map(([lng, lat]) => [lng, lat])

  const body = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({ paths: [pathPoints], spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPolyline',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    f: 'json',
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  let res: Response
  try {
    res = await fetch(ESRI_FEDERAL_LANDS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`Esri error: ${res.status}`)

  const data: EsriQueryResponse = await res.json()
  if (data.error) throw new Error(`Esri error: ${data.error.message}`)

  const features = data.features ?? []

  // Precompute cumulative km for every route coordinate
  const routeCoordDistances: number[] = [0]
  for (let i = 1; i < coords.length; i++) {
    routeCoordDistances.push(
      routeCoordDistances[i - 1] +
      haversineKm(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1])
    )
  }

  // Group by name — merge multi-polygon features of the same unit (min entry, max exit)
  const byName = new Map<string, { agency: string; entry_km: number; exit_km: number }>()

  for (const f of features) {
    const attrs = f.attributes
    const name = (
      attrs.unit_name ?? attrs.Unit_Name ?? attrs.UNIT_NM ??
      attrs.Name ?? attrs.NAME ?? 'Unknown Area'
    ) as string

    const crossing = findCrossing(route, f, routeCoordDistances)
    if (!crossing) continue

    const rawAgency = (attrs.Agency ?? attrs.agency ?? attrs.Mang_Name ?? attrs.agbur ?? attrs.AGBUR) as string | undefined
    const agency = normalizeAgency(rawAgency)

    const existing = byName.get(name)
    if (existing) {
      existing.entry_km = Math.min(existing.entry_km, crossing.entry_km)
      existing.exit_km  = Math.max(existing.exit_km,  crossing.exit_km)
    } else {
      byName.set(name, { agency, entry_km: crossing.entry_km, exit_km: crossing.exit_km })
    }
  }

  const crossings: LandCrossing[] = []
  for (const [name, { agency, entry_km, exit_km }] of byName) {
    crossings.push({ name, agency, type: 'Federal Land', status: 'public', entry_km, exit_km })
  }

  crossings.sort((a, b) => a.entry_km - b.entry_km)
  return crossings
}
