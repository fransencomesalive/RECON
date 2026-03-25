import { v4 as uuidv4 } from 'uuid'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { parseRouteFile } from '@/lib/parse-route'
import { storeRoute } from '@/lib/store'
import type { AnalyzeRequest } from '@/lib/types'

export const maxDuration = 30

// ─── URL helpers ──────────────────────────────────────────────────────────────

function resolveRouteUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'ridewithgps.com') {
      const m = u.pathname.match(/^\/(routes|trips)\/(\d+)$/)
      if (m) return `https://ridewithgps.com/${m[1]}/${m[2]}.gpx`
    }
  } catch { /* ignore */ }
  return url
}


// 10 route analyses per IP per day. Only active when Upstash is configured
// (i.e. in production). Dev mode skips rate limiting.
const ratelimit = process.env.KV_REST_API_URL
  ? new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(10, '1 d') })
  : null

// ─── POST /api/analyze ────────────────────────────────────────────────────────
// Parses the route file/URL → CanonicalRoute, stores it, returns { id }.
// All enrichment is handled client-side via /api/enrich/* endpoints.

export async function POST(req: Request) {
  try {
    if (ratelimit) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1'
      const whitelist = ['76.155.104.209']
      if (!whitelist.includes(ip)) {
        const { success } = await ratelimit.limit(ip)
        if (!success) {
          return Response.json(
            { error: "To keep it free, we're limiting users to 10 routes per day.", _ip: ip },
            { status: 429 },
          )
        }
      }
    }

    const body: AnalyzeRequest = await req.json()
    const { file_data, file_name, url, ride_date } = body

    if (!file_data && !url) {
      return Response.json({ error: 'No route file provided.' }, { status: 400 })
    }

    if (!ride_date) {
      return Response.json({ error: 'Ride date is required.' }, { status: 400 })
    }

    let fileContent: string
    let resolvedFileName: string

    if (url) {
      // ── Strava route — fetch via Strava API using OAuth token from cookie ──
      const stravaRouteId = (() => {
        try {
          const u = new URL(url)
          if (u.hostname.replace(/^www\./, '') === 'strava.com') {
            return u.pathname.match(/\/routes\/(\d+)/)?.[1] ?? null
          }
        } catch { /* ignore */ }
        return null
      })()

      if (stravaRouteId) {
        const token = req.headers.get('cookie')?.match(/strava_token=([^;]+)/)?.[1]
        if (!token) {
          return Response.json({ error: 'STRAVA_NOT_CONNECTED' }, { status: 401 })
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        let gpxRes: Response
        try {
          gpxRes = await fetch(
            `https://www.strava.com/api/v3/routes/${stravaRouteId}/export_gpx`,
            { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } }
          )
        } finally {
          clearTimeout(timer)
        }
        if (gpxRes!.status === 401) {
          return Response.json({ error: 'STRAVA_TOKEN_EXPIRED' }, { status: 401 })
        }
        if (!gpxRes!.ok) throw new Error(`Failed to fetch Strava route: ${gpxRes!.status}`)
        fileContent = await gpxRes!.text()
        resolvedFileName = `strava-route-${stravaRouteId}.gpx`
      } else {
        // ── RWGPS / direct .gpx or .tcx URL ──────────────────────────────────
        const fetchUrl = resolveRouteUrl(url)
        // AbortSignal.timeout is unreliable in Vercel Node.js — use explicit controller
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        let res: Response
        try {
          res = await fetch(fetchUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; RECON/1.0; +https://recon.mettlecycling.com)',
              'Accept': 'application/gpx+xml, application/xml, text/xml, */*',
            },
          })
        } finally {
          clearTimeout(timer)
        }
        if (!res!.ok) {
          const isRwgps = fetchUrl.includes('ridewithgps.com')
          if ((res!.status === 401 || res!.status === 403) && isRwgps) {
            throw new Error('Ride with GPS requires you to be logged in to download routes. Please download the GPX from Ride with GPS and upload the file here instead.')
          }
          throw new Error(`Failed to fetch route URL: ${res!.status}`)
        }
        fileContent = await res!.text()
        const trimmed = fileContent.trimStart()
        if (trimmed.startsWith('<!') || trimmed.toLowerCase().startsWith('<html')) {
          let htmlMsg = 'Route page requires login — export as GPX and upload the file instead.'
          try {
            if (new URL(fetchUrl).hostname.includes('ridewithgps.com')) {
              htmlMsg = 'This Ride with GPS route may be private — export as GPX and upload the file instead.'
            }
          } catch { /* ignore */ }
          throw new Error(htmlMsg)
        }
        const pathPart = new URL(fetchUrl).pathname.split('/').pop() ?? 'route.gpx'
        resolvedFileName = /\.(gpx|tcx)$/i.test(pathPart) ? pathPart : `${pathPart}.gpx`
      }
    } else {
      const decoded = Buffer.from(file_data!, 'base64')
      if (decoded.byteLength > 15 * 1024 * 1024) {
        return Response.json({ error: 'File too large (max 15 MB).' }, { status: 413 })
      }
      fileContent = decoded.toString('utf-8')
      resolvedFileName = file_name!
    }

    const id = uuidv4()
    const route = await parseRouteFile(fileContent, resolvedFileName, ride_date)
    await storeRoute(id, route)

    return Response.json({ id })
  } catch (err) {
    console.error('[analyze]', err)
    return Response.json(
      { error: (err as Error).message ?? 'Analysis failed.' },
      { status: 500 },
    )
  }
}
