'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import styles from '../results.module.css'
import type { BailoutRoute, ReconResult, SurfaceType, WeatherSegment } from '@/lib/types'

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
const SVG_H     = 362
const WEATHER_H = 10
const CHART_L   = 10, CHART_R = 790
// 5 lanes × 24px each (4 POI + 1 bailout), plus 10px gap before chart
const CHART_T        = WEATHER_H + 5 * 24 + 10   // = 150
const CHART_B        = 294
const BAILOUT_LANE_Y = WEATHER_H + 18 + 4 * 24   // = 134 (bottom lane)
// Weather strip positions — below the elevation baseline
const N_WTHR = 120            // rendering resolution
const WIND_Y = CHART_B + 14  // 308 — wind strip centerline
const RAIN_Y = CHART_B + 33  // 327 — rain strip centerline
const TEMP_Y = CHART_B + 52  // 346 — temp strip centerline

// Vertical lane per POI type: 0 = top (emergency), 3 = bottom (water)
const POI_LANE: Record<string, number> = {
  emergency: 0,
  shop:      1,
  shelter:   2,
  water:     3,
}
const poiLaneY = (type: string) => WEATHER_H + 18 + (POI_LANE[type] ?? 1) * 24

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

function interpolateWeather(
  segs: WeatherSegment[],
  distKm: number,
  key: 'wind_speed_kph' | 'precipitation_chance' | 'temp_c',
): number {
  const val = (s: WeatherSegment) =>
    key === 'wind_speed_kph' ? s.wind_speed_kph
    : key === 'precipitation_chance' ? s.precipitation_chance
    : s.temp_c
  if (!segs.length) return 0
  if (segs.length === 1) return val(segs[0])
  if (distKm <= segs[0].distance_km) return val(segs[0])
  if (distKm >= segs[segs.length - 1].distance_km) return val(segs[segs.length - 1])
  for (let i = 0; i < segs.length - 1; i++) {
    if (distKm >= segs[i].distance_km && distKm <= segs[i + 1].distance_km) {
      const t = (distKm - segs[i].distance_km) / (segs[i + 1].distance_km - segs[i].distance_km)
      return val(segs[i]) + t * (val(segs[i + 1]) - val(segs[i]))
    }
  }
  return val(segs[segs.length - 1])
}

function tempToColor(tempC: number): string {
  const f = tempC * 9 / 5 + 32
  if (f <  25) return '#000000'  // extreme cold — black
  if (f <  35) return '#1a237e'  // very cold    — dark blue
  if (f <  45) return '#29b6f6'  // cold         — sky blue
  if (f <  55) return '#26a69a'  // cool         — blue-green
  if (f <  65) return '#66bb6a'  // mild         — green
  if (f <  75) return '#fdd835'  // comfortable  — yellow
  if (f <  85) return '#f77f00'  // warm         — amber
  if (f <  95) return '#ed1c24'  // hot          — red
  return '#e040fb'               // extreme heat — magenta
}

