import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import lineIntersect from '@turf/line-intersect'
import { lineString, point } from '@turf/helpers'
import type { CanonicalRoute, LandAccess, LandCrossing, LandOwnership, LandStatus } from './types'

const PAD_US_FEE_MANAGERS =
  'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query'

const REQUEST_TIMEOUT_MS = 12_000
const ROUTE_CHUNK_COORDS = 500
const FEATURE_BATCH_SIZE = 50
const REQUEST_CONCURRENCY = 4
const DISTANCE_EPSILON_KM = 1e-7

const PAD_US_FIELDS = [
  'OBJECTID',
  'Category',
  'Own_Type',
  'Own_Name',
  'Mang_Type',
  'Mang_Name',
  'Unit_Nm',
  'Loc_Nm',
  'Pub_Access',
  'Access_Src',
  'Access_Dt',
  'GIS_Src',
  'Src_Date',
  'GIS_Acres',
].join(',')

type Position2D = [number, number]
type PadUsGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon

interface PadUsProperties {
  OBJECTID: number
  Category?: string | null
  Own_Type?: string | null
  Own_Name?: string | null
  Mang_Type?: string | null
  Mang_Name?: string | null
  Unit_Nm?: string | null
  Loc_Nm?: string | null
  Pub_Access?: string | null
  Access_Src?: string | null
  Access_Dt?: string | null
  GIS_Src?: string | null
  Src_Date?: string | null
  GIS_Acres?: number | null
}

type PadUsFeature = GeoJSON.Feature<PadUsGeometry, PadUsProperties>

interface EsriIdsResponse {
  objectIdFieldName?: string
  objectIds?: number[]
  error?: { message?: string; details?: string[] }
}

interface EsriGeoJsonResponse extends GeoJSON.FeatureCollection<PadUsGeometry, PadUsProperties> {
  error?: { message?: string; details?: string[] }
  exceededTransferLimit?: boolean
}

interface RouteSegment {
  start: Position2D
  end: Position2D
  startKm: number
  endKm: number
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

interface ClassifiedFeature {
  feature: PadUsFeature
  crossing: Omit<LandCrossing, 'entry_km' | 'exit_km'>
}

interface CandidateInterval extends ClassifiedFeature {
  entryKm: number
  exitKm: number
}

const AGENCY_LABELS: Record<string, string> = {
  ARS: 'Agricultural Research Service',
  BIA: 'Bureau of Indian Affairs',
  BLM: 'Bureau of Land Management',
  BPA: 'Bonneville Power Administration',
  CITY: 'City or Municipal Government',
  CNTY: 'County Government',
  DOD: 'Department of Defense',
  DOE: 'Department of Energy',
  FWS: 'US Fish & Wildlife Service',
  NGO: 'Non-Governmental Organization',
  NPS: 'National Park Service',
  NRCS: 'Natural Resources Conservation Service',
  OTHF: 'Other Federal Agency',
  OTHS: 'Other State Agency',
  REG: 'Regional Agency',
  RWD: 'Regional Water District',
  SDC: 'State Department of Conservation',
  SDNR: 'State Department of Natural Resources',
  SDOL: 'State Department of Lands',
  SFW: 'State Fish and Wildlife Agency',
  SLB: 'State Land Board',
  SPR: 'State Parks and Recreation',
  TERR: 'Territorial Government',
  TRIB: 'American Indian Lands',
  TVA: 'Tennessee Valley Authority',
  USACE: 'Army Corps of Engineers',
  USBR: 'Bureau of Reclamation',
  USFS: 'USDA Forest Service',
}

function esriErrorMessage(error: EsriIdsResponse['error']): string {
  const details = error?.details?.filter(Boolean).join('; ')
  return [error?.message, details].filter(Boolean).join(': ') || 'Unknown PAD-US response error'
}

async function fetchEsriJson<T>(body: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(PAD_US_FEE_MANAGERS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  })

  if (!response.ok) throw new Error(`PAD-US error: ${response.status}`)
  return response.json() as Promise<T>
}

function chunkRoute(coords: Position2D[]): Position2D[][] {
  const chunks: Position2D[][] = []
  for (let start = 0; start < coords.length - 1; start += ROUTE_CHUNK_COORDS - 1) {
    const chunk = coords.slice(start, start + ROUTE_CHUNK_COORDS)
    if (chunk.length >= 2) chunks.push(chunk)
  }
  return chunks
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size))
  return chunks
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return []

  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await mapper(values[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

async function queryIntersectingIds(
  routeChunk: Position2D[],
  signal: AbortSignal,
): Promise<number[]> {
  const body = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({
      paths: [routeChunk],
      spatialReference: { wkid: 4326 },
    }),
    geometryType: 'esriGeometryPolyline',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnIdsOnly: 'true',
    f: 'json',
  })

  const data = await fetchEsriJson<EsriIdsResponse>(body, signal)
  if (data.error) throw new Error(`PAD-US error: ${esriErrorMessage(data.error)}`)
  if (!Array.isArray(data.objectIds)) {
    throw new Error('PAD-US error: object ID query returned an invalid response')
  }
  return data.objectIds
}

