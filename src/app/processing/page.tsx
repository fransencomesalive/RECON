'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import styles from './processing.module.css'

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

// ─── Processing stages ────────────────────────────────────────────────────────

const STAGES = [
  'Parsing route geometry',
  'Fetching weather data',
  'Checking public lands',
  'Scanning OSM surfaces & POIs',
  'Checking cell coverage',
  'Compiling dossier',
]

// Each stage occupies a fraction of total progress
const STAGE_BREAKPOINTS = [0, 0.12, 0.28, 0.48, 0.68, 0.84, 1.0]

// ─── Route SVG path (designed to read as a real cycling route) ────────────────

const ROUTE_D = `
  M 30,230
  C 55,210 70,198 95,180
  C 120,162 114,145 138,126
  C 162,107 184,118 206,100
  C 228,82  224,60  250,46
  C 276,32  304,42  328,34
  C 352,26  370,36  394,48
  C 418,60  432,46  458,58
  C 484,70  492,98  514,108
  C 536,118 562,102 586,116
  C 610,130 616,158 636,170
  C 656,182 680,170 700,184
  C 718,196 724,220 710,238
  C 696,256 672,252 650,258
`

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProcessingPage() {
  const bgRef     = useRef<HTMLCanvasElement>(null)
  const grainRef  = useRef<HTMLCanvasElement>(null)
  const routeRef  = useRef<SVGPathElement>(null)
  const dotRef    = useRef<SVGCircleElement>(null)
  const progressPathRef = useRef<SVGPathElement>(null)

  const [stageIndex, setStageIndex] = useState(0)
  const [animDone, setAnimDone]     = useState(false) // animation finished
  const [done, setDone]             = useState(false) // API returned, navigating
  const [apiError, setApiError]     = useState<string | null>(null)
  const resultIdRef = useRef<string | null>(null)
  const router = useRouter()

  // ── Call /api/analyze in the background ─────────────────────────────────────
  useEffect(() => {
    const fileData  = sessionStorage.getItem('recon_file_data')
    const fileName  = sessionStorage.getItem('recon_file_name')
    const rideDate  = sessionStorage.getItem('recon_ride_date') ?? new Date().toISOString().split('T')[0]
    const routeUrl  = sessionStorage.getItem('recon_route_url')

    if (!fileData && !routeUrl) {
      setApiError('No route data found. Please go back and upload a file.')
      return
    }

    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_data: fileData ?? undefined, file_name: fileName ?? undefined, url: routeUrl ?? undefined, ride_date: rideDate }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) { setApiError(data.error); return }
        resultIdRef.current = data.id
        // Clean up sessionStorage
        sessionStorage.removeItem('recon_file_data')
        sessionStorage.removeItem('recon_file_name')
        sessionStorage.removeItem('recon_route_url')
      })
      .catch(err => setApiError(err.message ?? 'Analysis failed.'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // ── Route trace animation ───────────────────────────────────────────────────
  useEffect(() => {
    const path         = routeRef.current
    const progressPath = progressPathRef.current
    const dot          = dotRef.current
    if (!path || !progressPath || !dot) return

    const totalLength = path.getTotalLength()

    // Set up amber base path
    path.style.strokeDasharray  = `${totalLength}`
    path.style.strokeDashoffset = '0'

    // Set up red progress path — starts fully hidden
    progressPath.style.strokeDasharray  = `${totalLength}`
    progressPath.style.strokeDashoffset = `${totalLength}`

    const DURATION = 10000 // ms for full trace
    const start = performance.now()
    let raf: number

    const animate = (now: number) => {
      const elapsed = now - start
      const p = Math.min(elapsed / DURATION, 1)

      // Advance red line
      const drawn = totalLength * p
      progressPath.style.strokeDashoffset = `${totalLength - drawn}`

      // Move dot to current progress point
      const pt = path.getPointAtLength(drawn)
      dot.setAttribute('cx', String(pt.x))
      dot.setAttribute('cy', String(pt.y))

      // Update stage
      const si = STAGE_BREAKPOINTS.findIndex((bp, i) =>
        p >= bp && p < (STAGE_BREAKPOINTS[i + 1] ?? 2)
      )
      setStageIndex(Math.max(0, si))

      if (p < 1) {
        raf = requestAnimationFrame(animate)
      } else {
        setAnimDone(true)
        // Wait for API to finish (poll resultIdRef), then navigate
        const waitAndNavigate = () => {
          if (resultIdRef.current) {
            setDone(true)
            setTimeout(() => router.push(`/results/${resultIdRef.current!}`), 800)
          } else if (!apiError) {
            setTimeout(waitAndNavigate, 300)
          }
        }
        setTimeout(waitAndNavigate, 200)
      }
    }

    // Brief pause so amber path is visible before red starts
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(animate)
    }, 500)

    return () => { clearTimeout(timer); cancelAnimationFrame(raf) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

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
          <svg
            className={styles.routeSvg}
            viewBox="0 0 720 280"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Start marker */}
            <circle cx="30" cy="230" r="5" fill="#fdb618" opacity="0.7" />
            {/* End marker */}
            <circle cx="650" cy="258" r="5" fill="#fdb618" opacity="0.7" />

            {/* Amber base route */}
            <path
              ref={routeRef}
              d={ROUTE_D}
              stroke="#fdb618"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.45"
            />

            {/* Red progress route */}
            <path
              ref={progressPathRef}
              d={ROUTE_D}
              stroke="#ed1c24"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Moving dot at progress head */}
            <circle
              ref={dotRef}
              cx="30"
              cy="230"
              r="5"
              fill="#ed1c24"
              className={styles.dot}
            />
          </svg>

          {/* Stage label */}
          <div className={styles.stageRow}>
            <span className={styles.stageIndicator} />
            <span key={`${stageIndex}-${animDone}-${done}`} className={styles.stageLabel}>
              {done ? 'Route analysis complete' : animDone ? 'Finalizing dossier...' : STAGES[stageIndex]}
            </span>
          </div>

          {/* Stage progress dots */}
          <div className={styles.stageDots}>
            {STAGES.map((_, i) => (
              <span
                key={i}
                className={[
                  styles.stageDot,
                  animDone || i < stageIndex ? styles.stageDotDone :
                  i === stageIndex ? styles.stageDotActive : '',
                ].join(' ')}
              />
            ))}
          </div>
        </div>

      </div>
    </main>
  )
}
