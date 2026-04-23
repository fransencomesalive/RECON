@AGENTS.md

# Claude instructions for RECON

## Role
You are assisting on RECON, a cycling route reconnaissance app.
Prioritize pipeline stability, API reliability, and minimal regression risk.
This is a production app with real users — changes to enrichment endpoints, data parsing, or result storage carry real risk.

## Read first
Before making meaningful changes, read:
- AGENTS.md
- docs/current-state.md
- docs/architecture.md
- docs/design-system.md
- docs/known-gotchas.md

## Working style
- Prefer small, reviewable diffs
- Identify the likely root cause before proposing fixes — do not reach for broad changes
- State a short plan before multi-file work
- Do not change timeout values, retry logic, or storage patterns without explicit discussion
- Do not modify `src/lib/types.ts` without reviewing downstream consumers

## Next.js expectations
- Next.js 16 App Router, `src/` directory convention
- Server components and route handlers are the norm — keep `'use client'` minimal
- Keep `maxDuration` exports on enrichment routes — they are required for Vercel Pro
- `export const dynamic = 'force-dynamic'` is required on `/processing` — do not remove it
- Response redirects: always use `NextResponse.redirect()` from `next/server`, never `Response.redirect()` when setting cookies

## API and enrichment rules
- Each enrichment endpoint is independent — failures must be graceful, not fatal to the pipeline
- Never use `AbortSignal.timeout()` — use explicit `setTimeout + AbortController` (Vercel doesn't fire the former reliably)
- Never use `r.json()` on Vercel gateway responses — they may be HTML 504s; use `r.text()` + try/catch `JSON.parse()`
- Overpass: queries run through Cloudflare Worker proxy first (`OVERPASS_PROXY_URL`), then public mirrors — never remove the fallback
- Strava: token is in `strava_token` httpOnly cookie; availability gated by IP whitelist

## Storage rules
- Dev: filesystem store at `.next/recon-dev-store/` — `globalThis` is NOT reliable across route handlers in dev
- Prod: Upstash Redis via `KV_REST_API_URL` / `KV_REST_API_TOKEN`
- Never read `.env.local` raw in a session — use `awk` prefix/length inspection only

## Front end standards
- Visual hierarchy must feel intentional — results page is data-dense, clarity is critical
- CSS Modules are the styling pattern — do not introduce Tailwind utility classes into component files
- Mobile layout changes go in `@media (max-width: 800px)` blocks placed AFTER the desktop rule
- Mapbox GL v3: `line-pattern` with `match` expressions does NOT work — use separate layers per type
- Weather/elevation color scale (`tempToColor`) is defined in two places — keep them in sync

## Handoff
When finishing a task:
1. Summarize what changed
2. List anything unresolved
3. Update docs/current-state.md if decisions were made or active work changed
4. Remind user to commit and push (`handoff` keyword triggers this)
