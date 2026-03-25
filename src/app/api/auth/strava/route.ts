import { type NextRequest } from 'next/server'

// GET /api/auth/strava
// Redirects the user to Strava's OAuth authorization page.
// Required env vars: STRAVA_CLIENT_ID, NEXT_PUBLIC_BASE_URL

const STRAVA_WHITELIST = ['76.155.104.209', '127.0.0.1']

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1'
  if (!STRAVA_WHITELIST.includes(ip)) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://recon.mettlecycling.com'
    return Response.redirect(`${baseUrl}/?strava_error=beta_only`)
  }

  const clientId = process.env.STRAVA_CLIENT_ID
  if (!clientId) {
    return new Response('STRAVA_CLIENT_ID is not configured.', { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? (() => {
    const host = req.headers.get('host') ?? 'localhost:3001'
    return host.startsWith('localhost') ? `http://${host}` : `https://${host}`
  })()

  const params = new URLSearchParams({
    client_id:       clientId,
    redirect_uri:    `${baseUrl}/api/auth/strava/callback`,
    response_type:   'code',
    approval_prompt: 'auto',
    scope:           'read_all',
  })

  return Response.redirect(`https://www.strava.com/oauth/authorize?${params}`)
}
