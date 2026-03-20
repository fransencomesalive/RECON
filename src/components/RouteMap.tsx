'use client'

import { useEffect, useRef } from 'react'
import type { CoverageConfidence, ReconResult, SurfaceType, WeatherRisk, WeatherSegment } from '@/lib/types'

// Mapbox is a large library — loaded dynamically to avoid SSR issues
// and keep the initial bundle lean.

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''

// ─── Layer visibility config ─────────────────────────────────────────────────

export type MapLayer = 'Route' | 'Surface' | 'Weather' | 'Public Lands' | 'Mobile Coverage' | 'POIs'

// ─── Color helpers ────────────────────────────────────────────────────────────

const SURFACE_COLOR: Record<SurfaceType, string> = {
  paved:   '#016a7d',
  gravel:  '#d48728',
  dirt:    '#c45e1a',
  unknown: '#888888',
}

const WEATHER_COLOR: Record<WeatherRisk, string> = {
  green: '#2d8a4e',
  amber: '#fdb618',
  red:   '#ed1c24',
}

const COVERAGE_COLOR: Record<CoverageConfidence, string> = {
  good:    '#2d8a4e',
  fair:    '#fdb618',
  poor:    '#ed1c24',
  none:    '#555555',
  unknown: '#444444',
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
  className?:       string
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RouteMap({ result, activeLayers, weatherSegments, className }: RouteMapProps) {
  const containerRef       = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef             = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poiMarkersRef      = useRef<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bailoutMarkersRef  = useRef<any[]>([])
  // Ref so the async map load callback can read the current activeLayers
  const activeLayersRef    = useRef<Set<string>>(activeLayers)
  useEffect(() => { activeLayersRef.current = activeLayers }, [activeLayers])

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
          const weatherFeatures = weatherSegs.map((seg, i, arr) => {
            const fromFrac = i === 0 ? 0 : (arr[i - 1].distance_km / totalKm)
            const toFrac   = i === arr.length - 1 ? 1 : (arr[i].distance_km + (arr[i + 1]?.distance_km ?? totalKm)) / 2 / totalKm
            const fromIdx  = Math.floor(Math.min(fromFrac, 1) * (coords2d.length - 1))
            const toIdx    = Math.min(Math.ceil(Math.min(toFrac, 1) * (coords2d.length - 1)), coords2d.length - 1)
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: coords2d.slice(fromIdx, toIdx + 1) },
              properties: { risk: seg.risk, color: WEATHER_COLOR[seg.risk] },
            }
          })

          map.addSource('weather', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: weatherFeatures },
          })

          map.addLayer({
            id:     'weather-line',
            type:   'line',
            source: 'weather',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':   ['get', 'color'],
              'line-width':   6,
              'line-opacity': 0.6,
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

        // ── Mobile coverage glow ───────────────────────────────────────────
        // Rendered as two blurred layers *below* the route line so the glow
        // halos out from behind it without obscuring the route itself.
        const coverageSegs = result.coverage ?? []
        if (coverageSegs.length > 0) {
          const coverageFeatures = coverageSegs.map((seg, i, arr) => {
            const fromKm  = i === 0 ? 0 : arr[i - 1].distance_km
            const toKm    = seg.distance_km
            const fromIdx = Math.floor(Math.min(fromKm / totalKm, 1) * (coords2d.length - 1))
            const toIdx   = Math.min(Math.ceil(Math.min(toKm / totalKm, 1) * (coords2d.length - 1)), coords2d.length - 1)
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: coords2d.slice(fromIdx, toIdx + 1) },
              properties: { color: COVERAGE_COLOR[seg.confidence] ?? '#444' },
            }
          })

          map.addSource('coverage', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: coverageFeatures },
          })

          // Outer glow — wide, very soft
          map.addLayer({
            id:     'coverage-glow-outer',
            type:   'line',
            source: 'coverage',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':   ['get', 'color'],
              'line-width':   22,
              'line-opacity': 0.12,
              'line-blur':    10,
            },
          }, 'route-line') // insert below route line

          // Inner glow — tighter, slightly brighter
          map.addLayer({
            id:     'coverage-glow-inner',
            type:   'line',
            source: 'coverage',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color':   ['get', 'color'],
              'line-width':   12,
              'line-opacity': 0.22,
              'line-blur':    5,
            },
          }, 'route-line') // insert below route line
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

        // ── Sync initial layer visibility to activeLayers state ────────────
        // Layers are visible by default when added — apply the current toggle
        // state so the map matches the UI buttons on first load.
        const initLayers = activeLayersRef.current
        const initLayerMap: Record<string, string[]> = {
          'Route':        ['route-line'],
          'Surface':      ['surface-line'],
          'Weather':      ['weather-line'],
          'Public Lands': ['lands-line'],
          'Mobile Coverage': ['coverage-glow-outer', 'coverage-glow-inner'],
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
      })

      mapRef.current = map
    })

    return () => {
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
      'Route':        ['route-line'],
      'Surface':      ['surface-line'],
      'Weather':      ['weather-line'],
      'Public Lands': ['lands-line'],
      'Mobile Coverage': ['coverage-glow-outer', 'coverage-glow-inner'],
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
  }, [activeLayers])

  // ── Live weather update ──────────────────────────────────────────────────
  // When the parent re-derives weather segments (speed/start-time change),
  // push new GeoJSON into the existing Mapbox source without reinitializing.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded?.() || !weatherSegments) return
    const source = map.getSource('weather')
    if (!source) return

    const coords    = (result.route.geometry.coordinates as [number, number, number?][]).map(c => [c[0], c[1]] as [number, number])
    const totalKm   = result.route.distance_km

    const features = weatherSegments.map((seg, i, arr) => {
      const fromFrac = i === 0 ? 0 : arr[i - 1].distance_km / totalKm
      const toFrac   = i === arr.length - 1 ? 1 : (arr[i].distance_km + (arr[i + 1]?.distance_km ?? totalKm)) / 2 / totalKm
      const fromIdx  = Math.floor(Math.min(fromFrac, 1) * (coords.length - 1))
      const toIdx    = Math.min(Math.ceil(Math.min(toFrac, 1) * (coords.length - 1)), coords.length - 1)
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords.slice(fromIdx, toIdx + 1) },
        properties: { risk: seg.risk, color: WEATHER_COLOR[seg.risk] },
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(source as any).setData({ type: 'FeatureCollection', features })
  }, [weatherSegments, result])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
}
