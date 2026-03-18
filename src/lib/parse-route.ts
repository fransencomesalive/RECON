import { DOMParser } from '@xmldom/xmldom'
import { gpx, tcx } from '@tmcw/togeojson'
import bbox from '@turf/bbox'
import length from '@turf/length'
import along from '@turf/along'
import { lineString, featureCollection } from '@turf/helpers'
import type { Feature, LineString, FeatureCollection } from 'geojson'
import { v4 as uuidv4 } from 'uuid'
import type { CanonicalRoute, RoutePoint } from './types'

// ─── Parse GPX / TCX → GeoJSON ────────────────────────────────────────────────

function parseXml(content: string): Document {
  const parser = new DOMParser()
  return parser.parseFromString(content, 'application/xml') as unknown as Document
}

function extractLineString(geoJson: FeatureCollection): Feature<LineString> | null {
  for (const feature of geoJson.features) {
    if (feature.geometry?.type === 'LineString') {
      return feature as Feature<LineString>
    }
    // Some GPX files encode tracks as MultiLineString — take first segment
    if (feature.geometry?.type === 'MultiLineString') {
      const mls = feature.geometry as GeoJSON.MultiLineString
      if (mls.coordinates.length > 0) {
        return {
          type: 'Feature',
          properties: feature.properties,
          geometry: { type: 'LineString', coordinates: mls.coordinates[0] },
        }
      }
    }
  }
  return null
}

// ─── Elevation gain calculation ───────────────────────────────────────────────

function calcElevationGain(coords: number[][]): number {
  let gain = 0
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1][2] ?? 0
    const curr = coords[i][2] ?? 0
    if (curr > prev) gain += curr - prev
  }
  return gain
}

// ─── Sample points along route ────────────────────────────────────────────────
// Returns ~N evenly-spaced points for use in weather / coverage API calls.

function sampleRoute(line: Feature<LineString>, totalKm: number): RoutePoint[] {
  const SAMPLE_INTERVAL_KM = 5
  const points: RoutePoint[] = []
  const coords = line.geometry.coordinates

  // Always include the start
  const addPoint = (distKm: number) => {
    const pt = along(line, distKm, { units: 'kilometers' })
    const [lng, lat] = pt.geometry.coordinates
    // Interpolate elevation from nearest original coord
    const frac = distKm / totalKm
    const idx = Math.min(Math.floor(frac * (coords.length - 1)), coords.length - 1)
    const elevation_m = coords[idx][2] ?? 0
    points.push({ lat, lng, elevation_m, distance_km: distKm })
  }

  for (let d = 0; d <= totalKm; d += SAMPLE_INTERVAL_KM) {
    addPoint(Math.min(d, totalKm))
  }
  // Always include the end if not already there
  if (points[points.length - 1]?.distance_km < totalKm) {
    addPoint(totalKm)
  }

  return points
}

// ─── Name extraction ──────────────────────────────────────────────────────────

function extractName(geoJson: FeatureCollection, fallback: string): string {
  for (const f of geoJson.features) {
    if (f.properties?.name) return f.properties.name as string
    if (f.properties?.title) return f.properties.title as string
  }
  return fallback
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function parseRouteFile(
  content: string,
  fileName: string,
  rideDate: string,
): Promise<CanonicalRoute> {
  const ext = fileName.split('.').pop()?.toLowerCase()
  const doc = parseXml(content)

  let geoJson: FeatureCollection
  if (ext === 'gpx') {
    geoJson = gpx(doc as unknown as Document)
  } else if (ext === 'tcx') {
    geoJson = tcx(doc as unknown as Document)
  } else {
    throw new Error(`Unsupported file type: .${ext}`)
  }

  const lineFeature = extractLineString(geoJson)
  if (!lineFeature) {
    throw new Error('No route track found in file. Make sure the file contains a track or route.')
  }

  const coords = lineFeature.geometry.coordinates
  if (coords.length < 2) {
    throw new Error('Route contains fewer than 2 points.')
  }

  const fc = featureCollection([lineFeature])
  const routeBbox = bbox(fc) as [number, number, number, number]
  const totalKm = length(lineFeature, { units: 'kilometers' })
  const elevGain = calcElevationGain(coords)
  const name = extractName(geoJson, fileName.replace(/\.(gpx|tcx)$/i, ''))
  const samples = sampleRoute(lineFeature, totalKm)

  return {
    id: uuidv4(),
    name,
    source: ext as 'gpx' | 'tcx',
    ride_date: rideDate,
    distance_km: Math.round(totalKm * 100) / 100,
    elevation_gain_m: Math.round(elevGain),
    bbox: routeBbox,
    sample_points: samples,
    geometry: lineFeature.geometry,
  }
}
