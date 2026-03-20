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

const MIRROR_TIMEOUT_MS = 20_000

// Fires all mirrors in parallel and resolves with the first successful response.
function fetchFirstOk(mirrors, body) {
  return new Promise((resolve, reject) => {
    let remaining = mirrors.length
    let settled = false
    const controllers = []

    mirrors.forEach((mirror, i) => {
      const controller = new AbortController()
      controllers[i] = controller

      const timer = setTimeout(() => {
        if (settled) return
        controller.abort()
        if (--remaining === 0 && !settled) {
          settled = true
          reject(new Error('All Overpass mirrors timed out'))
        }
      }, MIRROR_TIMEOUT_MS)

      fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      }).then(res => {
        clearTimeout(timer)
        if (settled) return
        if (res.ok) {
          settled = true
          controllers.forEach((c, j) => { if (j !== i) try { c.abort() } catch {} })
          resolve(res)
        } else {
          if (--remaining === 0 && !settled) {
            settled = true
            reject(new Error('All Overpass mirrors failed'))
          }
        }
      }).catch(e => {
        clearTimeout(timer)
        if (settled || e.name === 'AbortError') return
        if (--remaining === 0 && !settled) {
          settled = true
          reject(new Error('All Overpass mirrors failed'))
        }
      })
    })
  })
}

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

    try {
      const res = await fetchFirstOk(MIRRORS, body)
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message ?? 'All Overpass mirrors failed' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      })
    }
  },
}
