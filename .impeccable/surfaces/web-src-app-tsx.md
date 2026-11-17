---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/styles.css","web/src/map/MapView.tsx"]
---

# Surface: Reach15 map app (web/)

Mode: Operate. One screen: map plus a left rail; a place panel when a point is selected. Mobile: rail becomes a bottom sheet.

Audience and job: Budapest flat-hunters. First task chosen by the user: city overview, then district exploration; second task: check a specific address (search or click). Must not feel playful (no gamification, badges, emoji). Shareable URL state, EN/HU, light/dark, keyboard search, axe-clean, existing `data-testid` hooks and accessible names kept.

Memorable moment: picking a place prints its 5/10/15-minute reach as three flat ink planes, with the score set as a condensed poster numeral.

Open decisions: district outline geometry is not in the tiles yet; district focus uses `district_id` on H3 cells plus a bbox from the ranking API.

## Direction contract

THESIS: Budapest's everyday reach, printed like a 1960s–70s Hungarian modernist poster: flat inks, condensed numerals, overprinted planes. It refuses the category default of a white floating search card and rounded result cards over a grey map.

OWN-WORLD: Committed palette. Ultramarine rail (#1F35A5 family) owns the left edge; cool paper ground (blue-tinted, never cream) under a re-inked Protomaps basemap; heatmap is a single ultramarine ramp; isochrones are saffron, poppy and ink. Archivo (variable width) everywhere: extra-condensed heavy for numerals and the wordmark, normal width for UI text. Flat planes, 2px radii, ink rules instead of boxes, no gradients, no glass, no hard offset shadows. The hexagon is the only construction shape (hover/selection outlines).

STORY: The visitor sees the whole city scored for their profile, reads the 23 districts as a ranked roster, focuses one, then drops a point and reads its minutes per category; they change mode or profile and watch the city re-ink instantly; they share the link.

FIRST VIEWPORT: Desktop 408px ultramarine rail: wordmark Reach15 with saffron "15", one-line purpose, search field, Walk/Bike segmented control and profile select, then the district roster (Roman numeral, name, score, p25–p75 bar). Map fills the rest with the ultramarine heatmap and a compact legend top-right. With a selection, a paper place panel sits at the map's right edge: address, district, poster score numeral, ten categories with minutes and nearest place, isochrone key.

FORM: Plakát, my grounded list position 6 of 7, assigned by the roll; seed:8d6d82cb76e0591e. Raises: type is the interface (metro tiles); finite district roster (character catalog); category focus fades the rest (datamatics); fixed three-step marker size ramp by persona weight (star atlas); hexagon as sole construction shape (Crouwel). Signature move: Overprint, the reach drawn as three nested flat ink planes.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
