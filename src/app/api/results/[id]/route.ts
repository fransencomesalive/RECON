import { getResult } from '@/lib/store'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 })

  const result = await getResult(id)
  if (!result) return Response.json({ error: 'Result not found' }, { status: 404 })

  return Response.json(result)
}
