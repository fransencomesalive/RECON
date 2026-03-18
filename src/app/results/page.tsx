'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Image from 'next/image'
import styles from './results.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

type Unit          = 'imperial' | 'metric'
type SurfaceType   = 'pavement' | 'gravel' | 'dirt' | 'unknown'
type WeatherStatus = 'green' | 'amber' | 'red'
type ElevPoint     = { dist: number; elev: number; surface: SurfaceType }

// ─── Mock data ────────────────────────────────────────────────────────────────

const TOTAL_MILES  = 47.3
const TOTAL_KM     = 76.1
const ELEV_GAIN_FT = 4820
const ELEV_GAIN_M  = 1469

function generateMockElevation(): ElevPoint[] {
  const pts: ElevPoint[] = []
  const N = 200
  for (let i = 0; i < N; i++) {
    const t    = i / (N - 1)
    const dist = t * TOTAL_MILES
    let elev: number
    if (t < 0.30)       elev = 2100 + (t / 0.30) * 2500 + Math.sin(t * 28) * 90
    else if (t < 0.52)  elev = 4600 + Math.sin(t * 22) * 180 + Math.cos(t * 11) * 110
    else if (t < 0.74)  elev = 4600 - ((t - 0.52) / 0.22) * 2200 + Math.sin(t * 24) * 65
    else                elev = 2400 + Math.sin(t * 16) * 130 + Math.sin(t * 6) * 90

    let surface: SurfaceType
    if      (t < 0.24)                      surface = 'pavement'
    else if (t < 0.44)                      surface = 'gravel'
    else if (t < 0.54)                      surface = 'dirt'
    else if (t < 0.62)                      surface = 'pavement'
    else if (t < 0.76)                      surface = 'gravel'
    else if (t < 0.82)                      surface = 'dirt'
    else                                    surface = 'pavement'

    pts.push({ dist, elev, surface })
  }
  return pts
}

const ELEV_DATA = generateMockElevation()
const MIN_ELEV  = Math.min(...ELEV_DATA.map(p => p.elev))
const MAX_ELEV  = Math.max(...ELEV_DATA.map(p => p.elev))

const MOCK_POIS = [
  { type: 'water',     name: 'Spring Creek',      mile: 8.2,  potable: true  },
  { type: 'shop',      name: 'Summit Cycles',      mile: 12.1                 },
  { type: 'water',     name: 'Ridgeline Cache',    mile: 23.4, potable: false },
  { type: 'bailout',   name: 'Hwy 34 Junction',    mile: 31.0                 },
  { type: 'water',     name: 'Valley Pump',        mile: 38.2, potable: true  },
  { type: 'emergency', name: 'Fire Station 14',    mile: 42.8                 },
]

const MOCK_WEATHER_ZONES: { from: number; to: number; status: WeatherStatus }[] = [
  { from: 0,    to: 0.27, status: 'green' },
  { from: 0.27, to: 0.61, status: 'amber' },
  { from: 0.61, to: 0.82, status: 'red'   },
  { from: 0.82, to: 1.0,  status: 'amber' },
]

const MOCK_SURFACE_PCT = { pavement: 52, nonPaved: 48 } // gravel 34% + dirt 12% + unknown 2%

const MOCK_LAND_CROSSINGS = [
  { name: 'USFS Pike National Forest', miles: '18.1 – 29.4', manager: 'USDA Forest Service'       },
  { name: 'BLM Colorado Front Range',  miles: '29.4 – 33.2', manager: 'Bureau of Land Management' },
]

const MOCK_ALERTS = [
  { severity: 'amber', title: 'Wind Advisory',        detail: '15–25 mph gusts above 9,000 ft. Active miles 18–32.' },
  { severity: 'amber', title: 'Weather Window Narrow', detail: 'Front arrives ~1:00 pm. Clear the ridge (miles 18–29) by noon.' },
]

