# Demo checklist — Earth Jukebox

Manual check of the demo before recording the video and before judging
(NFR7). Run it on **the demo laptop** and again on **the backup laptop**.
Every line must be green by Sunday 5:00 p.m. (Colombia time); after that only
fixes go in.

Mark each line `[x]` when it passes, and write the result next to it (time,
count, who tested). Planet-specific checks during development are in
[`PLANET-CHECKLIST.md`](PLANET-CHECKLIST.md).

| Laptop | OS | Browser and version | Audio output | Tested by | Date |
|---|---|---|---|---|---|
| Demo | | | | | |
| Backup | | | | | |
| Development (pre-check, section 2 only) | Windows 11 | | | Andres Navarro | 2026-11-14 |

## 1. Before unplugging the network (needs internet)

- [ ] Latest `main` pulled: `git pull`
- [ ] App image built: `./run-demo.sh --build` (Windows: `.\run-demo.ps1 -Build`)
- [ ] All tests green: `docker compose run --rm web-test`, `docker compose run --rm prep-test`, `docker compose run --rm server-test`
- [ ] Prepared data under 200 MB (NFR4): `du -sh web/public/data` → ______
- [ ] Browser and system audio updated; notifications off; volume at a known level

## 2. Offline start (FR2, NFR1, NFR4)

- [ ] **Network cable unplugged and Wi-Fi off**
- [ ] Docker Desktop started and showing "running"
- [ ] `./run-demo.sh` (Windows: `.\run-demo.ps1`) prints "ready" and opens the browser
- [ ] Time from running the script to the page answering is **5 s or less**: ______ s (the script prints it)
- [ ] Time from opening the page to hearing sound is **5 s or less**: ______ s
- [ ] Browser developer tools, Network tab, reload: **no request leaves `127.0.0.1`** (no fonts, textures or scripts from the internet)

> **Pre-check on the development laptop (Sat 14 Nov 2026, Andres Navarro): passed.**
> With Wi-Fi off and no cable, `run-demo` started the app, the planet loaded
> and the sound played. Online, on the same laptop and image, the script
> reported the app ready in 1.2 s. This does not replace the check on the demo
> and backup laptops above.

## 3. Sound

- [ ] **Start screen**: the "Start listening" button unlocks audio; no silence on first interaction
- [ ] **Layers are recognisable (FR3)**: with eyes closed, a person outside the team says which layer is playing and whether its value is high or low, in **4 of 5** tries. Person 1: __/5 · Person 2: __/5
- [ ] **Solo layer without clipping**: with one layer active for **1 minute**, the output meter never reaches the maximum and the layer does not drop out. (The old FR4 test of four mixed layers was retired by the 2026-11-15 team decision: only the picked layer sounds.)
- [ ] **One layer at a time**: picking a layer plays only its voice; picking another one switches the sound to it; Earth (no layer) is silent
- [ ] **Latency (NFR2)**: from clicking or dragging the selected point in the regional map to the sound changing, **100 ms or less**: ______ ms
- [ ] **No clicks**: moving the cursor across the edge of the Amazon rectangle gives no audible jump
- [ ] **Left / right (FR3.4)**: moving the point across the screen moves the sound between the speakers

## 4. Picture and movement

- [ ] **Planet (FR5)**: opens on the 3D planet, which can be turned, with the layers visible
- [ ] **To the Amazon and back (FR5.2)**: each transition takes **2 s or less**, with no sound cut. Out: ____ s · Back: ____ s
- [ ] **Frame rate (NFR3)**: planet, transition, map and timeline at **30 fps or more**. Lowest seen: ____ fps
- [ ] **Timeline (FR7)**: the line under the planet plays by itself at the planet's pace (one turn = one day of smoke, 30 days of CO2, one year of lightning) and keeps playing on a drag, with Auto-rotate off and when zoomed into a region or on the map; **❚❚ Pause** stops it and **▶ Play** goes on from there; it sits centred under the planet; it starts at 4× (`1 turn = 4 days` for smoke), 8× doubles it and `1 turn = …` changes to match, and there is no 1× or 2×; clicking or dragging the line picks a moment and the playing goes on from there; the forest shows a dimmed line with its single period; picture and sound fade together from one instant to the next
- [ ] **Story mode (FR8)**: runs through forest, smoke and CO2 in **under 60 s**: ____ s. The text presents CO2 as global context, not as a measured effect of the Amazon

## 5. Accessibility (FR9)

- [ ] Every control works with the keyboard only (layers, timeline line: ←/→ one instant, Page Up/Down one turn, arrows move the listening point)
- [ ] With the system screen reader on, each layer and region is read with its value as low, medium or high
- [ ] A person completes story mode **without the mouse and with the screen reader on**

## 6. Stability (NFR5)

- [ ] **10 minutes** of continuous use without reloading the page and without losing the sound
- [ ] `./run-demo.sh --stop` and `./run-demo.sh` again: it starts again, still offline

## 7. The story lands (success criterion)

- [ ] At least **2 people outside the team**, after the demo, say in their own words: the forest is the base, wildfire smoke affects it, and the planet's CO2 is the context that makes it important to protect. Person 1: ☐ ☐ ☐ · Person 2: ☐ ☐ ☐

## 8. Backup plan ready

- [ ] Backup laptop passes sections 1 and 2
- [ ] Screen recording of a full run saved on both laptops and on a USB stick

## If something fails

| Symptom | What to do |
|---|---|
| "Docker is not running" | Start Docker Desktop and wait until it says it is running |
| "the app image is not built on this machine" | Reconnect the network and run `./run-demo.sh --build` |
| "something else is already using port 8080" | `./run-demo.sh --stop`; if it persists, close the program using port 8080 |
| Silence | Click "Start listening"; check the system volume and the selected output |
| Clicks or delay in the sound | Fewer active layers; see the sound engine plan B in `TAREAS.md` |
| Planet below 30 fps | Close other programs; plan B: fixed planet and direct switch to the map |
