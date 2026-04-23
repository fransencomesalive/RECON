# Shared project instructions — RECON

## Read first
Before changing code, read:
- README.md
- docs/current-state.md
- docs/architecture.md
- docs/design-system.md
- docs/known-gotchas.md

## Project goals
- Keep the analysis pipeline stable and all enrichment services gracefully degradable
- Keep the results page clear and data-dense without sacrificing readability
- Keep diffs small and regression risk low — this is a production app

## Rules
- Follow existing architecture and patterns
- Do not change timeout values, retry logic, or pipeline orchestration without explicit instruction
- Do not modify `src/lib/types.ts` without reviewing all consumers
- Do not add dependencies unless clearly necessary and justified
- Preserve `maxDuration` exports on all enrichment route handlers
- Preserve `export const dynamic = 'force-dynamic'` on `/processing`
- Call out assumptions instead of silently making them

## API and storage rules
- Enrichment failures must be graceful — one service failing should not kill the pipeline
- Dev storage: filesystem (`.next/recon-dev-store/`) — `globalThis` unreliable across route handlers
- Prod storage: Upstash Redis
- Overpass: always proxy through Cloudflare Worker first, then fall back to public mirrors
- Strava: IP-whitelisted, httpOnly cookie auth — do not change the auth flow without full review

## Documentation updates
Update docs/current-state.md when:
- A task is completed
- A decision is made about architecture or data handling
- A new enrichment service or API is added
- Active deferred work changes

Update docs/known-gotchas.md when:
- A new API quirk, timeout behavior, or Vercel edge case is found
- A Mapbox GL v3 issue is encountered
- A data shape assumption turns out to be wrong

## Front end expectations
- Results page is data-dense — clarity and hierarchy matter more than visual novelty
- CSS Modules are the pattern — do not introduce inline styles or Tailwind utility classes
- Mobile layout: scoped to `@media (max-width: 800px)`, placed AFTER desktop rules in the file
- Check Mapbox layer interactions when adding new map layers

## Output format
At the end of a task:
- Summarize files changed
- Summarize risks or regressions to watch for
- Note follow-up work