const MOCK_PHOTOS = [
  { id: 1, location: 'Mile 14.2 — Ridgeline approach',   },
  { id: 2, location: 'Mile 22.8 — Summit traverse',      },
  { id: 3, location: 'Mile 26.1 — Descent switchbacks',  },
  { id: 4, location: 'Mile 31.0 — Hwy 34 bailout point', },
  { id: 5, location: 'Mile 37.4 — Valley floor',         },
  { id: 6, location: 'Mile 44.8 — Final road stretch',   },
]

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
    grd.addColorStop(0,    n.hex + n.a0)
    grd.addColorStop(0.55, n.hex + '55')
    grd.addColorStop(1,    n.hex + '00')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, W, H)
  })
}

// ─── Elevation SVG helpers ────────────────────────────────────────────────────

const SVG_W    = 800
const SVG_H    = 200
const WEATHER_H = 20
const CHART_L  = 10, CHART_R = 790
const CHART_T  = WEATHER_H + 6, CHART_B = 170

const toX = (dist: number) => CHART_L + (dist / TOTAL_MILES) * (CHART_R - CHART_L)
const toY = (elev: number) => CHART_B - ((elev - MIN_ELEV) / (MAX_ELEV - MIN_ELEV)) * (CHART_B - CHART_T)

type SurfaceGroup = { surface: SurfaceType; pts: ElevPoint[] }

function groupBySurface(pts: ElevPoint[]): SurfaceGroup[] {
  const groups: SurfaceGroup[] = []
  for (let i = 0; i < pts.length; i++) {
    const pt   = pts[i]
    const last = groups[groups.length - 1]
    if (!last || last.surface !== pt.surface) {
      // Overlap with previous group's last point for visual continuity
      const overlap = last ? [last.pts[last.pts.length - 1], pt] : [pt]
      groups.push({ surface: pt.surface, pts: overlap })
    } else {
      last.pts.push(pt)
    }
  }
  return groups
}

// All non-pavement uses the same dash — simpler, more readable
const SURFACE_DASH: Record<SurfaceType, string | undefined> = {
  pavement: undefined,
  gravel:   '10 6',
  dirt:     '10 6',
  unknown:  '10 6',
}

