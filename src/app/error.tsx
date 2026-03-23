'use client'

import { useEffect } from 'react'
import ErrorCard from '@/components/ErrorCard'

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[RECON] app error:', error) }, [error])

  return (
    <ErrorCard
      headline="Something broke and we're not sure what."
      body="Give it another try."
      reset={reset}
    />
  )
}
