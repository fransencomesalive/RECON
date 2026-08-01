import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cumulativeRouteDistances, sliceRouteByDistance } from './route-geometry'

function assertClose(actual: number, expected: number, tolerance = 1e-4): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`)
}

describe('route distance geometry', () => {
  it('slices by traveled distance when source vertices are unevenly spaced', () => {
    const route = [[0, 0], [0.001, 0], [0.101, 0]]
    const cumulative = cumulativeRouteDistances(route)
    const totalKm = cumulative.at(-1) ?? 0

    const slice = sliceRouteByDistance(route, totalKm * 0.5, totalKm * 0.75)

    assert.equal(slice.length, 2)
    assertClose(slice[0][0], 0.0505)
    assertClose(slice[1][0], 0.07575)
  })

  it('includes interior route vertices between interpolated boundaries', () => {
    const route = [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]]
    const cumulative = cumulativeRouteDistances(route)

    const slice = sliceRouteByDistance(
      route,
      cumulative[1] * 0.5,
      cumulative[2] + (cumulative[3] - cumulative[2]) * 0.5,
    )

    assert.equal(slice.length, 4)
    assert.deepEqual(slice[1], route[1])
    assert.deepEqual(slice[2], route[2])
  })

  it('never emits an invalid one-position LineString', () => {
    const route = [[0, 0], [0.01, 0]]

    assert.deepEqual(sliceRouteByDistance(route, 0.5, 0.5), [])
    assert.deepEqual(sliceRouteByDistance(route, 100, 101), [])
    assert.deepEqual(sliceRouteByDistance([[0, 0]], 0, 1), [])
  })
})
