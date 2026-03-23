'use client'

// Shared error card used by error.tsx, not-found.tsx, global-error.tsx.
// Caller fills in the headline, body, and optional service badge.
// The background is a static dark teal — no animated canvas to keep this
// dependency-free and safe to use in error boundaries.

interface ErrorCardProps {
  service?: string          // e.g. "ANTHROPIC" | "WEATHER" | "OSM" — shown as a badge
  headline: string          // bold top line, amber
  body: string              // descriptive sentence(s), white/muted
  reset?: () => void        // if provided, shows a "Try again" button
  homeHref?: string         // defaults to "/"
}

const S = {
  root: {
    position: 'fixed' as const,
    inset: 0,
    background: '#011c24',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'monospace',
    padding: '1.5rem',
  },
  card: {
    background: 'rgba(255,255,255,0.06)',
    border: '3px solid #fdb618',
    borderRadius: '4px',
    padding: '2rem 2.5rem',
    maxWidth: '480px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
    textAlign: 'center' as const,
  },
  badge: {
    display: 'inline-block',
    background: '#ed1c24',
    color: '#fff',
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.15em',
    padding: '2px 8px',
    borderRadius: '2px',
    alignSelf: 'center' as const,
  },
  headline: {
    color: '#fdb618',
    fontSize: '1.1rem',
    fontWeight: 700,
    margin: 0,
  },
  body: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: '0.9rem',
    lineHeight: 1.65,
    margin: 0,
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'center',
    marginTop: '0.5rem',
  },
  btnPrimary: {
    background: '#fdb618',
    color: '#011c24',
    border: 'none',
    borderRadius: '4px',
    padding: '0.5rem 1.5rem',
    fontWeight: 700,
    fontFamily: 'monospace',
    fontSize: '0.9rem',
    cursor: 'pointer',
  },
  btnSecondary: {
    background: 'transparent',
    color: '#fdb618',
    border: '2px solid #fdb618',
    borderRadius: '4px',
    padding: '0.5rem 1.5rem',
    fontWeight: 700,
    fontFamily: 'monospace',
    fontSize: '0.9rem',
    cursor: 'pointer',
  },
}

export default function ErrorCard({ service, headline, body, reset, homeHref = '/' }: ErrorCardProps) {
  return (
    <div style={S.root}>
      <div style={S.card}>
        {service && <span style={S.badge}>{service} ERROR</span>}
        <p style={S.headline}>{headline}</p>
        <p style={S.body}>{body}</p>
        <div style={S.actions}>
          {reset && (
            <button style={S.btnPrimary} onClick={reset}>Try again</button>
          )}
          <a href={homeHref} style={S.btnSecondary}>← Start over</a>
        </div>
      </div>
    </div>
  )
}
