import { v4 as uuidv4 } from 'uuid'
import type { BailoutDestinationType, BailoutRoute, CanonicalRoute, POI, POIType, SurfaceStat, SurfaceSegment, SurfaceType, SupplyGap } from './types'

// Public mirrors work from residential/Cloudflare IPs but are blocked by many cloud providers
// (AWS/Vercel). If OVERPASS_PROXY_URL is set (a Cloudflare Worker proxy), it is used first.
const PUBLIC_OVERPASS_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

function getOverpassMirrors(): string[] {
  // If a Cloudflare Worker proxy URL is configured, use it — it won't be blocked from cloud IPs
  const proxy = process.env.OVERPASS_PROXY_URL
  return proxy ? [proxy, ...PUBLIC_OVERPASS_MIRRORS] : PUBLIC_OVERPASS_MIRRORS
}

// Fires all mirrors in parallel and resolves with the first successful response.
// Uses explicit setTimeout+AbortController instead of AbortSignal.timeout, which
// does not fire reliably in Vercel's Node.js serverless runtime.
async function fetchFromAnyMirror(body: string): Promise<Response> {
  const mirrors = getOverpassMirrors()
  const MIRROR_TIMEOUT = 18_000

  console.log('[overpass] mirrors:', mirrors.map(m => m.replace(/^https?:\/\//, '')))

  return new Promise((resolve, reject) => {
    const errors: string[] = []
    let remaining = mirrors.length
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const controllers: AbortController[] = []

    mirrors.forEach((mirror, i) => {
      const controller = new AbortController()
      controllers[i] = controller

      // Explicit timeout — more reliable than AbortSignal.timeout in serverless environments
      timers[i] = setTimeout(() => {
        if (settled) return
        controller.abort()
        errors.push(`${mirror}: timeout after ${MIRROR_TIMEOUT}ms`)
        if (--remaining === 0) {
          settled = true
          reject(new Error(`All Overpass mirrors failed: ${errors.join('; ')}`))
        }
      }, MIRROR_TIMEOUT)

      fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      }).then(r => {
        if (settled) return
        clearTimeout(timers[i])
        if (r.ok) {
          settled = true
          // Cancel other timers and abort other in-flight fetches
          timers.forEach((t, j) => { if (j !== i) clearTimeout(t) })
          controllers.forEach((c, j) => { if (j !== i) try { c.abort() } catch {} })
          console.log('[overpass] success from:', mirror.replace(/^https?:\/\//, ''))
          resolve(r)
        } else {
          errors.push(`${mirror}: HTTP ${r.status}`)
          if (--remaining === 0) {
            settled = true
            reject(new Error(`All Overpass mirrors failed: ${errors.join('; ')}`))
          }
        }
      }).catch(e => {
        if (settled) return
        // AbortError means our setTimeout already decremented remaining — don't double-count
        if ((e as Error).name === 'AbortError') return
        clearTimeout(timers[i])
        errors.push(`${mirror}: ${(e as Error).message}`)
        if (--remaining === 0) {
          settled = true
          reject(new Error(`All Overpass mirrors failed: ${errors.join('; ')}`))
        }
      })
    })
  })
}
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
[out:json][timeout:15];
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
  node["amenity"="bicycle_repair_station"](${b});
  node["amenity"~"^(fire_station|hospital|clinic|doctors)$"](${b});
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential)$"](${b});
  node["place"~"^(city|town|village|hamlet)$"](${b});
  node["amenity"="shelter"](${b});
);
out body;
>;
out skel qt;
`.trim()
}

// ─── Surface tag → normalized type ───────────────────────────────────────────

function normalizeSurface(tags: Record<string, string>): SurfaceType {
  const surface  = tags['surface']
  const highway  = tags['highway']
  const tracktype = tags['tracktype']

  if (surface) {
    if (['asphalt', 'paved', 'concrete', 'chipseal', 'paving_stones', 'cobblestone', 'sett', 'metal', 'wood'].includes(surface)) return 'paved'
    if (['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'rock', 'stones', 'crushed_limestone'].includes(surface)) return 'gravel'
    if (['dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'unpaved', 'woodchips'].includes(surface)) return 'dirt'
  }

  if (tracktype) {
    if (tracktype === 'grade1') return 'paved'
    if (['grade2', 'grade3'].includes(tracktype)) return 'gravel'
    if (['grade4', 'grade5'].includes(tracktype)) return 'dirt'
  }

  if (highway) {
    if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'cycleway', 'living_street'].includes(highway)) return 'paved'
    if (['track', 'path', 'bridleway', 'footway'].includes(highway)) return 'dirt'
  }

  return 'unknown'
}

// ─── Point-to-segment distance (km²) ─────────────────────────────────────────
// Returns the squared kilometre distance from point (px, py) to the nearest
// point on segment (ax,ay)→(bx,by). All coordinates in degrees (lng, lat).

function ptSegDistKm2(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const cosLat = Math.cos(py * Math.PI / 180)
  const sx = cosLat * 111   // lng-degree → km
  const sy = 111            // lat-degree → km
  const dx = (bx - ax) * sx,  dy = (by - ay) * sy
  const ex = (px - ax) * sx,  ey = (py - ay) * sy
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return ex * ex + ey * ey
  const t  = Math.max(0, Math.min(1, (ex * dx + ey * dy) / len2))
  const fx = ex - t * dx,  fy = ey - t * dy
  return fx * fx + fy * fy
}

// ─── OSM node → POI ───────────────────────────────────────────────────────────

function classifyNode(tags: Record<string, string>): { type: POIType; potable?: boolean; name?: string; note?: string } | null {
  // Water
  if (tags['natural'] === 'spring') {
    const potable = tags['drinking_water'] !== 'no'
    return { type: 'water', potable, name: tags['name'], note: potable ? 'Natural spring' : 'Natural spring — filter required' }
  }
  if (tags['amenity'] === 'drinking_water' || tags['amenity'] === 'water_point') {
    return { type: 'water', potable: true, name: tags['name'], note: 'Drinking water' }
  }
  if (tags['man_made'] === 'water_tap') {
    return { type: 'water', potable: true, name: tags['name'], note: 'Water tap' }
  }
  if (tags['natural'] === 'water' && tags['drinking_water'] === 'yes') {
    return { type: 'water', potable: true, name: tags['name'], note: 'Water source' }
  }
  // Shops / repair
  if (tags['shop'] === 'bicycle') {
    return { type: 'shop', name: tags['name'] || tags['brand'], note: 'Bike shop' }
  }
  if (tags['amenity'] === 'bicycle_repair_station') {
    return { type: 'shop', name: tags['name'] || 'Bike repair station', note: 'Self-serve repair station' }
  }
  // Emergency / medical
  if (tags['amenity'] === 'fire_station') {
    return { type: 'emergency', name: tags['name'], note: 'Fire station' }
  }
  if (tags['amenity'] === 'hospital') {
    return { type: 'emergency', name: tags['name'], note: 'Hospital' }
  }
  if (tags['amenity'] === 'clinic') {
    return { type: 'emergency', name: tags['name'], note: 'Medical clinic' }
  }
  if (tags['amenity'] === 'doctors') {
    return { type: 'emergency', name: tags['name'], note: "Doctor's office" }
  }
  if (tags['amenity'] === 'emergency_phone' || tags['emergency'] === 'phone') {
    return { type: 'emergency', name: tags['name'] || 'Emergency phone', note: 'Emergency phone' }
  }
  // Place nodes are handled separately for bailout deduplication — skip here
  if (tags['place'] === 'city' || tags['place'] === 'town' ||
      tags['place'] === 'village' || tags['place'] === 'hamlet') {
    return null
  }
  if (tags['amenity'] === 'shelter') {
    return { type: 'shelter', name: tags['name'], note: 'Shelter' }
  }
  return null
}

// ─── Point-to-route distance helpers ─────────────────────────────────────────

// Returns cumulative route distance (km from start) at the nearest point.
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

  const frac = bestIdx / (coords.length - 1)
  return Math.round(frac * route.distance_km * 100) / 100
}

// Returns the lateral (perpendicular) distance in km from a point to the
// closest coordinate on the route. Used to filter off-route POIs.
function lateralRouteDistanceKm(
  lat: number,
  lng: number,
  route: CanonicalRoute,
): number {
  const coords = route.geometry.coordinates
  const cosLat  = Math.cos(lat * Math.PI / 180)
  let best = Infinity

  for (const coord of coords) {
    const dLat = (lat - coord[1]) * 111
    const dLng = (lng - coord[0]) * 111 * cosLat
    const d = Math.sqrt(dLat * dLat + dLng * dLng)
    if (d < best) best = d
  }
  return best
}

const MAX_POI_LATERAL_KM = 8.05 // ~5 miles

// ─── Routed bailout geometry (Mapbox Directions) ──────────────────────────────
// Replaces straight-line geometry with an actual cyclist-navigable route.
// Uses Mapbox cycling profile which respects bicycle=no restrictions.
// Falls back to original geometry on any API failure.

// Returns null if the destination is unreachable by bike (road restriction, no route).
// Returns the original bailout (with straight-line fallback geometry) on network failure.
// Returns an enriched bailout with actual routed geometry on success.
async function fetchRoutedBailoutGeometry(b: BailoutRoute): Promise<BailoutRoute | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) {
    // No token → keep with straight-line extension so line is at least visible
    return { ...b, road_geometry: [...b.road_geometry, [b.destination_lng, b.destination_lat]] }
  }
  try {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/cycling/` +
      `${b.intersection_lng},${b.intersection_lat};${b.destination_lng},${b.destination_lat}` +
      `?access_token=${token}&overview=full&geometries=geojson`
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) {
      // HTTP error (not a routing failure) → keep with fallback
      return { ...b, road_geometry: [...b.road_geometry, [b.destination_lng, b.destination_lat]] }
    }
    const data = await res.json()
    // Explicit "no route" from Mapbox means the destination is unreachable by bike
    // (e.g. bicycle=no restriction on the only connecting road) → discard
    if (!data.routes?.[0]) return null

    const routeData = data.routes[0]
    const coords: [number, number][] = routeData.geometry.coordinates
    const bailout_km = Math.round(routeData.distance / 1000 * 10) / 10
    const saves_km   = Math.round((b.route_remaining_km - bailout_km) * 10) / 10
    // Discard if the actual cycling route turns out to be longer than continuing
    if (saves_km < 1) return null
    return { ...b, road_geometry: coords, bailout_km, saves_km }
  } catch {
    // Network/timeout → keep with straight-line fallback rather than silently hiding
    return { ...b, road_geometry: [...b.road_geometry, [b.destination_lng, b.destination_lat]] }
  }
}

