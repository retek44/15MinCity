---
name: Reach15
description: Budapest's everyday reach, printed like a modernist poster - flat inks, condensed numerals, overprinted planes.
colors:
  ultramarine: "#1f35a5"
  ultramarine-deep: "#172984"
  ultramarine-dark: "#16247a"
  ultramarine-deep-dark: "#0f1a5e"
  ultramarine-text-dark: "#8ba2f0"
  rail-ink: "#ffffff"
  rail-muted: "#c9d0f0"
  rail-muted-dark: "#b9c2ec"
  saffron: "#f2a93b"
  poppy: "#e2412b"
  poppy-dark: "#f0573f"
  iso-5: "#64342f"
  iso-10: "#e6633d"
  iso-15: "#f1bb6a"
  iso-5-dark: "#e5b7af"
  iso-10-dark: "#e1633c"
  iso-15-dark: "#b98334"
  paper: "#eef0f6"
  sheet: "#ffffff"
  ink: "#151826"
  muted: "#4a5068"
  paper-dark: "#0e1220"
  sheet-dark: "#161b2e"
  ink-dark: "#e8ebf5"
  muted-dark: "#a7aecb"
  error: "#b42318"
  error-dark: "#ff8a7a"
typography:
  display:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "96px"
    fontWeight: 850
    lineHeight: 0.82
    fontVariation: "'wdth' 62"
    fontFeature: "'tnum' 1"
  wordmark:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "44px"
    fontWeight: 900
    lineHeight: 0.9
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 62"
  numeral:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "28px"
    fontWeight: 850
    lineHeight: 1
    fontVariation: "'wdth' 62"
    fontFeature: "'tnum' 1"
  headline:
    fontFamily: "Archivo Variable, Arial Narrow, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.02em"
    fontVariation: "'wdth' 75"
  title:
    fontFamily: "Archivo Variable, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Archivo Variable, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Archivo Variable, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.45
  caption:
    fontFamily: "Archivo Variable, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: "0px"
  swatch: "1px"
  sm: "2px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  rail-button:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "36px"
  rail-button-hover:
    backgroundColor: "{colors.ultramarine-deep}"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.sm}"
    padding: "7px 18px"
  segmented-option-checked:
    backgroundColor: "{colors.rail-ink}"
    textColor: "{colors.ultramarine}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.sm}"
    padding: "4px 9px"
  chip-checked:
    backgroundColor: "{colors.rail-ink}"
    textColor: "{colors.ultramarine}"
  search-input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px 0 42px"
    height: "48px"
  district-row:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.sm}"
    padding: "7px 6px"
  district-row-pressed:
    backgroundColor: "{colors.rail-ink}"
    textColor: "{colors.ultramarine}"
  category-meter:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 6px"
  category-meter-pressed:
    backgroundColor: "{colors.sheet}"
  place-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "22px 22px 18px"
    width: "360px"
  map-band:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "0 16px"
    height: "40px"
  hex-popup:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
---

# Design System: Reach15

## Overview

**Creative North Star: "Plakát"**

Reach15 is printed, not rendered. The system borrows from 1960s and 1970s Hungarian modernist posters: a few flat inks laid side by side on cool paper, numbers set extra-condensed and very heavy, and colour planes that overprint one another instead of floating in boxes. An ultramarine rail owns the left edge; the map fills the rest and is re-inked so the basemap, the heatmap and the chrome all come from the same press.

It is an operating tool, so density is high and calm: one screen, a rail of controls and a ranked roster on the left, the map as the answer, and a paper place panel that slides against the map's right edge when a point is chosen. Type does the hierarchy work. Rules (thin lines in ink or white) separate things; containers are almost never boxed. Depth comes from inks sitting on top of inks, never from shadows or blur.

The signature move is the Overprint: a chosen place prints its 5, 10 and 15 minute reach as three nested flat planes (ink, poppy, saffron), with the score beside it as a poster numeral.

**Key Characteristics:**
- Ultramarine rail, cool blue-tinted paper, ink text; saffron and poppy as the only warm inks.
- One variable family, Archivo: condensed heavy (wdth 62) for every number and the wordmark, normal width for UI text.
- Flat planes, 2px corners, rules instead of boxes, no shadows, no blur.
- The hexagon is the only construction shape on the map (hover and selection outlines).
- Light and dark are two printings of the same poster: same roles, re-mixed inks.

## Colors

