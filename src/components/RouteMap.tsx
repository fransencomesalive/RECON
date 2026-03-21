'use client'

import { useEffect, useRef } from 'react'
import type { CoverageConfidence, ReconResult, SurfaceType, WeatherSegment } from '@/lib/types'
import { WindParticleSystem } from '@/lib/windParticles'

// Mapbox is a large library — loaded dynamically to avoid SSR issues
// and keep the initial bundle lean.

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''

// ─── Layer visibility config ─────────────────────────────────────────────────

export type MapLayer = 'Route' | 'Surface' | 'Weather' | 'Public Lands' | 'Mobile Coverage' | 'POIs' | 'Imagery'

// ─── Color helpers ────────────────────────────────────────────────────────────

const SURFACE_COLOR: Record<SurfaceType, string> = {
  paved:   '#016a7d',
  gravel:  '#d48728',
  dirt:    '#c45e1a',
  unknown: '#888888',
}

// Mirror the profile's interpolateWeather for temp_c
function interpolateTemp(segs: WeatherSegment[], distKm: number): number {
  if (!segs.length) return 15
  if (segs.length === 1) return segs[0].temp_c
  if (distKm <= segs[0].distance_km) return segs[0].temp_c
  if (distKm >= segs[segs.length - 1].distance_km) return segs[segs.length - 1].temp_c
  for (let i = 0; i < segs.length - 1; i++) {
    if (distKm >= segs[i].distance_km && distKm <= segs[i + 1].distance_km) {
      const t = (distKm - segs[i].distance_km) / (segs[i + 1].distance_km - segs[i].distance_km)
      return segs[i].temp_c + t * (segs[i + 1].temp_c - segs[i].temp_c)
    }
  }
  return segs[segs.length - 1].temp_c
}

// Build a Mapbox line-gradient expression with 20 stops — same resolution as the
// profile's SVG linearGradient, producing a true smooth gradient along the line.
// Requires the source to have lineMetrics: true.
function buildWeatherGradientExpr(segs: WeatherSegment[], totalKm: number): unknown[] {
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  for (let i = 0; i < 20; i++) {
    const frac = i / 19
    expr.push(frac, tempToColor(interpolateTemp(segs, frac * totalKm)))
  }
  return expr
}

function tempToColor(tempC: number): string {
  const f = tempC * 9 / 5 + 32
  if (f <  25) return '#000000'
  if (f <  35) return '#1a237e'
  if (f <  45) return '#29b6f6'
  if (f <  55) return '#26a69a'
  if (f <  65) return '#1a7a35'
  if (f <  75) return '#fdd835'
  if (f <  85) return '#f77f00'
  if (f <  95) return '#ed1c24'
  return '#e040fb'
}

const COVERAGE_COLOR: Record<CoverageConfidence, string> = {
  good:    '#4caf50',
  fair:    '#fdb618',
  poor:    '#ed1c24',
  none:    '#888888',
  unknown: 'transparent',
}