// ─── Bailout route detection ──────────────────────────────────────────────────
// Finds roads that physically cross the route and lead to safety in less
// distance than continuing on the original route to the next settlement.
// Only included if saves_km ≥ MIN_SAVES_KM (farther bailouts are excluded
// unless downhill/cell-service logic is added in a future pass).

interface SafeDestination {
  lat: number
  lng: number
  name: string
  type: BailoutDestinationType
}

async function detectBailoutRoutes(
  ways: OsmElement[],
  nodeLookup: Map<number, { lat: number; lon: number }>,
  safeDestinations: SafeDestination[],
  route: CanonicalRoute,
): Promise<BailoutRoute[]> {
  const routeCoords    = route.geometry.coordinates   // [lng, lat, ele?][]
  const totalKm        = route.distance_km
  const INTERSECTION_SQ    = 0.0015 * 0.0015  // ~165 m threshold (degrees²)
  const PARALLEL_THRESH    = 0.75              // |cos θ| > this → parallel → skip
  const MIN_SAVES_KM       = 3
  const MAX_TOWN_ABSOLUTE  = 120               // absolute ceiling regardless of route length
  const MIN_SPACING_KM     = 15
  const MAX_BAILOUTS       = 5

  const NAVIGABLE = new Set([
    'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'road', 'service', 'track',
  ])
  const roadWays = ways.filter(w => w.tags?.highway && NAVIGABLE.has(w.tags.highway))

  // Safe points along the original route (towns/facilities within ~3.3 km)
  const routeSafePoints: Array<{ distance_km: number; name: string }> = []
  for (const dest of safeDestinations) {
    const { lat, lng } = dest
    let bestSq = Infinity, bestIdx = 0
    for (let i = 0; i < routeCoords.length; i++) {
      const dLat = lat - routeCoords[i][1]
      const dLng = lng - routeCoords[i][0]
      const sq = dLat * dLat + dLng * dLng
      if (sq < bestSq) { bestSq = sq; bestIdx = i }
    }
    if (Math.sqrt(bestSq) < 0.03) {
      routeSafePoints.push({
        distance_km: (bestIdx / (routeCoords.length - 1)) * totalKm,
        name: dest.name,
      })
    }
  }
  routeSafePoints.sort((a, b) => a.distance_km - b.distance_km)

  const candidates: BailoutRoute[] = []
  const seenWayIds = new Set<number>()

  for (const way of roadWays) {
    if (seenWayIds.has(way.id)) continue
    const nodeIds = way.nodes ?? []
    if (nodeIds.length < 2) continue

    // Find closest way-node to any route point
    let bestSq = Infinity, intersectNodeIdx = -1, routePointIdx = -1
    for (let wi = 0; wi < nodeIds.length; wi++) {
      const node = nodeLookup.get(nodeIds[wi])
      if (!node) continue
      for (let ri = 0; ri < routeCoords.length; ri++) {
        const dLat = node.lat - routeCoords[ri][1]
        const dLng = node.lon - routeCoords[ri][0]
        const sq = dLat * dLat + dLng * dLng
        if (sq < bestSq) { bestSq = sq; intersectNodeIdx = wi; routePointIdx = ri }
      }
    }
    if (bestSq > INTERSECTION_SQ) continue
    seenWayIds.add(way.id)

    const intersectNode = nodeLookup.get(nodeIds[intersectNodeIdx])!

    // Route direction at intersection (±5 points for stability)
    const ri    = routePointIdx
    const rPrev = routeCoords[Math.max(0, ri - 5)]
    const rNext = routeCoords[Math.min(routeCoords.length - 1, ri + 5)]
    const routeDX = rNext[0] - rPrev[0]
    const routeDY = rNext[1] - rPrev[1]
    const routeLen = Math.sqrt(routeDX * routeDX + routeDY * routeDY)

    // Determine which end of the road is farther from intersection
    const endANode = nodeLookup.get(nodeIds[0])
    const endBNode = nodeLookup.get(nodeIds[nodeIds.length - 1])
    if (!endANode || !endBNode) continue

    const dToA = Math.sqrt(Math.pow(endANode.lat - intersectNode.lat, 2) + Math.pow(endANode.lon - intersectNode.lon, 2))
    const dToB = Math.sqrt(Math.pow(endBNode.lat - intersectNode.lat, 2) + Math.pow(endBNode.lon - intersectNode.lon, 2))
    const farEndNode = dToA >= dToB ? endANode : endBNode
    const farEndIsA  = dToA >= dToB

    // Direction check: skip roads running parallel to route
    const roadDX = farEndNode.lon - intersectNode.lon
    const roadDY = farEndNode.lat - intersectNode.lat
    const roadLen = Math.sqrt(roadDX * roadDX + roadDY * roadDY)
    if (routeLen > 0 && roadLen > 0) {
      const absDot = Math.abs((routeDX * roadDX + routeDY * roadDY) / (routeLen * roadLen))
      if (absDot > PARALLEL_THRESH) continue
    }

    // Compute route position and remaining distance to next safe point first —
    // so the town search radius can be derived from actual remaining distance.
    const routePositionKm = Math.round((routePointIdx / (routeCoords.length - 1)) * totalKm * 100) / 100
    const nextSafe = routeSafePoints.find(sp => sp.distance_km > routePositionKm + 2)
    const route_remaining_km = Math.round(((nextSafe?.distance_km ?? totalKm) - routePositionKm) * 10) / 10

    // Max town distance: anything that could possibly save MIN_SAVES_KM, capped at 120 km
    const maxTownKm = Math.min(route_remaining_km - MIN_SAVES_KM, MAX_TOWN_ABSOLUTE)
    if (maxTownKm <= 0) continue

    // Find nearest safe destination to the far end of the road within the dynamic radius
    let bestTown: { name: string; lat: number; lng: number; distKm: number; type: BailoutDestinationType } | null = null
    for (const dest of safeDestinations) {
      const dLat = (dest.lat - farEndNode.lat) * 111
      const dLng = (dest.lng - farEndNode.lon) * 111 * Math.cos(farEndNode.lat * Math.PI / 180)
      const distKm = Math.sqrt(dLat * dLat + dLng * dLng)
      if (distKm <= maxTownKm && (!bestTown || distKm < bestTown.distKm)) {
        bestTown = { name: dest.name, lat: dest.lat, lng: dest.lng, distKm, type: dest.type }
      }
    }
    if (!bestTown) continue

    // Road geometry: from intersection toward the far (town) end
    const allCoords: [number, number][] = nodeIds
      .map(nid => nodeLookup.get(nid))
      .filter((n): n is { lat: number; lon: number } => n != null)
      .map(n => [n.lon, n.lat])
    const roadSegment: [number, number][] = farEndIsA
      ? allCoords.slice(0, intersectNodeIdx + 1).reverse()
      : allCoords.slice(intersectNodeIdx)

    // Road length from intersection to far end
    let roadLengthKm = 0
    for (let i = 1; i < roadSegment.length; i++) {
      const dLat = (roadSegment[i][1] - roadSegment[i - 1][1]) * 111
      const dLng = (roadSegment[i][0] - roadSegment[i - 1][0]) * 111 * Math.cos(roadSegment[i][1] * Math.PI / 180)
      roadLengthKm += Math.sqrt(dLat * dLat + dLng * dLng)
    }

    const bailout_km = Math.round((roadLengthKm + bestTown.distKm) * 10) / 10
    const saves_km   = Math.round((route_remaining_km - bailout_km) * 10) / 10

    if (saves_km < MIN_SAVES_KM) continue

    // Skip if the bailout destination is the same town as the next safe point —
    // that's not a bailout, it's the same destination.
    if (nextSafe && bestTown.name === nextSafe.name) continue

    // Require drawable geometry (≥2 points for a valid LineString)
    if (roadSegment.length < 2) continue

    candidates.push({
      id: uuidv4(),
      intersection_lat: intersectNode.lat,
      intersection_lng: intersectNode.lon,
      distance_km: routePositionKm,
      road_name: way.tags?.['name'],
      destination_name: bestTown.name,
      destination_type: bestTown.type,
      destination_lat: bestTown.lat,
      destination_lng: bestTown.lng,
      bailout_km,
      route_remaining_km,
      next_safe_name: nextSafe?.name,
      saves_km,
      road_geometry: roadSegment,
    })
  }

  // Sort by route position, deduplicate with min spacing (keep best savings per zone)
  candidates.sort((a, b) => a.distance_km - b.distance_km)
  const kept: BailoutRoute[] = []
  for (const b of candidates) {
    const last = kept[kept.length - 1]
    if (!last || (b.distance_km - last.distance_km) >= MIN_SPACING_KM) {
      kept.push(b)
    } else if (b.saves_km > last.saves_km) {
      kept[kept.length - 1] = b
    }
    if (kept.length >= MAX_BAILOUTS) break
  }

  // Enrich each kept bailout with actual cyclist-routed geometry in parallel.
  // fetchRoutedBailoutGeometry returns null when no cycling route exists (e.g. bicycle=no road) — discard those.
  const routed = await Promise.all(kept.map(fetchRoutedBailoutGeometry))
  return routed.filter((b): b is BailoutRoute => b !== null)
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
// Samples the route at evenly-spaced points, assigns each a surface type by
// finding the nearest OSM way segment (not just nearest node), then returns
// both ordered surface segments (for elevation profile coloring) and aggregate
// stats (for the summary card).

function computeSurfaceStats(
  ways: OsmElement[],
  nodeLookup: Map<number, { lat: number; lon: number }>,
  route: CanonicalRoute,
): { stats: SurfaceStat[]; segments: SurfaceSegment[] } {
  const routeCoords = route.geometry.coordinates  // [lng, lat, ele?][]
  const totalKm     = route.distance_km

  // Pre-filter: keep only ways that have any node within ~150m of any route coord.
  // Node-based pre-filter is intentionally loose so the tighter segment-based
  // scoring step below doesn't miss any candidate ways.
  const PRE_DEG_SQ = 0.00135 * 0.00135   // ~150 m in degrees²
  const candidateWays: OsmElement[] = []
  for (const way of ways) {
    const nodeIds = way.nodes ?? []
    let found = false
    for (let ni = 0; ni < nodeIds.length && !found; ni++) {
      const node = nodeLookup.get(nodeIds[ni])
      if (!node) continue
      for (const coord of routeCoords) {
        const dLat = node.lat - coord[1]
        const dLng = node.lon - coord[0]
        if (dLat * dLat + dLng * dLng < PRE_DEG_SQ) { found = true; break }
      }
    }
    if (found) candidateWays.push(way)
  }

  // Sample the route at evenly-spaced indices, assign surface by nearest segment.
  const SAMPLES        = Math.min(routeCoords.length, 200)
  const ON_ROUTE_KM2   = 0.05 * 0.05   // 50 m threshold in km²
  const surfaceAtSample: SurfaceType[] = []

  for (let s = 0; s < SAMPLES; s++) {
    const idx        = Math.round((s / (SAMPLES - 1)) * (routeCoords.length - 1))
    const [px, py]   = routeCoords[idx]
    let bestDist2    = Infinity
    let bestSurface: SurfaceType = 'unknown'

    for (const way of candidateWays) {
      const nodeIds = way.nodes ?? []
      for (let ni = 0; ni < nodeIds.length - 1; ni++) {
        const a = nodeLookup.get(nodeIds[ni])
        const b = nodeLookup.get(nodeIds[ni + 1])
        if (!a || !b) continue
        const d2 = ptSegDistKm2(px, py, a.lon, a.lat, b.lon, b.lat)
        if (d2 < bestDist2) { bestDist2 = d2; bestSurface = normalizeSurface(way.tags ?? {}) }
      }
    }

    surfaceAtSample.push(bestDist2 <= ON_ROUTE_KM2 ? bestSurface : 'unknown')
  }

  // Compress consecutive same-surface runs into ordered segments.
  const segments: SurfaceSegment[] = []
  if (SAMPLES > 0) {
    let runType  = surfaceAtSample[0]
    let runStart = 0
    for (let s = 1; s <= SAMPLES; s++) {
      const next = s < SAMPLES ? surfaceAtSample[s] : null
      if (next !== runType) {
        segments.push({
          from_km: Math.round((runStart / (SAMPLES - 1)) * totalKm * 10) / 10,
          to_km:   s < SAMPLES
            ? Math.round(((s - 1) / (SAMPLES - 1)) * totalKm * 10) / 10
            : totalKm,
          type: runType,
        })
        if (next !== null) { runType = next; runStart = s }
      }
    }
  }

  // Aggregate stats from segments.
  const counts: Record<SurfaceType, number> = { paved: 0, gravel: 0, dirt: 0, unknown: 0 }
  for (const seg of segments) counts[seg.type] += seg.to_km - seg.from_km
  const stats: SurfaceStat[] = (['paved', 'gravel', 'dirt', 'unknown'] as SurfaceType[])
    .filter(t => counts[t] > 0.1)
    .map(t => ({
      type: t,
      pct: Math.round((counts[t] / totalKm) * 100),
      km:  Math.round(counts[t] * 10) / 10,
    }))

  return { stats, segments }
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
  surface_segments: SurfaceSegment[]
  pois: POI[]
  supply_gaps: SupplyGap[]
  bailouts: BailoutRoute[]
}> {
  const query = buildQuery(route.bbox)
  const body = `data=${encodeURIComponent(query)}`

  const res = await fetchFromAnyMirror(body)

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

  const { stats: surfaces, segments: surface_segments } = computeSurfaceStats(ways, nodeLookup, route)

  // Separate place nodes for bailout handling
  const placeNodes = nodes.filter(n => {
    const p = n.tags?.['place']
    return p === 'city' || p === 'town' || p === 'village' || p === 'hamlet'
  })

  // Build unified safe destinations: towns + fire stations + hospitals/clinics
  const safeDestinations: SafeDestination[] = [
    ...placeNodes.map(n => ({
      lat: n.lat!, lng: n.lon!,
      name: n.tags?.['name'] ?? 'Town',
      type: 'town' as const,
    })),
    ...nodes
      .filter(n => n.tags?.['amenity'] === 'fire_station')
      .map(n => ({
        lat: n.lat!, lng: n.lon!,
        name: n.tags?.['name'] ?? 'Fire Station',
        type: 'fire_station' as const,
      })),
    ...nodes
      .filter(n => n.tags?.['amenity'] === 'hospital' || n.tags?.['amenity'] === 'clinic')
      .map(n => ({
        lat: n.lat!, lng: n.lon!,
        name: n.tags?.['name'] ?? 'Medical Facility',
        type: 'medical' as const,
      })),
  ]

  const pois: POI[] = []

  // Standard POIs (water, shop, emergency, shelter)
  for (const node of nodes) {
    const tags = node.tags ?? {}
    const classification = classifyNode(tags)
    if (!classification) continue

    const lat = node.lat!
    const lng = node.lon!

    // Skip POIs more than 5 miles off-route
    if (lateralRouteDistanceKm(lat, lng, route) > MAX_POI_LATERAL_KM) continue

    const distance_km = nearestRouteDistance(lat, lng, route)

    pois.push({
      id: uuidv4(),
      type: classification.type,
      name: classification.name || `${classification.type} (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
      lat,
      lng,
      distance_km,
      potable: classification.potable,
      note: classification.note,
      tags,
    })
  }

  // Sort POIs by distance along route
  pois.sort((a, b) => a.distance_km - b.distance_km)

  // Deduplicate: drop same-type POIs within 0.5 km of each other (keep first)
  const dedupedPois: POI[] = []
  for (const poi of pois) {
    const tooClose = dedupedPois.some(
      p => p.type === poi.type && Math.abs(p.distance_km - poi.distance_km) < 0.5
    )
    if (!tooClose) dedupedPois.push(poi)
  }

  const supply_gaps = detectSupplyGaps(dedupedPois, route.distance_km)
  const bailouts    = await detectBailoutRoutes(ways, nodeLookup, safeDestinations, route)

  return { surfaces, surface_segments, pois: dedupedPois, supply_gaps, bailouts }
}