A committed three-ink poster palette: ultramarine for structure and data, saffron and poppy for the reach and for emphasis, ink on cool paper for reading.

### Primary
- **Rail Ultramarine** (ultramarine): the left rail's ground, the score numeral, the category meter fill, links, the caret, and the hue of the whole heatmap ramp. In dark mode the rail drops to ultramarine-dark, and text-weight ultramarine on dark paper lifts to ultramarine-text-dark so the score numeral and links stay legible.
- **Deep Ultramarine** (ultramarine-deep): the hover and pressed-adjacent state inside the rail (rail buttons, district rows, the category focus note). Dark mode uses ultramarine-deep-dark.

### Secondary
- **Saffron** (saffron): the "15" in the wordmark, the district mean tick, the selected hexagon outline (3px), the outer 15-minute reach plane, the weight sliders, the focus ring, text selection, and the focused category's name in the rail. Same value in both themes.

### Tertiary
- **Poppy** (poppy / poppy-dark): the 10-minute reach plane and a category meter that has run past the 15-minute limit. Nothing else.

### Reach planes (iso-5, iso-10, iso-15 and their dark counterparts)
These are the key swatches in the place panel. They are not new inks: each one is the colour the map actually prints once the planes overprint (the 5-minute swatch is ink over poppy over saffron; in dark mode the 5-minute plane is light ink, so its swatch is pale). Change them only by recomputing from the map layers.

### Neutral
- **Cool Paper** (paper / paper-dark): page ground, map background and basemap earth, the place panel, the map band, map controls. Blue-tinted, never cream.
- **Sheet** (sheet / sheet-dark): the one raised plane, used for the search field, search results and the pressed category meter.
- **Ink** (ink / ink-dark): body text, the 2px rules that edge the place panel and map band, the hover hexagon outline, POI dots and the selected point.
- **Muted Ink** (muted / muted-dark): secondary lines, captions, placeholders, ramp end labels, credits.
- **Rule** (ink at 14% alpha, `rgba(21, 24, 38, 0.14)`; dark `rgba(232, 235, 245, 0.14)`): hairlines between rows, meter tracks, light hover fills, skeleton bars.
- **Rail ink and Rail muted** (rail-ink / rail-muted / rail-muted-dark): text on the rail. White at 20% is the rail's hairline, 16% the spread track, 60% the p25-p75 band.
- **Error** (error / error-dark): the place panel's error line only.

### Heatmap ramp
The heatmap is a single ultramarine ramp interpolated linearly from 0 to 100. Light: `#dfe3f5 → #a9b4e6 → #6c7fd2 → #3a51b8 → #1a2a8a` (pale to deep). Dark steps up towards light: `#1d2758 → #2d43a0 → #4a68d8 → #8ca3f2 → #d6deff`. The legend bar draws the same stops.

### Named Rules
**The Three Inks Rule.** Ultramarine, saffron and poppy are the only chromatic inks. Anything new is a mix or an overprint of these on paper and ink, never a fourth hue.

