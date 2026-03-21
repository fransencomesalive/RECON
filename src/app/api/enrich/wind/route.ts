import { getRoute } from '@/lib/store'
import { buildWindGrid } from '@/lib/wind'
import type { EnrichRequest } from '@/lib/types'

export const maxDuration = 15

export async function POST(req: Request) {
  try {
    const { id }: EnrichRequest = await req.json()
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const windField = await buildWindGrid(route.bbox, route.distance_km, route.ride_date)
    return Response.json(windField)
  } catch (err) {
    console.error('[enrich/wind]', err)
    return Response.json(
      { error: (err as Error).message ?? 'Wind enrichment failed.' },
      { status: 500 },
    )
  }
}
