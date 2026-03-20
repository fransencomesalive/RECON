/**
 * RECON — Overpass Proxy (Cloudflare Worker)
 *
 * Deploy this as a Cloudflare Worker to proxy Overpass API requests.
 * Cloudflare IPs are NOT blocked by public Overpass mirrors, unlike AWS/Vercel IPs.
 *
 * Setup:
 *   1. Sign up free at https://dash.cloudflare.com
 *   2. Workers & Pages → Create application → Create Worker
 *   3. Paste this code → Deploy
 *   4. Copy the worker URL (e.g. https://overpass-proxy.YOUR-NAME.workers.dev)
 *   5. Add to Vercel env vars:  OVERPASS_PROXY_URL=https://overpass-proxy.YOUR-NAME.workers.dev
 *
 * The worker accepts the same POST body as a standard Overpass API call:
 *   data=<url-encoded Overpass QL query>
 */

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const body = await request.text()

    for (const mirror of MIRRORS) {
      try {
        const res = await fetch(mirror, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(25_000),
        })
        if (res.ok) {
          return new Response(res.body, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          })
        }
      } catch {
        // try next mirror
      }
    }

    return new Response(JSON.stringify({ error: 'All Overpass mirrors failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  },
}
