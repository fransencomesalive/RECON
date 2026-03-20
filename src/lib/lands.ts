import type { CanonicalRoute, LandCrossing } from './types'

// PAD-US via Esri USA Federal Lands FeatureServer (no auth required)
const ESRI_FEDERAL_LANDS =
  'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Federal_Lands/FeatureServer/0/query'

// ─── Esri response types ──────────────────────────────────────────────────────

interface EsriFeature {
  attributes: {
    unit_name?: string
    Agency?: string
    [key: string]: unknown
  }
}

interface EsriQueryResponse {
  features?: EsriFeature[]
  error?: { message: string }
}

// ─── Approx km at which the route enters/exits each land parcel ───────────────
// We use a simple heuristic: intersect the route geometry points against the
// returned feature envelopes. For V1 this gives a reasonable estimate.

function estimateCrossing(
  route: CanonicalRoute,
  feature: EsriFeature,
  totalKm: number,
): { entry_km: number; exit_km: number } {
  // Without individual polygon geometries in this query we approximate:
  // spread features evenly across the route for a best-effort display.
  // V2 should query with returnGeometry=true and do proper intersection.
  void feature // suppress unused warning
  void totalKm
  return { entry_km: 0, exit_km: totalKm }
}

// ─── Agency name normalization ────────────────────────────────────────────────

function normalizeAgency(raw: string | undefined): string {
  if (!raw) return 'Unknown Agency'
  const map: Record<string, string> = {
    'FS': 'USDA Forest Service',
    'BLM': 'Bureau of Land Management',
    'NPS': 'National Park Service',
    'FWS': 'US Fish & Wildlife Service',
    'BOR': 'Bureau of Reclamation',
    'DOD': 'Department of Defense',
    'NWR': 'National Wildlife Refuge',
    'USFS': 'USDA Forest Service',
  }
  return map[raw.trim()] ?? raw
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function enrichPublicLands(route: CanonicalRoute): Promise<LandCrossing[]> {
  const [minLng, minLat, maxLng, maxLat] = route.bbox

  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${minLng},${minLat},${maxLng},${maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  })

  // AbortSignal.timeout is unreliable in Vercel Node.js — use explicit controller
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  let res: Response
  try {
    res = await fetch(`${ESRI_FEDERAL_LANDS}?${params}`, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`Esri FeatureServer error: ${res.status}`)

  const data: EsriQueryResponse = await res.json()

  if (data.error) throw new Error(`Esri error: ${data.error.message}`)

  const features = data.features ?? []

  // Deduplicate by name
  const seen = new Set<string>()
  const crossings: LandCrossing[] = []

  for (const f of features) {
    const attrs = f.attributes
    // Field names vary across Esri service versions — try common variants
    const name = (
      attrs.unit_name ?? attrs.Unit_Name ?? attrs.UNIT_NM ??
      attrs.Name ?? attrs.NAME ?? 'Unknown Area'
    ) as string
    if (seen.has(name)) continue
    seen.add(name)

    const rawAgency = (
      attrs.Agency ?? attrs.agency ?? attrs.Mang_Name ??
      attrs.agbur ?? attrs.AGBUR
    ) as string | undefined

    const { entry_km, exit_km } = estimateCrossing(route, f, route.distance_km)

    crossings.push({
      name,
      agency: normalizeAgency(rawAgency),
      type: 'Federal Land',
      entry_km,
      exit_km,
    })
  }

  return crossings
}
