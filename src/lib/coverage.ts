import type { RoutePoint, CoverageSegment } from './types'

// ─── FCC Coverage ─────────────────────────────────────────────────────────────
// The FCC Broadband Data Collection (BDC) API provides mobile coverage data.
// API docs: https://broadbandmap.fcc.gov/docs/api-description
//
// TODO V2: Integrate the FCC BDC availability API:
//   GET https://broadbandmap.fcc.gov/api/public/map/listAvailability
//     ?latitude={lat}&longitude={lng}&unit=1&category=Mobile+Broadband
//
// The API requires a registered account for production use.
// For now this returns a placeholder result indicating coverage is unverified.
// ─────────────────────────────────────────────────────────────────────────────

export async function enrichCoverage(
  samplePoints: RoutePoint[],
): Promise<CoverageSegment[]> {
  // Stub: mark all segments as unknown until FCC integration is complete.
  return samplePoints.map(p => ({
    distance_km: p.distance_km,
    confidence: 'unknown' as const,
  }))
}
