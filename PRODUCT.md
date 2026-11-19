# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People choosing where to live in Budapest: moving to the city, changing flats, or renting. They
compare specific addresses and districts and want to know what daily life there looks like without
a car: how far the nearest grocery, pharmacy, doctor, school, kindergarten, park, transit stop,
food, gym and library are on foot or by bike.

They arrive with a candidate address (from a listing) or a vague area in mind, and leave with a
judgement: "this place works for how we live" or "it does not".

## Product Purpose

Reach15 answers "what can I reach from here in 15 minutes?" for any point in Budapest, and turns
that into a score that reflects the visitor's own priorities (a family weighs kindergartens and
parks, a student food and transit). Success: a visitor can paste an address, understand its
everyday reachability in seconds, and compare it fairly with other places.

## Positioning

Real street-network travel times, not straight-line distance: oneway streets for bikes, steps,
footpaths, and islands are respected. Scores are re-weighted live in the browser for the visitor's
own priorities, across the whole city at once. Data is open (OpenStreetMap) and refreshed weekly.

## Operating Context

- Typical flow: search an address (accent- and abbreviation-insensitive, e.g. `andrassy u 1`),
  or click the map; read the score, per-category nearest places and times, and the 5/10/15-minute
  isochrones; switch walk/bike; pick a persona or set custom weights; compare districts in the ranking.
- Shareable links encode point, mode and persona (`#p=lat,lon&m=bike&w=family`); visitors send
  them to partners or flatmates.
- Used on desktop while browsing listings, and on phones while viewing a flat on site.
- Also a portfolio project: interviewers may open it, but the design serves the flat-hunter first.

## Capabilities and Constraints

- Ten categories: grocery, pharmacy, doctor, school, kindergarten, park, transit, food, gym, library.
- Three modes: walk, bike and public transport (BKK timetable, RAPTOR; per place only, the heatmap
  and ranking stay walk/bike). Five personas: balanced, family, student, senior, active; plus custom weights.
- Score 0–100: per category `clamp(1 - seconds / 900, 0, 1)`, weighted mean. 15 minutes = 0 for that category.
- Heatmap: H3 resolution-9 hexagons; their raw times per category load once per release and
  are scored client-side (no request and no tile re-read when weights change).
- District ranking (23 districts), mean cell score with p25/p75.
- "When?": a local time filters places by OSM opening hours (unknown hours count as open and are
  labelled) and sets the public transport departure. Public holidays are not modelled.
- "Where should we live?": up to four places with their own mode and limit; the common area and the
  best-scoring spots inside.
- Coverage: Budapest only. No real-time transit, no housing prices or listings.
- UI languages: English and Hungarian, both complete. Light and dark themes.
- Stack is fixed: React 19, Vite, MapLibre GL 6, Protomaps basemap, TanStack Query; API types
  generated from `openapi/openapi.json`.
- E2E tests rely on `data-testid` hooks (`place-card`, `place-title`, `score`, `category-<id>`)
  and accessible roles/names (combobox "Search", radio "Bike", ...); keep them or update the tests.

## Brand Commitments

- Name: Reach15.

## Evidence on Hand

- Real Budapest data: 189k street vertices, 57k places, 8.5k hexagons, 178k searchable addresses/places.
- District ranking results (top: VII, V, VI; bottom: XXIII) come from that data and change weekly.
- No testimonials, user counts, or press exist; do not invent any.

## Product Principles

1. The map is the answer: the city-wide picture is visible before any interaction.
2. Times before scores: a score is only trusted when the minutes behind it are one glance away.
3. The visitor's priorities, not ours: weights are explicit, editable, and shareable.
4. Honest limits: say clearly what is not modelled (holidays, real-time delays, unmapped opening hours) and when a point is off the network.

## Accessibility & Inclusion

WCAG 2.2 AA. Colour is never the only carrier of the score (numbers and labels accompany it);
keyboard-only search and selection must work; Playwright runs axe-core and fails on serious violations.
