'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import styles from '../results.module.css'
import type { BailoutRoute, ReconResult, SurfaceType, WeatherRisk, WeatherSegment } from '@/lib/types'

const RouteMap = dynamic(() => import('@/components/RouteMap'), { ssr: false })

// ─── Mesh gradient ────────────────────────────────────────────────────────────

type MeshDef  = { hex: string; rMin: number; rMax: number; a0: string }
type MeshNode = { x: number; y: number; vx: number; vy: number; hex: string; a0: string; r: number }

const MESH_DEFS: MeshDef[] = [
  { hex: '#00aac9', rMin: 0.55, rMax: 0.75, a0: 'dd' },
  { hex: '#016a7d', rMin: 0.20, rMax: 0.30, a0: '66' },
  { hex: '#00899e', rMin: 0.38, rMax: 0.52, a0: '99' },
  { hex: '#c45e1a', rMin: 0.50, rMax: 0.68, a0: 'cc' },
  { hex: '#d48728', rMin: 0.52, rMax: 0.70, a0: 'cc' },
  { hex: '#7c3a10', rMin: 0.18, rMax: 0.28, a0: '55' },
  { hex: '#fcba4b', rMin: 0.48, rMax: 0.65, a0: 'cc' },
  { hex: '#013d4a', rMin: 0.15, rMax: 0.25, a0: '44' },
]

function initMeshNodes(): MeshNode[] {
  return MESH_DEFS.map(def => ({
    x: Math.random(), y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00025, vy: (Math.random() - 0.5) * 0.00025,
    hex: def.hex, a0: def.a0,
    r: def.rMin + Math.random() * (def.rMax - def.rMin),
  }))
}

function drawMesh(ctx: CanvasRenderingContext2D, nodes: MeshNode[], W: number, H: number) {
  ctx.fillStyle = '#011c24'
  ctx.fillRect(0, 0, W, H)
  nodes.forEach(n => {
    const cx = n.x * W, cy = n.y * H, r = n.r * Math.max(W, H)
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    grd.addColorStop(0, n.hex + n.a0)
    grd.addColorStop(0.55, n.hex + '55')
    grd.addColorStop(1, n.hex + '00')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, W, H)
  })
}

// ─── Elevation SVG helpers ────────────────────────────────────────────────────

const SVG_W     = 800
const SVG_H     = 220
const WEATHER_H = 20
const CHART_L   = 10, CHART_R = 790
// 4 POI lanes × 14px each, plus 6px gap below last lane before chart starts
const CHART_T   = WEATHER_H + 4 * 14 + 6   // = 82
const CHART_B   = 210

// Vertical lane per POI type: 0 = top (emergency), 3 = bottom (water)
const POI_LANE: Record<string, number> = {
  emergency: 0,
  shop:      1,
  shelter:   2,
  water:     3,
}
const poiLaneY = (type: string) => WEATHER_H + 12 + (POI_LANE[type] ?? 1) * 14

type ElevPoint = { dist: number; elev: number; surface: SurfaceType }
type SurfaceGroup = { surface: SurfaceType; pts: ElevPoint[] }

function buildElevData(result: ReconResult): ElevPoint[] {
  const coords = result.route.geometry.coordinates
  if (!coords.length) return []

  const totalKm = result.route.distance_km

  const getSurface = (distKm: number): SurfaceType => {
    // Use ordered surface segments when available (accurate positions along route)
    if (result.surface_segments?.length) {
      for (const seg of result.surface_segments) {
        if (distKm >= seg.from_km && distKm <= seg.to_km) return seg.type
      }
      return 'unknown'
    }
    // Legacy fallback for results stored before surface_segments was added
    let cursor = 0
    for (const s of result.surfaces) {
      if (distKm >= cursor && distKm <= cursor + s.km) return s.type
      cursor += s.km
    }
    return 'unknown'
  }

  return coords.map((c, i) => {
    const distKm = (i / (coords.length - 1)) * totalKm
    const dist   = distKm  // stored in km; toX divides by route.distance_km
    const elev   = (c[2] ?? 0) * 3.28084  // m → ft
    return { dist, elev, surface: getSurface(distKm) }
  })
}

