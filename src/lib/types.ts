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

// Ordered surface segments along the route — used to color the elevation profile
// in the correct positions. Derived from computeSurfaceStats.
export interface SurfaceSegment {
  from_km: number
  to_km: number
  type: SurfaceType
}

// ─── POIs ─────────────────────────────────────────────────────────────────────

export type POIType = 'water' | 'shop' | 'emergency' | 'shelter'

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

// ─── Bailout Routes ───────────────────────────────────────────────────────────
// A road that crosses the route and leads to safety in less distance than
// continuing on the original route.

export type BailoutDestinationType = 'town' | 'fire_station' | 'medical'

export interface BailoutRoute {
  id: string
  intersection_lat: number
  intersection_lng: number
  distance_km: number          // position on original route
  road_name?: string           // OSM name of the bailout road
  destination_name: string     // nearest town/settlement or facility name
  destination_type: BailoutDestinationType
  destination_lat: number
  destination_lng: number
  bailout_km: number           // distance from intersection to safety via this road
  route_remaining_km: number   // distance on original route to next safe point
  next_safe_name?: string      // name of next safe point on original route
  saves_km: number             // route_remaining_km − bailout_km (always positive)
  road_geometry: [number, number][]  // [lng, lat][] from intersection toward destination
}

// ─── Weather ──────────────────────────────────────────────────────────────────

export type WeatherRisk = 'green' | 'amber' | 'red'

export interface HourlyPeriod {
  start_time: string         // ISO-8601 local time
  temp_c: number
  wind_speed_kph: number
  wind_dir: string
  precipitation_chance: number
  description: string
  risk: WeatherRisk
}

export interface WeatherSegment {
  lat: number
  lng: number
  distance_km: number
  cumulative_gain_m: number  // elevation gain from start — used for Naismith arrival time
  temp_c: number
  wind_speed_kph: number
  wind_dir: string
  precipitation_chance: number
  description: string
  risk: WeatherRisk
  hourly_forecast?: HourlyPeriod[]  // hourly periods for the ride day; enables client-side re-picking
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
  reference_speed_kph: number  // speed used at analysis time for initial period selection
  ride_start_hour: number      // hour-of-day (0–23) used at analysis time
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
  surface_segments: SurfaceSegment[]
  pois: POI[]
  supply_gaps: SupplyGap[]
  bailouts: BailoutRoute[]
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

// ─── Client-orchestrated enrichment API ───────────────────────────────────────

export interface EnrichRequest {
  id: string
}

export interface OsmEnrichResult {
  surfaces: SurfaceStat[]
  surface_segments: SurfaceSegment[]
  pois: POI[]
  supply_gaps: SupplyGap[]
  bailouts: BailoutRoute[]
}

export interface NarrativeRequest {
  id: string
  surfaces: SurfaceStat[]
  pois: POI[]
  supply_gaps: SupplyGap[]
  weather: WeatherResult
  lands: LandCrossing[]
}

export interface FinalizeRequest {
  id: string
  osm: OsmEnrichResult
  weather: WeatherResult
  lands: LandCrossing[]
  coverage: CoverageSegment[]
  imagery: RouteImage[]
  narrative: string
  errors: Record<string, string>
}
