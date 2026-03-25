// GET /api/auth/strava/available
// Returns { available: boolean } — true only for whitelisted IPs.
// Used by the intake page to decide whether to show the active Connect Strava
// button or the "in testing" disabled state.

const STRAVA_WHITELIST = ['76.155.104.209', '127.0.0.1']

export async function GET(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1'
  return Response.json({ available: STRAVA_WHITELIST.includes(ip) })
}
