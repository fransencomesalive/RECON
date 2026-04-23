# Architecture — RECON

## Pipeline overview

```
Intake (page.tsx)
  → sessionStorage
  → /processing
  → POST /api/analyze           (parse GPX/TCX → CanonicalRoute, storeRoute, returns { id })
  → browser orchestrates parallel enrichments:
      POST /api/enrich/osm      (surfaces, POIs, supply gaps, bailouts)  maxDuration=60
      POST /api/enrich/weather  (NWS segments + alerts)                  maxDuration=20
      POST /api/enrich/lands    (Esri PAD-US federal lands)              maxDuration=15
      POST /api/enrich/coverage (broadbandmap.com FCC BDC)               maxDuration=30
      POST /api/enrich/wind     (Open-Meteo U/V grid)                    maxDuration=15
      POST /api/enrich/imagery  (Mapillary bbox queries)                  maxDuration=30
  → when osm + weather + lands done:
      POST /api/enrich/narrative (Claude Sonnet 4.6)                     maxDuration=30
  → POST /api/results/finalize   (assemble + store ReconResult)          maxDuration=15
  → navigate /results/[id]
  → fetch /api/results/[id] → render dossier + Mapbox map
```

## Key files

| File | Purpose |
|---|---|
| `src/lib/types.ts` | All shared TypeScript interfaces — treat as source of truth |
| `src/lib/parse-route.ts` | GPX/TCX → CanonicalRoute (togeojson + turf) |
| `src/lib/overpass.ts` | OSM: segmented parallel queries, surfaces, POIs, bailouts |
| `src/lib/nws.ts` | NWS weather segments + alerts |
| `src/lib/lands.ts` | Esri PAD-US federal lands query |
| `src/lib/wind.ts` | Open-Meteo wind grid fetcher |
| `src/lib/windParticles.ts` | WindParticleSystem — 1500-particle canvas animation |
| `src/lib/coverage.ts` | broadbandmap.com FCC BDC API — batched, 5 concurrent |
| `src/lib/mapillary.ts` | Mapillary Graph API — bbox queries, quality-ranked |
| `src/lib/store.ts` | Upstash Redis (prod) / filesystem dev storage |
| `src/components/RouteMap.tsx` | Mapbox GL map, 7 toggleable layers + wind particle canvas |
| `src/app/page.tsx` | Intake: file upload + URL input + date |
| `src/app/processing/page.tsx` | Processing: 6-service status rows — must be `force-dynamic` |
| `src/app/results/[id]/page.tsx` | Full dossier — client component |
| `src/app/api/analyze/route.ts` | Parse-only, storeRoute, returns { id } |
| `src/app/api/enrich/*/route.ts` | Individual enrichment endpoints |
| `src/app/api/results/finalize/route.ts` | Assembles + stores ReconResult |
| `src/app/api/results/[id]/route.ts` | Result retrieval |
| `src/app/api/auth/strava/` | Strava OAuth flow (redirect, callback, available) |
| `cloudflare-worker/overpass-proxy.js` | Cloudflare Worker — parallel mirror fetching for Overpass |

## Routing
- `/` — intake (file upload or URL)
- `/processing` — live enrichment status (force-dynamic)
- `/results/[id]` — full dossier
- `/api/analyze` — parse + store
- `/api/enrich/*` — 6 enrichment services
- `/api/results/finalize` — assemble result
- `/api/results/[id]` — fetch result
- `/api/auth/strava/*` — OAuth flow

## Overpass / Cloudflare Worker
- `OVERPASS_PROXY_URL` env var → Cloudflare Worker (`https://proud-feather-8242.randall-737.workers.dev`)
- Worker fetches from multiple Overpass mirrors in parallel
- Falls back to public mirrors: `openstreetmap.fr`, `overpass-api.de`
- **Must redeploy to Cloudflare dashboard manually after code changes** — not auto-deployed via git push

## Strava OAuth
1. User pastes `strava.com/routes/ID` → Strava platform detected
2. Page fetches `/api/auth/strava/available` — returns true only for whitelisted IPs
3. Connect → `/api/auth/strava` → Strava OAuth → callback
4. Callback sets `strava_token` (httpOnly) + `strava_connected=1` cookies
5. `analyze/route.ts` reads cookie → `GET /api/v3/routes/{id}/export_gpx`
- Token lifetime ~6 hours, no refresh token handling yet
- Strava app in sandbox (1 athlete) — expanded access not yet approved

## URL import
- Ride with GPS: auto-transforms to `.gpx` URL server-side
  - Public routes: 401 from RWGPS (requires auth) → error message shown
  - Private with privacy code: `?privacy_code=HASH` carried through → works
- Strava: OAuth flow above
- Garmin / Map My Ride: removed — not supported

## Storage
- Dev: `fs.writeFileSync/readFileSync` to `.next/recon-dev-store/{key}.json`
  - `globalThis` is NOT shared across route handler bundles in dev mode
- Prod: Upstash Redis (`KV_REST_API_URL`, `KV_REST_API_TOKEN`)

## Environment variables
```
NEXT_PUBLIC_MAPBOX_TOKEN      # Map + bailout routing
ANTHROPIC_API_KEY             # Claude narrative (one key per machine)
KV_REST_API_URL               # Upstash (empty locally)
KV_REST_API_TOKEN             # Upstash (empty locally)
OVERPASS_PROXY_URL            # Cloudflare Worker URL
MAPILLARY_ACCESS_TOKEN        # Imagery
STRAVA_CLIENT_ID              # Vercel only
STRAVA_CLIENT_SECRET          # Vercel only
NEXT_PUBLIC_BASE_URL          # https://recon.mettlecycling.com (Vercel only)
```
