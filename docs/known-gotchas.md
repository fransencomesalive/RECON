# Known Gotchas — RECON

## Vercel / serverless

- **`AbortSignal.timeout()` does not fire reliably on Vercel.** Always use explicit `setTimeout + AbortController`:
  ```ts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
  } finally { clearTimeout(timer) }
  ```

- **Vercel 504/502 responses are HTML, not JSON.** Never use `r.json()` directly on enrichment endpoint responses called from the client. Use `r.text()` + `JSON.parse()` in a try/catch.

- **`/processing` must be `force-dynamic`.** Without `export const dynamic = 'force-dynamic'`, Vercel serves it from edge cache — all enrichments fail on runs 3+.

- **`Response.redirect()` headers are immutable.** Always use `NextResponse.redirect()` from `next/server` when you need to set cookies on a redirect. `res.cookies.set()`, not `res.headers.append('Set-Cookie', ...)`.

- **`globalThis` is NOT shared across route handler bundles in dev mode.** Use filesystem storage (`src/lib/store.ts`) for dev — data writes to `.next/recon-dev-store/{key}.json`.

## Overpass / OSM

- **Cloudflare Worker must be manually redeployed.** Code changes to `cloudflare-worker/overpass-proxy.js` do NOT auto-deploy via git push. Must redeploy through the Cloudflare dashboard.

- **`maxAllowableOffset` collapses polygons.** Never use it in Esri PAD-US queries — collapses large polygons to degenerate single points.

- **`resultRecordCount` with default OBJECTID ordering misses large polygons.** Use polyline query instead.

- **`sample_points` (~5 km resolution) misses land crossings.** Must use full `route.geometry.coordinates` for point-in-polygon.

## Mapbox GL v3

- **`line-pattern` with `match` expressions does NOT work** — falls back to black. Use separate layers per feature type.

- **`['get', 'color']` on `line-color` works fine** — same pattern as surface-line layer.

- **`tempToColor` is defined in two places** — `results/[id]/page.tsx` AND `RouteMap.tsx`. If you change the color scale, update both. The map version uses `#1a7a35` for the green band (darkened from `#66bb6a` for terrain contrast).

## CSS / mobile layout

- **Mobile `@media` overrides must be placed AFTER their desktop rule** in the file. Overrides placed earlier are silently overridden by the desktop rule's cascade position.

- **Sticky sidebar on mobile.** `position: sticky` on `.dossierRight` must be explicitly disabled in a `@media` block placed after the desktop rule — not just relying on block-level default.

## Strava

- **Token lifetime ~6 hours** — no refresh token handling. Users must reconnect after expiry.

- **Strava app is in 1-athlete sandbox.** Expanded API access not yet approved. `STRAVA_WHITELIST` IP must be updated in TWO places if IP changes: `api/auth/strava/available/route.ts` and `api/auth/strava/route.ts`.

- **Strava OAuth callback must use `NextResponse.redirect()`** — sets cookies, which requires mutable headers.

## Data / API shapes

- **Esri PAD-US field name variants.** Handle: `unit_name`, `Unit_Name`, `UNIT_NM`; `Agency`, `Mang_Name`, `agbur`. Always check both cases.

- **broadbandmap.com response shape.** `{ coverage: CellRecord[], count: number }` — NOT a top-level array.

- **Open-Meteo**: free public API, no key. Wind grid: 3×3 (<20 km), 4×4 (20–80 km), 5×5 (>80 km) over expanded bbox (+0.5°).

## Environment / keys

- **One `ANTHROPIC_API_KEY` per machine** — use separate keys on Mac Studio and MacBook Air to isolate revocations. Never expose the key in conversation context — Anthropic auto-revokes exposed keys.

- **Rate limit whitelist IP.** Mac Studio is whitelisted at `76.155.104.209` (IPv4). If IP changes, update `whitelist` array in `src/app/api/analyze/route.ts`. Vercel always sees IPv4 even if `ifconfig.me` returns IPv6.

## Deferred work (not bugs, but important to know)

- **Error message redesign**: raw technical strings are the current pattern — planned redesign to plain-language, in-place messages with error ID codes. Do not add new raw strings in the meantime; they'll need to be replaced.

- **Wind particles**: deployed but untested in production. First live run may need tuning of `SPEED_SCALE`, `MAX_AGE`, opacity in `src/lib/windParticles.ts`.

- **Public lands entry/exit km**: hardcoded to full route span. V2 needs proper point-in-polygon entry/exit detection.
