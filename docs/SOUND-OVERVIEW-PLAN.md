# Sound Overview — visible-area field

Status: implemented on `sound-overview` (first pass).

## Decision

The planet view sonifies the **visible area** of the selected layer instead of a
single locked point. Every screen column sounds at once:

- **Data time** is the shared timeline position. Since #26 it has its own clock
  and only the pause button stops it; a drag, Auto-rotate off and the map view
  do not pause it.
- The 12 visible columns are panned across the stereo field and sound
  simultaneously; there is no scan clock or ping-pong.
- Auto-rotate off stops the planet; the timeline and the field keep running.
- The region map keeps point selection (click locks, drag moves, double click
  returns), but it uses the same instrument table as the overview: the selected
  point's left-right screen position sets pan, and the layer value sets a
  discrete pitch over one octave of the visible value range. The globe has no
  point selection; a marker selected earlier in the regional map remains
  visible there.

## Field and mapping

- A **12 x 12 screen grid** is raycast against the globe at ~10 Hz, giving 144
  visible cells with longitude, latitude, and screen position.
- Every screen column sounds at the same time; the columns spread across the
  stereo field, so the whole visible field is audible at once.
- **Screen X -> pan.** Visually right cells sound on the right.
- **|Latitude| -> pitch**, quantised to a pentatonic scale: poles low, equator
  high.
- **Layer value -> gain** with a `value^2` quadratic curve; a cell sounds only when its
  value reaches the **average intensity of the visible field** (a relative
  threshold, never a fixed absolute level); no-data cells are silent.
- **Data time -> frame** through `framePosition`, the same blend the picture and
  point audio use.
- The field is normalised by its total active cells and sent through the
  existing bus and limiter.

## Synthesis

The engine builds the overview field lazily, only when first used:

- 12 columns x 12 rows = 144 oscillators (one per visible cell)
- each column has twelve row gains, one low-pass filter and one stereo panner
- all 12 panners sound simultaneously; there is no scan clock
- all parameters use short ramps; no nodes are allocated per update
- the instrument table lives in `web/src/audio/overview.ts`, one entry per layer

Current editable instruments:

| Layer | Wave | Role |
|---|---|---|
| Forest | triangle | soft continuous bed |
| Smoke | sawtooth | brighter, rougher; suspended pentatonic |
| CO2 | sawtooth | lower register; minor pentatonic |
| Lightning | square | percussive edge |

Each entry also sets filter cutoff/Q, attack, release, gain, detune, octave and scale. A global `OVERVIEW_LAYER_GAIN` applies extra level to every layer; CO2 uses the minor pentatonic scale, smoke uses the suspended pentatonic, and the other layers use the major pentatonic.

## Data-time tempo marks

No layer currently has a timed mark. The helper in `web/src/audio/tempo.ts`
remains for adding marks to other layers later. Lightning now has a longer
release on its overview voice instead of a monthly tick.

## Forest bird ambience

When the forest is the active overview layer, the engine also plays sparse
excerpts of the existing `audio/samples/oajaros-suaves.ogg` recording over the
synthesized field:

- first excerpt after 1–4 s, then a new one every 6–14 s
- each excerpt lasts 2–5 s, with a random start offset
- random pan and slight random level; the field stays foregrounded
- birds stop when the forest layer or the globe overview is left

The bird bus goes through the normal data bus, so scene ducking and the limiter
still apply.

## Integration

- `EarthMesh` samples the visible screen field and publishes it through a ref.
- `DataAudio` turns the field into all columns and updates the engine every 100 ms.
- Globe and return transitions use the overview; the region map uses the same
  base waveform/scale/filter, enriched with a detuned companion, a sub-octave,
  a short chorus and a generated reverb. The value is a discrete pitch across
  one octave of the visible range; screen X is the pan. A separate regional gain
  keeps the voice below the overview mix. Lightning uses decaying notes at a
  value-dependent 90–120 bpm; value 0 is the lowest scale note at 90 bpm, not
  silence (only no-data/null is silent).
- Smoke and CO2 add looped air textures from the existing sample library; the
  forest bird ambience already plays in both views.
- The selected marker uses the focused region bounds on the map and is also
  drawn on the globe when a point was selected earlier in the regional map.
- Forest birds play in both views only when the visible field average (globe)
  or selected value (regional map) is at least `0.25`; sparse forest stops the
  bird ambience. The selected marker is drawn on both the globe and the
  regional map.
- Auto-rotate, drag, and the map control the planet/field, not data time.
- The globe uses drag-to-rotate and double-click-to-zoom; point selection is
  hidden from the globe HUD.
- `TimelineTrack` has its own clock and pause button (#26); it is not driven by
  the planet turn.

## Verification

- `web/src/audio/overview.test.ts`: 144 cells, pitch/pan/gain mapping, layer
  instrument table.
- `web/src/audio/engine.overview.test.ts`: lazy graph, all-column panners,
  waveform, disable/fade.
- Existing web tests and the production build cover the rest.
- Manual: left/right spread, poles low / equator high, value dynamics,
  Auto-rotate off still sounding the field, timeline pause, forest bird
  spacing, lightning release, globe/map transition, no clipping or clicks.
- Manual CPU check of the 144-oscillator overview with and without `?lite=1`
  remains pending (review note).
