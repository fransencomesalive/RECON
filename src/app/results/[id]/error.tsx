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
      headline="Your dossier failed to load."
      body="The analysis expired or a service failed mid-run. Try analyzing again from the start."
      reset={reset}
    />
  )
}