function groupBySurface(pts: ElevPoint[]): SurfaceGroup[] {
  const groups: SurfaceGroup[] = []
  for (const pt of pts) {
    const last = groups[groups.length - 1]
    if (!last || last.surface !== pt.surface) {
      const overlap = last ? [last.pts[last.pts.length - 1], pt] : [pt]
      groups.push({ surface: pt.surface, pts: overlap })
    } else {
      last.pts.push(pt)
    }
  }
  return groups
}

const SURFACE_DASH: Record<SurfaceType, string | undefined> = {
  paved:   undefined,
  gravel:  '10 6',
  dirt:    '10 6',
  unknown: '10 6',
}

const WEATHER_COLOR: Record<WeatherRisk, string> = {
  green: '#2d8a4e',
  amber: '#fdb618',
  red:   '#ed1c24',
}

const POI_COLOR: Record<string, string> = {
  water:     '#00aac9',
  shop:      '#fdb618',
  emergency: '#fcba4b',
  shelter:   '#aaa',
}

function poiSymbol(poi: { type: string; potable?: boolean; note?: string }): string {
  switch (poi.type) {
    case 'water':     return poi.potable === false ? '🐟' : '🚰'
    case 'shop':      return poi.note === 'Self-serve repair station' ? '🔧' : '🛠️'
    case 'emergency':
      if (poi.note === 'Fire station')                             return '🚒'
      if (poi.note === 'Hospital' || poi.note === 'Medical clinic') return '🏥'
      if (poi.note === "Doctor's office")                          return '🩺'
      if (poi.note === 'Emergency phone')                          return '📞'
      return '🆘'
    case 'shelter':   return '🛖'
    default:          return '📍'
  }
}