function surfaceAreaPath(seg: SurfaceGroup): string {
  const pts = seg.pts
  if (pts.length < 2) return ''
  const d     = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.dist).toFixed(1)},${toY(p.elev).toFixed(1)}`).join(' ')
  const first = pts[0], last = pts[pts.length - 1]
  return `${d} L ${toX(last.dist).toFixed(1)},${CHART_B} L ${toX(first.dist).toFixed(1)},${CHART_B} Z`
}

const WEATHER_COLOR: Record<WeatherStatus, string> = {
  green: '#2d8a4e',
  amber: '#fdb618',
  red:   '#ed1c24',
}

const POI_COLOR: Record<string, string> = {
  water:     '#00aac9',
  shop:      '#fdb618',
  bailout:   '#ed1c24',
  emergency: '#fcba4b',
}

function poiSymbol(type: string): string {
  switch (type) {
    case 'water':     return '💧'
    case 'shop':      return '🔧'
    case 'bailout':   return '↩'
    case 'emergency': return '🚨'
    default:          return '📍'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const bgRef    = useRef<HTMLCanvasElement>(null)
  const grainRef = useRef<HTMLCanvasElement>(null)

  const [unit,         setUnit]         = useState<Unit>('imperial')
  const [showWeather,  setShowWeather]  = useState(false)
  const [activeLayers, setActiveLayers] = useState<Set<string>>(new Set(['Route']))
  const [copied,       setCopied]       = useState(false)
  const [rideDate,     setRideDate]     = useState('')
  const [editingDate,  setEditingDate]  = useState(false)

  useEffect(() => {
    const stored = sessionStorage.getItem('recon_ride_date')
    setRideDate(stored ?? new Date().toISOString().split('T')[0])
  }, [])

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

  // ── Handlers ──────────────────────────────────────────────────────────────
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

  // ── Elevation SVG ─────────────────────────────────────────────────────────
  const surfaceGroups = groupBySurface(ELEV_DATA)

  const formatRideDate = (iso: string) => {
    if (!iso) return ''
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  }

  // ── Render ────────────────────────────────────────────────────────────────
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
          <a
            href="https://www.strava.com/routes/123456"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.notchRoute}
          >
            Breakfast Climb Loop ↗
          </a>
          {editingDate ? (
            <input
              type="date"
              className={styles.notchDateInput}
              value={rideDate}
              autoFocus
              onChange={e => setRideDate(e.target.value)}
              onBlur={() => { sessionStorage.setItem('recon_ride_date', rideDate); setEditingDate(false) }}
              onKeyDown={e => e.key === 'Enter' && (e.currentTarget.blur())}
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
              <Image
                src="/RECON-logo-topo.png"
                alt="R.E.C.O.N."
                width={336}
                height={126}
                priority
                className={styles.logoImg}
              />
            </a>
          </div>
          <div className={styles.headerCenter} />
          <div className={styles.headerRight}>
            <button
              className={[styles.pill, styles.pillActive].join(' ')}
              onClick={() => setUnit(u => u === 'imperial' ? 'metric' : 'imperial')}
            >
              {unit === 'imperial' ? 'Miles / Feet' : 'Kilometers / Meters'}
            </button>
            <button className={styles.pill} onClick={handleCopy}>
              {copied ? 'Copied!' : 'Share'}
            </button>
            <button className={styles.pill}>Export</button>
          </div>
        </header>

        {/* ── Map ── */}
        <section className={styles.mapSection}>
          <div className={styles.mapContainer}>
            <div className={styles.mapPlaceholder}>
              <span className={styles.mapLabel}>Mapbox · route map coming next</span>
            </div>
          </div>
          <div className={styles.layerToggles}>
            {['Route', 'Surface', 'Weather', 'Public Lands', 'Coverage', 'POIs'].map(layer => (
              <button
                key={layer}
                className={[styles.pill, activeLayers.has(layer) ? styles.pillActive : ''].join(' ')}
                onClick={() => toggleLayer(layer)}
              >
                {layer}
              </button>
            ))}
          </div>
        </section>

        {/* ── Stats strip ── */}
        <div className={styles.statsStrip}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Distance</span>
            <span className={styles.statValue}>
              {unit === 'imperial' ? `${TOTAL_MILES} mi` : `${TOTAL_KM} km`}
            </span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Elevation Gain</span>
            <span className={styles.statValue}>
              {unit === 'imperial'
                ? `${ELEV_GAIN_FT.toLocaleString()} ft`
                : `${ELEV_GAIN_M.toLocaleString()} m`}
            </span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Est. Ride Time</span>
            <span className={styles.statValue}>3h 45m</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>FPO</span>
          </div>
        </div>

        {/* ── Elevation profile ── */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.sectionTitle}>Elevation Profile</h2>
            <button
              className={[styles.pill, showWeather ? styles.pillActive : ''].join(' ')}
              onClick={() => setShowWeather(w => !w)}
            >
              Weather overlay
            </button>
          </div>

          <svg
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            className={styles.elevSvg}
            preserveAspectRatio="none"
          >
            <defs>
              {/* Weather hash patterns */}
              {(['green', 'amber', 'red'] as WeatherStatus[]).map(status => (
                <pattern key={status} id={`hash-${status}`}
                  patternUnits="userSpaceOnUse" width="8" height="8"
                  patternTransform="rotate(45 0 0)"
                >
                  <line x1="0" y1="0" x2="0" y2="8" stroke={WEATHER_COLOR[status]} strokeWidth="4" />
                </pattern>
              ))}
              {/* Vertical stripe fill for off-road sections */}
              <pattern id="offroad-fill" patternUnits="userSpaceOnUse" width="8" height="8">
                <rect width="8" height="8" fill="rgba(1,106,125,0.12)" />
                <line x1="0" y1="0" x2="0" y2="8" stroke="#016a7d" strokeWidth="2" opacity="0.45" />
              </pattern>
            </defs>

            {/* Weather band */}
            {showWeather && MOCK_WEATHER_ZONES.map((z, i) => {
              const x = toX(z.from * TOTAL_MILES)
              const w = toX(z.to * TOTAL_MILES) - x
              return (
                <rect key={i} x={x} y={0} width={w} height={WEATHER_H}
                  fill={`url(#hash-${z.status})`} opacity={0.85} />
              )
            })}

            {/* Per-surface-group area fills */}
            {surfaceGroups.map((seg, i) => {
              const isPaved = seg.surface === 'pavement'
              const aPath   = surfaceAreaPath(seg)
              if (!aPath) return null
              return (
                <path key={`fill-${i}`} d={aPath}
                  fill={isPaved ? 'rgba(1,106,125,0.30)' : 'url(#offroad-fill)'}
                />
              )
            })}

            {/* Surface-segmented stroke */}
            {surfaceGroups.map((seg, i) => {
              const d = seg.pts.map((p, j) =>
                `${j === 0 ? 'M' : 'L'} ${toX(p.dist).toFixed(1)},${toY(p.elev).toFixed(1)}`
              ).join(' ')
              return (
                <path key={`stroke-${i}`} d={d}
                  stroke="#016a7d" strokeWidth="3" fill="none"
                  strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={SURFACE_DASH[seg.surface]}
                />
              )
            })}

            {/* POI tick marks */}
            {MOCK_POIS.map(poi => {
              const idx = Math.round((poi.mile / TOTAL_MILES) * (ELEV_DATA.length - 1))
              const pt  = ELEV_DATA[idx]
              const x   = toX(poi.mile)
              const y   = toY(pt.elev)
              const col = POI_COLOR[poi.type] ?? '#fff'
              return (
                <g key={poi.name}>
                  <line x1={x} y1={y + 6} x2={x} y2={CHART_B}
                    stroke={col} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
                  <circle cx={x} cy={y} r="5" fill={col} stroke="white" strokeWidth="1.5" />
                </g>
              )
            })}
          </svg>

          {/* Legend + Surface Breakdown */}
          <div className={styles.elevFooter}>
            <div className={styles.elevLegend}>
              <span className={styles.legendItem}>
                <svg width="28" height="5"><line x1="0" y1="2.5" x2="28" y2="2.5" stroke="#016a7d" strokeWidth="3" /></svg>
                Pavement
              </span>
              <span className={styles.legendItem}>
                <svg width="28" height="5"><line x1="0" y1="2.5" x2="28" y2="2.5" stroke="#016a7d" strokeWidth="3" strokeDasharray="8 5" /></svg>
                Off-road
              </span>
              <span className={styles.legendDivider} />
              {Object.entries(POI_COLOR).map(([type, col]) => (
                <span key={type} className={styles.legendItem}>
                  <span className={styles.legendDot} style={{ background: col }} />
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </span>
              ))}
            </div>
            <div className={styles.surfaceInset}>
              <span className={styles.statLabel}>Surface Breakdown</span>
              <div className={styles.surfaceBar}>
                <div className={styles.segPavement} style={{ width: `${MOCK_SURFACE_PCT.pavement}%` }} title={`Paved ${MOCK_SURFACE_PCT.pavement}%`} />
                <div className={styles.segNonPaved} style={{ width: `${MOCK_SURFACE_PCT.nonPaved}%` }} title={`Off-road ${MOCK_SURFACE_PCT.nonPaved}%`} />
              </div>
              <div className={styles.surfaceLegend}>
                <span className={styles.legendItem}><span className={[styles.dot, styles.dotPavement].join(' ')} />{MOCK_SURFACE_PCT.pavement}% paved</span>
                <span className={styles.legendItem}><span className={[styles.dot, styles.dotNonPaved].join(' ')} />{MOCK_SURFACE_PCT.nonPaved}% off-road</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Dossier + Summary ── */}
        <div className={styles.twoCol}>

          {/* Dossier */}
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>Route Dossier</h2>

            {MOCK_ALERTS.map(alert => (
              <div key={alert.title} className={[styles.alert, styles[`alert_${alert.severity}`]].join(' ')}>
                <strong>{alert.title}</strong>
                <span>{alert.detail}</span>
              </div>
            ))}

            <h3 className={styles.subTitle}>Supply Gaps</h3>
            <div className={styles.gapRow}>
              <span className={styles.gapBadge}>15 mi</span>
              <span>Miles 8 → 23. No water or resupply.</span>
            </div>
            <div className={styles.gapRow}>
              <span className={styles.gapBadge}>15 mi</span>
              <span>Miles 23 → 38. Remote terrain — bailout at mile 31 only.</span>
            </div>

            <h3 className={styles.subTitle}>Points of Interest</h3>
            <table className={styles.poiTable}>
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>{unit === 'imperial' ? 'Mile' : 'KM'}</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_POIS.map((poi, i) => {
                  const prev       = MOCK_POIS[i - 1]
                  const gapMi      = prev ? (poi.mile - prev.mile).toFixed(1) : null
                  const gapDisplay = gapMi
                    ? unit === 'imperial'
                      ? `+${gapMi} mi`
                      : `+${(parseFloat(gapMi) * 1.609).toFixed(1)} km`
                    : '—'
                  const mileDisplay = unit === 'imperial'
                    ? poi.mile.toFixed(1)
                    : (poi.mile * 1.609).toFixed(1)
                  return (
                    <tr key={poi.name}>
                      <td className={styles.poiIcon}>{poiSymbol(poi.type)}</td>
                      <td>
                        {poi.name}
                        {'potable' in poi && poi.potable === false && (
                          <span className={styles.nonPotable} title="Non-potable source, filter needed">*</span>
                        )}
                      </td>
                      <td className={styles.poiMile}>{mileDisplay}</td>
                      <td className={styles.poiGap}>{gapDisplay}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <h3 className={styles.subTitle}>Land Management</h3>
            {MOCK_LAND_CROSSINGS.map(lc => (
              <div key={lc.name} className={styles.landRow}>
                <span className={styles.landName}>{lc.name}</span>
                <span className={styles.landDetail}>Miles {lc.miles} · {lc.manager}</span>
              </div>
            ))}
          </section>

          {/* Planning Summary */}
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>Planning Summary</h2>
            <div className={styles.summaryBody}>
              <p>The first 12 miles are civilized — paved, groomed, with a bike shop at mile 12 to handle any mechanical before things get serious. After that, the route transitions to gravel and doesn&apos;t apologize.</p>
              <p>Weather window is narrow. A front is forecast to arrive around 1:00 pm, putting the exposed ridge crossing (miles 18–29) in play. Start early or plan to be off the ridge by noon. Wind advisory active above 9,000 ft — the descent on dirt gets technical in high winds.</p>
              <p><strong>Critical supply gap:</strong> 15 miles of remote terrain between mile 23 and mile 38 with no reliable water. Carry 3+ liters out of Ridgeline Cache. Cell coverage drops to zero at mile 22 and doesn&apos;t return until mile 35.</p>
              <p>Bailout at mile 31 via Hwy 34 if conditions deteriorate. Flag it on your GPS before you leave.</p>
            </div>
          </section>

        </div>

        {/* ── Photo grid ── */}
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Visual Recon <span className={styles.sourceTag}>Mapillary</span></h2>
          <div className={styles.photoGrid}>
            {MOCK_PHOTOS.map(photo => (
              <div key={photo.id} className={styles.photoCard}>
                <div className={styles.photoPlaceholder} />
                <span className={styles.photoLocation}>{photo.location}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className={styles.footer}>
          <span className={styles.version}>v1.000</span>
          <span className={styles.disclaimer}>Beta product — results may be inaccurate. Do not rely solely on this data to plan your route.</span>
        </footer>

      </div>
    </main>
  )
}