async function fetchFeatures(objectIds: number[], signal: AbortSignal): Promise<PadUsFeature[]> {
  const body = new URLSearchParams({
    objectIds: objectIds.join(','),
    outFields: PAD_US_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  })

  const data = await fetchEsriJson<EsriGeoJsonResponse>(body, signal)
  if (data.error) throw new Error(`PAD-US error: ${esriErrorMessage(data.error)}`)
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('PAD-US error: feature query returned an invalid GeoJSON response')
  }
  if (data.exceededTransferLimit) {
    throw new Error('PAD-US error: feature query exceeded the service transfer limit')
  }

  const invalidFeature = data.features.find(feature =>
    !feature.properties ||
    typeof feature.properties.OBJECTID !== 'number' ||
    (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon')
  )
  if (invalidFeature) {
    throw new Error('PAD-US error: feature query returned an invalid polygon')
  }

  const returnedIds = new Set(data.features.map(feature => feature.properties.OBJECTID))
  const missingIds = objectIds.filter(objectId => !returnedIds.has(objectId))
  if (missingIds.length > 0) {
    throw new Error(`PAD-US error: feature query omitted ${missingIds.length} requested records`)
  }

  return data.features
}

function haversineKm(a: Position2D, b: Position2D): number {
  const earthRadiusKm = 6371
  const lat1 = a[1] * Math.PI / 180
  const lat2 = b[1] * Math.PI / 180
  const dLat = lat2 - lat1
  const dLng = (b[0] - a[0]) * Math.PI / 180
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return earthRadiusKm * 2 * Math.asin(Math.sqrt(value))
}

function buildRouteSegments(coords: Position2D[]): { segments: RouteSegment[]; totalKm: number } {
  const segments: RouteSegment[] = []
  let cumulativeKm = 0

  for (let i = 1; i < coords.length; i++) {
    const start = coords[i - 1]
    const end = coords[i]
    const segmentKm = haversineKm(start, end)
    if (segmentKm <= DISTANCE_EPSILON_KM) continue

    segments.push({
      start,
      end,
      startKm: cumulativeKm,
      endKm: cumulativeKm + segmentKm,
      minLng: Math.min(start[0], end[0]),
      minLat: Math.min(start[1], end[1]),
      maxLng: Math.max(start[0], end[0]),
      maxLat: Math.max(start[1], end[1]),
    })
    cumulativeKm += segmentKm
  }

  return { segments, totalKm: cumulativeKm }
}

function geometryBounds(geometry: PadUsGeometry): [number, number, number, number] {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  const visitRing = (ring: GeoJSON.Position[]) => {
    for (const coordinate of ring) {
      minLng = Math.min(minLng, coordinate[0])
      minLat = Math.min(minLat, coordinate[1])
      maxLng = Math.max(maxLng, coordinate[0])
      maxLat = Math.max(maxLat, coordinate[1])
    }
  }

  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach(visitRing)
  } else {
    geometry.coordinates.forEach(polygon => polygon.forEach(visitRing))
  }

  return [minLng, minLat, maxLng, maxLat]
}

function boundsOverlap(segment: RouteSegment, bounds: [number, number, number, number]): boolean {
  return segment.maxLng >= bounds[0] && segment.minLng <= bounds[2] &&
    segment.maxLat >= bounds[1] && segment.minLat <= bounds[3]
}

function intersectionFraction(
  start: Position2D,
  end: Position2D,
  intersection: GeoJSON.Position,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const denominator = dx * dx + dy * dy
  if (denominator === 0) return 0
  const fraction = ((intersection[0] - start[0]) * dx + (intersection[1] - start[1]) * dy) /
    denominator
  return Math.max(0, Math.min(1, fraction))
}

function uniqueSorted(values: number[]): number[] {
  const sorted = values.sort((a, b) => a - b)
  return sorted.filter((value, index) =>
    index === 0 || Math.abs(value - sorted[index - 1]) > DISTANCE_EPSILON_KM
  )
}