**The Cool Paper Rule.** Paper is blue-tinted (#eef0f6 family). Cream, warm grey or pure white grounds break the printing.

**The One Ramp Rule.** Scores on the map are one hue, light to deep. No rainbow, no traffic-light red-to-green.

## Typography

**Display Font:** Archivo Variable at width 62 (with Arial Narrow, sans-serif)
**Body Font:** Archivo Variable at normal width (with system-ui, sans-serif)

**Character:** One family pulled two ways. Extra-condensed, very heavy numerals carry the poster voice; the same family at normal width keeps the interface quiet and readable.

### Hierarchy
- **Display** (850, 96px, line-height 0.82, wdth 62, tabular): the place score numeral only, in ultramarine. 72px on narrow screens.
- **Wordmark** (900, 44px, line-height 0.9, wdth 62): "Reach15" with the "15" in saffron. 34px on narrow screens.
- **Numeral** (850, 28px, wdth 62, tabular): district Roman numerals and district scores. Category minutes use the same face at 22px.
- **Headline** (800, 22px, wdth 75, uppercase, 0.02em): rail section heads (the district roster). The place panel's section heads use the same treatment at 17px.
- **Title** (700, 19px, line-height 1.2, balanced wrap): the place's address.
- **Body** (400, 15px, line-height 1.45): default text; district and category names set at 15px/600.
- **Label** (600, 14px): buttons, chips (500 at rest, 700 when checked), the segmented control (700), key titles, the tagline and hints.
- **Caption** (400, 13px): roster caption, search sublabels, nearest-place names, the map band. 12px for the colophon, 11px for the band on phones.

### Named Rules
**The Numbers Are Condensed Rule.** Every figure the visitor compares (scores, minutes, district numerals) is set in the condensed heavy cut with tabular figures. UI words never are.

**The Type Is The Interface Rule.** Hierarchy comes from size, width and weight. Section heads are condensed uppercase type, not boxes, icons or coloured labels.

## Layout

A two-column operating screen. Desktop: a fixed 400px rail on the left (24px padding, 20px vertical gap between blocks) and the map filling the rest at full viewport height. When a point is selected, a 360px place panel sits flush against the map's right edge, full height, and the map's padding shifts so the point is not hidden under it. A 40px map band runs along the map's foot (legend and credit), stopping at the place panel; map controls stand on the band, flush right.

Spacing is a tight 4/6/8/10/12/16/20/24px rhythm; list rows bleed 6px past their column so hover fills reach the gutter while text stays aligned.

At 720px and below the columns stack: the map takes the top, the rail becomes a bottom region capped at 46dvh (16px padding), and the place panel becomes a fixed bottom sheet up to 62dvh with a 2px ink rule on top. While the sheet is open, the map band moves to the map's head so the colour key and the OpenStreetMap credit stay visible. The tagline and the extra credits drop on phones.

### Named Rules
**The Flush Plane Rule.** Panels, bands and map controls meet the viewport or map edge flush, separated by a single 2px ink rule on their open side. Nothing floats over the map with a margin around it.

## Elevation & Depth

The system is flat. There are no drop shadows anywhere; MapLibre's default control and popup shadows are explicitly removed. Depth is conveyed by plane order and ink: the sheet colour lifts the search field and a pressed meter off paper, a 2px ink rule separates the place panel and map band from the map, and on the map, inks overprint (heatmap at 82% opacity, dropping to 30% under a selection; reach planes at 62/72/75% so the street grid shows through).

### Shadow Vocabulary
- **Pressed ring** (`box-shadow: inset 0 0 0 2px` ultramarine): the pressed category meter. An inset ring, not elevation.

### Named Rules
**The Overprint Rule.** Things in front are drawn as flat inks over what is behind, with the order meaning something (largest reach first, smaller planes printed on top). Never blur, glass, gradients or shadows to suggest depth.

## Shapes

Corners are nearly square: 2px on every interactive control and container, 1px on key swatches and skeleton bars, 0 on map controls that join the map edge. Lines are the main structural device: 1px hairlines between rows, 2px ink rules on panel edges and the search results list, 2px outline on the segmented control. Icons are authored line drawings on a 24px grid with a 2px stroke, square caps and mitre joins, drawn in currentColor.

On the map the hexagon (H3 cell) is the only construction shape: a 1.5px ink outline under the cursor, a 3px saffron outline on the selected cell. Map marks are plain circles: nearest-place dots in ink with a 2px paper stroke at 5, 6.5 or 8px radius (the category's weight in the profile, three fixed steps), and the chosen point as a 9px paper disc with a 5px ink ring.

### Named Rules
**The Hexagon Rule.** The hexagon is the only shape drawn for emphasis on the map. No pins, no pulsing rings, no rounded callouts.

## Components

### Buttons
Quiet, bordered, typographic.
- **Shape:** 2px corners, 36px minimum height and width.
- **Rail button:** transparent with a white 20% hairline, white label (14px/600), 18px icon. Hover fills with deep ultramarine. Used for the language and theme toggles and "show all".
- **Icon button (paper side):** 36px square, no border, ink icon at 20px; hover fills with the rule tint. Used for closing the place panel.
- **Text link:** ultramarine, 600, underlined with a 3px offset.
- **Focus:** every control gets a 2px saffron outline at 2px offset.

### Segmented control
- **Style:** a 2px white outline around two options (Walk, Bike), each with an icon and a 700 label, 7px by 18px padding.
- **Checked:** the option inverts to white with ultramarine text.

### Chips
- **Style:** persona choices as a wrapping radiogroup. Transparent, white 20% hairline, 14px/500, 4px by 9px.
- **Hover:** hairline strengthens to white 60%.
- **Checked:** inverts to a white plane with ultramarine 700 text.

### Inputs / Fields
- **Search field:** a 48px sheet plane with no border, 2px corners, 16px text, a 20px muted search icon inset 13px left.
- **Results list:** sheet plane with a 2px ink rule, 360px max height; the active option takes the paper tint; label 600, sublabel 13px muted.
- **Weight sliders:** native range inputs with saffron accent, in a three-column row (name, 120px slider, value), behind a disclosure whose chevron rotates 90 degrees.

### District roster
The 23 districts as a finite ranked list with fixed furniture per row: Roman numeral (28px condensed), name (15px/600) above a 6px spread bar, and the mean score (28px condensed, right aligned). The spread bar shows the p25 to p75 band in white 60% on a white 16% track with a 3px saffron mean tick. Rows are separated by rail hairlines; hover fills deep ultramarine; the pressed district inverts to a white row with ultramarine text and the bar re-tinted in ultramarine. Focusing a district fades every other district's hexagons to 8%.

### Place panel and category meters
A paper plane with a 2px ink rule on its map side. Address title, district line (14px/600), postcode line (muted), then the score as the display numeral with a caption saying what it was computed for. Below, the reach key (three swatches with minutes) and the "nearest by category" list.

Each category meter is a full-width button: name (15px/600) with the nearest place beneath (13px muted, ellipsis), minutes on the right (22px condensed), and a 4px track where the ultramarine fill shows minutes against the 15-minute limit (shorter means closer). Past the limit the fill turns poppy. Pressing a meter recolours the map by that category alone; the pressed meter lifts to sheet with a 2px inset ultramarine ring and the others fade to 42% opacity (0.25s, ease-out-expo).

Loading state is a set of rule-tinted skeleton bars pulsing between 50% and 100% opacity.

### Map band and legend
A 40px paper band with a 2px ink rule on top: the legend caption (700, ellipsised; two clamped lines on phones), "0", a 160px continuous ramp bar (56px on phones), "100", and the credit (OpenStreetMap always, Protomaps and Reach15 when room allows).

### Map chrome
Zoom and geolocate controls are redrawn as one paper column flush to the map's right edge with a 2px ink rule on its left, hairline dividers, and ink mask icons; no radius, no shadow. The hover popup over a hexagon is an ink chip with paper text (13px/600), 2px corners, no shadow.

### The Overprint (signature)
Choosing a place draws its reach as three nested flat planes, largest first: 15 minutes in saffron at 75%, 10 minutes in poppy at 72%, 5 minutes in ink at 62% (light ink in dark mode). The heatmap drops to 30% underneath. Nearest places appear as ink dots sized by profile weight, and the selected hexagon gets its saffron outline.

### Basemap
The Protomaps basemap is re-inked into the palette: earth and background are paper, water is a pale ultramarine (#bcc6e0 light, #1b2650 dark), parks a cool sage, roads white on paper (or a step above paper in dark), labels in ink tones. POI icons are removed and landmark names appear only from zoom 15.5; tiny locality labels are dropped; neighbourhood labels have no halo so they do not smear over the hexagons.

## Do's and Don'ts

### Do:
- **Do** set every score, minute and district numeral in Archivo at wdth 62, weight 850, with tabular figures.
- **Do** separate panels from the map with a single 2px ink rule and keep them flush to the edge.
- **Do** keep corners at 2px on controls and containers, 1px on swatches, 0 where a control joins the map edge.
- **Do** use saffron for focus rings, selection and the one thing that must catch the eye in a block (the wordmark's 15, the mean tick, the selected hexagon).
- **Do** draw map scores with the single ultramarine ramp, and show it in the legend as one continuous bar because the map interpolates it.
- **Do** print the reach as nested planes in ink, poppy and saffron, largest first, and keep the key swatches equal to the printed overprint.
- **Do** invert to white-on-ultramarine (or ultramarine-on-white) for the checked or pressed state inside the rail.
- **Do** honour reduced motion: all transitions and animations switch off.

### Don't:
- **Don't** use drop shadows, glass, blur or backdrop filters; depth is overprint and rules.
- **Don't** use gradients as decoration. The legend bar is the single gradient, because it depicts the interpolated heatmap.
- **Don't** introduce a fourth chromatic ink or a cream or warm-grey ground.
- **Don't** colour the heatmap with a multi-hue or red-to-green ramp.
- **Don't** float rounded cards over the map; this world replaces the white floating search card and rounded result cards.
- **Don't** add map pins, pulsing markers or shapes other than hexagon outlines and plain circles.
- **Don't** set UI words in the condensed cut, or numbers in the normal-width cut.
