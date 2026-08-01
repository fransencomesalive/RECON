import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { enrichPublicLands } from './lands'
import type { CanonicalRoute } from './types'

const originalFetch = globalThis.fetch

function routeWithCoordinates(coordinates: number[][]): CanonicalRoute {
  return {
    id: 'test-route',
    name: 'Test route',
    source: 'gpx',
    ride_date: '2026-08-01',
    distance_km: 0,
    elevation_gain_m: 0,
    bbox: [-105.8, 39.9, -105.2, 40.1],
    sample_points: [],
    geometry: { type: 'LineString', coordinates },
  }
}

function mockPadUsFeature(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): void {
  globalThis.fetch = (async (_input, init) => {
    const body = String(init?.body)
    if (body.includes('returnIdsOnly=true')) {
      return new Response(JSON.stringify({ objectIdFieldName: 'OBJECTID', objectIds: [42] }), {
        status: 200,
      })
    }

    const featureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry,
        properties: {
          OBJECTID: 42,
          Category: 'Fee',
          Own_Type: 'STAT',
          Own_Name: 'CO',
          Mang_Type: 'STAT',
          Mang_Name: 'SPR',
          Unit_Nm: 'Test State Park',
          Pub_Access: 'OA',
          Access_Src: 'Agency source',
          Src_Date: '2025',
          GIS_Acres: 100,
        },
      }],
    }
    return new Response(JSON.stringify(featureCollection), { status: 200 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('enrichPublicLands', () => {
  it('detects a parcel crossed between two route vertices outside the parcel', async () => {
    const polygon: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [-105.6, 39.9],
        [-105.4, 39.9],
        [-105.4, 40.1],
        [-105.6, 40.1],
        [-105.6, 39.9],
      ]],
    }
    mockPadUsFeature(polygon)

    const result = await enrichPublicLands(routeWithCoordinates([
      [-105.8, 40],
      [-105.2, 40],
    ]))

    assert.equal(result.length, 3)
    assert.deepEqual(result.map(interval => interval.evidence), [
      'unverified-gap',
      'pad-us-fee',
      'unverified-gap',
    ])
    assert.deepEqual(
      {
        name: result[1].name,
        agency: result[1].agency,
        ownership: result[1].ownership,
        access: result[1].access,
        source_date: result[1].source_date,
      },
      {
        name: 'Test State Park',
        agency: 'State Parks and Recreation',
        ownership: 'state',
        access: 'open',
        source_date: '2025',
      },
    )
    assert.ok(Math.abs(result[0].exit_km - result[1].entry_km) < 1e-6)
    assert.ok(Math.abs(result[1].exit_km - result[2].entry_km) < 1e-6)
  })

  it('preserves polygon holes as unverified route intervals', async () => {
    const polygonWithHole: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-105.7, 39.9],
          [-105.3, 39.9],
          [-105.3, 40.1],
          [-105.7, 40.1],
          [-105.7, 39.9],
        ],
        [
          [-105.55, 39.95],
          [-105.55, 40.05],
          [-105.45, 40.05],
          [-105.45, 39.95],
          [-105.55, 39.95],
        ],
      ],
    }
    mockPadUsFeature(polygonWithHole)

    const result = await enrichPublicLands(routeWithCoordinates([
      [-105.8, 40],
      [-105.2, 40],
    ]))

    assert.deepEqual(result.map(interval => interval.evidence), [
      'unverified-gap',
      'pad-us-fee',
      'unverified-gap',
      'pad-us-fee',
      'unverified-gap',
    ])
    assert.equal(result.filter(interval => interval.evidence === 'pad-us-fee').length, 2)
  })
})
