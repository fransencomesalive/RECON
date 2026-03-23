import { getRoute } from '@/lib/store'
import { enrichWeather } from '@/lib/nws'
import type { EnrichRequest } from '@/lib/types'

export const maxDuration = 20

export async function POST(req: Request) {
  try {
    const { id, date }: EnrichRequest & { date?: string } = await req.json()
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const result = await Promise.race([
      enrichWeather(route.sample_points, route.bbox, date ?? route.ride_date),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Weather timeout')), 15_000)),
    ])

    return Response.json(result)
  } catch (err) {
    console.error('[enrich/weather]', err)
    return Response.json({ error: (err as Error).message ?? 'Weather enrichment failed.' }, { status: 500 })
  }
}