function poiEmoji(poi: { type: string; potable?: boolean; note?: string }): string {
  switch (poi.type) {
    case 'water':     return poi.potable === false ? '🐟' : '🚰'
    case 'shop':      return poi.note === 'Self-serve repair station' ? '🔧' : '🛠️'
    case 'emergency':
      if (poi.note === 'Fire station')                        return '🚒'
      if (poi.note === 'Hospital' || poi.note === 'Medical clinic') return '🏥'
      if (poi.note === "Doctor's office")                     return '🩺'
      if (poi.note === 'Emergency phone')                     return '📞'
      return '🆘'
    case 'shelter':   return '🛖'
    default:          return '📍'
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface RouteMapProps {
  result:           ReconResult
  activeLayers:     Set<string>
  weatherSegments?: WeatherSegment[]  // client-computed time-aware override
  startHour?:       number            // hour-of-day for wind particle field
  hoverFrac?:       number | null
  onHoverFrac?:     (frac: number | null) => void
  className?:       string
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RouteMap({ result, activeLayers, weatherSegments, startHour, hoverFrac, onHoverFrac, className }: RouteMapProps) {
  const containerRef       = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef             = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poiMarkersRef      = useRef<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bailoutMarkersRef  = useRef<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imageryMarkersRef  = useRef<any[]>([])
  // Ref so the async map load callback can read the current activeLayers
  const activeLayersRef      = useRef<Set<string>>(activeLayers)
  useEffect(() => { activeLayersRef.current = activeLayers }, [activeLayers])

  // Ref so the async map load callback can read the current weatherSegments
  const weatherSegmentsRef   = useRef<WeatherSegment[] | undefined>(weatherSegments)
  useEffect(() => { weatherSegmentsRef.current = weatherSegments }, [weatherSegments])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrubberMarkerRef  = useRef<any>(null)
  const onHoverFracRef     = useRef(onHoverFrac)
  useEffect(() => { onHoverFracRef.current = onHoverFrac }, [onHoverFrac])

  const windCanvasRef    = useRef<HTMLCanvasElement | null>(null)
  const windParticlesRef = useRef<WindParticleSystem | null>(null)
  const windRafRef       = useRef<number>(0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windTickRef      = useRef<((...args: any[]) => void) | null>(null)

  const startHourRef     = useRef<number>(startHour ?? 9)
  useEffect(() => {
    startHourRef.current = startHour ?? 9
    windParticlesRef.current?.setHour(startHour ?? 9)
  }, [startHour])

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    import('mapbox-gl').then(({ default: mapboxgl }) => {
      mapboxgl.accessToken = MAPBOX_TOKEN

      // Cast coordinates to Position[] (mapbox-gl expects [lng, lat] or [lng, lat, ele])
      const coords = result.route.geometry.coordinates as [number, number, number?][]
      // Strip optional elevation to avoid GeoJSON type issues
      const coords2d: [number, number][] = coords.map(c => [c[0], c[1]])
      const lngs = coords.map(c => c[0])
      const lats = coords.map(c => c[1])
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ]

      const map = new mapboxgl.Map({
        container: containerRef.current!,
        style:     'mapbox://styles/mapbox/outdoors-v12',
        bounds,
        fitBoundsOptions: { padding: 48 },
        attributionControl: false,
      })

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right')

      map.on('load', () => {
        // ── Route line (base) ──────────────────────────────────────────────
        map.addSource('route', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: result.route.geometry,
            properties: {},
          },
        })

        map.addLayer({
          id:     'route-line',
          type:   'line',
          source: 'route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color':   '#fdb618',
            'line-width':   3,
            'line-opacity': 0.9,
          },
        })

        // ── Surface segments ───────────────────────────────────────────────
        // Build per-segment GeoJSON from surface stats + route coordinates
        const surfaces = result.surfaces
        const totalKm  = result.route.distance_km

        if (surfaces.length > 0 && coords2d.length > 1) {
          let cursor = 0
          const surfaceFeatures = surfaces.map(s => {
            const fromFrac = cursor / totalKm
            cursor += s.km
            const toFrac = Math.min(cursor / totalKm, 1)

            const fromIdx = Math.floor(fromFrac * (coords2d.length - 1))
            const toIdx   = Math.min(Math.ceil(toFrac  * (coords2d.length - 1)), coords2d.length - 1)
            const segCoords = coords2d.slice(fromIdx, toIdx + 1)

            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: segCoords },
              properties: { surface: s.type, color: SURFACE_COLOR[s.type] ?? '#888' },
            }
          })

          map.addSource('surfaces', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: surfaceFeatures },
          })

          map.addLayer({
            id:     'surface-line',
            type:   'line',
            source: 'surfaces',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': ['get', 'color'],
              'line-width': 4,
            },
          })
        }

        // ── Weather segments ───────────────────────────────────────────────
        const weatherSegs = result.weather.segments
        if (weatherSegs.length > 0) {
          map.addSource('weather', {
            type:        'geojson',
            lineMetrics: true,
            data: {
              type:     'Feature',
              geometry: { type: 'LineString', coordinates: coords2d },
              properties: {},
            },
          })

          // Use the time-aware segments if available (ref holds current prop value);
          // fall back to raw NWS segments if the parent hasn't derived them yet.
          const initWeatherSegs = weatherSegmentsRef.current?.length ? weatherSegmentsRef.current : weatherSegs
          map.addLayer({
            id:     'weather-line',
            type:   'line',
            source: 'weather',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':    '#888888',
              'line-width':    6,
              'line-opacity':  0.6,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              'line-gradient': buildWeatherGradientExpr(initWeatherSegs, totalKm) as any,
            },
          })
        }

        // ── POI markers (HTML — emoji render reliably, toggle via ref) ────
        const poiMarkers: any[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const poi of result.pois) {
          const el = document.createElement('div')
          el.textContent = poiEmoji(poi)
          el.style.cssText = 'font-size:24px;line-height:1;cursor:pointer;user-select:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55));'

          const noteHtml  = poi.note ? `<br><span style="opacity:0.75">${poi.note}</span>` : ''
          const filterHtml = poi.potable === false ? '<br><span style="color:#ed1c24">⚠ Filter required</span>' : ''

          new mapboxgl.Marker({ element: el })
            .setLngLat([poi.lng, poi.lat])
            .setPopup(new mapboxgl.Popup({ offset: 16, closeButton: false }).setHTML(
              `<div style="font-family:monospace;font-size:11px;color:#fdb618;background:#011c24;padding:6px 10px;border-radius:3px;line-height:1.8">` +
              `<strong style="font-size:12px">${poiEmoji(poi)} ${poi.name}</strong>` +
              noteHtml + filterHtml +
              `</div>`
            ))
            .addTo(map)

          poiMarkers.push(el)
        }
        poiMarkersRef.current = poiMarkers

        // ── Land crossings (boundary lines) ───────────────────────────────
        if (result.lands.length > 0) {
          const landFeatures = result.lands.map(land => {
            const fromFrac = Math.min(land.entry_km / totalKm, 1)
            const toFrac   = Math.min(land.exit_km  / totalKm, 1)
            const fromIdx  = Math.floor(fromFrac * (coords2d.length - 1))
            const toIdx    = Math.min(Math.ceil(toFrac * (coords2d.length - 1)), coords2d.length - 1)
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: coords2d.slice(fromIdx, toIdx + 1) },
              properties: { name: land.name, agency: land.agency },
            }
          })

          map.addSource('lands', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: landFeatures },
          })

          map.addLayer({
            id:     'lands-line',
            type:   'line',
            source: 'lands',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':     '#2d8a4e',
              'line-width':     4,
              'line-opacity':   0.65,
              'line-dasharray': [4, 3],
            },
          })
        }

        // ── Bailout routes ─────────────────────────────────────────────────
        const bailouts = (result.bailouts ?? []).filter(b => b.road_geometry.length >= 2)
        console.log('[RECON] bailouts:', bailouts.map(b => ({
          destination: b.destination_name,
          saves_km: b.saves_km,
          geometry_points: b.road_geometry.length,
          intersection: [b.intersection_lng, b.intersection_lat],
        })))
        if (bailouts.length > 0) {
          const bailoutFeatures = bailouts.map(b => {
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: b.road_geometry },
              properties: { destination: b.destination_name, saves_km: b.saves_km },
            }
          })

          map.addSource('bailouts', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: bailoutFeatures },
          })

          map.addLayer({
            id:     'bailout-line',
            type:   'line',
            source: 'bailouts',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':     '#fdb618',
              'line-width':     5,
              'line-opacity':   0.95,
              'line-dasharray': [4, 3],
            },
          })

          // ☠️ marker at each intersection point
          const bailoutEls: HTMLElement[] = []
          for (const b of bailouts) {
            const el = document.createElement('div')
            el.textContent = '☠️'
            el.style.cssText = 'font-size:24px;cursor:pointer;user-select:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55));'
            const bailoutMi = (b.bailout_km * 0.621371).toFixed(1)
            const savesMi   = (b.saves_km   * 0.621371).toFixed(1)
            const nextSafe  = b.next_safe_name ?? 'end of route'
            const destIcon  = b.destination_type === 'fire_station' ? '🚒'
                            : b.destination_type === 'medical'      ? '🏥'
                            : '🏘️'
            new mapboxgl.Marker({ element: el })
              .setLngLat([b.intersection_lng, b.intersection_lat])
              .setPopup(new mapboxgl.Popup({ offset: 14 }).setHTML(
                `<div style="font-family:monospace;font-size:11px;color:#fdb618;background:#011c24;padding:6px 10px;border-radius:3px;line-height:1.8">` +
                `<strong style="font-size:12px">${destIcon} Bail out to ${b.destination_name}: ${bailoutMi} mi</strong><br>` +
                `Saves ${savesMi} mi vs continuing to ${nextSafe}` +
                `</div>`
              ))
              .addTo(map)
            bailoutEls.push(el)
          }
          bailoutMarkersRef.current = bailoutEls
        }

        // ── Mobile coverage halo ───────────────────────────────────────────
        // Wide, blurred line under the route showing coverage quality per segment.
        const coverageSegs = result.coverage ?? []
        const visibleCovSegs = coverageSegs.filter(s => s.confidence !== 'unknown')
        if (visibleCovSegs.length > 0) {
          const coverageFeatures = visibleCovSegs.map((seg, i) => {
            const fromFrac = seg.distance_km / totalKm
            const toFrac   = i < visibleCovSegs.length - 1
              ? visibleCovSegs[i + 1].distance_km / totalKm
              : 1
            const fromIdx  = Math.round(Math.min(fromFrac, 1) * (coords2d.length - 1))
            const toIdx    = Math.min(Math.round(Math.min(toFrac, 1) * (coords2d.length - 1)), coords2d.length - 1)
            const segCoords = coords2d.slice(fromIdx, Math.max(toIdx + 1, fromIdx + 2))
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: segCoords },
              properties: { color: COVERAGE_COLOR[seg.confidence] },
            }
          })

          map.addSource('coverage', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: coverageFeatures },
          })

          map.addLayer({
            id:     'coverage-halo',
            type:   'line',
            source: 'coverage',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':   ['get', 'color'],
              'line-width':   18,
              'line-opacity': 0.75,
              'line-blur':    3,
            },
          }, 'route-line')
        }

        // ── Start / End markers ────────────────────────────────────────────
        const startCoord = coords2d[0]
        const endCoord   = coords2d[coords2d.length - 1]

        new mapboxgl.Marker({ color: '#fdb618' })
          .setLngLat([startCoord[0], startCoord[1]])
          .setPopup(new mapboxgl.Popup().setHTML('<div style="font-family:monospace;font-size:12px">Start</div>'))
          .addTo(map)

        new mapboxgl.Marker({ color: '#ed1c24' })
          .setLngLat([endCoord[0], endCoord[1]])
          .setPopup(new mapboxgl.Popup().setHTML('<div style="font-family:monospace;font-size:12px">Finish</div>'))
          .addTo(map)

        // ── Imagery pins ───────────────────────────────────────────────────
        const imageryMarkerEls: HTMLElement[] = []
        for (const img of result.imagery ?? []) {
          const el = document.createElement('div')
          el.textContent = '📍'
          el.style.cssText = 'font-size:24px;line-height:1;cursor:pointer;user-select:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55));'

          new mapboxgl.Marker({ element: el })
            .setLngLat([img.lng, img.lat])
            .setPopup(new mapboxgl.Popup({ offset: 20, closeButton: false, maxWidth: '420px' }).setHTML(
              `<div style="font-family:monospace;font-size:11px;color:#fdb618;background:#011c24;padding:6px;border-radius:3px;line-height:1.6">` +
              `<img src="${img.thumb_url}" style="width:400px;height:auto;display:block;border-radius:2px;margin-bottom:4px" />` +
              `📷 ${img.distance_km.toFixed(1)} km` +
              `</div>`
            ))
            .addTo(map)

          imageryMarkerEls.push(el)
        }
        imageryMarkersRef.current = imageryMarkerEls

        // ── Elevation scrubber marker ──────────────────────────────────────
        const scrubEl = document.createElement('div')
        scrubEl.textContent = '🥑'
        scrubEl.style.cssText = 'font-size:22px;line-height:1;pointer-events:none;display:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.7));transform:translate(-50%,-50%);'
        const scrubMarker = new mapboxgl.Marker({ element: scrubEl })
          .setLngLat(coords2d[0])
          .addTo(map)
        scrubberMarkerRef.current = scrubMarker

        // ── Route hover → send fraction to elevation profile ──────────────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.on('mousemove', 'route-line', (e: any) => {
          const { lng, lat } = e.lngLat
          let minDist = Infinity, nearestIdx = 0
          for (let i = 0; i < coords2d.length; i++) {
            const dx = coords2d[i][0] - lng
            const dy = coords2d[i][1] - lat
            const d = dx * dx + dy * dy
            if (d < minDist) { minDist = d; nearestIdx = i }
          }
          onHoverFracRef.current?.(nearestIdx / (coords2d.length - 1))
          map.getCanvas().style.cursor = 'crosshair'
        })
        map.on('mouseleave', 'route-line', () => {
          onHoverFracRef.current?.(null)
          map.getCanvas().style.cursor = ''
        })

        // ── Sync initial layer visibility to activeLayers state ────────────
        // Layers are visible by default when added — apply the current toggle
        // state so the map matches the UI buttons on first load.
        const initLayers = activeLayersRef.current
        const initLayerMap: Record<string, string[]> = {
          'Route':           ['route-line'],
          'Surface':         ['surface-line'],
          'Weather':         ['weather-line'],
          'Public Lands':    ['lands-line'],
          'Mobile Coverage': ['coverage-halo'],
          'Bailouts':        ['bailout-line'],
        }
        for (const [layer, ids] of Object.entries(initLayerMap)) {
          const vis = initLayers.has(layer) ? 'visible' : 'none'
          for (const id of ids) {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
          }
        }
        const poiVis = initLayers.has('POIs') ? 'block' : 'none'
        for (const el of poiMarkersRef.current) el.style.display = poiVis
        const bailoutVis = initLayers.has('Bailouts') ? 'block' : 'none'
        for (const el of bailoutMarkersRef.current) el.style.display = bailoutVis
        const imageryVis = initLayers.has('Imagery') ? 'block' : 'none'
        for (const el of imageryMarkersRef.current) el.style.display = imageryVis

        // ── Wind particle canvas ───────────────────────────────────────────
        if (result.wind_field && containerRef.current) {
          const windCanvas = document.createElement('canvas')
          windCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
          containerRef.current.appendChild(windCanvas)
          windCanvasRef.current = windCanvas

          const sys = new WindParticleSystem(result.wind_field)
          sys.setHour(startHourRef.current)
          windParticlesRef.current = sys

          // Define the reusable tick and store it so the activeLayers effect can start/stop it
          const tick = () => {
            const canvas = windCanvasRef.current
            if (!canvas) return
            const { width, height } = canvas.getBoundingClientRect()
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width; canvas.height = height
            }
            const ctx = canvas.getContext('2d')
            if (ctx) { sys.tick(map); sys.draw(ctx, map) }
            windRafRef.current = requestAnimationFrame(tick)
          }
          windTickRef.current = tick

          if (initLayers.has('Weather')) {
            windRafRef.current = requestAnimationFrame(tick)
          }
        }
      })

      mapRef.current = map
    })

    return () => {
      cancelAnimationFrame(windRafRef.current)
      windParticlesRef.current?.destroy()
      windParticlesRef.current = null
      windCanvasRef.current?.remove()
      windCanvasRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  // ── Layer visibility toggle ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded?.()) return

    const layerMap: Record<string, string[]> = {
      'Route':           ['route-line'],
      'Surface':         ['surface-line'],
      'Weather':         ['weather-line'],
      'Public Lands':    ['lands-line'],
      'Mobile Coverage': ['coverage-halo'],
      'Bailouts':        ['bailout-line'],
    }

    for (const [layer, ids] of Object.entries(layerMap)) {
      const vis = activeLayers.has(layer) ? 'visible' : 'none'
      for (const id of ids) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', vis)
        }
      }
    }

    // POI markers are HTML elements — toggle display directly
    const poiDisplay = activeLayers.has('POIs') ? 'block' : 'none'
    for (const el of poiMarkersRef.current) {
      el.style.display = poiDisplay
    }

    // Bailout HTML markers — same pattern
    const bailoutDisplay = activeLayers.has('Bailouts') ? 'block' : 'none'
    for (const el of bailoutMarkersRef.current) {
      el.style.display = bailoutDisplay
    }

    // Imagery pins — same pattern
    const imageryDisplay = activeLayers.has('Imagery') ? 'block' : 'none'
    for (const el of imageryMarkersRef.current) {
      el.style.display = imageryDisplay
    }

    // Wind particles — start/stop with Weather toggle
    cancelAnimationFrame(windRafRef.current)
    const windCanvas = windCanvasRef.current
    if (activeLayers.has('Weather') && windTickRef.current) {
      windRafRef.current = requestAnimationFrame(windTickRef.current)
    } else if (windCanvas) {
      windCanvas.getContext('2d')?.clearRect(0, 0, windCanvas.width, windCanvas.height)
    }
  }, [activeLayers])

  // ── Scrubber marker position ─────────────────────────────────────────────
  useEffect(() => {
    const marker = scrubberMarkerRef.current
    if (!marker) return
    const el = marker.getElement() as HTMLElement
    if (hoverFrac == null) { el.style.display = 'none'; return }
    const coords = (result.route.geometry.coordinates as [number, number, number?][]).map(c => [c[0], c[1]] as [number, number])
    const idx = Math.round(Math.max(0, Math.min(hoverFrac, 1)) * (coords.length - 1))
    marker.setLngLat(coords[idx])
    el.style.display = 'block'
  }, [hoverFrac, result])

  // ── Live weather update ──────────────────────────────────────────────────
  // When the parent re-derives weather segments (speed/start-time change),
  // push new GeoJSON into the existing Mapbox source without reinitializing.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded?.() || !weatherSegments) return
    if (!map.getLayer('weather-line')) return

    const totalKm = result.route.distance_km
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.setPaintProperty('weather-line', 'line-gradient', buildWeatherGradientExpr(weatherSegments, totalKm) as any)
  }, [weatherSegments, result])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', position: 'relative' }} />
}
