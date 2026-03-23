'use client'

import { useEffect } from 'react'
import ErrorCard from '@/components/ErrorCard'

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[RECON] app error:', error) }, [error])

  return (
    <ErrorCard
      headline="Something went wrong."
      body="An unexpected error occurred. You can try again or start over with a new route."
      reset={reset}
    />
  )
}