function featureIntervals(
  classified: ClassifiedFeature,
  routeSegments: RouteSegment[],
): CandidateInterval[] {
  const bounds = geometryBounds(classified.feature.geometry)
  const intervals: CandidateInterval[] = []

  for (const segment of routeSegments) {
    if (!boundsOverlap(segment, bounds)) continue

    const segmentLine = lineString([segment.start, segment.end])
    const intersections = lineIntersect(segmentLine, classified.feature)
    const segmentKm = segment.endKm - segment.startKm
    const breakpoints = uniqueSorted([
      segment.startKm,
      segment.endKm,
      ...intersections.features.map(intersection =>
        segment.startKm + segmentKm * intersectionFraction(
          segment.start,
          segment.end,
          intersection.geometry.coordinates,
        )
      ),
    ])

    for (let i = 1; i < breakpoints.length; i++) {
      const entryKm = breakpoints[i - 1]
      const exitKm = breakpoints[i]
      if (exitKm - entryKm <= DISTANCE_EPSILON_KM) continue

      const midpointFraction = ((entryKm + exitKm) / 2 - segment.startKm) / segmentKm
      const midpoint: Position2D = [
        segment.start[0] + (segment.end[0] - segment.start[0]) * midpointFraction,
        segment.start[1] + (segment.end[1] - segment.start[1]) * midpointFraction,
      ]
      if (!booleanPointInPolygon(point(midpoint), classified.feature)) continue

      const previous = intervals.at(-1)
      if (previous && Math.abs(previous.exitKm - entryKm) <= DISTANCE_EPSILON_KM) {
        previous.exitKm = exitKm
      } else {
        intervals.push({ ...classified, entryKm, exitKm })
      }
    }
  }

  return intervals
}

function ownershipFrom(properties: PadUsProperties): LandOwnership {
  const ownerType = properties.Own_Type?.trim().toUpperCase()
  const managerType = properties.Mang_Type?.trim().toUpperCase()
  const managerName = properties.Mang_Name?.trim().toUpperCase()

  if (ownerType === 'TRIB' || managerType === 'TRIB' || managerName === 'TRIB') return 'tribal'

  switch (ownerType) {
    case 'FED': return 'federal'
    case 'STAT': return 'state'
    case 'LOC':
    case 'DIST': return 'local'
    case 'NGO': return 'nonprofit'
    case 'PVT': return 'private'
    case 'JNT': return 'joint'
    case 'TERR': return 'territorial'
    default: return 'unknown'
  }
}

function legacyStatus(ownership: LandOwnership): LandStatus {
  switch (ownership) {
    case 'state': return 'state'
    case 'private': return 'private'
    case 'tribal': return 'tribal'
    case 'unknown': return 'unknown'
    default: return 'public'
  }
}

function accessFrom(code: string | null | undefined): LandAccess {
  switch (code?.trim().toUpperCase()) {
    case 'OA': return 'open'
    case 'RA': return 'restricted'
    case 'XA': return 'closed'
    default: return 'unknown'
  }
}

function ownershipLabel(ownership: LandOwnership): string {
  switch (ownership) {
    case 'federal': return 'Federal Land'
    case 'state': return 'State Land'
    case 'local': return 'Local Public Land'
    case 'tribal': return 'Tribal Area'
    case 'nonprofit': return 'Nonprofit Protected Land'
    case 'private': return 'Private Protected Land'
    case 'joint': return 'Jointly Managed Land'
    case 'territorial': return 'Territorial Land'
    case 'unknown': return 'Protected Area'
  }
}

function normalizeAgency(properties: PadUsProperties): string {
  const manager = properties.Mang_Name?.trim()
  if (manager) return AGENCY_LABELS[manager.toUpperCase()] ?? manager

  const owner = properties.Own_Name?.trim()
  if (owner) return AGENCY_LABELS[owner.toUpperCase()] ?? owner
  return 'Unknown Land Manager'
}

function classifyFeature(feature: PadUsFeature): ClassifiedFeature {
  const properties = feature.properties
  const ownership = ownershipFrom(properties)
  const agency = normalizeAgency(properties)
  const name = properties.Unit_Nm?.trim() || properties.Loc_Nm?.trim() || agency

  return {
    feature,
    crossing: {
      name,
      agency,
      type: ownershipLabel(ownership),
      status: legacyStatus(ownership),
      ownership,
      access: accessFrom(properties.Pub_Access),
      evidence: 'pad-us-fee',
      ...(properties.Src_Date ? { source_date: properties.Src_Date } : {}),
      ...(properties.Access_Src ? { access_source: properties.Access_Src } : {}),
    },
  }
}

function accessRisk(access: LandAccess | undefined): number {
  switch (access) {
    case 'closed': return 4
    case 'restricted': return 3
    case 'unknown': return 2
    case 'open': return 1
    default: return 0
  }
}

function ownershipRisk(ownership: LandOwnership | undefined): number {
  switch (ownership) {
    case 'private': return 8
    case 'tribal': return 7
    case 'unknown': return 6
    case 'joint': return 5
    case 'nonprofit': return 4
    case 'territorial': return 3
    case 'local': return 2
    case 'state': return 2
    case 'federal': return 1
    default: return 0
  }
}

