import { v4 as uuidv4 } from 'uuid'
import type { CanonicalRoute, POI, POIType, SurfaceStat, SurfaceType, SupplyGap } from './types'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const CORRIDOR_BUFFER_DEG = 0.02 // ~2 km buffer around bbox

// ─── Overpass query builder ───────────────────────────────────────────────────

function buildQuery(bbox: [number, number, number, number]): string {
  const [minLng, minLat, maxLng, maxLat] = bbox
  // Expand bbox by buffer
  const s = minLat - CORRIDOR_BUFFER_DEG
  const w = minLng - CORRIDOR_BUFFER_DEG
  const n = maxLat + CORRIDOR_BUFFER_DEG
  const e = maxLng + CORRIDOR_BUFFER_DEG
  const b = `${s},${w},${n},${e}`

  return `
[out:json][timeout:60];
(
  way["highway"]["surface"](${b});
  way["highway"]["tracktype"](${b});
  way["highway"~"^(track|path|cycleway|bridleway)$"](${b});
  node["natural"="spring"](${b});
  node["amenity"="drinking_water"](${b});
  node["man_made"="water_tap"](${b});
  node["amenity"="water_point"](${b});
  node["natural"="water"]["drinking_water"="yes"](${b});
  node["shop"="bicycle"](${b});
  node["amenity"~"^(fire_station|hospital|clinic|doctors)$"](${b});
  node["place"~"^(city|town|village|hamlet)$"](${b});
  node["highway"="bus_stop"](${b});
  node["amenity"="shelter"](${b});
);
out body;
>;
out skel qt;
`.trim()
}

// ─── Surface tag → normalized type ───────────────────────────────────────────

