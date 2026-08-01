# Current State — RECON

## Project summary
RECON is a cycling route reconnaissance app. Users upload a GPX/TCX file or paste a route URL (Ride with GPS, Strava). The app runs parallel enrichment services (OSM terrain, weather, land access, mobile coverage, wind, imagery) and generates a Claude-powered narrative. Results render as a dossier with a Mapbox map, elevation profile, and weather strips.

**Production**: https://recon.mettlecycling.com (also recon-beryl.vercel.app)
**Repo**: https://github.com/fransencomesalive/RECON
**Dev**: `npm run dev` (port 3000 per package.json)

## Current priorities
1. **NEXT: Fix `/processing` production caching**. Production returned `x-nextjs-prerender: 1` even though the client page exports `dynamic = 'force-dynamic'`. Move the client implementation behind a server page wrapper and verify repeated normal and RSC requests do not return `PRERENDER`.
2. **Security dependency upgrades**. The 2026-08-01 npm audit reports high-severity advisories affecting Next.js 16.1.7 and `@xmldom/xmldom` 0.8.11, plus moderate direct advisories for UUID and the Anthropic SDK. Upgrade in a dedicated regression-tested change; do not use `npm audit fix --force`.
3. Add GitHub repo secrets to enable Cloudflare Worker auto-deploy. `wrangler.toml` and the workflow are committed; add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub Actions secrets.
4. Deferred: add authoritative parcel/access integrations for private-land verification. PAD-US gaps are intentionally marked unverified and must never be treated as private or public.
5. Deferred: error message redesign (personality + plain language, in-place). See docs/known-gotchas.md.
6. Deferred: Strava expanded API access (currently 1-athlete sandbox).

## Tech stack
- Framework: Next.js 16 App Router (`src/` convention)
- Styling: CSS Modules (component-level `.module.css` files)
- Language: TypeScript strict
- React: 19
- Map: Mapbox GL v3
- AI: Anthropic SDK (`claude-sonnet-4-6`)
- Storage: Upstash Redis (prod) / filesystem (dev)
- Rate limiting: `@upstash/ratelimit`
- Route parsing: `@tmcw/togeojson`, `@turf/turf`, `@xmldom/xmldom`
- Hosting: Vercel Pro (maxDuration active per endpoint)
- Analytics: `@vercel/analytics`
- Regression tests: Node test runner with `tsx`

## Active constraints
- Vercel Function CPU: Standard (1 vCPU, 2 GB) — 130-mile route peaked at 1001 MB; recommend Performance tier for 200-mile routes
- Strava OAuth: 1-athlete sandbox limit until expanded API access is approved
- Overpass: proxied through Cloudflare Worker; Cloudflare must be manually redeployed after code changes
- Rate limit: 10 analyses/day per IP; Mac Studio whitelisted at `76.155.104.209`
- `export const dynamic = 'force-dynamic'` required on `/processing` — removing it causes Vercel edge cache to serve stale RSC payload
- Broadband Map requires `BROADBANDMAP_API_KEY`; the current account permits RECON's existing use and seven-day result retention
- PAD-US is screening evidence for ownership and general public access, not proof that a route has a legal right-of-way

## Architecture notes
- See docs/architecture.md for full pipeline diagram
- Intake → sessionStorage → `/processing` → POST `/api/analyze` → parallel enrichments → finalize → `/results/[id]`
- Each enrichment is independent and gracefully degradable
- Dev storage: `.next/recon-dev-store/{key}.json` (filesystem; `globalThis` unreliable in dev)
- Prod storage: Upstash Redis

## In progress
- Coverage and land-access reliability implementation completed locally on 2026-08-01; deployment is pending

## Latest decisions
- Decision: represent land ownership, reported access, and evidence separately (2026-08-01)
  - Why: public ownership does not prove public passage, tribal land is not generic public land, and PAD-US does not cover every private parcel
  - Impact: federal, state, local, tribal, nonprofit, private protected, joint, territorial, and unknown ownership are supported; access is open, restricted, closed, unknown, or unverified

- Decision: treat every route section without a PAD-US Fee Managers match as unverified (2026-08-01)
  - Why: absence from PAD-US cannot establish either public or private ownership
  - Impact: RECON will not claim a route is clear of private land without an authoritative parcel and right-of-way check

- Decision: keep Broadband Map's all-network response and label the map as best available network (2026-08-01)
  - Why: the endpoint returns carrier, radio technology, signal level, and RSRP evidence per sample, while the current map displays the strongest reported network
  - Impact: per-network evidence remains stored for a future carrier selector; users are not told the best-network line applies to their specific carrier

- Decision: docs/ folder as cross-tool context layer (2026-04-23)
  - Why: Both Claude and Codex can read repo files; auto memory is tool-specific and machine-local
  - Impact: Handoffs should update docs/current-state.md before committing

- Decision: CSS Modules over Tailwind in component files
  - Why: Established pattern; Tailwind is available but not used in component-level styling
  - Impact: Do not introduce Tailwind utility classes into component files

## Known open issues
- Production `/processing` is being prerendered despite the source export; this remains a reliability risk until the server-wrapper fix is deployed and verified
- Dependency audit currently reports 11 advisories (7 high, 3 moderate, 1 low); the direct high-risk upgrades are Next.js and `@xmldom/xmldom`
- PAD-US does not provide nationwide private-parcel completeness or determine whether a road/trail easement permits passage; unverified route sections require local parcel and access research
- The current mobile-coverage map is best-network, not carrier-specific; per-network observations are retained but a carrier selector is deferred
- Wind particles: built and deployed, but untested in production — first live run needed
  - Watch: particle speed (SPEED_SCALE=0.00012), MAX_AGE=120, TRAIL_LENGTH=8, canvas sizing on mobile
- `@upstash/ratelimit` TS error locally (`Cannot find module`) — pre-existing, safe to ignore, builds fine on Vercel
- Error messages: raw technical strings, not user-friendly — redesign deferred

## Resume here
Deploy and verify the coverage/land-access changes, then fix `/processing` production caching. Before deployment, configure `BROADBANDMAP_API_KEY` in every target environment.
