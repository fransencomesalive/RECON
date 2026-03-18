'use client'

import { useEffect, useRef } from 'react'
import type { ReconResult, SurfaceType, WeatherRisk } from '@/lib/types'

// Mapbox is a large library — loaded dynamically to avoid SSR issues
// and keep the initial bundle lean.

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''

// ─── Layer visibility config ─────────────────────────────────────────────────

export type MapLayer = 'Route' | 'Surface' | 'Weather' | 'Public Lands' | 'Coverage' | 'POIs'

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

const POI_COLOR: Record<string, string> = {
  water:     '#00aac9',
  shop:      '#fdb618',
  bailout:   '#ed1c24',
  emergency: '#fcba4b',
  shelter:   '#aaaaaa',
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface RouteMapProps {
  result:       ReconResult
  activeLayers: Set<string>
  className?:   string
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RouteMap({ result, activeLayers, className }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef       = useRef<any>(null)

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

        // ── POI markers ───────────────────────────────────────────────────
        if (result.pois.length > 0) {
          const poiFeatures = result.pois.map(poi => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [poi.lng, poi.lat] },
            properties: {
              name:  poi.name,
              type:  poi.type,
              color: POI_COLOR[poi.type] ?? '#aaa',
            },
          }))

          map.addSource('pois', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: poiFeatures },
          })

          map.addLayer({
            id:     'poi-circles',
            type:   'circle',
            source: 'pois',
            paint: {
              'circle-radius':       6,
              'circle-color':        ['get', 'color'],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#011c24',
            },
          })

          // Tooltip on hover
          const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })

          map.on('mouseenter', 'poi-circles', e => {
            map.getCanvas().style.cursor = 'pointer'
            const feature = e.features?.[0]
            if (!feature) return
            const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number]
            const { name, type } = feature.properties as { name: string; type: string }
            popup.setLngLat(coords).setHTML(
              `<div style="font-family:monospace;font-size:12px;color:#fdb618;background:#011c24;padding:4px 8px;border-radius:3px">${type}: ${name}</div>`
            ).addTo(map)
          })

          map.on('mouseleave', 'poi-circles', () => {
            map.getCanvas().style.cursor = ''
            popup.remove()
          })
        }

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
      'Coverage':     [],
      'POIs':         ['poi-circles'],
    }

    for (const [layer, ids] of Object.entries(layerMap)) {
      const vis = activeLayers.has(layer) ? 'visible' : 'none'
      for (const id of ids) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', vis)
        }
      }
    }
  }, [activeLayers])

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />
}
