# Earth Jukebox — Listen to the Amazon

Proof of concept for the NASA Space Apps Challenge 2026 challenge
"The Earth Information Jukebox" (team Sagitta).

The goal is a local web app that opens on a 3D planet with four NASA Earth
science layers (forest height, wildfire smoke, CO2, lightning). Each layer gets
its own voice, generated in real time in the browser, and focusing the Amazon
flattens the planet into a detailed regional map. The story: the Amazon as the
lungs of the world — how it works, why it matters, what affects it.

## Status

This repository is the **shared base** of the build. What is in place:

| Part | Where | State |
|---|---|---|
| Data download and conversion (GEDI, MERRA-2, OCO-2, SVS frames) | `tools/fetch/`, `tools/fetch-frames.sh` | Done, tested |
| Data preparation (sources → grids, textures, manifest) | `tools/prep/`, `data/prep-config.json` | Done, tested |
| Prepared data (four layers and the planet images) | `web/public/data/` | Done (about 49 MB) |
| Data types and loader | `web/src/data/` | Done, tested |
| Interpolation and timeline | `web/src/lib/` | Done, tested |
| Value → sound mapping and sound engine (Web Audio) | `web/src/audio/` | Done, tested |
| Local server (Axum) | `server/` | Done, tested |
| Planet, Amazon map and transition | `web/src/scene/` | Done, tested |
| Side panel, timeline bar, story mode, accessibility | `web/src/ui/` | In progress |
| Docker containers to run, test and prepare the data | `docker-compose.yml`, `web/Dockerfile`, `tools/prep/Dockerfile` | Done |
| Final app container (built interface + local server) | `Dockerfile`, service `app` | Done |
| Demo launcher | `run-demo.sh`, `run-demo.ps1` | Done |
| Demo checklist, submission drafts | `docs/DEMO-CHECKLIST.md`, `docs/SUBMISSION.md` | Drafts |

## Project layout

```
web/              React + Tailwind + GSAP + three.js interface, Web Audio, Vitest tests
tools/prep/       Rust program: NASA frames -> intensity grids + textures + manifest
tools/fetch-frames.sh  downloads the NASA frames into data/raw/
server/           Rust (Axum) static server for 127.0.0.1: serves web/dist
Dockerfile        final app image: built interface + release server binary
run-demo.sh       demo launcher (run-demo.ps1 on Windows PowerShell)
docs/             demo checklist and submission drafts
data/             prep-config.json, SOURCES.md, raw/ (downloaded frames, not versioned)
web/public/data/  prepared data shipped with the app
docker-compose.yml  services to run, test and prepare the data in containers
```

## Run and test with Docker (the team's way)

The only requirement is Docker Desktop. Node.js and Rust live inside the
containers. Run every command from the repository root.

### 1. Build the images (needs internet, do it before the demo)

```bash
docker compose --profile "*" build
```

**The demo runs without internet, so build the images beforehand** on the
machine that will run it. Once they are built, starting the interface, running
the tests and preparing the data download nothing. Build again after pulling a
change to `web/package.json`, `web/package-lock.json`, `tools/prep/Cargo.toml`,
`tools/prep/Cargo.lock`, `server/Cargo.toml` or `server/Cargo.lock`.

A plain `docker compose build` builds the final app image only, because every
other service sits behind a profile (so that `docker compose up` never starts
them by accident).

### 2. Run the app (the demo)

The quickest way, which also checks that Docker is running and the image is
built, waits for the app and opens the browser:

```bash
./run-demo.sh --build     # once, with internet
./run-demo.sh             # every time after, works offline; --stop to stop it
```

On Windows PowerShell: `.\run-demo.ps1 -Build`, then `.\run-demo.ps1` (and
`-Stop`). If scripts are blocked, run
`powershell -ExecutionPolicy Bypass -File .\run-demo.ps1`.

The same with Docker Compose directly:

```bash
docker compose build app        # needs internet; again after any change to web/ or server/
docker compose up               # http://127.0.0.1:8080, Ctrl+C to stop
docker compose up -d            # same, in the background
docker compose down             # stop and remove the containers
```

The `app` image holds the built interface, the prepared data and the release
server binary, so once it is built the app starts in about a second and needs
no internet. It does not read your working tree: rebuild it to see new code.

### 3. Develop the interface

```bash
docker compose up web           # http://127.0.0.1:5173, live reload, Ctrl+C to stop
docker compose up -d web        # same, in the background
```

`web/` is mounted into the container, so saving a file on your machine reloads
the page. Every port is published on `127.0.0.1` only.

To try the server code without rebuilding the app image, build the interface
into `web/dist` and serve it from the mounted `server/` source:

```bash
docker compose run --rm web npm run build
docker compose up server        # http://127.0.0.1:8081
```

Build `web/dist` first: without it the server stops and says which command to
run.

### 4. Run the tests

```bash
docker compose run --rm web-test     # Vitest: every web/src/**/*.test.ts
docker compose run --rm prep-test    # cargo test for tools/prep
docker compose run --rm server-test  # cargo test for server/
```

