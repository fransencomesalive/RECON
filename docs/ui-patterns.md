# UI Patterns — RECON

## Intake page
- Single card, centered, moderate opacity white on dark canvas background
- Card background: 55% white opacity (below this, text is unreadable on the canvas)
- URL input: visible white box, 1.5px border, left-aligned, label "Route URL"
- File upload and URL input separated by "— OR —" divider (bold)
- Hint text: `color: #555` (dark gray on light card, not white-on-light)
- Placeholder: `color: #777` (~4.5:1 WCAG contrast against white input)
- Platform badge: teal info (RWGPS/Strava detected), amber warn (Strava not connected)

## Processing page
- 6 service status rows: parse, OSM, weather, lands, coverage, wind
- Each row: icon + service name + status badge (pending / running / done / failed)
- Consistent row height and spacing — do not stack or collapse rows on mobile
- Must remain `force-dynamic` — never serve from edge cache

## Results page — dossier layout
- Two-column on desktop: map/analysis left, data table right
- Single column on mobile (≤800px): Planning Summary first (`dossierRight { order: -1 }`), then POI table
- Sticky sidebar on desktop (`position: sticky; top: 5.5rem`); static on mobile

## Results page — stats row
- Desktop: Distance, Elevation Gain, Surfaces stacked vertically
- Mobile: `.statTopRow` → `display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem`
- Est. Ride Time card (with speed + start time sliders) sits below at full width on both

## Mapbox map
- 7 toggleable layers: Route, Surface, Weather, Public Lands, Mobile Coverage, POIs, Bailouts
- Default active: Route, POIs, Bailouts
- Layer insertion order matters — coverage halo inserts below route-line
- Canvas overlay for wind particles: `position:absolute;inset:0`, appended to map container on load
- Bidirectional hover sync: elevation scrubber ↔ map marker via `hoverFrac` (0–1) shared state

## Elevation profile
- SVG: `SVG_H=362`, weather strips at bottom (`WEATHER_H=10`, `CHART_B=294`)
- Weather strips (when Weather layer active): wind rects, rain sine-wave path, temp linearGradient
- Per-strip hover tooltips: wind mph/km/h, temp °F/°C, rain in/mm (respects imperial/metric toggle)
- Legend: `.legendPointsGrid` — 2 cols of 5 on mobile (was 3 cols of 4)

## Error states
- Current: raw technical strings (e.g. `osm: OSM timeout`) — redesign deferred
- Target pattern: plain-language, personality-driven, in-place (not full-screen), with error ID code
- Do not add new raw technical error strings — use the existing pattern until redesign lands

## Imperial/metric toggle
- Converts bidirectionally: km↔mi, m↔ft
- Works on stored results regardless of what units Claude happened to write in the narrative
- `narrativeForUnit()` handles the conversion