function bailoutDist(b: BailoutRoute, unit: 'imperial' | 'metric'): string {
  const factor = unit === 'imperial' ? 0.621371 : 1
  const suffix = unit === 'imperial' ? 'mi' : 'km'
  return `${(b.bailout_km * factor).toFixed(1)} ${suffix}`
}
function bailoutSaves(b: BailoutRoute, unit: 'imperial' | 'metric'): string {
  const factor = unit === 'imperial' ? 0.621371 : 1
  const suffix = unit === 'imperial' ? 'mi' : 'km'
  return `${(b.saves_km * factor).toFixed(1)} ${suffix}`
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatRideDate(iso: string) {
  if (!iso) return ''
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// Naismith's rule: time = distance/speed + climb/600 m·h⁻¹
function naisimithHours(km: number, gainM: number, speedKph: number): number {
  return km / speedKph + gainM / 600
}

function formatHours(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return `${h}h ${m}m`
}

// Re-derive weather segments from stored hourly forecast data based on
// current speed and start hour. Falls back to stored values if no hourly data.
function deriveWeatherSegments(
  segments: WeatherSegment[],
  speedKph: number,
  startHour: number,
): WeatherSegment[] {
  return segments.map(seg => {
    if (!seg.hourly_forecast?.length) return seg
    const travelHours  = naisimithHours(seg.distance_km, seg.cumulative_gain_m ?? 0, speedKph)
    const arrivalHour  = startHour + travelHours
    const targetHour   = Math.floor(arrivalHour)
    const match = seg.hourly_forecast.find(p => new Date(p.start_time).getHours() >= targetHour)
                  ?? seg.hourly_forecast[seg.hourly_forecast.length - 1]
    return { ...seg, ...match }
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const params = useParams()
  const id = params.id as string

  const bgRef    = useRef<HTMLCanvasElement>(null)
  const grainRef = useRef<HTMLCanvasElement>(null)

  const [result,       setResult]       = useState<ReconResult | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [fetchError,   setFetchError]   = useState<string | null>(null)
  const [unit,         setUnit]         = useState<'imperial' | 'metric'>('imperial')
  const [activeLayers, setActiveLayers] = useState<Set<string>>(new Set(['Route', 'POIs', 'Bailouts']))
  const [copied,       setCopied]       = useState(false)
  const [editingDate,  setEditingDate]  = useState(false)
  const [rideDate,     setRideDate]     = useState('')
  const [speedKph,     setSpeedKph]     = useState(16 / 0.621371)  // 16 mph default
  const [startHour,    setStartHour]    = useState(9)

  // ── Fetch result ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`/api/results/${id}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setFetchError(data.error); return }
        setResult(data as ReconResult)
        setRideDate(data.route.ride_date ?? '')
      })
      .catch(e => setFetchError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  // ── Mesh gradient ─────────────────────────────────────────────────────────
  useEffect(() => {
    const bg = bgRef.current, grain = grainRef.current
    if (!bg || !grain) return
    const bgCtx = bg.getContext('2d')!, ctx = grain.getContext('2d')!
    let W = window.innerWidth, H = window.innerHeight
    const DPR = window.devicePixelRatio || 1
    let PW = 0, PH = 0, imgData = ctx.createImageData(1, 1), grainCount = 0
    const meshNodes = initMeshNodes()
    const resize = () => {
      W = window.innerWidth; H = window.innerHeight
      PW = Math.floor(W * DPR); PH = Math.floor(H * DPR)
      bg.width = W; bg.height = H
      grain.width = PW; grain.height = PH
      grain.style.width = `${W}px`; grain.style.height = `${H}px`
      imgData = ctx.createImageData(PW, PH)
      grainCount = Math.floor(PW * PH * 0.02)
    }
    resize()
    window.addEventListener('resize', resize)
    let raf: number, frame = 0
    const tick = () => {
      frame++
      if (frame % 2 === 0) {
        meshNodes.forEach(n => {
          n.x += n.vx; n.y += n.vy
          if (n.x < 0.05 || n.x > 0.95) n.vx *= -1
          if (n.y < 0.05 || n.y > 0.95) n.vy *= -1
        })
        drawMesh(bgCtx, meshNodes, W, H)
      }
      if (frame % 3 === 0) {
        const data = imgData.data; data.fill(0)
        for (let i = 0; i < grainCount; i++) {
          const base = ((Math.random() * PH | 0) * PW + (Math.random() * PW | 0)) * 4
          data[base] = 255; data[base + 1] = 225; data[base + 2] = 160; data[base + 3] = 90
        }
        ctx.putImageData(imgData, 0, 0)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf) }
  }, [])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const toggleLayer = useCallback((layer: string) => {
    setActiveLayers(prev => {
      const next = new Set(prev)
      next.has(layer) ? next.delete(layer) : next.add(layer)
      return next
    })
  }, [])

  // ── Time-aware weather (must be before early returns — Rules of Hooks) ───
  const displayWeather = useMemo<WeatherSegment[]>(
    () => result ? deriveWeatherSegments(result.weather.segments, speedKph, startHour) : [],
    [result, speedKph, startHour],
  )

  // ── Loading / error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <main className={styles.root}>
        <canvas ref={bgRef}    className={styles.bgCanvas} />
        <canvas ref={grainRef} className={styles.grainCanvas} />
        <div className={styles.layout} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', letterSpacing: '0.1em' }}>
            Loading dossier…
          </p>
        </div>
      </main>
    )
  }

  if (fetchError || !result) {
    return (
      <main className={styles.root}>
        <canvas ref={bgRef}    className={styles.bgCanvas} />
        <canvas ref={grainRef} className={styles.grainCanvas} />
        <div className={styles.layout} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#ed1c24', fontFamily: 'monospace' }}>
            {fetchError ?? 'Result not found.'}
          </p>
          <a href="/" style={{ color: '#fdb618', marginTop: '1rem', display: 'block', textAlign: 'center' }}>
            ← Analyze a new route
          </a>
        </div>
      </main>
    )
  }

  // ── Derived display data ──────────────────────────────────────────────────
  const route     = result.route
  const totalMi   = Math.round(route.distance_km * 0.621371 * 10) / 10
  const gainFt    = Math.round(route.elevation_gain_m * 3.28084)
  const elevData  = buildElevData(result)
  const minElev   = elevData.length ? Math.min(...elevData.map(p => p.elev)) : 0
  const maxElev   = elevData.length ? Math.max(...elevData.map(p => p.elev)) : 1000
  const totalDist = unit === 'imperial' ? totalMi : route.distance_km

  const toX = (dist: number) => CHART_L + (dist / route.distance_km) * (CHART_R - CHART_L)
  const toY = (elev: number) => CHART_B - ((elev - minElev) / (maxElev - minElev || 1)) * (CHART_B - CHART_T)

  const surfaceGroups = groupBySurface(elevData)
  const surfaceAreaPath = (seg: SurfaceGroup) => {
    const pts = seg.pts
    if (pts.length < 2) return ''
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.dist).toFixed(1)},${toY(p.elev).toFixed(1)}`).join(' ')
    const first = pts[0], last = pts[pts.length - 1]
    return `${d} L ${toX(last.dist).toFixed(1)},${CHART_B} L ${toX(first.dist).toFixed(1)},${CHART_B} Z`
  }

  const pavedPct    = result.surfaces.find(s => s.type === 'paved')?.pct ?? 0
  const nonPavedPct = 100 - pavedPct

  const rideHours   = naisimithHours(route.distance_km, route.elevation_gain_m, speedKph)
  const rideTimeStr = formatHours(rideHours)
  const speedDisplay = unit === 'imperial'
    ? `${(speedKph * 0.621371).toFixed(1)} mph`
    : `${speedKph} km/h`
  const startTimeStr = `${String(startHour).padStart(2, '0')}:00`

  // Weather zones mapped to route fraction
  const weatherZones = displayWeather.map((seg, i, arr) => ({
    from: i === 0 ? 0 : arr[i - 1].distance_km / route.distance_km,
    to:   i === arr.length - 1 ? 1 : (arr[i].distance_km + arr[i + 1].distance_km) / 2 / route.distance_km,
    status: seg.risk,
  }))

  return (
    <main className={styles.root}>
      <canvas ref={bgRef}    className={styles.bgCanvas} />
      <canvas ref={grainRef} className={styles.grainCanvas} />

      {/* ── Notch ── */}
      <div className={styles.notch}>
        <div className={styles.halWrapper}>
          <span className={styles.halLight} />
          <button className={styles.halBtn} aria-label="HAL 9000" tabIndex={-1} />
        </div>
        <div className={styles.halBubble}>
          &ldquo;No 9000 computer has ever made a mistake or distorted information.&rdquo;
        </div>
        <div className={styles.notchText}>
          <span className={styles.notchRoute}>
            <span className={styles.notchRouteLabel}>Route Title: </span>
            {route.name}
          </span>
          {editingDate ? (
            <input
              type="date"
              className={styles.notchDateInput}
              value={rideDate}
              autoFocus
              onChange={e => setRideDate(e.target.value)}
              onBlur={() => setEditingDate(false)}
              onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
            />
          ) : (
            <span className={styles.notchDate} onClick={() => setEditingDate(true)}>
              Proposed Date: {formatRideDate(rideDate)}
              <span className={styles.dateEditIcon}>✎</span>
            </span>
          )}
        </div>
      </div>

      <div className={styles.layout}>

        {/* ── Header ── */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <a href="/">
              <Image src="/RECON-logo-topo.png" alt="R.E.C.O.N." width={336} height={126} priority className={styles.logoImg} />
            </a>
          </div>
          <div className={styles.headerCenter} />
          <div className={styles.headerRight}>
            <button className={[styles.pill, styles.pillActive].join(' ')} onClick={() => setUnit(u => u === 'imperial' ? 'metric' : 'imperial')}>
              {unit === 'imperial' ? 'Miles / Feet' : 'Kilometers / Meters'}
            </button>
            <button className={styles.pill} onClick={handleCopy}>{copied ? 'Copied!' : 'Share'}</button>
            <button className={styles.pill}>Export</button>
          </div>
        </header>

        {/* ── Map ── */}
        <section className={styles.mapSection}>
          <div className={styles.mapContainer}>
            {result && (
              <RouteMap
                result={result}
                activeLayers={activeLayers}
                weatherSegments={displayWeather}
                className={styles.mapInner}
              />
            )}
          </div>
        </section>

        {/* ── Layer toggles — centered between map and elevation ── */}
        <div className={styles.layerToggles}>
          {['Route', 'Surface', 'Weather', 'Public Lands', 'Mobile Coverage', 'POIs', 'Bailouts'].map(layer => (
            <button
              key={layer}
              className={[styles.pill, activeLayers.has(layer) ? styles.pillActive : ''].join(' ')}
              onClick={() => toggleLayer(layer)}
            >
              {layer}
            </button>
          ))}
        </div>

        {/* ── Elevation profile + Stats panel ── */}
        <div className={styles.elevStatsRow}>

          {/* Elevation profile — 85% */}
          {elevData.length > 0 && (
          <div className={styles.elevPanel}>
          <div className={[styles.card, styles.elevCard].join(' ')}>
            <div className={styles.elevHeader}>
              <span className={styles.sectionTitle}>Elevation Profile</span>
            </div>

            <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className={styles.elevSvg} preserveAspectRatio="none">
              <defs>
                <pattern id="offRoadHatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(1,106,125,0.25)" strokeWidth="3" />
                </pattern>
                <pattern id="weatherHatchAmber" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(253,182,24,0.3)" strokeWidth="3" />
                </pattern>
                <pattern id="weatherHatchRed" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(237,28,36,0.3)" strokeWidth="3" />
                </pattern>
              </defs>

              {/* Weather zones */}
              {activeLayers.has('Weather') && weatherZones.map((z, i) => {
                const x1 = CHART_L + z.from * (CHART_R - CHART_L)
                const x2 = CHART_L + z.to   * (CHART_R - CHART_L)
                const color = WEATHER_COLOR[z.status]
                const hatchFill = z.status === 'red' ? 'url(#weatherHatchRed)' : z.status === 'amber' ? 'url(#weatherHatchAmber)' : null
                return (
                  <g key={i}>
                    {/* Solid color band at top for all risk levels */}
                    <rect x={x1} y={0} width={x2 - x1} height={WEATHER_H} fill={color} opacity={z.status === 'green' ? 0.35 : 0.7} />
                    {/* Hatching over elevation fill for amber/red only */}
                    {hatchFill && <rect x={x1} y={CHART_T} width={x2 - x1} height={CHART_B - CHART_T} fill={hatchFill} opacity="0.35" />}
                  </g>
                )
              })}

              {/* Surface fills */}
              {surfaceGroups.map((seg, i) => (
                <path
                  key={i}
                  d={surfaceAreaPath(seg)}
                  fill={seg.surface === 'paved' ? 'rgba(1,106,125,0.18)' : 'url(#offRoadHatch)'}
                />
              ))}

              {/* Surface lines */}
              {surfaceGroups.map((seg, i) => {
                const pts = seg.pts
                if (pts.length < 2) return null
                const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'} ${toX(p.dist).toFixed(1)},${toY(p.elev).toFixed(1)}`).join(' ')
                return (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke="#016a7d"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={SURFACE_DASH[seg.surface]}
                  />
                )
              })}

              {/* POI markers — staggered by type into 4 vertical lanes */}
              {result.pois.map((poi, i) => {
                const x  = toX(poi.distance_km)
                const ey = poiLaneY(poi.type)
                const color = POI_COLOR[poi.type] ?? '#aaa'
                return (
                  <g key={i}>
                    <line x1={x} y1={ey + 3} x2={x} y2={CHART_B} stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                    <text x={x} y={ey} textAnchor="middle" fontSize="11" style={{ userSelect: 'none' }}>{poiSymbol(poi)}</text>
                  </g>
                )
              })}

              {/* Baseline */}
              <line x1={CHART_L} y1={CHART_B} x2={CHART_R} y2={CHART_B} stroke="rgba(1,106,125,0.3)" strokeWidth="1" />
            </svg>

            {/* Legend */}
            <div className={styles.elevLegend}>
              <div className={styles.legendGroup}>
                <span className={styles.legendTitle}>Surface</span>
                <span className={styles.legendItem}>
                  <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#016a7d" strokeWidth="2" /></svg> Paved
                </span>
                <span className={styles.legendItem}>
                  <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#016a7d" strokeWidth="2" strokeDasharray="6 4" /></svg> Unpaved
                </span>
              </div>
              <div className={styles.legendGroup}>
                <span className={styles.legendTitle}>Points</span>
                {[
                  { emoji: '🚰', label: 'Potable water' },
                  { emoji: '🐟', label: 'Filter required' },
                  { emoji: '🛠️', label: 'Bike shop' },
                  { emoji: '🔧', label: 'Repair station' },
                  { emoji: '🚒', label: 'Fire station' },
                  { emoji: '🏥', label: 'Hospital / Clinic' },
                  { emoji: '🩺', label: "Doctor's office" },
                  { emoji: '📞', label: 'Emergency phone' },
                  { emoji: '🛖', label: 'Shelter' },
                  { emoji: '🛑', label: 'Bailout point' },
                ].map(({ emoji, label }) => (
                  <span key={label} className={styles.legendItem}>
                    <span style={{ fontSize: '10px' }}>{emoji}</span> {label}
                  </span>
                ))}
              </div>
              {activeLayers.has('Weather') && weatherZones.length > 0 && (
                <div className={styles.legendGroup}>
                  <span className={styles.legendTitle}>Weather</span>
                  <span className={styles.legendItem}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: WEATHER_COLOR.green, opacity: 0.8 }} /> Clear</span>
                  <span className={styles.legendItem}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: WEATHER_COLOR.amber, opacity: 0.8 }} /> Caution</span>
                  <span className={styles.legendItem}><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: WEATHER_COLOR.red, opacity: 0.8 }} /> Danger</span>
                </div>
              )}
              <div className={styles.legendGroup}>
                <span className={styles.legendTitle}>Surface mix</span>
                <div className={styles.surfaceBar}>
                  <div style={{ width: `${pavedPct}%`, background: 'rgba(1,106,125,0.5)', height: '100%' }} />
                  <div style={{ width: `${nonPavedPct}%`, background: 'repeating-linear-gradient(45deg,rgba(1,106,125,0.3),rgba(1,106,125,0.3) 3px,transparent 3px,transparent 8px)', height: '100%' }} />
                </div>
                <span className={styles.surfaceBarLabel}>{pavedPct}% paved · {nonPavedPct}% unpaved</span>
              </div>
            </div>
          </div>
          </div>
          )} {/* end elevPanel */}

          {/* Stats panel — 15% */}
          <div className={styles.statsPanel}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Distance</span>
              <span className={styles.statValue}>
                {unit === 'imperial' ? `${totalMi} mi` : `${route.distance_km} km`}
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Elevation Gain</span>
              <span className={styles.statValue}>
                {unit === 'imperial' ? `${gainFt.toLocaleString()} ft` : `${route.elevation_gain_m.toLocaleString()} m`}
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Est. Ride Time</span>
              <span className={styles.statValue}>{rideTimeStr}</span>
              <div className={styles.rideControls}>
                <label className={styles.rideControlLabel}>
                  Speed
                  <input
                    type="range"
                    min={unit === 'imperial' ? 5 : 8}
                    max={unit === 'imperial' ? 22 : 35}
                    step={unit === 'imperial' ? 0.5 : 1}
                    value={unit === 'imperial' ? +(speedKph * 0.621371).toFixed(1) : speedKph}
                    onChange={e => {
                      const v = parseFloat(e.target.value)
                      setSpeedKph(unit === 'imperial' ? v / 0.621371 : v)
                    }}
                    className={styles.rideSlider}
                  />
                  <span>{speedDisplay}</span>
                </label>
                <label className={styles.rideControlLabel}>
                  Start
                  <input
                    type="range"
                    min={4} max={12} step={1}
                    value={startHour}
                    onChange={e => setStartHour(+e.target.value)}
                    className={styles.rideSlider}
                  />
                  <span>{startTimeStr}</span>
                </label>
              </div>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Surfaces</span>
              <span className={styles.statValue}>{pavedPct}% paved</span>
            </div>
          </div>

        </div> {/* end elevStatsRow */}

        {/* ── Dossier + planning summary ── */}
        <div className={styles.dossier}>
          <div className={styles.dossierLeft}>

            {/* Alerts */}
            {result.weather.alerts.length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>Alerts</span>
                {result.weather.alerts.map((alert, i) => (
                  <div key={i} className={[styles.alertRow, alert.severity === 'severe' || alert.severity === 'extreme' ? styles.alertRed : styles.alertAmber].join(' ')}>
                    <span className={styles.alertTitle}>{alert.title}</span>
                    <span className={styles.alertDetail}>{alert.description}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Supply gaps */}
            {result.supply_gaps.length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>Supply Gaps</span>
                {result.supply_gaps.map((gap, i) => {
                  const from  = unit === 'imperial' ? (gap.from_km * 0.621371).toFixed(1) : gap.from_km.toFixed(1)
                  const to    = unit === 'imperial' ? (gap.to_km   * 0.621371).toFixed(1) : gap.to_km.toFixed(1)
                  const span  = unit === 'imperial' ? ((gap.to_km - gap.from_km) * 0.621371).toFixed(1) : (gap.to_km - gap.from_km).toFixed(1)
                  const label = unit === 'imperial' ? 'Mile' : 'km'
                  const unit2 = unit === 'imperial' ? 'miles' : 'km'
                  return (
                    <div key={i} className={styles.gapRow}>
                      <span className={styles.gapBadge}>Gap</span>
                      <span className={styles.gapDesc}>
                        From {label} {from} to {label} {to} — {span} {unit2} with no water or resupply
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* POI table */}
            {result.pois.length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>Points of Interest</span>
                <table className={styles.poiTable}>
                  <thead>
                    <tr>
                      <th />
                      <th>Name</th>
                      <th>Type</th>
                      <th>{unit === 'imperial' ? 'Mile' : 'km'}</th>
                      <th>Gap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.pois.map((poi, i) => {
                      const dist = unit === 'imperial'
                        ? (poi.distance_km * 0.621371).toFixed(1)
                        : poi.distance_km.toFixed(1)
                      const prevDist = i > 0
                        ? (unit === 'imperial'
                          ? result.pois[i - 1].distance_km * 0.621371
                          : result.pois[i - 1].distance_km)
                        : 0
                      const currDist = unit === 'imperial' ? poi.distance_km * 0.621371 : poi.distance_km
                      const gap = (currDist - prevDist).toFixed(1)
                      return (
                        <tr key={poi.id}>
                          <td>{poiSymbol(poi)}</td>
                          <td>
                            {poi.name}
                            {poi.potable === false && <span className={styles.nonPotable}> *</span>}
                          </td>
                          <td style={{ color: 'rgba(1,106,125,0.65)', fontSize: '0.72rem' }}>{poi.note ?? '—'}</td>
                          <td>{dist}</td>
                          <td className={styles.poiGap}>+{gap}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {result.pois.some(p => p.potable === false) && (
                  <p className={styles.potableNote}>* Non-potable — filter required</p>
                )}
              </div>
            )}

            {/* Bailout routes */}
            {(result.bailouts ?? []).length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>🛑 Bailout Routes</span>
                {(result.bailouts ?? []).map((b, i) => (
                  <div key={b.id ?? i} className={styles.landRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className={styles.gapBadge} style={{ background: '#ed1c24' }}>
                        {unit === 'imperial'
                          ? `Mi ${(b.distance_km * 0.621371).toFixed(1)}`
                          : `Km ${b.distance_km.toFixed(1)}`}
                      </span>
                      <span className={styles.landName}>
                        {b.road_name ? `${b.road_name} → ` : ''}{b.destination_name}
                      </span>
                    </div>
                    <span className={styles.landMeta}>
                      {bailoutDist(b, unit)} to safety
                      {' · '}
                      <strong style={{ color: '#2d8a4e' }}>saves {bailoutSaves(b, unit)}</strong>
                      {b.next_safe_name ? ` vs. continuing to ${b.next_safe_name}` : ' vs. continuing on route'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Land management */}
            {result.lands.length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>Land Management</span>
                {result.lands.map((land, i) => (
                  <div key={i} className={styles.landRow}>
                    <span className={styles.landName}>{land.name}</span>
                    <span className={styles.landMeta}>
                      {unit === 'imperial'
                        ? `${(land.entry_km * 0.621371).toFixed(1)}–${(land.exit_km * 0.621371).toFixed(1)} mi`
                        : `${land.entry_km.toFixed(1)}–${land.exit_km.toFixed(1)} km`}
                      {' · '}{land.agency}
                    </span>
                  </div>
                ))}
              </div>
            )}

          </div>

          {/* Planning summary */}
          <div className={styles.dossierRight}>
            <div className={styles.card}>
              <span className={styles.sectionTitle}>Planning Summary</span>
              {result.narrative ? (
                <div className={styles.narrative}>
                  {result.narrative.split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
              ) : (
                <div className={styles.narrative}>
                  <p>
                    {route.name} is a {totalDist.toFixed(1)} {unit === 'imperial' ? 'mile' : 'km'} route
                    with {unit === 'imperial' ? `${gainFt.toLocaleString()} ft` : `${route.elevation_gain_m.toLocaleString()} m`} of elevation gain.
                  </p>
                  {result.errors['narrative'] && (
                    <p style={{ color: 'rgba(237,28,36,0.7)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                      AI summary unavailable: {result.errors['narrative']}
                    </p>
                  )}
                  {!process.env.NEXT_PUBLIC_AI_ENABLED && (
                    <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                      Add ANTHROPIC_API_KEY to .env.local to enable AI planning narrative.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Data errors (dev visibility) */}
            {Object.keys(result.errors).length > 0 && (
              <div className={styles.card} style={{ borderColor: 'rgba(237,28,36,0.4)' }}>
                <span className={styles.sectionTitle} style={{ color: '#ed1c24' }}>Data Source Errors</span>
                {Object.entries(result.errors).map(([source, msg]) => (
                  <div key={source} style={{ fontSize: '0.75rem', color: 'rgba(237,28,36,0.8)', marginTop: '0.25rem' }}>
                    <strong>{source}:</strong> {msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Imagery ── */}
        {result.imagery.length > 0 && (
          <div className={styles.card}>
            <span className={styles.sectionTitle}>Visual Recon</span>
            <div className={styles.photoGrid}>
              {result.imagery.map(img => (
                <a key={img.id} href={img.full_url} target="_blank" rel="noopener noreferrer" className={styles.photoCard}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.thumb_url} alt={`Route at ${img.distance_km.toFixed(1)} km`} className={styles.photoImg} />
                  <span className={styles.photoMeta}>
                    {unit === 'imperial' ? `Mi ${(img.distance_km * 0.621371).toFixed(1)}` : `Km ${img.distance_km.toFixed(1)}`}
                  </span>
                  <span className={styles.photoSource}>Mapillary</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className={styles.footer}>
          <div className={styles.footerTop}>
            <span className={styles.version}>v1.000</span>
            <span className={styles.disclaimer}>Beta product — results may be inaccurate. Do not rely solely on this data to plan your route.</span>
          </div>
        </footer>

      </div>
    </main>
  )
}
