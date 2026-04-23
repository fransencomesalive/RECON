# Current State — RECON

## Project summary
RECON is a cycling route reconnaissance app. Users upload a GPX/TCX file or paste a route URL (Ride with GPS, Strava). The app runs parallel enrichment services (OSM terrain, weather, public lands, mobile coverage, wind, imagery) and generates a Claude-powered narrative. Results render as a dossier with a Mapbox map, elevation profile, and weather strips.

**Production**: https://recon.mettlecycling.com (also recon-beryl.vercel.app)
**Repo**: https://github.com/fransencomesalive/RECON
**Dev**: `npm run dev` (port 3000 per package.json)

## Current priorities
1. No active task — pipeline is stable as of 2026-03-25
2. Deferred: error message redesign (personality + plain language, in-place) — see docs/known-gotchas.md
3. Deferred: Strava expanded API access (currently 1-athlete sandbox)
4. Deferred: public lands entry/exit km (V2 — hardcoded to full route span currently)

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

## Active constraints
- Vercel Function CPU: Standard (1 vCPU, 2 GB) — 130-mile route peaked at 1001 MB; recommend Performance tier for 200-mile routes
- Strava OAuth: 1-athlete sandbox limit until expanded API access is approved
- Overpass: proxied through Cloudflare Worker; Cloudflare must be manually redeployed after code changes
- Rate limit: 10 analyses/day per IP; Mac Studio whitelisted at `76.155.104.209`
- `export const dynamic = 'force-dynamic'` required on `/processing` — removing it causes Vercel edge cache to serve stale RSC payload

## Architecture notes
- See docs/architecture.md for full pipeline diagram
- Intake → sessionStorage → `/processing` → POST `/api/analyze` → parallel enrichments → finalize → `/results/[id]`
- Each enrichment is independent and gracefully degradable
- Dev storage: `.next/recon-dev-store/{key}.json` (filesystem; `globalThis` unreliable in dev)
- Prod storage: Upstash Redis

## In progress
- Nothing currently active
- Dual-tool workflow infrastructure added 2026-04-23

## Latest decisions
- Decision: docs/ folder as cross-tool context layer (2026-04-23)
  - Why: Both Claude and Codex can read repo files; auto memory is tool-specific and machine-local
  - Impact: Handoffs should update docs/current-state.md before committing

- Decision: CSS Modules over Tailwind in component files
  - Why: Established pattern; Tailwind is available but not used in component-level styling
  - Impact: Do not introduce Tailwind utility classes into component files

## Known open issues
- Wind particles: built and deployed, but untested in production — first live run needed
  - Watch: particle speed (SPEED_SCALE=0.00012), MAX_AGE=120, TRAIL_LENGTH=8, canvas sizing on mobile
- `@upstash/ratelimit` TS error locally (`Cannot find module`) — pre-existing, safe to ignore, builds fine on Vercel
- Lands entry/exit km hardcoded to full route span — V2 plan documented in architecture notes
- Error messages: raw technical strings, not user-friendly — redesign deferred

## Resume here
No active task. Next best: error message redesign (plain language, in-place, personality-driven).
See docs/known-gotchas.md for the deferred error ID concept.
