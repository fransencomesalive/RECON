type Position = number[]

const EARTH_RADIUS_KM = 6371
const MIN_SEGMENT_KM = 0.001

function haversineKm(a: Position, b: Position): number {
  const lat1 = a[1] * Math.PI / 180
  const lat2 = b[1] * Math.PI / 180
  const dLat = lat2 - lat1
  const dLng = (b[0] - a[0]) * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h))
}

export function cumulativeRouteDistances(coords: Position[]): number[] {
  if (coords.length === 0) return []

  const distances = [0]
  for (let i = 1; i < coords.length; i++) {
    distances.push(distances[i - 1] + haversineKm(coords[i - 1], coords[i]))
  }
  return distances
}

function interpolatePosition(a: Position, b: Position, fraction: number): Position {
  const dimensions = Math.max(a.length, b.length)
  return Array.from({ length: dimensions }, (_, i) => {
    const start = a[i] ?? 0
    const end = b[i] ?? start
    return start + (end - start) * fraction
  })
}

function coordinateAtDistance(
  coords: Position[],
  cumulative: number[],
  distanceKm: number,
): Position {
  if (distanceKm <= 0) return [...coords[0]]

  const totalKm = cumulative[cumulative.length - 1]
  if (distanceKm >= totalKm) return [...coords[coords.length - 1]]

  let low = 1
  let high = cumulative.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (cumulative[mid] < distanceKm) low = mid + 1
    else high = mid
  }

  const endIndex = low
  const startIndex = endIndex - 1
  const segmentKm = cumulative[endIndex] - cumulative[startIndex]
  const fraction = segmentKm > 0
    ? (distanceKm - cumulative[startIndex]) / segmentKm
    : 0
  return interpolatePosition(coords[startIndex], coords[endIndex], fraction)
}

function samePosition(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10
}

/**
 * Slice route coordinates by traveled distance rather than raw vertex index.
 * Returns an empty array for zero-length intervals so callers never emit an
 * invalid one-position GeoJSON LineString.
 */
export function sliceRouteByDistance(
  coords: Position[],
  fromKm: number,
  toKm: number,
): Position[] {
  if (coords.length < 2) return []

  const cumulative = cumulativeRouteDistances(coords)
  const totalKm = cumulative[cumulative.length - 1]
  const startKm = Math.max(0, Math.min(fromKm, totalKm))
  const endKm = Math.max(startKm, Math.min(toKm, totalKm))
  if (endKm - startKm < MIN_SEGMENT_KM) return []

  const sliced: Position[] = [coordinateAtDistance(coords, cumulative, startKm)]
  for (let i = 1; i < coords.length - 1; i++) {
    if (cumulative[i] > startKm && cumulative[i] < endKm) sliced.push([...coords[i]])
  }
  sliced.push(coordinateAtDistance(coords, cumulative, endKm))

  const deduped = sliced.filter((coord, index) =>
    index === 0 || !samePosition(coord, sliced[index - 1])
  )
  return deduped.length >= 2 ? deduped : []
}
