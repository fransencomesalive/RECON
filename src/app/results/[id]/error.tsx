'use client'

import { useEffect } from 'react'
import ErrorCard from '@/components/ErrorCard'

export default function ResultsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[RECON] results error:', error) }, [error])

  // Surface a service name if one is embedded in the error message
  const msg = error.message ?? ''
  const service =
    /anthropic|claude|narrative/i.test(msg) ? 'ANTHROPIC' :
    /weather|nws/i.test(msg)                ? 'WEATHER'   :
    /osm|overpass|terrain/i.test(msg)       ? 'OSM'       :
    /lands|esri|pad-us/i.test(msg)          ? 'LANDS'     :
    /coverage|broadband|fcc/i.test(msg)     ? 'COVERAGE'  :
    /wind|meteo/i.test(msg)                 ? 'WIND'      :
    /imagery|mapillary/i.test(msg)          ? 'IMAGERY'   :
    undefined

  return (
    <ErrorCard
      service={service}
      headline="Failed to load dossier."
      body="This result couldn't be retrieved. The analysis may have expired or a service failed mid-run. Start a new analysis to try again."
      reset={reset}
    />
  )
}
