import { getRoute } from '@/lib/store'
import { enrichFromOverpass } from '@/lib/overpass'
import type { EnrichRequest } from '@/lib/types'

export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const { id }: EnrichRequest = await req.json()
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const result = await Promise.race([
      enrichFromOverpass(route),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OSM timeout')), 55_000)),
    ])

    return Response.json(result)
  } catch (err) {
    console.error('[enrich/osm]', err)
    return Response.json({ error: (err as Error).message ?? 'OSM enrichment failed.' }, { status: 500 })
  }
}
