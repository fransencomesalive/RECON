import type { WindField } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COUNT  = 1500
const MAX_AGE         = 120   // frames (~2s at 60fps)
const TRAIL_LENGTH    = 8     // positions retained per particle
// Converts m/s to degrees/frame. Tuned so 10 m/s ≈ 1.2px/frame at zoom 10.
const SPEED_SCALE     = 0.00012

// ─── Types ────────────────────────────────────────────────────────────────────

interface Particle {
  lng:   number
  lat:   number
  age:   number
  trail: [number, number][]  // [lng, lat] history, oldest first
}

// ─── Bilinear interpolation ───────────────────────────────────────────────────

function interpolateWind(
  field: WindField,
  lng: number,
  lat: number,
  hour: number,
): [number, number] {
  const { grid, grid_cols, grid_rows, bbox } = field
  const [minLng, minLat, maxLng, maxLat] = bbox

  // Normalised position within grid (clamped to [0,1])
  const tx = Math.max(0, Math.min(1, (lng - minLng) / (maxLng - minLng))) * (grid_cols - 1)
  const ty = Math.max(0, Math.min(1, (lat - minLat) / (maxLat - minLat))) * (grid_rows - 1)

  const c0 = Math.floor(tx), c1 = Math.min(c0 + 1, grid_cols - 1)
  const r0 = Math.floor(ty), r1 = Math.min(r0 + 1, grid_rows - 1)
  const fx = tx - c0, fy = ty - r0

  const idx = (r: number, c: number) => r * grid_cols + c
  const u = (r: number, c: number) => grid[idx(r, c)]?.hourly_u[hour] ?? 0
  const v = (r: number, c: number) => grid[idx(r, c)]?.hourly_v[hour] ?? 0

  // Bilinear blend
  const bu = (1 - fx) * (1 - fy) * u(r0, c0) + fx * (1 - fy) * u(r0, c1)
           + (1 - fx) *      fy  * u(r1, c0) + fx *      fy  * u(r1, c1)
  const bv = (1 - fx) * (1 - fy) * v(r0, c0) + fx * (1 - fy) * v(r0, c1)
           + (1 - fx) *      fy  * v(r1, c0) + fx *      fy  * v(r1, c1)

  return [bu, bv]
}

// ─── Particle system ──────────────────────────────────────────────────────────

export class WindParticleSystem {
  private field:     WindField
  private particles: Particle[]
  private hour:      number = 9

  constructor(field: WindField) {
    this.field = field
    this.particles = Array.from({ length: PARTICLE_COUNT }, () =>
      this.spawn(this.field.bbox, Math.floor(Math.random() * MAX_AGE))
    )
  }

  setHour(hour: number): void {
    this.hour = Math.max(0, Math.min(23, Math.floor(hour)))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tick(map: any): void {
    const zoom = map.getZoom() as number
    const zoomFactor = Math.pow(2, zoom - 10)
    const bounds = map.getBounds()
    const viewBbox: [number, number, number, number] = [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ]

    for (const p of this.particles) {
      // Push current position into trail
      p.trail.push([p.lng, p.lat])
      if (p.trail.length > TRAIL_LENGTH) p.trail.shift()

      // Advance position
      const [u, v] = interpolateWind(this.field, p.lng, p.lat, this.hour)
      const latRad  = p.lat * Math.PI / 180
      const scale   = SPEED_SCALE * zoomFactor
      p.lng += u * scale / Math.max(Math.cos(latRad), 0.01)
      p.lat += v * scale
      p.age++

      // Respawn if aged out or drifted out of viewport
      if (
        p.age >= MAX_AGE ||
        p.lng < viewBbox[0] || p.lng > viewBbox[2] ||
        p.lat < viewBbox[1] || p.lat > viewBbox[3]
      ) {
        const fresh = this.spawn(viewBbox, 0)
        p.lng = fresh.lng; p.lat = fresh.lat; p.age = 0; p.trail = []
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(ctx: CanvasRenderingContext2D, map: any): void {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

    for (const p of this.particles) {
      const trailFull = [...p.trail, [p.lng, p.lat]] as [number, number][]
      if (trailFull.length < 2) continue

      // Speed at current position determines base opacity
      const [u, v] = interpolateWind(this.field, p.lng, p.lat, this.hour)
      const speed = Math.sqrt(u * u + v * v)
      const baseAlpha = Math.min(Math.max(speed / 12, 0.06), 0.65)

      ctx.lineWidth = 1.2
      ctx.lineCap   = 'round'
      ctx.lineJoin  = 'round'

      // Draw each trail segment with fading alpha
      for (let i = 1; i < trailFull.length; i++) {
        const segFrac   = i / (trailFull.length - 1)
        const ageFrac   = 1 - p.age / MAX_AGE
        ctx.globalAlpha = segFrac * baseAlpha * ageFrac

        const [aLng, aLat] = trailFull[i - 1]
        const [bLng, bLat] = trailFull[i]

        const a = map.project([aLng, aLat])
        const b = map.project([bLng, bLat])

        ctx.strokeStyle = '#ffffff'
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    ctx.globalAlpha = 1
  }

  private spawn(
    bbox: [number, number, number, number],
    age: number,
  ): Particle {
    const [minLng, minLat, maxLng, maxLat] = bbox
    return {
      lng:   minLng + Math.random() * (maxLng - minLng),
      lat:   minLat + Math.random() * (maxLat - minLat),
      age,
      trail: [],
    }
  }

  destroy(): void {
    this.particles = []
  }
}