function normalizeSurface(tags: Record<string, string>): SurfaceType {
  const surface = tags['surface']
  const highway = tags['highway']
  const tracktype = tags['tracktype']

  if (surface) {
    if (['asphalt', 'paved', 'concrete', 'chipseal', 'paving_stones'].includes(surface)) return 'paved'
    if (['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'rock', 'stones'].includes(surface)) return 'gravel'
    if (['dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'unpaved'].includes(surface)) return 'dirt'
  }

  if (tracktype) {
    if (tracktype === 'grade1') return 'paved'
    if (['grade2', 'grade3'].includes(tracktype)) return 'gravel'
    if (['grade4', 'grade5'].includes(tracktype)) return 'dirt'
  }

  if (highway) {
    if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'cycleway'].includes(highway)) return 'paved'
    if (['track', 'path', 'bridleway', 'footway'].includes(highway)) return 'dirt'
  }

  return 'unknown'
}

// ─── OSM node → POI ───────────────────────────────────────────────────────────

function classifyNode(tags: Record<string, string>): { type: POIType; potable?: boolean; name?: string } | null {
  if (tags['natural'] === 'spring' || tags['amenity'] === 'drinking_water' ||
      tags['man_made'] === 'water_tap' || tags['amenity'] === 'water_point' ||
      (tags['natural'] === 'water' && tags['drinking_water'] === 'yes')) {
    const potable = tags['drinking_water'] !== 'no'
    return { type: 'water', potable, name: tags['name'] }
  }
  if (tags['shop'] === 'bicycle') {
    return { type: 'shop', name: tags['name'] || tags['brand'] }
  }
  if (tags['amenity'] === 'fire_station' || tags['amenity'] === 'hospital' ||
      tags['amenity'] === 'clinic' || tags['amenity'] === 'doctors') {
    return { type: 'emergency', name: tags['name'] }
  }
  // Place nodes are handled separately for bailout deduplication — skip here
  if (tags['place'] === 'city' || tags['place'] === 'town' ||
      tags['place'] === 'village' || tags['place'] === 'hamlet') {
    return null
  }
  if (tags['amenity'] === 'shelter') {
    return { type: 'shelter', name: tags['name'] }
  }
  return null
}

// ─── Point-to-segment distance ────────────────────────────────────────────────
// Returns approximate distance in km from a lat/lng to the nearest route point.

function nearestRouteDistance(
  lat: number,
  lng: number,
  route: CanonicalRoute,
): number {
  const coords = route.geometry.coordinates
  let best = Infinity
  let bestIdx = 0

  for (let i = 0; i < coords.length; i++) {
    const dLat = lat - coords[i][1]
    const dLng = lng - coords[i][0]
    const d = dLat * dLat + dLng * dLng
    if (d < best) { best = d; bestIdx = i }
  }

  // Interpolate cumulative distance at that index
  const frac = bestIdx / (coords.length - 1)
  return Math.round(frac * route.distance_km * 100) / 100
}

// ─── Bailout point detection ──────────────────────────────────────────────────
// Finds towns/villages near the route. Returns one marker per section of route
// (spaced at least 15 km apart) at the nearest route point to each settlement.
// Capped at 5 total to avoid noise.

function detectBailoutPoints(
  placeNodes: OsmElement[],
  route: CanonicalRoute,
): Array<{ lat: number; lng: number; name: string; distance_km: number }> {
  const MAX_DISTANCE_DEG = 0.03   // ~3 km — must be reachable from route
  const MIN_SPACING_KM   = 15     // deduplicate: ignore places within 15 km of each other on route
  const MAX_BAILOUTS     = 5

  const routeCoords = route.geometry.coordinates

  // Score each place by its distance to the nearest route point
  const candidates = placeNodes
    .map(node => {
      const lat = node.lat!, lng = node.lon!
      let bestDist = Infinity, bestIdx = 0
      for (let i = 0; i < routeCoords.length; i++) {
        const dLat = lat - routeCoords[i][1]
        const dLng = lng - routeCoords[i][0]
        const d = Math.sqrt(dLat * dLat + dLng * dLng)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      if (bestDist > MAX_DISTANCE_DEG) return null
      const distance_km = Math.round((bestIdx / (routeCoords.length - 1)) * route.distance_km * 100) / 100
      return { lat, lng, name: node.tags?.['name'] ?? 'Town', distance_km, bestDist }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.distance_km - b.distance_km)

  // Deduplicate: only keep a bailout if it's MIN_SPACING_KM from the last kept one
  const kept: typeof candidates = []
  for (const c of candidates) {
    const last = kept[kept.length - 1]
    if (!last || (c.distance_km - last.distance_km) >= MIN_SPACING_KM) {
      kept.push(c)
      if (kept.length >= MAX_BAILOUTS) break
    }
  }

  return kept
}

// ─── Supply gap detection ─────────────────────────────────────────────────────

function detectSupplyGaps(pois: POI[], totalKm: number): SupplyGap[] {
  const waterAndShops = pois
    .filter(p => p.type === 'water' || p.type === 'shop')
    .sort((a, b) => a.distance_km - b.distance_km)

  const gaps: SupplyGap[] = []
  let prev = 0

  for (const poi of waterAndShops) {
    const gap = poi.distance_km - prev
    if (gap > 25) {
      gaps.push({
        from_km: Math.round(prev * 10) / 10,
        to_km: Math.round(poi.distance_km * 10) / 10,
        description: `${Math.round(gap)} km with no water or resupply.`,
      })
    }
    prev = poi.distance_km
  }

  // Check gap from last supply to end
  const tail = totalKm - prev
  if (tail > 25) {
    gaps.push({
      from_km: Math.round(prev * 10) / 10,
      to_km: Math.round(totalKm * 10) / 10,
      description: `${Math.round(tail)} km with no water or resupply to end of route.`,
    })
  }

  return gaps
}

// ─── Surface stats ────────────────────────────────────────────────────────────
// For each route sample point, find the nearest OSM way and record its surface.
// This samples the route itself rather than counting all ways in the bbox.

function computeSurfaceStats(
  ways: OsmElement[],
  nodeLookup: Map<number, { lat: number; lon: number }>,
  route: CanonicalRoute,
): SurfaceStat[] {
  const routeCoords = route.geometry.coordinates // [lng, lat, ele?][]
  const totalKm = route.distance_km
  const ON_ROUTE_THRESHOLD = 0.001 // ~100m in degrees

  // For each way, compute its minimum distance to any route coordinate
  // using its referenced node positions.
  interface ScoredWay { way: OsmElement; minDist: number }
  const scored: ScoredWay[] = []

  for (const way of ways) {
    const nodeIds = way.nodes ?? []
    let minDist = Infinity
    for (const nid of nodeIds) {
      const node = nodeLookup.get(nid)
      if (!node) continue
      for (const coord of routeCoords) {
        const dLat = node.lat - coord[1]
        const dLng = node.lon - coord[0]
        const d = Math.sqrt(dLat * dLat + dLng * dLng)
        if (d < minDist) minDist = d
      }
    }
    if (minDist < ON_ROUTE_THRESHOLD) scored.push({ way, minDist })
  }

  // Sample the route at ~100 evenly-spaced coordinate indices and find the
  // nearest on-route OSM way to assign a surface type at that point.
  const SAMPLES = Math.min(routeCoords.length, 100)
  const surfaceCounts: Record<SurfaceType, number> = { paved: 0, gravel: 0, dirt: 0, unknown: 0 }

  for (let s = 0; s < SAMPLES; s++) {
    const idx = Math.round((s / (SAMPLES - 1)) * (routeCoords.length - 1))
    const coord = routeCoords[idx]
    let bestDist = Infinity
    let bestSurface: SurfaceType = 'unknown'

    for (const { way, minDist: _ } of scored) {
      const nodeIds = way.nodes ?? []
      for (const nid of nodeIds) {
        const node = nodeLookup.get(nid)
        if (!node) continue
        const dLat = node.lat - coord[1]
        const dLng = node.lon - coord[0]
        const d = dLat * dLat + dLng * dLng
        if (d < bestDist) {
          bestDist = d
          bestSurface = normalizeSurface(way.tags ?? {})
        }
      }
    }
    surfaceCounts[bestSurface]++
  }

  const total = Object.values(surfaceCounts).reduce((a, b) => a + b, 0) || 1
  const types: SurfaceType[] = ['paved', 'gravel', 'dirt', 'unknown']

  return types
    .filter(t => surfaceCounts[t] > 0)
    .map(t => ({
      type: t,
      pct: Math.round((surfaceCounts[t] / total) * 100),
      km: Math.round((surfaceCounts[t] / total) * totalKm * 10) / 10,
    }))
}

// ─── Overpass response types ──────────────────────────────────────────────────

interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  tags?: Record<string, string>
  nodes?: number[]
}

interface OverpassResponse {
  elements: OsmElement[]
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function enrichFromOverpass(route: CanonicalRoute): Promise<{
  surfaces: SurfaceStat[]
  pois: POI[]
  supply_gaps: SupplyGap[]
}> {
  const query = buildQuery(route.bbox)

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(65_000),
  })

  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`)
  }

  const data: OverpassResponse = await res.json()
  const elements = data.elements ?? []

  const ways = elements.filter(e => e.type === 'way')
  const nodes = elements.filter(e => e.type === 'node' && e.lat != null && e.lon != null)

  // Build node lookup for surface proximity filtering
  const nodeLookup = new Map<number, { lat: number; lon: number }>()
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodeLookup.set(el.id, { lat: el.lat, lon: el.lon! })
    }
  }

  const surfaces = computeSurfaceStats(ways, nodeLookup, route)

  // Separate place nodes for bailout handling
  const placeNodes = nodes.filter(n => {
    const p = n.tags?.['place']
    return p === 'city' || p === 'town' || p === 'village' || p === 'hamlet'
  })

  const pois: POI[] = []

  // Standard POIs (water, shop, emergency, shelter)
  for (const node of nodes) {
    const tags = node.tags ?? {}
    const classification = classifyNode(tags)
    if (!classification) continue

    const lat = node.lat!
    const lng = node.lon!
    const distance_km = nearestRouteDistance(lat, lng, route)

    pois.push({
      id: uuidv4(),
      type: classification.type,
      name: classification.name || `${classification.type} (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
      lat,
      lng,
      distance_km,
      potable: classification.potable,
      tags,
    })
  }

  // Deduplicated bailout points
  const bailouts = detectBailoutPoints(placeNodes, route)
  for (const b of bailouts) {
    pois.push({
      id: uuidv4(),
      type: 'bailout',
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      distance_km: b.distance_km,
    })
  }

  // Sort POIs by distance along route
  pois.sort((a, b) => a.distance_km - b.distance_km)

  const supply_gaps = detectSupplyGaps(pois, route.distance_km)

  return { surfaces, pois, supply_gaps }
}
