'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import styles from './page.module.css'

// ─── Mesh gradient ───────────────────────────────────────────────────────────

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
  return MESH_DEFS.map((def) => ({
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

// ─── URL detection ────────────────────────────────────────────────────────────


// ─── URL validation ───────────────────────────────────────────────────────────

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ─── Data sources for footer ──────────────────────────────────────────────────

const DATA_SOURCES = [
  { label: 'OpenStreetMap', url: 'https://wiki.openstreetmap.org/wiki/Overpass_API' },
  { label: 'NWS Weather', url: 'https://www.weather.gov/documentation/services-web-api' },
  { label: 'PAD-US Public Lands', url: 'https://data.usgs.gov/datacatalog/data/USGS:652ef930d34edd15305a9b03' },
  { label: 'FCC Coverage', url: 'https://broadbandmap.fcc.gov/' },
  { label: 'Mapillary', url: 'https://www.mapillary.com/developer/api-documentation' },
  { label: 'Trailforks', url: 'https://www.trailforks.com/about/api/' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReconPage() {
  const bgRef     = useRef<HTMLCanvasElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const orientRef = useRef<{ x: number; y: number } | null>(null)
  const calibRef  = useRef<{ beta: number; gamma: number } | null>(null)
  const [showOrientBtn, setShowOrientBtn] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [fileError, setFileError]       = useState<string | null>(null)
  const [isDragging, setIsDragging]     = useState(false)

  const [url, setUrl] = useState('')

  const tomorrowISO = new Date(Date.now() + 86400000).toISOString().split('T')[0]
  const [rideDate, setRideDate]       = useState(tomorrowISO)
  const [dateWarning, setDateWarning] = useState(false)

  const router = useRouter()

  // ── Orientation (mobile) ──────────────────────────────────────────────────

  useEffect(() => {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (!isTouch) return
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function'
    ) {
      setShowOrientBtn(true)
    } else if (typeof DeviceOrientationEvent !== 'undefined') {
      window.addEventListener('deviceorientation', onOrientation)
    }
    return () => window.removeEventListener('deviceorientation', onOrientation)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onOrientation(e: DeviceOrientationEvent) {
    const gamma = e.gamma ?? 0, beta = e.beta ?? 0
    if (!calibRef.current) calibRef.current = { beta, gamma }
    orientRef.current = {
      x: Math.max(-1, Math.min(1, (gamma - calibRef.current.gamma) / 45)),
      y: Math.max(-1, Math.min(1, (beta  - calibRef.current.beta)  / 45)),
    }
    setShowOrientBtn(false)
  }

  async function requestOrientationPermission() {
    try {
      const req = (DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission
      if ((await req()) === 'granted') window.addEventListener('deviceorientation', onOrientation)
    } catch { /* denied */ }
    setShowOrientBtn(false)
  }

  // ── Canvas animation ──────────────────────────────────────────────────────

  useEffect(() => {
    const bg = bgRef.current, canvas = canvasRef.current
    if (!bg || !canvas) return

    const bgCtx = bg.getContext('2d')!, ctx = canvas.getContext('2d')!
    let W = window.innerWidth, H = window.innerHeight
    const DPR = window.devicePixelRatio || 1
    let PW = 0, PH = 0, imgData = ctx.createImageData(1, 1), grainCount = 0
    const meshNodes = initMeshNodes()

    const resize = () => {
      W = window.innerWidth; H = window.innerHeight
      PW = Math.floor(W * DPR); PH = Math.floor(H * DPR)
      bg.width = W; bg.height = H
      canvas.width = PW; canvas.height = PH
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
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
        const data = imgData.data
        data.fill(0)
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

  // ── File handling ─────────────────────────────────────────────────────────

  const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15 MB — covers high-density 400-mile ultra recordings

  const validateFile = (file: File): boolean => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['gpx', 'tcx'].includes(ext ?? '')) {
      setFileError("We're only taking .gpx or .tcx files at the moment. What you uploaded is not one of those (or corrupted).")
      setSelectedFile(null)
      return false
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError('What are you doing, riding 1000 miles?! File sizes are limited to 15MB.')
      setSelectedFile(null)
      return false
    }
    setFileError(null)
    setSelectedFile(file)
    setUrl('')
    return true
  }

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }, [])
  const handleDragLeave = useCallback(() => setIsDragging(false), [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) validateFile(file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) validateFile(file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── URL handling ──────────────────────────────────────────────────────────

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setUrl(val)
    if (val) { setSelectedFile(null); setFileError(null) }
  }, [])

  // ── Submit ────────────────────────────────────────────────────────────────

  const canSubmit = (selectedFile !== null && !fileError) ||
                    (url !== '' && isValidUrl(url))

  const handleDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setRideDate(val)
    if (val) {
      const diffDays = (new Date(val).getTime() - Date.now()) / 86400000
      setDateWarning(diffDays > 10)
    } else {
      setDateWarning(false)
    }
  }, [])

  const handleSubmit = async () => {
    if (!canSubmit) return

    if (selectedFile) {
      // Encode file as base64 — chunked to avoid call stack overflow on large files
      const buffer = await selectedFile.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const CHUNK = 8192
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const base64 = btoa(binary)
      sessionStorage.setItem('recon_file_data', base64)
      sessionStorage.setItem('recon_file_name', selectedFile.name)
      sessionStorage.removeItem('recon_route_url')
    } else if (url) {
      sessionStorage.setItem('recon_route_url', url)
      sessionStorage.removeItem('recon_file_data')
      sessionStorage.removeItem('recon_file_name')
    }

    sessionStorage.setItem('recon_ride_date', rideDate)
    router.push('/processing')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className={styles.root}>
      <canvas ref={bgRef}     className={styles.bgCanvas} />
      <canvas ref={canvasRef} className={styles.grainCanvas} />

      <div className={styles.layout}>

        {/* Logo lockup */}
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

        {/* Intake */}
        <section className={styles.intake}>

          {/* File drop */}
          <div
            className={[
              styles.card,
              isDragging  ? styles.cardDragging : '',
              fileError   ? styles.cardError    : '',
              selectedFile && !fileError ? styles.cardFilled : '',
            ].join(' ')}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".gpx,.tcx"
              className={styles.hidden}
              onChange={handleFileInput}
            />
            {selectedFile ? (
              <span className={styles.fileName}>{selectedFile.name}</span>
            ) : (
              <>
                <span className={styles.cardLabel}>Drop route file here</span>
                <span className={styles.cardSub}>GPX · TCX</span>
              </>
            )}
            {fileError && <span className={styles.errorMsg}>{fileError}</span>}
          </div>

          <div className={styles.divider}><span>or</span></div>

          {/* URL paste */}
          <div
            className={[
              styles.card,
              styles.cardUrl,
              url && !isValidUrl(url) ? styles.cardError  : '',
              url &&  isValidUrl(url) ? styles.cardFilled : '',
            ].join(' ')}
          >
            <input
              type="text"
              className={styles.urlInput}
              placeholder="Paste a direct link to a GPX or TCX file"
              value={url}
              onChange={handleUrlChange}
              onClick={(e) => e.stopPropagation()}
            />
            {url && !isValidUrl(url) && (
              <span className={styles.errorMsg}>{"Something's up with your URL. Double check it."}</span>
            )}
            <span className={styles.comingSoon}>Strava · MapMyRide import coming in V2</span>
          </div>

          <div className={styles.dividerPlain} />

          {/* Date input */}
          <div className={styles.dateCard}>
            <label className={styles.dateLabel} htmlFor="ride-date">Ride Date</label>
            <input
              id="ride-date"
              type="date"
              className={styles.dateInput}
              value={rideDate}
              onChange={handleDateChange}
              onClick={(e) => e.stopPropagation()}
            />
            {dateWarning && (
              <span className={styles.dateWarning}>
                {"We're forecasting, not predicting far into the future. 10 days from now is as far as we can check for ya."}
              </span>
            )}
          </div>

          <button
            className={styles.cta}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            Analyze Route
          </button>

        </section>

        {/* Footer */}
        <footer className={styles.footer}>
          <div className={styles.footerTop}>
            <span className={styles.version}>v1.1</span>
            <span className={styles.disclaimer}>
              Beta product — results may be inaccurate. Do not rely solely on this data to plan your route.
            </span>
          </div>
          <div className={styles.sources}>
            <span className={styles.sourcesLabel}>Data sources:</span>
            {DATA_SOURCES.map((s) => (
              <a key={s.label} href={s.url} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
                {s.label}
              </a>
            ))}
          </div>
        </footer>

      </div>

      {showOrientBtn && (
        <button className={styles.orientBtn} onClick={requestOrientationPermission}>
          Hold naturally · tap to enable tilt
        </button>
      )}
    </main>
  )
}
