'use client'

import { useEffect } from 'react'

// global-error.tsx replaces the root layout — must include <html> and <body>.
// Cannot use ErrorCard (which imports a client component) safely here,
// so inline the same styles directly.

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[RECON] global error:', error) }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <div style={{
          position: 'fixed', inset: 0, background: '#011c24',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'monospace', padding: '1.5rem',
        }}>
          <div style={{
            background: 'rgba(255,255,255,0.06)', border: '3px solid #fdb618',
            borderRadius: '4px', padding: '2rem 2.5rem', maxWidth: '480px',
            width: '100%', textAlign: 'center',
          }}>
            <p style={{ color: '#fdb618', fontWeight: 700, fontSize: '1.1rem', margin: '0 0 1rem' }}>
              R.E.C.O.N. is temporarily offline.
            </p>
            <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 1.5rem' }}>
              A critical error occurred. Try reloading — if it persists, start over with a new route.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button
                onClick={reset}
                style={{ background: '#fdb618', color: '#011c24', border: 'none', borderRadius: '4px', padding: '0.5rem 1.5rem', fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9rem', cursor: 'pointer' }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{ background: 'transparent', color: '#fdb618', border: '2px solid #fdb618', borderRadius: '4px', padding: '0.5rem 1.5rem', fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9rem', textDecoration: 'none', display: 'inline-block', lineHeight: 1.5 }}
              >
                ← Start over
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
