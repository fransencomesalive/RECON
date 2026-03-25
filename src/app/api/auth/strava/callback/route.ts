import { NextResponse, type NextRequest } from 'next/server'

// GET /api/auth/strava/callback
// Exchanges the Strava auth code for an access token, sets two cookies:
//   strava_token    — httpOnly, used server-side by /api/analyze
//   strava_connected — readable by client JS to show "connected" UI
// Required env vars: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, NEXT_PUBLIC_BASE_URL

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code  = searchParams.get('code')
  const error = searchParams.get('error')

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? (() => {
    const host = req.headers.get('host') ?? 'localhost:3001'
    return host.startsWith('localhost') ? `http://${host}` : `https://${host}`
  })()

  if (error || !code) {
    return Response.redirect(`${baseUrl}/?strava_error=access_denied`)
  }

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    }),
  })

  let data: { access_token?: string; expires_in?: number }
  try {
    data = await tokenRes.json()
  } catch {
    return Response.redirect(`${baseUrl}/?strava_error=token_exchange`)
  }

  if (!tokenRes.ok || !data.access_token) {
    return Response.redirect(`${baseUrl}/?strava_error=token_exchange`)
  }

  const maxAge = data.expires_in ?? 21600 // Strava tokens live ~6 hours
  const secure = !baseUrl.startsWith('http://localhost')

  const res = NextResponse.redirect(`${baseUrl}/?strava=connected`)
  res.cookies.set('strava_token', data.access_token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge, secure })
  res.cookies.set('strava_connected', '1', { path: '/', sameSite: 'lax', maxAge, secure })
  return res
}
