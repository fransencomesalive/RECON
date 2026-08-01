import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { enrichCoverage } from './coverage'
import type { RoutePoint } from './types'

const point: RoutePoint = {
  lat: 39.7392,
  lng: -104.9903,
  elevation_m: 1_609,
  distance_km: 0,
}

const originalApiKey = process.env.BROADBANDMAP_API_KEY
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.BROADBANDMAP_API_KEY
  else process.env.BROADBANDMAP_API_KEY = originalApiKey
})

describe('enrichCoverage', () => {
  it('requires a server-side API key for non-empty routes', async () => {
    delete process.env.BROADBANDMAP_API_KEY
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response()
    }) as typeof fetch

    await assert.rejects(() => enrichCoverage([point]), /BROADBANDMAP_API_KEY/)
    assert.equal(fetchCalls, 0)
  })

  it('authenticates requests and preserves per-network evidence', async () => {
    process.env.BROADBANDMAP_API_KEY = 'test-key'
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    globalThis.fetch = (async (input, init) => {
      calls.push([input, init])
      return new Response(JSON.stringify({
        coverage: [
          {
            network: 'Carrier A',
            network_slug: 'carrier-a',
            technology: '5G NR',
            rsrp_dbm: -87,
            signal_level: 'Strong',
          },
          {
            network: 'Carrier B',
            network_slug: 'carrier-b',
            technology: '4G LTE',
            rsrp_dbm: -111,
            signal_level: 'Weak',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await enrichCoverage([point])

    assert.deepEqual(result, [{
      distance_km: 0,
      confidence: 'good',
      networks: [
        {
          network: 'Carrier A',
          network_slug: 'carrier-a',
          technology: '5G NR',
          rsrp_dbm: -87,
          signal_level: 'Strong',
        },
        {
          network: 'Carrier B',
          network_slug: 'carrier-b',
          technology: '4G LTE',
          rsrp_dbm: -111,
          signal_level: 'Weak',
        },
      ],
    }])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][1]?.headers, { Authorization: 'Bearer test-key' })
  })

  it('retries a burst throttle once using Retry-After', async () => {
    process.env.BROADBANDMAP_API_KEY = 'test-key'
    const responses = [
      new Response(JSON.stringify({ error: 'Slow down', code: 'burst_rate_limit' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
      new Response(JSON.stringify({ coverage: [] }), { status: 200 }),
    ]
    let fetchCalls = 0
    globalThis.fetch = (async () => responses[fetchCalls++]) as typeof fetch

    assert.deepEqual(await enrichCoverage([point]), [{
      distance_km: 0,
      confidence: 'none',
      networks: [],
    }])
    assert.equal(fetchCalls, 2)
  })

  it('surfaces credential and quota failures instead of returning false unknown data', async () => {
    process.env.BROADBANDMAP_API_KEY = 'invalid-key'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'API key required',
      code: 'invalid_key',
    }), { status: 401 })) as typeof fetch

    await assert.rejects(
      () => enrichCoverage([point]),
      /Mobile coverage authentication or quota is unavailable/,
    )
  })

  it('reports a provider outage when every point request fails', async () => {
    process.env.BROADBANDMAP_API_KEY = 'test-key'
    globalThis.fetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch

    await assert.rejects(() => enrichCoverage([point]), /provider is unavailable/)
  })
})
