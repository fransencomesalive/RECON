'use client'

import { useEffect, useRef } from 'react'
import Image from 'next/image'
import styles from '../processing/processing.module.css'

// ─── Mesh gradient ────────────────────────────────────────────────────────────

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

// ─── Hardcoded preview states ─────────────────────────────────────────────────

const PREVIEW_SERVICES = [
  { label: 'Parsing route file',                    status: 'done'    },
  { label: 'Mapping terrain & infrastructure',      status: 'done'    },
  { label: 'Pulling weather forecast',              status: 'loading' },
  { label: 'Querying land boundaries',              status: 'loading' },
  { label: 'Establishing mobile coverage strength', status: 'pending' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProcessingPreview() {
  const bgRef       = useRef<HTMLCanvasElement>(null)
  const grainRef    = useRef<HTMLCanvasElement>(null)
  const elevRef     = useRef<HTMLCanvasElement>(null)

  // Mesh + grain
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

  // Excitebike-style elevation scroll
  useEffect(() => {
    const canvas = elevRef.current
    if (!canvas) return

    const DPR = window.devicePixelRatio || 1
    let W = 0, H = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      W = rect.width
      H = rect.height
      canvas.width  = Math.round(W * DPR)
      canvas.height = Math.round(H * DPR)
    }
    resize()

    const ctx = canvas.getContext('2d')!

    // Layout constants (as fractions of canvas height)
    const CHART_T = 0.10  // top of elevation band
    const CHART_B = 0.90  // bottom of elevation band
    const DOT_X_F = 0.25  // dot's fixed horizontal position

    // How many data points are visible at once (controls apparent "zoom")
    const VISIBLE = ELEV_N * 0.35

    // Speed: traverse VISIBLE data points in ~9 seconds at 60fps
    const SPEED = VISIBLE / (9 * 60)

    let offset  = 0
    let pulseT  = 0
    let raf: number

    const getY = (screenX: number): number => {
      const raw = (offset + (screenX / W) * VISIBLE + ELEV_N) % ELEV_N
      const i0  = Math.floor(raw) % ELEV_N
      const i1  = (i0 + 1) % ELEV_N
      const frac = raw - Math.floor(raw)
      const v   = ELEV_DATA[i0] * (1 - frac) + ELEV_DATA[i1] * frac
      return H * CHART_B - v * H * (CHART_B - CHART_T)
    }

    const draw = () => {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const dotX = W * DOT_X_F
      const dotY = getY(dotX)

      // ── Amber ghost path (full width) ──────────────────────────────────────
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

      // ── Red path (visited — left edge to dot) ──────────────────────────────
      ctx.beginPath()
      for (let x = 0; x <= dotX; x++) {
        const y = getY(x)
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = '#ed1c24'
      ctx.globalAlpha = 1
      ctx.lineWidth   = 2.5
      ctx.stroke()

      // ── Dot glow ───────────────────────────────────────────────────────────
      pulseT += 0.06
      const pulseR = 4.5 + Math.sin(pulseT) * 2
      const grd = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, pulseR * 3)
      grd.addColorStop(0, 'rgba(237,28,36,0.55)')
      grd.addColorStop(1, 'rgba(237,28,36,0)')
      ctx.globalAlpha = 1
      ctx.fillStyle   = grd
      ctx.beginPath()
      ctx.arc(dotX, dotY, pulseR * 3, 0, Math.PI * 2)
      ctx.fill()

      // ── Dot ────────────────────────────────────────────────────────────────
      ctx.beginPath()
      ctx.arc(dotX, dotY, pulseR, 0, Math.PI * 2)
      ctx.fillStyle = '#ed1c24'
      ctx.fill()

      offset = (offset + SPEED + ELEV_N) % ELEV_N
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

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

          <div className={styles.serviceList}>
            {PREVIEW_SERVICES.map(({ label, status }) => (
              <div key={label} className={styles.serviceRow}>
                <div className={styles.serviceRowHead}>
                  <span className={[
                    styles.serviceDot,
                    status === 'loading' ? styles.serviceDotLoading :
                    status === 'done'    ? styles.serviceDotDone : '',
                  ].join(' ')} />
                  <span className={styles.serviceLabel}>{label}</span>
                </div>
                <div className={[
                  styles.serviceBar,
                  status === 'loading' ? styles.serviceBarLoading :
                  status === 'done'    ? styles.serviceBarDone : '',
                ].join(' ')} />
              </div>
            ))}
          </div>

          <div className={styles.divider} />

          {/* Narrative row — loading state */}
          <div className={styles.narrativeRow}>
            <div className={styles.serviceRowHead}>
              <span className={[styles.narrativeDot, styles.narrativeDotLoading].join(' ')} />
              <span className={styles.narrativeLabel}>Generating R.E.C.O.N.</span>
              <span className={styles.narrativeDots} aria-hidden>...</span>
            </div>
            <div className={[styles.serviceBar, styles.narrativeBarLoading].join(' ')} />
          </div>

        </div>
      </div>
    </main>
  )
}
