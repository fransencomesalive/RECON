'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import styles from './processing.module.css'
import type {
  OsmEnrichResult,
  WeatherResult,
  LandCrossing,
  CoverageSegment,
} from '@/lib/types'

// ─── Mesh gradient (shared with intake) ──────────────────────────────────────

type MeshDef = { hex: string; rMin: number; rMax: number; a0: string }
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
type MeshNode = { x: number; y: number; vx: number; vy: number; hex: string; a0: string; r: number }
function initMeshNodes(): MeshNode[] {
  return MESH_DEFS.map(def => ({
    x: Math.random(), y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00025,
    vy: (Math.random() - 0.5) * 0.00025,
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

// ─── Tileable elevation data ──────────────────────────────────────────────────
// Integer sine multiples guarantee seamless looping (all waves complete at N)

const ELEV_N = 2000
const ELEV_DATA = (() => {
  const data = new Float32Array(ELEV_N)
  let min = Infinity, max = -Infinity
  for (let i = 0; i < ELEV_N; i++) {
    const t = (i / ELEV_N) * Math.PI * 2
    data[i] =
      Math.sin(t * 3)  * 0.40 +
      Math.sin(t * 7)  * 0.22 +
      Math.sin(t * 13) * 0.13 +
      Math.sin(t * 23) * 0.07 +
      Math.sin(t * 41) * 0.03
    if (data[i] < min) min = data[i]
    if (data[i] > max) max = data[i]
  }
  const range = max - min
  for (let i = 0; i < ELEV_N; i++) data[i] = (data[i] - min) / range
  return data
})()

// ─── Service definitions ──────────────────────────────────────────────────────

type ServiceKey = 'parse' | 'osm' | 'weather' | 'lands' | 'coverage'
type ServiceStatus = 'pending' | 'loading' | 'done' | 'error'
type NarrativeStatus = 'hidden' | 'pending' | 'loading' | 'done' | 'error'

const SERVICES: { key: ServiceKey; label: string }[] = [
  { key: 'parse',    label: 'Parsing route file' },
  { key: 'osm',      label: 'Mapping terrain & infrastructure' },
  { key: 'weather',  label: 'Pulling weather forecast' },
  { key: 'lands',    label: 'Querying land boundaries' },
  { key: 'coverage', label: 'Establishing mobile coverage strength' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProcessingPage() {
  const bgRef    = useRef<HTMLCanvasElement>(null)
  const grainRef = useRef<HTMLCanvasElement>(null)
  const elevRef  = useRef<HTMLCanvasElement>(null)

  const [analyzeId, setAnalyzeId]         = useState<string | null>(null)
  const [services, setServices]           = useState<Record<ServiceKey, ServiceStatus>>({
    parse: 'loading', osm: 'pending', weather: 'pending', lands: 'pending', coverage: 'pending',
  })
  const [narrativeStatus, setNarrativeStatus] = useState<NarrativeStatus>('hidden')
  const [apiError, setApiError]           = useState<string | null>(null)

  // Enrichment data stored in refs — only needed at finalize time
  const osmRef      = useRef<OsmEnrichResult | null>(null)
  const weatherRef  = useRef<WeatherResult | null>(null)
  const landsRef    = useRef<LandCrossing[] | null>(null)
  const coverageRef = useRef<CoverageSegment[] | null>(null)
  const narrativeRef = useRef<string>('')
  const errorsRef   = useRef<Record<string, string>>({})

  const router = useRouter()

  // ── Step 1: parse route ─────────────────────────────────────────────────────
  useEffect(() => {
    const fileData = sessionStorage.getItem('recon_file_data')
    const fileName = sessionStorage.getItem('recon_file_name')
    const rideDate = sessionStorage.getItem('recon_ride_date') ?? new Date().toISOString().split('T')[0]
    const routeUrl = sessionStorage.getItem('recon_route_url')

    if (!fileData && !routeUrl) {
      setApiError('No route data found. Please go back and upload a file.')
      return
    }

    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_data: fileData ?? undefined,
        file_name: fileName ?? undefined,
        url: routeUrl ?? undefined,
        ride_date: rideDate,
      }),
    })
      .then(async r => {
        const text = await r.text()
        let data: { id?: string; error?: string }
        try { data = JSON.parse(text) }
        catch {
          throw new Error(r.status === 504 || r.status === 502
            ? 'Analysis timed out. Try a shorter route or try again.'
            : `Server error (${r.status}). Please try again.`)
        }
        if (data.error) { setApiError(data.error); return }
        sessionStorage.removeItem('recon_file_data')
        sessionStorage.removeItem('recon_file_name')
        sessionStorage.removeItem('recon_route_url')
        setServices(s => ({ ...s, parse: 'done' }))
        setAnalyzeId(data.id!)
      })
      .catch(err => setApiError(err.message ?? 'Analysis failed.'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Step 2: fire enrichments when id is ready ───────────────────────────────
  useEffect(() => {
    if (!analyzeId) return

    let cancelled = false

    const post = async (path: string, body: object) => {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const text = await r.text()
      try { return JSON.parse(text) }
      catch { throw new Error(r.status === 504 || r.status === 502 ? 'Request timed out' : `Server error (${r.status})`) }
    }

    const setStatus = (key: ServiceKey, status: ServiceStatus) =>
      setServices(s => ({ ...s, [key]: status }))

    const run = async () => {
      setServices(s => ({ ...s, osm: 'loading', weather: 'loading', lands: 'loading', coverage: 'loading' }))

      // Fire OSM, weather, lands, coverage in parallel; track each individually
      const osmP = post('/api/enrich/osm', { id: analyzeId })
        .then(data => {
          if (cancelled) return
          if (data.error) { errorsRef.current.osm = data.error; setStatus('osm', 'error') }
          else { osmRef.current = data; setStatus('osm', 'done') }
        })
        .catch(e => { if (!cancelled) { errorsRef.current.osm = e.message; setStatus('osm', 'error') } })

      const weatherP = post('/api/enrich/weather', { id: analyzeId })
        .then(data => {
          if (cancelled) return
          if (data.error) { errorsRef.current.weather = data.error; setStatus('weather', 'error') }
          else { weatherRef.current = data; setStatus('weather', 'done') }
        })
        .catch(e => { if (!cancelled) { errorsRef.current.weather = e.message; setStatus('weather', 'error') } })

      const landsP = post('/api/enrich/lands', { id: analyzeId })
        .then(data => {
          if (cancelled) return
          if (data.error) { errorsRef.current.lands = data.error; setStatus('lands', 'error') }
          else { landsRef.current = data; setStatus('lands', 'done') }
        })
        .catch(e => { if (!cancelled) { errorsRef.current.lands = e.message; setStatus('lands', 'error') } })

      const coverageP = post('/api/enrich/coverage', { id: analyzeId })
        .then(data => {
          if (cancelled) return
          if (data.error) { errorsRef.current.coverage = data.error; setStatus('coverage', 'error') }
          else { coverageRef.current = data; setStatus('coverage', 'done') }
        })
        .catch(e => { if (!cancelled) { errorsRef.current.coverage = e.message; setStatus('coverage', 'error') } })

      // Narrative waits for OSM + weather + lands
      await Promise.allSettled([osmP, weatherP, landsP])
      if (cancelled) return

      setNarrativeStatus('loading')
      const defaultWeather: WeatherResult = {
        segments: [], alerts: [], provider: 'nws', reference_speed_kph: 25.75, ride_start_hour: 9,
      }
      await post('/api/enrich/narrative', {
        id: analyzeId,
        surfaces:     osmRef.current?.surfaces     ?? [],
        pois:         osmRef.current?.pois         ?? [],
        supply_gaps:  osmRef.current?.supply_gaps  ?? [],
        weather:      weatherRef.current           ?? defaultWeather,
        lands:        landsRef.current             ?? [],
      })
        .then(data => {
          if (cancelled) return
          if (data.error) { errorsRef.current.narrative = data.error; setNarrativeStatus('error') }
          else { narrativeRef.current = data.narrative ?? ''; setNarrativeStatus('done') }
        })
        .catch(e => { if (!cancelled) { errorsRef.current.narrative = e.message; setNarrativeStatus('error') } })

      // Wait for coverage before finalizing
      await coverageP
      if (cancelled) return

      // Finalize
      const defaultOsm: OsmEnrichResult = { surfaces: [], surface_segments: [], pois: [], supply_gaps: [], bailouts: [] }
      post('/api/results/finalize', {
        id: analyzeId,
        osm:       osmRef.current      ?? defaultOsm,
        weather:   weatherRef.current  ?? defaultWeather,
        lands:     landsRef.current    ?? [],
        coverage:  coverageRef.current ?? [],
        imagery:   [],
        narrative: narrativeRef.current,
        errors:    errorsRef.current,
      })
        .then(data => {
          if (cancelled) return
          if (data.error) { setApiError(data.error); return }
          router.push(`/results/${data.id}`)
        })
        .catch(e => { if (!cancelled) setApiError(e.message ?? 'Failed to save result.') })
    }

    run().catch(e => { if (!cancelled) setApiError((e as Error).message) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeId])

  // ── Mesh gradient ───────────────────────────────────────────────────────────
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

  // ── Excitebike elevation scroll ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = elevRef.current
    if (!canvas) return

    const DPR = window.devicePixelRatio || 1
    let W = 0, H = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      W = rect.width; H = rect.height
      canvas.width  = Math.round(W * DPR)
      canvas.height = Math.round(H * DPR)
    }
    resize()

    const ctx = canvas.getContext('2d')!
    const CHART_T = 0.10
    const CHART_B = 0.90
    const DOT_X_F = 0.25
    const VISIBLE  = ELEV_N * 0.35
    const SPEED    = VISIBLE / (9 * 60)

    let offset = 0, pulseT = 0
    let raf: number

    const getY = (screenX: number): number => {
      const raw  = (offset + (screenX / W) * VISIBLE + ELEV_N) % ELEV_N
      const i0   = Math.floor(raw) % ELEV_N
      const i1   = (i0 + 1) % ELEV_N
      const frac = raw - Math.floor(raw)
      const v    = ELEV_DATA[i0] * (1 - frac) + ELEV_DATA[i1] * frac
      return H * CHART_B - v * H * (CHART_B - CHART_T)
    }

    const draw = () => {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const dotX = W * DOT_X_F
      const dotY = getY(dotX)

      // Amber ghost path (full width)
      ctx.beginPath()
      for (let x = 0; x <= W; x++) {
        const y = getY(x)
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = '#fdb618'
      ctx.globalAlpha = 0.4
      ctx.lineWidth   = 2.5
      ctx.lineJoin    = 'round'
      ctx.lineCap     = 'round'
      ctx.stroke()

      // Red path (visited — left edge to dot)
      ctx.beginPath()
      for (let x = 0; x <= dotX; x++) {
        const y = getY(x)
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = '#ed1c24'
      ctx.globalAlpha = 1
      ctx.lineWidth   = 2.5
      ctx.stroke()

      // Dot glow
      pulseT += 0.06
      const pulseR = 4.5 + Math.sin(pulseT) * 2
      const grd = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, pulseR * 3)
      grd.addColorStop(0, 'rgba(237,28,36,0.55)')
      grd.addColorStop(1, 'rgba(237,28,36,0)')
      ctx.fillStyle = grd
      ctx.beginPath()
      ctx.arc(dotX, dotY, pulseR * 3, 0, Math.PI * 2)
      ctx.fill()

      // Dot
      ctx.beginPath()
      ctx.arc(dotX, dotY, pulseR, 0, Math.PI * 2)
      ctx.fillStyle = '#ed1c24'
      ctx.globalAlpha = 1
      ctx.fill()

      offset = (offset + SPEED + ELEV_N) % ELEV_N
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Error UI ────────────────────────────────────────────────────────────────
  if (apiError) {
    const isStravaError = apiError === 'STRAVA_AUTH_REQUIRED'
    return (
      <main className={styles.root}>
        <canvas ref={bgRef}    className={styles.bgCanvas} />
        <canvas ref={grainRef} className={styles.grainCanvas} />
        <div className={styles.layout}>
          <div className={styles.card}>
            {isStravaError ? (
              <>
                <p style={{ color: '#ed1c24', fontFamily: 'monospace', textAlign: 'center', padding: '1rem 1rem 0' }}>
                  Strava requires login to access this route.
                </p>
                <p style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'monospace', fontSize: '0.85rem', textAlign: 'center', padding: '0.5rem 1rem 1rem', lineHeight: 1.6 }}>
                  Export a <strong>.gpx</strong> file from Strava and upload it directly:<br />
                  Strava → Your Route → <strong>⋯ → Export GPX</strong>
                </p>
              </>
            ) : (
              <p style={{ color: '#ed1c24', fontFamily: 'monospace', textAlign: 'center', padding: '1rem' }}>
                {apiError}
              </p>
            )}
            <button
              onClick={() => router.push('/')}
              style={{ marginTop: '0.5rem', background: '#fdb618', border: 'none', borderRadius: '4px', padding: '0.5rem 1.5rem', fontWeight: 700, cursor: 'pointer', display: 'block', margin: '0 auto 1rem' }}
            >
              ← Back
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.root}>
      <canvas ref={bgRef}    className={styles.bgCanvas} />
      <canvas ref={grainRef} className={styles.grainCanvas} />

      <div className={styles.layout}>

        <header className={styles.header}>
          <Image
            src="/RECON-logo-topo.png"
            alt="R.E.C.O.N."
            width={320}
            height={120}
            priority
            className={styles.logoImg}
          />
        </header>

        <div className={styles.card}>
          {/* Excitebike elevation scroll */}
          <canvas
            ref={elevRef}
            className={styles.routeSvg}
            style={{ aspectRatio: '720 / 280' }}
          />

          <div className={styles.divider} />

          {/* Service status rows */}
          <div className={styles.serviceList}>
            {SERVICES.map(({ key, label }) => {
              const status = services[key]
              return (
                <div key={key} className={styles.serviceRow}>
                  <div className={styles.serviceRowHead}>
                    <span className={[
                      styles.serviceDot,
                      status === 'loading' ? styles.serviceDotLoading :
                      status === 'done'    ? styles.serviceDotDone :
                      status === 'error'   ? styles.serviceDotError : '',
                    ].join(' ')} />
                    <span className={styles.serviceLabel}>
                      {label}
                    </span>
                  </div>
                  <div className={[
                    styles.serviceBar,
                    status === 'loading' ? styles.serviceBarLoading :
                    status === 'done'    ? styles.serviceBarDone :
                    status === 'error'   ? styles.serviceBarError : '',
                  ].join(' ')} />
                </div>
              )
            })}
          </div>

          {/* Narrative row — appears when deps complete */}
          {narrativeStatus !== 'hidden' && (
            <>
              <div className={styles.divider} />
              <div className={styles.narrativeRow}>
                <div className={styles.serviceRowHead}>
                  <span className={[
                    styles.narrativeDot,
                    narrativeStatus === 'loading' ? styles.narrativeDotLoading :
                    narrativeStatus === 'done'    ? styles.narrativeDotDone :
                    narrativeStatus === 'error'   ? styles.serviceDotError : '',
                  ].join(' ')} />
                  <span className={styles.narrativeLabel}>
                    {narrativeStatus === 'done'  ? 'R.E.C.O.N. intelligence ready' :
                     narrativeStatus === 'error' ? 'Intelligence generation failed' :
                     'Generating R.E.C.O.N.'}
                  </span>
                  {narrativeStatus === 'loading' && (
                    <span className={styles.narrativeDots} aria-hidden>...</span>
                  )}
                </div>
                <div className={[
                  styles.serviceBar,
                  narrativeStatus === 'loading' ? styles.narrativeBarLoading :
                  narrativeStatus === 'done'    ? styles.narrativeBarDone :
                  narrativeStatus === 'error'   ? styles.serviceBarError :
                  styles.narrativeBarPending,
                ].join(' ')} />
              </div>
            </>
          )}
        </div>

      </div>
    </main>
  )
}
