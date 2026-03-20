import { v4 as uuidv4 } from 'uuid'
import { parseRouteFile } from '@/lib/parse-route'
import { storeRoute } from '@/lib/store'
import type { AnalyzeRequest } from '@/lib/types'

export const maxDuration = 30

// ─── POST /api/analyze ────────────────────────────────────────────────────────
// Parses the route file/URL → CanonicalRoute, stores it, returns { id }.
// All enrichment is handled client-side via /api/enrich/* endpoints.

export async function POST(req: Request) {
  try {
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
      fileContent = Buffer.from(file_data!, 'base64').toString('utf-8')
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
