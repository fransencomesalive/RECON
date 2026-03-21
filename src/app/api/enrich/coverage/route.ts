import { getRoute } from '@/lib/store'
import { enrichCoverage } from '@/lib/coverage'
import type { EnrichRequest } from '@/lib/types'

export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const { id }: EnrichRequest = await req.json()
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const result = await enrichCoverage(route.sample_points)
    return Response.json(result)
  } catch (err) {
    console.error('[enrich/coverage]', err)
    return Response.json({ error: (err as Error).message ?? 'Coverage enrichment failed.' }, { status: 500 })
  }
}