function compareCandidates(a: CandidateInterval, b: CandidateInterval): number {
  const accessDifference = accessRisk(b.crossing.access) - accessRisk(a.crossing.access)
  if (accessDifference !== 0) return accessDifference

  const ownershipDifference = ownershipRisk(b.crossing.ownership) - ownershipRisk(a.crossing.ownership)
  if (ownershipDifference !== 0) return ownershipDifference

  const aIsFee = a.feature.properties.Category?.toLowerCase() === 'fee' ? 1 : 0
  const bIsFee = b.feature.properties.Category?.toLowerCase() === 'fee' ? 1 : 0
  if (aIsFee !== bIsFee) return bIsFee - aIsFee

  const acreageDifference = (a.feature.properties.GIS_Acres ?? Infinity) -
    (b.feature.properties.GIS_Acres ?? Infinity)
  if (Number.isFinite(acreageDifference) && acreageDifference !== 0) return acreageDifference

  return a.feature.properties.OBJECTID - b.feature.properties.OBJECTID
}

function unverifiedGap(entryKm: number, exitKm: number): LandCrossing {
  return {
    name: 'Unverified land ownership',
    agency: 'No PAD-US fee record',
    type: 'Unverified',
    status: 'unknown',
    ownership: 'unknown',
    access: 'unverified',
    evidence: 'unverified-gap',
    entry_km: entryKm,
    exit_km: exitKm,
  }
}

function crossingKey(crossing: LandCrossing): string {
  return [
    crossing.name,
    crossing.agency,
    crossing.type,
    crossing.status,
    crossing.ownership,
    crossing.access,
    crossing.evidence,
    crossing.source_date,
    crossing.access_source,
  ].join('|')
}

function resolveIntervals(candidates: CandidateInterval[], totalKm: number): LandCrossing[] {
  const breakpoints = uniqueSorted([
    0,
    totalKm,
    ...candidates.flatMap(candidate => [candidate.entryKm, candidate.exitKm]),
  ])
  const resolved: LandCrossing[] = []

  for (let i = 1; i < breakpoints.length; i++) {
    const entryKm = breakpoints[i - 1]
    const exitKm = breakpoints[i]
    if (exitKm - entryKm <= DISTANCE_EPSILON_KM) continue

    const midpointKm = (entryKm + exitKm) / 2
    const active = candidates
      .filter(candidate =>
        candidate.entryKm - DISTANCE_EPSILON_KM <= midpointKm &&
        candidate.exitKm + DISTANCE_EPSILON_KM >= midpointKm
      )
      .sort(compareCandidates)

    const crossing: LandCrossing = active.length > 0
      ? { ...active[0].crossing, entry_km: entryKm, exit_km: exitKm }
      : unverifiedGap(entryKm, exitKm)

    const previous = resolved.at(-1)
    if (
      previous &&
      Math.abs(previous.exit_km - entryKm) <= DISTANCE_EPSILON_KM &&
      crossingKey(previous) === crossingKey(crossing)
    ) {
      previous.exit_km = exitKm
    } else {
      resolved.push(crossing)
    }
  }

  return resolved
}

export async function enrichPublicLands(route: CanonicalRoute): Promise<LandCrossing[]> {
  const coords = route.geometry.coordinates
    .map(coordinate => [coordinate[0], coordinate[1]] as Position2D)
  if (coords.some(coordinate =>
    !Number.isFinite(coordinate[0]) ||
    !Number.isFinite(coordinate[1]) ||
    coordinate[0] < -180 || coordinate[0] > 180 ||
    coordinate[1] < -90 || coordinate[1] > 90
  )) {
    throw new Error('Invalid route geometry')
  }

  const { segments, totalKm } = buildRouteSegments(coords)
  if (segments.length === 0 || totalKm <= DISTANCE_EPSILON_KM) return []

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const idGroups = await mapConcurrent(
      chunkRoute(coords),
      REQUEST_CONCURRENCY,
      routeChunk => queryIntersectingIds(routeChunk, controller.signal),
    )
    const objectIds = [...new Set(idGroups.flat())].sort((a, b) => a - b)

    const featureGroups = await mapConcurrent(
      chunkValues(objectIds, FEATURE_BATCH_SIZE),
      REQUEST_CONCURRENCY,
      batch => fetchFeatures(batch, controller.signal),
    )
    const candidates = featureGroups
      .flat()
      .flatMap(feature => featureIntervals(classifyFeature(feature), segments))

    return resolveIntervals(candidates, totalKm)
  } catch (error) {
    if (timedOut) throw new Error('Lands timeout')
    controller.abort()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