function makeRainPath(centerY: number, halfH: number, amp: number, wlen: number): string {
  const W = CHART_R - CHART_L
  const pts: string[] = []
  for (let px = 0; px <= W * 2; px += 2) {
    const y = centerY - halfH + amp * Math.sin(2 * Math.PI * px / wlen)
    pts.push(`${pts.length === 0 ? 'M' : 'L'} ${px.toFixed(1)},${y.toFixed(1)}`)
  }
  pts.push(`L ${(W * 2).toFixed(1)},${(centerY + halfH).toFixed(1)}`)
  pts.push(`L 0,${(centerY + halfH).toFixed(1)}`)
  pts.push('Z')
  return pts.join(' ')
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
  const [hoverFrac,    setHoverFrac]    = useState<number | null>(null)
  const [hoverSvgY,    setHoverSvgY]    = useState<number | null>(null)

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

  const handleElevMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W
    const svgY = ((e.clientY - rect.top)  / rect.height) * SVG_H
    setHoverFrac(Math.max(0, Math.min(1, (svgX - CHART_L) / (CHART_R - CHART_L))))
    setHoverSvgY(svgY)
  }, [])

  const handleElevMouseLeave = useCallback(() => { setHoverFrac(null); setHoverSvgY(null) }, [])

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

  const pavedPct = result.surfaces.find(s => s.type === 'paved')?.pct ?? 0

  const rideHours   = naisimithHours(route.distance_km, route.elevation_gain_m, speedKph)
  const rideTimeStr = formatHours(rideHours)
  const speedDisplay = unit === 'imperial'
    ? `${(speedKph * 0.621371).toFixed(1)} mph`
    : `${speedKph} km/h`
  const startTimeStr = `${String(startHour).padStart(2, '0')}:00`

  // Weather strip parameters — react live to speed + start-time sliders via displayWeather
  const maxWindKph = displayWeather.length ? Math.max(...displayWeather.map(s => s.wind_speed_kph)) : 0
  const maxPrecip  = displayWeather.length ? Math.max(...displayWeather.map(s => s.precipitation_chance)) : 0
  const precipFrac = maxPrecip / 100
  const windFrac   = Math.min(maxWindKph / 60, 1)               // cap at 60 kph ≈ 37 mph
  const rainHalfH  = (3 + precipFrac * 12) / 2                  // 1.5–7.5px half-height
  const waveAmp    = precipFrac * 4 + precipFrac * windFrac * 3  // 0–7px; rain+wind combo boosts waviness
  const waveLen    = Math.max(40, 80 - windFrac * 40)            // 80px calm → 40px windy
  const waveDur    = Math.max(1.5, 3 - windFrac * 1.5)           // 3s calm → 1.5s windy
  const rainPath   = displayWeather.length > 0 ? makeRainPath(RAIN_Y, rainHalfH, waveAmp, waveLen) : ''

  // POI proximity filter: per lane, enforce ≥40 SVG units between markers
  const MIN_POI_SPACING = 40 // SVG units
  const chartPois = (() => {
    const lastX: Record<string, number> = {}
    return result.pois.filter(poi => {
      const x = toX(poi.distance_km)
      const lane = String(POI_LANE[poi.type] ?? 1)
      if (lastX[lane] !== undefined && x - lastX[lane] < MIN_POI_SPACING) return false
      lastX[lane] = x
      return true
    })
  })()

  // ── Hover scrubber (elevation ↔ map sync) ───────────────────────────────────
  const hoverIdx  = hoverFrac != null ? Math.round(Math.max(0, Math.min(hoverFrac, 1)) * (elevData.length - 1)) : null
  const hoverPt   = hoverIdx != null ? (elevData[hoverIdx] ?? null) : null
  const hoverX    = hoverFrac != null ? CHART_L + hoverFrac * (CHART_R - CHART_L) : null
  const hoverY    = hoverPt ? toY(hoverPt.elev) : null
  const TIP_W = 160, TIP_H = 22
  const hoverTipX = hoverX != null ? (hoverX + TIP_W + 16 > CHART_R ? hoverX - TIP_W - 8 : hoverX + 8) : null
  const hoverTipY = hoverY != null ? Math.max(CHART_T + 4, Math.min(CHART_B - TIP_H - 4, hoverY - TIP_H / 2)) : null

  // Strip hover — zone detection + per-strip values at current x position
  const STRIP_TOL  = 14
  const hoverZone  = hoverSvgY == null ? null
    : hoverSvgY >= CHART_T && hoverSvgY <= CHART_B              ? 'elev'
    : Math.abs(hoverSvgY - WIND_Y) < STRIP_TOL                  ? 'wind'
    : Math.abs(hoverSvgY - RAIN_Y) < STRIP_TOL                  ? 'rain'
    : Math.abs(hoverSvgY - TEMP_Y) < STRIP_TOL                  ? 'temp'
    : 'none'
  const windAtHover = hoverPt && displayWeather.length > 0 ? interpolateWeather(displayWeather, hoverPt.dist, 'wind_speed_kph')        : null
  const rainAtHover = hoverPt && displayWeather.length > 0 ? interpolateWeather(displayWeather, hoverPt.dist, 'precipitation_chance')   : null
  const tempAtHover = hoverPt && displayWeather.length > 0 ? interpolateWeather(displayWeather, hoverPt.dist, 'temp_c')                 : null
  const windLabel   = windAtHover != null ? (unit === 'imperial' ? `${(windAtHover * 0.621371).toFixed(0)} mph` : `${windAtHover.toFixed(0)} km/h`) : null
  const rainLabel   = rainAtHover != null ? `${rainAtHover.toFixed(0)}% precip` : null
  const tempLabel   = tempAtHover != null ? (unit === 'imperial' ? `${(tempAtHover * 9 / 5 + 32).toFixed(0)}°F` : `${tempAtHover.toFixed(0)}°C`) : null
  const hoverLineBottom = activeLayers.has('Weather') && displayWeather.length > 0 ? TEMP_Y + 8 : CHART_B

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
                startHour={startHour}
                hoverFrac={hoverFrac}
                onHoverFrac={setHoverFrac}
                className={styles.mapInner}
              />
            )}
          </div>
        </section>

        {/* ── Layer toggles — centered between map and elevation ── */}
        <div className={styles.layerToggles}>
          {['Route', 'Surface', 'Weather', 'Public Lands', 'Mobile Coverage', 'POIs', 'Bailouts', 'Imagery'].map(layer => (
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

            <svg
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              className={styles.elevSvg}
              onMouseMove={handleElevMouseMove}
              onMouseLeave={handleElevMouseLeave}
              style={{ cursor: 'crosshair' }}
            >
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
                <clipPath id="weatherClip">
                  <rect x={CHART_L} y={0} width={CHART_R - CHART_L} height={SVG_H} />
                </clipPath>
                {displayWeather.length > 0 && (
                  <linearGradient id="tempGrad" x1="0" x2="1">
                    {Array.from({ length: 20 }, (_, i) => {
                      const frac = i / 19
                      const temp = interpolateWeather(displayWeather, frac * route.distance_km, 'temp_c')
                      return <stop key={i} offset={`${(frac * 100).toFixed(1)}%`} stopColor={tempToColor(temp)} />
                    })}
                  </linearGradient>
                )}
              </defs>

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
              {activeLayers.has('POIs') && chartPois.map((poi, i) => {
                const x  = toX(poi.distance_km)
                const ey = poiLaneY(poi.type)
                const emojiSize = poi.type === 'water' ? 18 : 16
                return (
                  <g key={i}>
                    <line x1={x} y1={ey + 3} x2={x} y2={CHART_B} stroke="#555" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                    <text x={x} y={ey} textAnchor="middle" fontSize={emojiSize} style={{ userSelect: 'none' }}>{poiSymbol(poi)}</text>
                  </g>
                )
              })}

              {/* Bailout markers — bottom lane, toggled with Bailouts layer */}
              {activeLayers.has('Bailouts') && (result.bailouts ?? []).map((b, i) => {
                const x = toX(b.distance_km)
                return (
                  <g key={i}>
                    <line x1={x} y1={BAILOUT_LANE_Y + 3} x2={x} y2={CHART_B} stroke="#555" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                    <text x={x} y={BAILOUT_LANE_Y} textAnchor="middle" fontSize="16" style={{ userSelect: 'none' }}>☠️</text>
                  </g>
                )
              })}

              {/* Baseline */}
              <line x1={CHART_L} y1={CHART_B} x2={CHART_R} y2={CHART_B} stroke="rgba(1,106,125,0.3)" strokeWidth="1" />

              {/* ── Weather strips: Wind / Rain / Temp ── */}
              {/* All three react live to speed + start-time sliders via displayWeather */}
              {activeLayers.has('Weather') && displayWeather.length > 0 && (
                <>
                  {/* Wind — variable-thickness gray stroke, scaled to max wind on route */}
                  <g clipPath="url(#weatherClip)">
                    {Array.from({ length: N_WTHR }, (_, i) => {
                      const frac   = i / (N_WTHR - 1)
                      const distKm = frac * route.distance_km
                      const wind   = interpolateWeather(displayWeather, distKm, 'wind_speed_kph')
                      const h      = maxWindKph > 0 ? 3 + (wind / maxWindKph) * 12 : 3
                      const x      = CHART_L + frac * (CHART_R - CHART_L)
                      const w      = (CHART_R - CHART_L) / N_WTHR + 0.5
                      return <rect key={i} x={x} y={WIND_Y - h / 2} width={w} height={h} fill="rgba(170,170,170,0.75)" />
                    })}
                  </g>

                  {/* Rain — animated water-depth wave. depth = precip intensity; waviness = precip × wind combo */}
                  {rainPath && (
                    <g clipPath="url(#weatherClip)">
                      <g transform={`translate(${CHART_L},0)`}>
                        <g>
                          <animateTransform
                            attributeName="transform"
                            attributeType="XML"
                            type="translate"
                            from="0,0"
                            to={`${-(CHART_R - CHART_L)},0`}
                            dur={`${waveDur.toFixed(2)}s`}
                            repeatCount="indefinite"
                          />
                          <path d={rainPath} fill="rgba(99,179,237,0.55)" />
                        </g>
                      </g>
                    </g>
                  )}

                  {/* Temp — 5px smooth gradient bar */}
                  <rect x={CHART_L} y={TEMP_Y - 2.5} width={CHART_R - CHART_L} height={5}
                    fill="url(#tempGrad)" opacity={0.9} rx={2} />
                </>
              )}

              {/* ── Hover scrubber overlay ── */}
              {hoverX != null && hoverPt != null && (
                <g pointerEvents="none">
                  {/* Vertical line — extends through weather strips when visible */}
                  <line x1={hoverX} y1={0} x2={hoverX} y2={hoverLineBottom}
                    stroke="rgba(253,182,24,0.45)" strokeWidth="1" />

                  {/* Elevation dot + tooltip — show when not hovering a weather strip */}
                  {hoverY != null && hoverTipX != null && hoverTipY != null &&
                   hoverZone !== 'wind' && hoverZone !== 'rain' && hoverZone !== 'temp' && (
                    <>
                      <circle cx={hoverX} cy={hoverY} r="4" fill="#fdb618" stroke="#011c24" strokeWidth="1.5" />
                      <rect x={hoverTipX} y={hoverTipY} width={TIP_W} height={TIP_H} rx="3"
                        fill="rgba(1,28,36,0.92)" stroke="#016a7d" strokeWidth="0.5" />
                      <text x={hoverTipX + TIP_W / 2} y={hoverTipY + 14}
                        textAnchor="middle" fill="#fdb618" fontSize="11" fontFamily="monospace">
                        {unit === 'imperial'
                          ? `${(hoverPt.dist * 0.621371).toFixed(1)} mi  ·  ${hoverPt.elev.toFixed(0)} ft`
                          : `${hoverPt.dist.toFixed(1)} km  ·  ${(hoverPt.elev / 3.28084).toFixed(0)} m`}
                      </text>
                    </>
                  )}

                  {/* Weather strip dots + tooltips */}
                  {activeLayers.has('Weather') && displayWeather.length > 0 && hoverTipX != null && (
                    <>
                      <circle cx={hoverX} cy={WIND_Y} r="3" fill="rgba(210,210,210,0.9)" stroke="#011c24" strokeWidth="1" />
                      <circle cx={hoverX} cy={RAIN_Y} r="3" fill="rgba(99,179,237,0.9)"  stroke="#011c24" strokeWidth="1" />
                      <circle cx={hoverX} cy={TEMP_Y} r="3"
                        fill={tempAtHover != null ? tempToColor(tempAtHover) : '#888'} stroke="#011c24" strokeWidth="1" />
                      {hoverZone === 'wind' && windLabel && (
                        <>
                          <rect x={hoverTipX} y={WIND_Y - TIP_H - 4} width={TIP_W} height={TIP_H} rx="3"
                            fill="rgba(1,28,36,0.92)" stroke="#016a7d" strokeWidth="0.5" />
                          <text x={hoverTipX + TIP_W / 2} y={WIND_Y - TIP_H - 4 + 14}
                            textAnchor="middle" fill="#fdb618" fontSize="11" fontFamily="monospace">{windLabel}</text>
                        </>
                      )}
                      {hoverZone === 'rain' && rainLabel && (
                        <>
                          <rect x={hoverTipX} y={RAIN_Y - TIP_H - 4} width={TIP_W} height={TIP_H} rx="3"
                            fill="rgba(1,28,36,0.92)" stroke="#016a7d" strokeWidth="0.5" />
                          <text x={hoverTipX + TIP_W / 2} y={RAIN_Y - TIP_H - 4 + 14}
                            textAnchor="middle" fill="#fdb618" fontSize="11" fontFamily="monospace">{rainLabel}</text>
                        </>
                      )}
                      {hoverZone === 'temp' && tempLabel && (
                        <>
                          <rect x={hoverTipX} y={TEMP_Y - TIP_H - 4} width={TIP_W} height={TIP_H} rx="3"
                            fill="rgba(1,28,36,0.92)" stroke="#016a7d" strokeWidth="0.5" />
                          <text x={hoverTipX + TIP_W / 2} y={TEMP_Y - TIP_H - 4 + 14}
                            textAnchor="middle" fill="#fdb618" fontSize="11" fontFamily="monospace">{tempLabel}</text>
                        </>
                      )}
                    </>
                  )}
                </g>
              )}
            </svg>

            {/* Legend */}
            <div className={styles.elevLegend}>
              <div className={styles.legendSection}>
                <span className={styles.legendTitle}>Points</span>
                <div className={styles.legendPointsGrid}>
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
                    { emoji: '☠️', label: 'Bailout point' },
                  ].map(({ emoji, label }) => (
                    <span key={label} className={styles.legendItem}>
                      <span style={{ fontSize: '14px' }}>{emoji}</span> {label}
                    </span>
                  ))}
                </div>
              </div>
              {activeLayers.has('Public Lands') && result.lands.some(l => l.status && l.status !== 'unknown') && (
                <div className={styles.legendRow}>
                  <span className={styles.legendTitle}>Land</span>
                  <span className={styles.legendItem}>
                    <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><rect x="0" y="2" width="28" height="6" fill="#14532d" rx="2" /></svg> Federal
                  </span>
                  <span className={styles.legendItem}>
                    <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><rect x="0" y="2" width="28" height="6" fill="#f9a825" rx="2" /></svg> State
                  </span>
                  <span className={styles.legendItem}>
                    <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><rect x="0" y="2" width="28" height="6" fill="#c62828" rx="2" /></svg> Private
                  </span>
                  {result.lands.some(l => l.status === 'tribal') && (
                    <span className={styles.legendItem}>
                      <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><rect x="0" y="2" width="28" height="6" fill="#7b5ea7" rx="2" /></svg> Tribal
                    </span>
                  )}
                </div>
              )}
              {activeLayers.has('Weather') && displayWeather.length > 0 && (
                <div className={styles.legendRow}>
                  <span className={styles.legendTitle}>Weather</span>
                  <span className={styles.legendItem}>
                    <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><line x1="0" y1="5" x2="28" y2="5" stroke="rgba(170,170,170,0.85)" strokeWidth="5" strokeLinecap="round" /></svg> Wind
                  </span>
                  <span className={styles.legendItem}>
                    <svg width="28" height="10" style={{ verticalAlign: 'middle' }}><rect x="0" y="2" width="28" height="6" fill="rgba(99,179,237,0.55)" rx="2" /></svg> Rain
                  </span>
                  <span className={styles.legendItem}>
                    <svg width="60" height="10" style={{ verticalAlign: 'middle' }}>
                      <defs><linearGradient id="tLegGrad" x1="0" x2="1"><stop offset="0%" stopColor="#1a237e"/><stop offset="25%" stopColor="#26a69a"/><stop offset="50%" stopColor="#fdd835"/><stop offset="75%" stopColor="#f77f00"/><stop offset="100%" stopColor="#e040fb"/></linearGradient></defs>
                      <rect x="0" y="2.5" width="60" height="5" fill="url(#tLegGrad)" rx="1" />
                    </svg> Temp
                  </span>
                </div>
              )}
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
                <div className={styles.rideControl}>
                  <div className={styles.rideControlRow}>
                    <span className={styles.rideControlName}>Speed</span>
                    <span className={styles.rideControlVal}>{speedDisplay}</span>
                  </div>
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
                </div>
                <div className={styles.rideControl}>
                  <div className={styles.rideControlRow}>
                    <span className={styles.rideControlName}>Start Time</span>
                    <span className={styles.rideControlVal}>{startTimeStr}</span>
                  </div>
                  <input
                    type="range"
                    min={4} max={12} step={1}
                    value={startHour}
                    onChange={e => setStartHour(+e.target.value)}
                    className={styles.rideSlider}
                  />
                </div>
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

            {/* Bailout routes */}
            {(result.bailouts ?? []).length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>☠️ Bailout Routes</span>
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
                      <strong style={{ color: '#14532d' }}>saves {bailoutSaves(b, unit)}</strong>
                      {b.next_safe_name ? ` vs. continuing to ${b.next_safe_name}` : ' vs. continuing on route'}
                    </span>
                  </div>
                ))}
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

          </div>

          {/* Right column */}
          <div className={styles.dossierRight}>

            {/* Planning summary */}
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

            {/* Land management — always last */}
            {result.lands.length > 0 && (
              <div className={styles.card}>
                <span className={styles.sectionTitle}>Land Management</span>
                {result.lands.map((land, i) => {
                  const dotColor = land.status === 'public' ? '#14532d'
                    : land.status === 'state'   ? '#f9a825'
                    : land.status === 'private' ? '#c62828'
                    : land.status === 'tribal'  ? '#7b5ea7'
                    : '#888'
                  return (
                    <div key={i} className={styles.landRow}>
                      <span className={styles.landName} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                        {land.name}
                      </span>
                      <span className={styles.landMeta}>
                        {unit === 'imperial'
                          ? `${(land.entry_km * 0.621371).toFixed(1)}–${(land.exit_km * 0.621371).toFixed(1)} mi`
                          : `${land.entry_km.toFixed(1)}–${land.exit_km.toFixed(1)} km`}
                        {' · '}{land.agency}
                      </span>
                    </div>
                  )
                })}
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
            <span className={styles.version}>v1.1</span>
            <span className={styles.disclaimer}>Beta product — results may be inaccurate. Do not rely solely on this data to plan your route.</span>
            <span className={styles.version}>© Mettle Cycling 2026</span>
          </div>
          <div className={styles.footerSources}>
            <span className={styles.footerSourcesLabel}>Data sources:</span>
            {[
              { label: 'OpenStreetMap',     url: 'https://wiki.openstreetmap.org/wiki/Overpass_API' },
              { label: 'NWS Weather',       url: 'https://www.weather.gov/documentation/services-web-api' },
              { label: 'PAD-US Public Lands', url: 'https://data.usgs.gov/datacatalog/data/USGS:652ef930d34edd15305a9b03' },
              { label: 'FCC Coverage',      url: 'https://broadbandmap.fcc.gov/' },
              { label: 'Mapillary',         url: 'https://www.mapillary.com/developer/api-documentation' },
            ].map(s => (
              <a key={s.label} href={s.url} target="_blank" rel="noopener noreferrer" className={styles.footerSourceLink}>
                {s.label}
              </a>
            ))}
          </div>
        </footer>

      </div>
    </main>
  )
}
