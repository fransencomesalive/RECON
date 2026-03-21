import { getRoute } from '@/lib/store'
import { enrichMapillaryImagery } from '@/lib/mapillary'

export const maxDuration = 30

export async function POST(req: Request) {
  try {
    const { id } = await req.json()
    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const imagery = await enrichMapillaryImagery(route)
    return Response.json(imagery)
  } catch (err) {
    console.error('[enrich/imagery]', err)
    return Response.json(
      { error: (err as Error).message ?? 'Imagery enrichment failed.' },
      { status: 500 },
    )
  }
}