All three read the source from your working tree; no rebuild is needed after a code
change.

### 5. Other jobs

```bash
docker compose run --rm web npm run typecheck   # TypeScript check
docker compose run --rm web npm run build       # type-check and build into web/dist
docker compose run --rm prep                    # regenerate web/public/data/ from data/prep-config.json
docker compose run --rm prep --sample           # generated stand-in data instead
```

`prep` reads `data/` (read-only) and writes `web/public/data/`. It needs the
frames in `data/raw/`; see [Preparing the data](#preparing-the-data).

### Good to know

- **Dependencies of the interface** live in the Docker volume
  `earth-jukebox_web_node_modules`, not in your working tree (the empty
  `web/node_modules/` folder is only its mount point). When
  `web/package-lock.json` changes, the container runs `npm ci` by itself on its
  next start; that one start needs internet.
- **Adding an npm package**: `docker compose run --rm web npm install <name>`,
  then commit `web/package.json` and `web/package-lock.json`.
- **Start clean**: `docker compose down -v` also deletes the dependency volume;
  the next start fills it again from the image.
- **The local server** listens on `127.0.0.1:8080` by default; `JUKEBOX_HOST`
  and `JUKEBOX_PORT` change it (inside the containers it listens on `0.0.0.0`
  and Docker publishes the port on `127.0.0.1` only). If `index.html` or
  `data/manifest.json` is missing it stops and says which command to run.
- There is no database.

## Planet view

The interface opens on the 3D planet (code in `web/src/scene/` and
`web/src/ui/`).

```bash
docker compose up web     # then open http://127.0.0.1:5173/
```

- **Planet**: it turns slowly by itself. The overview plays the visible globe
  all at once: screen position sets the stereo side, latitude sets the pitch
  (poles low, equator high), and the layer value sets the volume. The timeline
  plays on its own clock, so Auto-rotate off stops the planet but the data frame
  and the field keep going. The forest overview adds sparse bird excerpts from
  `audio/samples/oajaros-suaves.ogg` when the visible forest is dense enough.
  Drag to turn the planet; double-click a region to fly there. On a touch screen
  a finger drag turns the planet and a double tap flies to a region. Point
  locking belongs to the regional map; the globe uses the visible-area overview.
  The active layer is drawn over `earth.jpg`.
- **Layer picker** (top left, temporary until the side panel): any layer of
  `web/public/data/manifest.json` appears there, with no code change.
- **Timeline line** (under the planet): one mark per instant of the picked
  layer, at its real time (three hours of smoke, a day of CO2, a month of
  lightning). It plays by itself at the pace of the planet's turn: one turn is one day of
  smoke, 30 days of CO2 and one year of lightning, and the picture and the sound fade from one
  instant to the next. The 4× and 8× buttons (4× to start) make each turn cover more time
  (the line shows `1 turn = …`); the planet keeps its pace. It keeps playing on the map
  view, during a drag and with Auto-rotate off; only the **❚❚ Pause** button
  on the line stops it (**▶ Play** goes on). Click
  or drag along the line (or use the arrow keys, Page Up/Down for a whole
  turn) to pick a moment. The forest shows a dimmed line with its one period.
- **Amazon only layers** (`global: null`; none today): drawn inside
  the Amazon rectangle (`region.bbox`) from their regional grid, on the planet
  and on the map, and nothing elsewhere. Layers with a global grid use it
  outside the rectangle and their regional grid inside it.
- **To a region and back**: double-click a region (the cursor becomes a hand)
  or press **Amazon**; the planet turns, flattens into the map and the camera
  moves close (1.6 s). Double-click the map or press **Back to Earth** to
  return (1.4 s) and the planet turns again. The regional view uses the same
  base instruments as the overview, enriched with detuned/sub voices, chorus,
  reverb and air textures; the selected point's left-right position sets pan
  and the layer value sets a discrete pitch over one octave. Lightning
  retriggers decaying notes at 90–120 bpm (0 is the lowest note at 90 bpm, not
  silence), and forest birds play while the visible/selected forest value is at
  least 0.25.
- **Indicator** (bottom left): longitude, latitude and the active layer's
  value (0 to 100 %) for the point under the cursor; the region map also shows
  the locked point, or "no data here".
- **Listening point** for the region map:
  `useListeningPoint()` from `web/src/scene/listeningPoint.tsx` returns the
  locked point as `{ lon, lat, screenX }` (`screenX` 0 at the left edge of the
  canvas, 1 at the right), or `null` until a point is selected. Only the region
  map selects a point now; the globe uses the visible-area overview.
- **Frames per second** (top right): the average over the last second; green
  at 30 or more (the target), red below. The browser's own performance monitor
  (Chrome DevTools, "Performance monitor") gives the same figure as a backup.
- **Lite mode (plan B)**: open `http://127.0.0.1:5173/?lite=1`. Half-resolution
  planet image, fewer mesh segments, no antialiasing, and the view switches to
  the map at once instead of flattening. The counter shows `· lite`.
- If `earth.jpg` cannot be loaded, a warning appears and the planet is drawn
  over a plain ocean colour; everything else keeps working.

The manual browser check is in [docs/PLANET-CHECKLIST.md](docs/PLANET-CHECKLIST.md).

## Run without Docker (secondary)

Requirements: Node.js 20.19 or newer (npm), stable Rust (cargo).

```bash
npm --prefix web ci
npm --prefix web run dev        # http://127.0.0.1:5173
npm --prefix web run build      # type-check and build into web/dist
cargo run --release --manifest-path server/Cargo.toml   # serves web/dist on http://127.0.0.1:8080
```

Tests:

```bash
npm --prefix web exec -- vitest run
cargo test --manifest-path tools/prep/Cargo.toml
cargo test --manifest-path server/Cargo.toml
```

Nothing is loaded from the internet at runtime: fonts are system fonts and all
data lives under `web/public/data/`.

Deno 2 can also run the interface (`cd web && deno install && deno task build`),
but it writes its own `web/node_modules` and `web/deno.lock`. Do not commit
them; npm inside the containers and `web/package-lock.json` are the reference.

## Preparing the data

The prepared data is already in `web/public/data/`. To rebuild it, download the
frames on your machine (this script needs `curl` and `ffmpeg`, it is not
containerized) and run the preparation in its container:

```bash
tools/fetch-frames.sh                # about 50 MB into data/raw/, rewrites data/SOURCES.md
docker compose run --rm prep         # data/prep-config.json -> web/public/data/
```

To work with generated stand-in data instead (flagged `sample: true` in the
manifest):

```bash
docker compose run --rm prep --sample
```

Without Docker, the same two jobs are:

```bash
cargo run --manifest-path tools/prep/Cargo.toml -- --config data/prep-config.json
cargo run --manifest-path tools/prep/Cargo.toml -- --sample
```

Video frames are extracted with ffmpeg; `tools/fetch-frames.sh` does it for you.
The command it runs for one frame is:

```bash
ffmpeg -ss 28.5 -i data/raw/4950/GEDI_global_w_colorbar_1080p60.mp4 -frames:v 1 data/raw/4950/gedi_globe_28.5.png
```

`data/prep-config.json` says, for every layer, which frames to read, how each
frame is placed on the Earth (flat map, or a globe view with the point under
the camera) and how colour becomes a value.

### Data format

`web/public/data/manifest.json` lists the layers (`forest`, `smoke`, `co2`) with
`title`, `description`, `source`, `static`, `sample`, `dates[]`, and two grids:
`global` (whole planet, `null` for layers that only cover the Amazon) and
`region` (Amazon detail). Each grid has `width`, `height`, `frames`, `file` and
`texture`. `region.bbox` is the Amazon rectangle in degrees.

A grid file holds one byte per cell (0 to 255; the app divides by 255), ordered
by instant, then row (north first), then column (west first).

## Data sources and their limits

See [`data/SOURCES.md`](data/SOURCES.md) for every file and link.

| Layer | Source | Coverage | What the value is |
|---|---|---|---|
| Forest height | [GEDI L3 Gridded Land Surface Metrics V3](https://doi.org/10.3334/ORNLDAAC/2525) (NASA GEDI, ORNL DAAC), filled with [NASA SVS 4950](https://svs.gsfc.nasa.gov/4950) where GEDI has no data | Global, April 2019 - July 2025 | **Measurement** on a fixed scale: 0 to 50 m canopy height |
| Wildfire smoke | [MERRA-2 aerosol diagnostics (M2T1NXAER)](https://disc.gsfc.nasa.gov/datasets/M2T1NXAER_5.12.4/summary), organic + black carbon optical depth (NASA GMAO reanalysis) | Global, 1 August - 30 September 2026, every 3 hours | **Model value** on a fixed square-root scale: optical depth 0 to 2; smoke only, no desert dust |
| Atmospheric CO2 | [OCO-2 GEOS Level 3 daily XCO2, V10r](https://disc.gsfc.nasa.gov/datasets/OCO2_GEOS_L3CO2_DAY_10r/summary) (NASA GES DISC: GEOS model with OCO-2 satellite measurements assimilated) | Global, every day of 2020 | **Model value** on a fixed scale: 404 to 420 ppm |
| Lightning | Lightning Events Detected from the ISS 2017-2023, [NASA SVS 5011](https://svs.gsfc.nasa.gov/5011) | About 55° N to 55° S, 2017 - 2023, one frame per month (not accumulated) | **Relative frequency** read from the visualization, not a flash count |

Backdrop of the planet: [Natural Earth I](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-1/)
(public domain); it carries no data values.

**Forest height, smoke and CO2 are measured or modelled values on fixed
scales. Lightning is a relative value read from a rendered NASA visualization,
not a physical measurement.** CO2 covers the whole planet every day and is
presented as global context, not as a measured effect of what happens in the
Amazon.

## Use of AI

An AI coding assistant (Claude Code) generated code, data-preparation scripts
and documentation drafts in this repository under the team's direction. The
team reviews and is responsible for the result. No AI-generated images, video
or audio are included; the data comes from the NASA sources listed above.
