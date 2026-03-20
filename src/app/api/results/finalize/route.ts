import { getRoute, storeResult } from '@/lib/store'
import type { FinalizeRequest, ReconResult } from '@/lib/types'

export const maxDuration = 15

export async function POST(req: Request) {
  try {
    const body: FinalizeRequest = await req.json()
    const { id, osm, weather, lands, coverage, imagery, narrative, errors } = body

    if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 })

    const route = await getRoute(id)
    if (!route) return Response.json({ error: 'Route not found.' }, { status: 404 })

    const result: ReconResult = {
      id,
      created_at: new Date().toISOString(),
      route,
      surfaces: osm.surfaces,
      surface_segments: osm.surface_segments,
      pois: osm.pois,
      supply_gaps: osm.supply_gaps,
      bailouts: osm.bailouts,
      weather,
      lands,
      coverage,
      imagery,
      narrative,
      errors,
    }

    await storeResult(result)
    return Response.json({ id })
  } catch (err) {
    console.error('[results/finalize]', err)
    return Response.json(
      { error: (err as Error).message ?? 'Failed to save result.' },
      { status: 500 },
    )
  }
}
