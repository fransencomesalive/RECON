# Design System — RECON

## Overall direction
Data-dense, functional, outdoor-technical aesthetic.
The app processes complex route data and renders it as a dossier — clarity and hierarchy are the primary goals, not visual novelty.
Think expedition briefing, not dashboard SaaS.

## Typography
- Strong hierarchy between section titles, card labels, data values, and supporting text
- Monospace for data values where appropriate (distances, elevations, percentages)
- Body copy must be easy to scan — the results page is long and information-heavy
- Avoid competing text sizes in adjacent data cells

## Color
- CSS Modules define component-level colors — no global design token system currently
- Map layer color scales are explicitly defined and must not be changed without updating both map and profile:
  - Temperature: 9-stop °F scale defined in `tempToColor()` in `results/[id]/page.tsx` AND `RouteMap.tsx` — must stay in sync
  - Surface types: defined in overpass.ts and mapped in RouteMap.tsx
  - Coverage: good=#4caf50, fair=#fdb618, poor=#ed1c24, none=#888888
  - Public lands: public=#14532d, state=#f9a825, private=#c62828, tribal=#7b5ea7

## Layout
- Intake page: single card, centered, clean — form over visual complexity
- Processing page: 6-service status rows, vertical rhythm
- Results page: two-column dossier (map + analysis left, data right) with elevation profile below
- Mobile (≤800px): dossier stacks; Planning Summary moves above POI table (`dossierRight { order: -1 }`)

## Spacing
- Use consistent spacing within CSS Modules — avoid per-component magic numbers
- Results page has a lot of vertical sections — use consistent section spacing
- Mobile: reduce padding deliberately, do not just remove it

## Components
- Stats row: Distance, Elevation Gain, Surfaces in a 3-column grid on mobile; stacked on desktop
- Map: full-width, with overlay controls — do not shrink the map unnecessarily
- Cards: consistent padding/radius within the dossier
- Status rows (processing page): icon + label + status badge — keep the format consistent

## Responsive behavior (mobile ≤800px)
- All mobile overrides go in `@media (max-width: 800px)` blocks
- Place mobile overrides AFTER their desktop rule definitions in the file — earlier placement is silently overridden
- Sticky sidebar disabled on mobile (`position: static` on `.dossierRight`)
- Notch: `position: relative; top: auto` on mobile — scrolls with page

## Do
- Keep the `tempToColor` scale synchronized between results page and RouteMap
- Use separate Mapbox layers per feature type (not `match` expressions on `line-pattern`)
- Keep error states visually distinct and informative (error message redesign is deferred but planned)

## Don't
- Introduce Tailwind utility classes into component files — CSS Modules is the pattern
- Use `line-pattern` with `match` expressions in Mapbox GL v3 — falls back to black
- Change the temperature color scale without updating both locations
