import type { Metadata } from 'next'
import { getResult } from '@/lib/store'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await getResult(id)

  if (!result) {
    return { title: 'R.E.C.O.N.' }
  }

  const title       = `${result.route.name} on R.E.C.O.N. p/b Mettle Cycling`
  const description = `${result.route.name} p/b Mettle Cycling`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ['/RECON-shareimage-v2.png'],
    },
  }
}

export default function ResultLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
