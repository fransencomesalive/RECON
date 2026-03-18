// ─── Route ────────────────────────────────────────────────────────────────────

export type RouteSource = 'gpx' | 'tcx' | 'strava' | 'mapmyride'

export interface RoutePoint {
  lat: number
  lng: number
  elevation_m: number
  distance_km: number // cumulative from start
}

export interface CanonicalRoute {
  id: string
  name: string
  source: RouteSource
  ride_date: string
  distance_km: number
  elevation_gain_m: number
  bbox: [number, number, number, number] // [minLng, minLat, maxLng, maxLat]
  sample_points: RoutePoint[] // ~every 5 km, used for weather/coverage API calls
  geometry: GeoJSON.LineString // full geometry [lng, lat, ele?][]
}

// ─── Surfaces ─────────────────────────────────────────────────────────────────

export type SurfaceType = 'paved' | 'gravel' | 'dirt' | 'unknown'

export interface SurfaceStat {
  type: SurfaceType
  pct: number
  km: number
}

// ─── POIs ─────────────────────────────────────────────────────────────────────

export type POIType = 'water' | 'shop' | 'bailout' | 'emergency' | 'shelter'

export interface POI {
  id: string
  type: POIType
  name: string
  lat: number
  lng: number
  distance_km: number // nearest point on route from start
  potable?: boolean   // water only
  note?: string
  tags?: Record<string, string> // raw OSM tags
}

export interface SupplyGap {
  from_km: number
  to_km: number
  description: string
}

// ─── Weather ──────────────────────────────────────────────────────────────────

export type WeatherRisk = 'green' | 'amber' | 'red'

export interface WeatherSegment {
  lat: number
  lng: number
  distance_km: number
  temp_c: number
  wind_speed_kph: number
  wind_dir: string
  precipitation_chance: number
  description: string
  risk: WeatherRisk
}

export interface WeatherAlert {
  severity: 'minor' | 'moderate' | 'severe' | 'extreme'
  title: string
  description: string
  areas: string
  onset?: string
  expires?: string
  source: 'nws'
}

export interface WeatherResult {
  segments: WeatherSegment[]
  alerts: WeatherAlert[]
  provider: 'nws' | 'open-meteo'
}

// ─── Public Lands ─────────────────────────────────────────────────────────────

export interface LandCrossing {
  name: string
  agency: string
  type: string
  entry_km: number
  exit_km: number
}

// ─── Cell Coverage ────────────────────────────────────────────────────────────

export type CoverageConfidence = 'good' | 'fair' | 'poor' | 'none' | 'unknown'

export interface CoverageSegment {
  distance_km: number
  confidence: CoverageConfidence
}

// ─── Imagery ──────────────────────────────────────────────────────────────────

export interface RouteImage {
  id: string
  lat: number
  lng: number
  distance_km: number
  thumb_url: string
  full_url: string
  captured_at?: string
  source: 'mapillary'
}

// ─── Full Result ──────────────────────────────────────────────────────────────

export interface ReconResult {
  id: string
  created_at: string
  route: CanonicalRoute
  surfaces: SurfaceStat[]
  pois: POI[]
  supply_gaps: SupplyGap[]
  weather: WeatherResult
  lands: LandCrossing[]
  coverage: CoverageSegment[]
  imagery: RouteImage[]
  narrative: string
  errors: Record<string, string> // data source name → error message
}

// ─── API ──────────────────────────────────────────────────────────────────────

export interface AnalyzeRequest {
  file_data?: string  // base64-encoded GPX or TCX
  file_name?: string
  url?: string
  ride_date: string
}

export interface AnalyzeResponse {
  id: string
  error?: string
}
