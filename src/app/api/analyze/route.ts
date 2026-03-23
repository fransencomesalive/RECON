import { v4 as uuidv4 } from 'uuid'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { parseRouteFile } from '@/lib/parse-route'
import { storeRoute } from '@/lib/store'
import type { AnalyzeRequest } from '@/lib/types'

export const maxDuration = 30

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
      const whitelist = ['2601:280:4a85:7630:5d59:c3ca:9e3e:5398']
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
      // AbortSignal.timeout is unreliable in Vercel Node.js — use explicit controller
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let res: Response
      try {
        res = await fetch(url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res!.ok) throw new Error(`Failed to fetch route URL: ${res!.status}`)
      fileContent = await res!.text()
      const trimmed = fileContent.trimStart()
      if (trimmed.startsWith('<!') || trimmed.toLowerCase().startsWith('<html')) {
        throw new Error('STRAVA_AUTH_REQUIRED')
      }
      const pathPart = new URL(url).pathname.split('/').pop() ?? 'route.gpx'
      resolvedFileName = /\.(gpx|tcx)$/i.test(pathPart) ? pathPart : `${pathPart}.gpx`
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
