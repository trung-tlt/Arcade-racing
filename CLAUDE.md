# CLAUDE.md — VOLTLINE

Browser 3D arcade combat racer. Neon night city, every car has a roof gun. Drift to charge nitro,
shoot to clear the line, finish first. This file is the architecture and conventions guide for contributors and AI coding
assistants; the README covers setup and CONTRIBUTING.md covers the pull request rules.

## Your role

- **Code first.** The art, audio and design data already live in `public/assets/` and `data/`. Do not redraw, replace or
  re-generate existing models, textures or sounds, and never put placeholder art over real assets. If an asset seems
  missing or wrong, ask. New assets are welcome in pull requests, with their source and license stated.
- Read `public/assets/ASSETS.md` before touching anything that loads a model, texture or sound.
- Keep changes focused, and make sure the game runs and is playable after every change (the milestones below are the
  original build order and are all done).
- Every gameplay number comes from `data/*.json`. Don't hard-code tuning values in TypeScript.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # tsc --noEmit && vite build → dist/
npm run preview    # serve the production build
npm run test       # Vitest unit tests
npm run lint       # ESLint + Prettier check
```

Before you finish any task: `npm run build` and `npm run test` must pass with zero errors, and
nothing new may appear in the browser console.

## Stack (do not swap without asking)

- Vite + TypeScript (`strict: true`; no `any`, no `@ts-ignore`)
- three.js — rendering, `GLTFLoader`, `EffectComposer` + `UnrealBloomPass`
- `@dimforge/rapier3d-compat` — physics, using `DynamicRayCastVehicleController` for cars
- Web Audio API (no audio library), HTML/CSS overlay for HUD and menus (no UI framework)
- `lil-gui` (dev only) for live tuning, `stats.js` (dev only)
- Vitest for logic tests, one Playwright smoke test (boots the game and drives for 5 s)

## Repo layout

```
src/
  main.ts                 boot: load assets → menu
  core/     Game.ts Loop.ts Events.ts Input.ts Assets.ts Settings.ts
  world/    Track.ts (spline → road/barrier meshes) Props.ts Lighting.ts Environment.ts
  vehicle/  Car.ts CarPhysics.ts CarVisual.ts ChaseCamera.ts
  combat/   PulseMG.ts Rockets.ts Damage.ts Pickups.ts
  ai/       RacingLine.ts AIDriver.ts AIGunner.ts
  race/     RaceManager.ts Laps.ts Positions.ts Respawn.ts
  fx/       Particles.ts Tracers.ts Skidmarks.ts PostFX.ts
  audio/    AudioBus.ts EngineSound.ts Sfx.ts
  ui/       hud.ts menus.ts results.ts styles.css
public/assets/   models/ textures/ sfx/ ASSETS.md      (read-only for you)
data/            cars.json weapons.json tracks/cat_lai.json (tuning only; keep the schema)
tests/           *.test.ts, smoke.spec.ts
```

## Architecture rules

- **Fixed timestep:** physics and gameplay step at 60 Hz with an accumulator. Rendering interpolates
  and runs at display rate. Clamp frame delta to 0.1 s so a backgrounded tab doesn't explode the game.
- **Systems over inheritance:** each module owns one concern. They talk through a typed event bus
  (`Events.ts`, e.g. `carHit`, `carWrecked`, `checkpoint`, `lapComplete`, `pickupTaken`) — no global
  singletons except `Game`.
- **Player and AI cars are the same `Car` class.** Only the controller differs:
  `InputController` vs `AIController`, both producing `{throttle, brake, steer, drift, nitro, fire, fireSecondary}`.
- Keep game logic pure and testable (laps, positions, damage, heat, pickups) and away from three.js and Rapier.
- **Assets:** load everything once through `Assets.ts` with a progress bar, then `clone()` it.
  Clone materials per car instance before you tint them or apply damage effects.
- **Disposal:** leaving a race disposes geometries, materials, textures and the Rapier world.
  Restarting a race 20 times in a row must not grow memory.

## World conventions

- Meters, **+Y up, +Z forward** (glTF convention). The chase camera sits behind the car on its −Z side.
- Track = closed Catmull-Rom spline from `data/tracks/cat_lai.json`. Every along-track position is
  `t ∈ [0,1)` from the start line. Race position = `lap + t`; resolve ties by distance to the next checkpoint.
- A lap counts only if all 8 checkpoints were passed in order. Respawn puts the car on the spline
  at the last checkpoint, facing the tangent.

## Vehicle rig (from the .glb files — don't rename)

`chassis`, `wheel_*` (names and steer flags in cars.json; cars use `wheel_FL/FR/RL/RR`) (spin around local X, front wheels steer around Y), `gun_mount`
(yaw around Y) › `gun` › `muzzle` (fire origin, +Z), `exhaust_L/R` (nitro flames).
Take collider half-extents, wheel positions, radius and width from `data/cars.json`.
11 vehicles: kestrel_gt, rhino_x4, wisp_r, warden_px (police), velora_s (speedster), raijin_rx (silver AWD tuner coupe, quad round tail lamps),
bento_ev (city EV), truongson_av8 (8x8 APC, 8 wheels `wheel_1L…4R`), mantis_650r (sport bike + armoured `rider` in digital camo,
wheels `wheel_F/R`), mira_150 (retro scooter + `rider`, `wheel_F/R`, vehicleType bike), fulmine_fx (open-wheel racer, `openWheel: true`, `downforce`). Car select keys 1–9, 0 and - (minus). Branch on `vehicleType` (car | apc8x8 | bike); see ASSETS.md "Physics notes" —
the bike uses 4 virtual raycast wheels plus visual lean. Turret yaw limit = `turretYawDeg` in cars.json.
Emissive materials to drive at runtime: `Light_Tail` (brake), `Underglow` (player colour),
`Light_Siren_Red/Blue` (warden_px, alternate at ~2 Hz),
`Muzzle` (flash), and `lamp_1..5` on `start_gantry` (countdown).

**Hidden maps:** Cong Hoa, Hanoi (Xa lộ) and Pham Van Dong are hidden for now (`HIDDEN_TRACK_IDS` in `Data.ts`): `TRACKS` (menus, online lobby, server room validation) lists only the visible maps; `ALL_TRACKS` and `getTrack` still reach them, and `?track=<id>` opens them in dev. To show one again, remove its id from `HIDDEN_TRACK_IDS`.

## Game rules (numbers live in data/)

- Tracks: `cat_lai.json` (v2: daylight, the real Cát Lái container terminal, 3.6 km counter-clockwise; see "Cát Lái Port v2 (Map 1)" below), `cong_hoa.json` (day), `xa_lo_ha_noi.json` (dusk), `pham_van_dong.json` (monsoon storm), `monte_carlo.json` (Riviera daylight street circuit) and `ardennes.json` (Ardennes forest circuit, daylight).
  Cát Lái is flat but 2 m above the physics ground plane (`hasElevation` is true: the road ribbon is the driving surface and the river is at y = 0). Xa lộ, Phạm Văn Đồng, Monte-Carlo and Ardennes have elevation in the spline — build the road ribbon from 3D spline points and bank nothing. Track code is data-driven: one `Track` class builds
  road, dressing, lighting and ambient traffic from the JSON — no per-map code paths beyond `timeOfDay` and the optional `weather` block.
- Race: chosen track (Cát Lái Port, Cong Hoa Boulevard, Hanoi Highway Pham Van Dong Boulevard, Monte-Carlo Harbour, Ardennes Forest Circuit or Suzuka Hills Circuit), laps from the track JSON (3; Phạm Văn Đồng and Ardennes 2), 6 cars (1 player + 5 AI picked from the 11-vehicle garage; on Monte-Carlo AI prefer fulmine_fx in different liveries), grid from the track JSON (`startLine.grid`), 3-2-1-GO countdown.
- Nitro: up to 3 bars. Bars are earned by drifting, near-misses, MG hits (+2% per hit), takedowns
  (+1 bar) and nitro pickups.
- Pulse MG: hitscan, 10 shots/s, 4 damage, 8° soft auto-aim cone, 120 m range. Heat locks the gun
  for 1.5 s after 3 s of firing.
- Hornet rockets: from pickups, 2 per pickup, mild homing, 40 damage, 6 m splash.
- Damage: hull HP per car. Below 60% → smoke, below 30% → sparks and fire, at 0 → wreck. A wreck
  explodes, respawns after 2 s with 2 s of invulnerability, and gives the attacker +250 score and +1 nitro bar.
- Guns are disabled while airborne (bridge jump).
- AI follows the spline with lookahead steering and per-car lane offsets, plus mild rubber-banding.
  It fires when a target is inside its cone and grabs pickups near its line. Target: on default
  difficulty the AI wins about 50% of races.

## Controls

Keyboard: W/S throttle/brake, A/D steer, Space drift, Shift nitro, J or left mouse fire MG,
K or right mouse rocket, R reset to track, Esc pause.
Gamepad (standard mapping): RT/LT, left stick, X drift, A nitro, RB fire, LB rocket, Y reset, Start pause.
All bindings go through one action map in `Input.ts`.

## Look & feel

- Palette: night `#0E1116`, asphalt `#2A3240`, player/nitro `#FF6A1A`, neon/UI `#2EC5FF`,
  enemy/damage `#FF3D6E`, pickups `#C6FF3D`. UI fonts: Space Grotesk (headings) and Inter (body).
- Lighting: hemisphere (`#1B2A4A` / `#0E1116`) plus one directional moonlight with a single
  2048 shadow map that follows the player. Exponential fog `#0E1116` at density 0.006.
  ACES filmic tone mapping. Bloom strength 0.8, threshold 0.6.
- Speed feel: FOV 70 → 85 on nitro, camera lag, screen shake on hits and wrecks, speed lines.
- Screens: follow the design canvas artboards 09–19 (flow: Loading → Title → Car select → Race setup →
  Countdown → Racing ⇄ Pause / Wrecked → Results). Each maps to one `GameState`.
- **Keyboard-first menus (required):** every menu works without a mouse. ↑/↓ move focus, ←/→ change
  values, Enter/Space confirm, Esc/Backspace go back. Every button shows its hotkey chip (e.g. RACE
  `Enter`/`R`, GARAGE `G`, SETTINGS `S`, CONTROLS `C`, pause: `Esc` resume, `R` restart, `Q` quit;
  results: `Enter` race again, `C` change car, `M` menu; car select: `←`/`→` or `1`–`9`). Implement
  one `MenuInput` that maps keys and gamepad (D-pad, A = confirm, B = back) to the same actions. Show a
  visible focus ring and a bottom key-hint bar on every screen, as on the design canvas artboards 09–19.
- **Menu audio (required):** every menu action makes a sound and menus have music. Use `data/ui_sounds.json`
  for the event → sound map (move, confirm, back, blocked, toggles, slider, vehicle switch/confirm, track switch,
  start race, title sting, countdown). One `AudioBus` with UI / music / game buses tied to the Settings volumes;
  unlock audio on the first input; menu music loops across menu screens and fades out on START RACE.
- **Mobile (required for M4+):** landscape-only on phones (portrait shows a rotate screen), designed at 844×390
  CSS px with 44 px side safe areas (`env(safe-area-inset-*)`). Touch controls write the same action object as
  keyboard/gamepad via a `TouchInput` (pointer events, multi-touch, capture). Default scheme: ◀ ▶ pads bottom-left
  (78 px), FIRE 92 px / rocket / nitro / brake arc bottom-right, drift above the left pads, pause top-centre;
  alternatives: tilt (DeviceOrientation, ask permission on iOS) and swipe-wheel. Auto-gas ON by default.
  Touch targets ≥ 48 px. Mobile defaults: Low preset, DPR cap 1.5, ambient traffic off. Follow canvas artboards 25–32.
- HUD (top-left) position and lap/time · (top-centre) takedown banner · (top-right) round minimap ·
  (bottom-left) hull, MG heat, rockets · (bottom-right) speed, gear and 3 nitro bars.

## Weather (Map 4 only)

`pham_van_dong.json` has a `weather` block; every other track has none, so the code must treat it as optional.

- **Rain:** GPU particles (instanced quads or LineSegments) in a box that follows the camera, using `fx_rain_streaks.png`. Use 6000 particles on desktop and 1500 on mobile. Intensity is per lap: `rain.intensity[lap]`.
- **Wet road:** set the road material to roughness 0.22 and metalness 0.15, with an envMap. Grip multiplies by `grip.wetMul` everywhere.
- **Puddles:** flat decals (`pvd_puddle.png`) placed at `{t, lateralM, radiusM}`. Entering one applies `puddleMul` grip for 0.4 s, a small yaw kick, `fx_splash` and `sfx/splash.wav`.
- **Flood:** between `flood.fromT` and `flood.toT`, add a water plane at `waterY`, then apply `floodMul` grip and `dragMul` drag and throw a bow-wave spray.
- **Spray:** each car above 60 km/h emits `fx_splash` sprites behind its rear wheels.
- **Lightning:** a timer of `lightning.everySec` triggers a hemi-light boost (double flash), a bolt sprite on the skyline, then `sfx/thunder.wav` after a delay.
- **Audio:** `sfx/rain_loop.wav` loops, with volume taken from rain intensity. Halve it under the bridge and the overpass.
- **Performance:** on the Low preset, no spray sprites and 1500 rain particles. Puddles stay, because they matter for gameplay.

## Monte-Carlo Harbour (Map 5)

- **Width 12 m**, Armco + catch fence both sides: wall hits cost hull −8 and speed ×0.6; glancing scrapes (< 15°) −2 with sparks.
- **No-fire zones:** `noFireZones` (tunnel, Nouvelle Chicane). Weapons can't fire there; show a lock icon on the HUD. Make this a generic track-JSON feature.
- **Start:** `startLine.lights` — light `start_light_1..5` one per second, random 0.2–3 s hold, all out = GO (replaces 3-2-1 on this map). Jump start = 3 s penalty.
- **Tunnel:** exposure −1.5 EV inside, bloom flare at the exit, all car audio through a ConvolverNode with `sfx/monaco/tunnel_ir.wav`.
- **Water:** `three/addons/objects/Water.js` (planar reflection, 512² on Medium, off on Low → plain MeshStandardMaterial with `mc_sea`). Sky: `three/addons/objects/Sky.js`, also PMREM'd for the environment map.
- **Instancing:** Armco/fence/kerb/palms/yachts/buildings are InstancedMesh per model; the whole map must stay inside the 350 draw-call budget.
- **Audio:** ambience/crowd zones and events from `audio`; the helicopter follows the leader; yacht horn when P1 crosses the line.

## Cát Lái Port v2 (Map 1, daylight, real layout)

- **Code:** `src/world/CatLai.ts` (scene) + `src/world/catLaiLayout.ts` (pure, tested in `tests/catLaiTrack.test.ts`, browser spec `tests/catLai.spec.ts`); props are lazy-loaded from `main.ts` (`CAT_LAI_MODELS` / `CAT_LAI_SHARED_MODELS` / `CAT_LAI_TEXTURES`). The generic `Track` builds the road ribbon, kerbs, walls, checkpoint gates and the start gantry; Map 1 adds nothing there but three data-driven hooks in `loadTrack`: `widthByT` (the varying carriageway width from `roadWidthM.byT`, read by `roadWidthAt`), a `widthProfile` entry with `worldTileM` (the port's concrete road, tiled in world space) and `sidewalkT` (kerb and sidewalk on Nguyễn Thị Định and the link only). `blockedLane: 'left'` keeps the rivals out of the parked truck queue (the older maps' queues were on the right).
- **Layout is the data's:** the spline is flat at y = 2 (the road ribbon is the driving surface, `hasElevation` is true), the river at y = 0, drive on the right, counter-clockwise. The game drives `relaxTightBends(spline)`; the design placements were authored against the raw spline, so `dropOnRoad` filters every prop against the real carriageway (`RoadIndex` + `roadWidthAt`): a prop's footprint must stay 0.5 m clear (crane legs may reach 1.8 m past the edge: the invisible wall is what the car meets; 3 of the 20 STS cranes stand on the lane's bends and are dropped). The queue, scooters, people, the quay-edge kit and Gate B are on the road by design; the queue is kept off the start grid.
- **Ground:** river plane (y = 0, `catlai2_river` + ripple normals scrolling), the land polygon, the port slab and the far bank are flat layers that do not write depth (they draw in order, river first), so nothing z-fights at 700 m; the quay wall runs from the shoreline down to -3 m. Custom gradient sky dome (`lighting.sky`, never Sky.js, it washes out) that follows the camera and is baked into the environment map. Exposure, sun and fog come straight from the JSON (`sunDirection(azimuth, elevation)` in `Data.ts`).
- **Static props** (`BakeGrid`): baked per material per cell, one class per cell size and window (big 300 m, cranes 300 m, yard 160 m, street 120 m, furniture 60 m, scooters and trucks 40 m), each cell behind a `DistanceCull`. Lamps lose their glow and two-sided plain parts are flipped so a cell costs a handful of draws; the eight tube-house variants share one atlas draw.
- **Containers:** `yardBlocks` become ~10,300 stacks / ~35,400 boxes (row pitch 2.6 m, bay pitch length + 0.4 m, tier 2.6 m), tinted per instance from `containerColours` (x0.85-1.1). Near the camera every tier is an instance; farther out a stack is one box scaled to its height (98.5 % wide, so it hides inside the near boxes). Per size, one InstancedMesh per range, windowed by `WedgeWindow` (only what is within the radius AND in front of the camera: 800 m far / 260 m near on High, 700 / 210 on Medium, 500 / 170 on Low).
- **Colliders:** `planColliders` makes ~350 cuboids: STS and RTG legs, Gate B's outer booth islands (the three around the centre line are drive-through: six cars on one lane wedged against them, and the shifted gate puts a lane on the centre line), houses, poles, masts, oil tanks, the CFS warehouses and port office, reach stackers and terminal tractors, and one cuboid per container block near the road. Cars cannot leave the carriageway (the generic walls), so the quay edge needs no barrier. `data/colliders/cat_lai.json` is baked from the browser world (`scripts/bake-colliders.mjs cat_lai`, ~1 MB); re-bake after changing any of this.
- **Soft things:** scooters and people are visual only (no colliders, not even sensors): the pack allowed "push + slow", which the shared sim has no kinematic body for yet.
- **Surroundings:** `cat_lai_osm.json` roads become asphalt strips (pieces on the lap's own road or in the port are skipped), tube houses line residential / primary roads (21 m deep, facade to the road, skipped where the back would meet another road), the building "footprints" are single points in this file and become boxes by type, trees on open land at least 10 m from any road, a far-bank strip and the Thu Duc towers. Map data (c) OpenStreetMap contributors, ODbL: the credits screen carries it.
- **Ferry:** two `car_ferry` boats on the 240 s Cát Lái crossing (sail 45 %, load 5 %, back, load), half a cycle apart.
- **Sponsors:** the JSON lists none; `planBillboards` puts the four `props_xalo/billboard_*` (brands alternating) along Nguyễn Thị Định and the link, facing the oncoming driver, and the houses within 15 m of one make way.
- **AI:** rivals hold the centre line from 90 m before the Gate B section (`GATE_LEAD_M`); the left pickup lane sits a metre inside the truck queue.
- **Budget (software GL, High):** 117 draw calls and ~317k world triangles at the worst spot (the start straight, 5 rivals around), 250-330k triangles elsewhere; the game's own counter (shadow pass and rivals included) reads 399k there, 262k on the quay.

## Ardennes Forest Circuit (Map 6)

- **Code:** `src/world/Ardennes.ts` (scene) + `src/world/ardennesLayout.ts` (pure, tested in `tests/ardennesTrack.test.ts`); props are lazy-loaded from `main.ts` (`ARDENNES_MODELS` / `ARDENNES_TEXTURES`, ~5 MB). The generic `Track` builds the road ribbon from the 3D spline; the Armco face lines up with the generic side-wall collider at `barriers.armco.lateralM` (19.5 m) on both sides of the whole lap (the JSON's 3 m set-back at Eau Rouge / the pit straight is not modelled: one wall offset everywhere, same hull -8 / speed x0.6 rules as Map 5).
- **Terrain:** `spa_terrain_height.png` decoded in the browser (`height = (R*256+G)/65535*260-30`), a 16 m grid (257 x 163 vertices) in 6 frustum-culled chunks, vertex colours from the forest mask + splat over a tiled `spa_grass`. The grid follows the road height minus 0.35 m within 24 m of the centre line and blends to the natural hills by 52 m. The reachable part (36 m either side of the road) is a Rapier trimesh (`scenery` in the baked colliders, so the headless server rebuilds it); the generic ground plane at y = 0 stays far below.
- **Forest:** deterministic one-tree-per-cell sampling on the forest mask (jittered, tinted per instance), rebuilt every 150 m of camera travel and only submitted inside the camera's view wedge (60 degrees either side). Every tree is a `spruce_hq` alpha-card spruce (two variants, 300-440 tris): the 1,218-triangle cone spruces would blow the triangle budget in dense forest. Medium plants one per ~120 m² out to 160 m and one per ~480 m² out to 340 m; `forest_card_40m` rings continue to the horizon and the `ardennes_ridges` cylinder follows the camera. Grass tufts within 150 m (no rocks: one draw call each). Low and High scale the radii and density.
- **Draw calls:** the grid start (6 cars, shadow pass included) measures 345 draw calls, Monte-Carlo 344. Static props (signs, bridges, stands, pits, tecpro, tyre walls, fence, Armco sponsor panels and every placement group but kerbs / grass / crowds) are baked per material into 600 m chunks (`StaticBake`, offset so the pit straight is one chunk); plain Armco, kerbs, grass and crowds are windowed instanced sets. Plain two-sided parts (flags, tent cloth) get a flipped triangle copy so they merge.
- **Placements:** `data/tracks/ardennes_placements.json` (2,193 objects, 10 groups) is baked into the static chunks (kerbs, grass and crowds: windowed instances). Y = road height at `t` (`y: "road"`) or the carved ground.
- **Start:** the gantry and the five-light sequence reuse Map 5's `StartGantry`; it stands at path t = 0 (the lap line), not at `startLine.t` (the grid is staged behind t = 0).
- **Not built:** the lap-2 shower (rain, wet grip, mist) is a design brief only: `loadTrack` leaves `weather` null for `type: "changeable"`, so the shared sim never sees it.

## Suzuka Hills Circuit (Map 7)

- **Code:** `src/world/Suzuka.ts` (scene) + `suzukaLayout.ts` (pure: placement heights, the camera window, terrain colours) + `suzukaSurroundings.ts` (OpenStreetMap roads, car parks, ponds, buildings); `src/audio/SuzukaAudio.ts`. Tests: `tests/suzukaTrack.test.ts`, `tests/suzukaLayout.test.ts`. The props (37 GLBs), textures, sounds and the two big JSON files (`public/assets/tracks/suzuka_hills_placements.json`, 2.6 MB, and `..._osm.json`) are fetched the first time the map is raced (`main.ts`: `loadSuzukaData()` then `assets.extend`).
- **Figure-eight:** the spline crosses itself 8.5 m above the road underneath. Nothing special is needed in the sim: the road ribbon is one trimesh with both legs, and along-track progress uses `TrackPath.project(x, z, hintT)` with the car's previous `t`, never the nearest point of the whole lap. A teleport that moves a car further than the search window must also set its `t` (the fall recovery would otherwise "recover" it).
- **Start line:** the design's spline starts on the back straight and puts the start line at `startLine.t` = 0.057. With `rotateToStartLine` in the JSON, `src/core/startLine.ts` rotates the spline to the nearest control point and shifts every along-track `t` (checkpoints, pickups, corners, no-fire zones, widths, kerbs, crossover, pit lane), so the lap line, grid, gantry and pit straight agree. `raw.startShiftT` is the shift: the placements keep world x/z but list design `t`s, so road heights use `t - startShiftT`.
- **Widths:** `width` is a stepped list by section; `widthStepTable` turns it into the `[t, w]` table `roadWidthAt` already reads (each change is reached 40 m after its start). `barriers.armco.lateralM` (16.3) was added to the data so the invisible side walls stand where most of the Armco does; it also marks the map as a circuit (no generic sidewalk strip: that cost 94k triangles).
- **Terrain:** `suzuka_terrain_height.png` (4 m/px, `(R*256+G)/65535*160-10`) on a 16 m grid in frustum-culled chunks, vertex colours from `suzuka_landcover.png` (R forest, G paddy, B built-up, A = 255 minus water). The drawn ground is a flat shelf 0.35 m under the road out to 24 m, blending to the hills by 52 m; the road leg is the nearest in plan, except within 110 m of the crossover, where height counts too (its legs are 8.5 m apart). **There is no terrain collider:** a 16 m grid under a hillside road made ridges poking through the road (cars took off, the client and server diverged, AI cars got stuck). `barriers.armco.driveToWall` makes the road collider itself extend flat out to the invisible side walls (16.3 m), so run-off is drivable at road level.
- **Look:** the design's sky (turbidity 10, mie 0.008) whites the whole screen out when the road points at the sun, so the JSON values were toned down and the sky shader's output is capped at 1.8 (`SKY_MAX`); the sun is still low and warm. The sun azimuth in the JSON is a compass bearing (from north, clockwise; z = -north): `loadTrack` converts it for `sunDirection` when the sky is `physicalSky`. The three.js `Sky` follows the camera (the camera's far plane is 1.5 km, so the design's 11 km mountain cylinder is a 1.3 km band that follows the camera), and a PMREM of the sky is the scene environment at 0.3 intensity.
- **Props:** 27,000 placements are windowed per model (`suzukaLayout.ts`: radius, cap, view wedge, deterministic thinning with distance; trees are ~350 triangle cards). Measured: 180 to 230 draw calls and 200k to 313k triangles around the lap (6 cars).
- **Not built:** the monorail beams and power-line wires from the OSM data, the Ise Bay sea plane, the LED rim glow of the wheel, and sound at the shrines.

## Online multiplayer UI (v1)

Design: canvas boards 40–48 (spec, then Online hub, Lobby, name tags and Online results for desktop and phone). Every state can be clicked through in Play. The data lives in `data/online_ui.json`: colours, room-code alphabet, ping thresholds, name-tag numbers, the lobby and rematch rules, the sound for each event, and every UI string. The icons are in `ui/icons/*.svg`.

- **Entry:** the title screen has ONLINE (`O`; on phone it is the row under RACE).
- **Hub:** shows errors in place, never in pop-ups. The states are searching, found, room full, update needed, server down, bad code and no rooms. The room-code input accepts only `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, upper-cases what's typed, takes 6 characters and is shown as `XXX·XXX`.
- **Lobby:** only the host can start, and only when there are at least 2 players and every present player is ready. Guests see the track and laps locked. If the host leaves, the lowest slot number becomes host. Ready uses `Space`; Copy shows "Copied!" for 1.6 s.
- **Name tags:** follow `nameTags` exactly. Show a tag within 60 m only when it is on screen and not occluded. Fade it from 25 m to 60 m and scale it from 1.0 to 0.8. Cap tags at 5 on desktop and 3 on phone; stack overlapping tags and dim tags near the reticle. Own car never gets a tag. Rivals are pink, you are orange (only in replays and spectate), and teammates are cyan (later). Tags are DOM or canvas 2D over the WebGL canvas, not 3D sprites, so the text stays sharp.
- **Results:** the rematch vote uses a 30 s timer. If every connected player votes yes, go to the countdown; otherwise everyone returns to the lobby. A player who left shows DNF with the disconnected icon.
- **v1.1 (boards 49–55):**
  - **Name entry:** shown on the first ONLINE when no name is stored; afterwards reached from Edit name (`N`). The rules are in `online_ui.json → name`.
  - **Online loading:** follow `loading`. The "starting anyway" wording comes in two versions: use `.join` if late loaders join the race, `.drop` if the server leaves them out.
  - **Finished, waiting:** follow `finished`. Pause stays available.
  - **Hub states:** connection lost (in a lobby, race or results), race already started, and room closed.
  - **Lobby:** a "need at least 2 racers" line and a host-change notice.
  - **Searching:** shows elapsed time only.
- **Still not designed:** per-player tints, ping in the HUD, and the reconnecting banner. The disconnected tag variant is already designed on board 40.

## Driver FPV (cockpit view)

- Camera cycle with **V**: chase → hood → cockpit. **H** cycles HUD full / minimal / off. **C** looks back.
- `cars.json[*].fpv`: `mode` is `cockpit` (7 cars) or `helmet` (Mantis, Mira, AV8, Fulmine — open cockpit, so the halo stays visible); `eye` = camera position in car space; `fovDeg`; `tint` = paint/accent for the rig.
- Cockpit mode: load `models/cars/cockpit_rig.glb` once, clone per player car, set `Cockpit_Paint`/`Cockpit_Accent` colours from `fpv.tint`, parent it to the car at `fpv.eye`, hide the car's own meshes. Rotate `steering_wheel` by steer × 2.4 rad (hands are children).
- Mirror: render a 512×128 camera at `rear_mirror_cam` (looking −Z) into a WebGLRenderTarget, map it (flipped on X) onto `Mirror_Glass`. 30 fps; 15 fps 256×64 on Low.
- `Dash_Screen`: replace its texture with a CanvasTexture you redraw at 10 Hz (speed, gear, RPM arc, nitro bars).
- Render the cockpit on its own layer after the world, near plane 0.03 m. Tracers in FPV start at `muzzle_fpv`.
- Visor HUD layout, colours and camera feel (FOV +6° on nitro, head lag, lean, look-to-apex, shake): canvas boards 36–37.

## Game branding (VOLTLINE identity)

`branding/` holds the game's own logo, app icon and favicons (designed for VOLTLINE, safe to use anywhere).

- Copy `branding/` to `public/branding/` and paste `branding/head_snippet.html` into `index.html` `<head>` (favicon.svg + .ico, apple-touch icon, `site.webmanifest` for the PWA: fullscreen, landscape, maskable icon).
- Loading and Title screens show `voltline_logo_horizontal_on_dark.svg` (desktop 640 px / 360 px wide, mobile 300 px / 240 px) with the "a CraftMann app" endorsement under it.
- Use the SVGs as `<img>`; never re-type the wordmark in a font. Mono marks are for watermarks and one-colour UI.

## Sponsor brands

Emesoft, CaptureMann and CraftMann are real sponsor logos (`public/assets/brand/*.svg`); they are trademarks and are not covered by the MIT license (see `NOTICE.md`). Never redraw, recolour, stretch or add effects to them; only use the shipped textures/models. Car liveries are baked into the GLBs (`decals` mesh). For maps, place the shipped `billboard_*` and `sponsor_banner_*` models where the track JSON says; when adding new maps, mix brands so neighbouring banners don't repeat. Don't invent other real brands.

**Studio endorsement:** VOLTLINE is "a CraftMann app". Show `brand/endorsement_craftmann_app_on_dark.svg` (use `_on_light` only on light backgrounds) directly under the VOLTLINE wordmark on the Loading and Title screens, desktop and mobile (mobile: also the rotate-device screen). Keep it at least 120 px wide, unaltered, no tint or effects, and never larger than the VOLTLINE wordmark.

## Performance budget (enforce it)

- 60 fps at 1080p on Apple M1 / Intel Iris Xe. Fewer than 350 draw calls (6 detailed cars are ~210 of them), under 400k triangles on
  screen, first load under 5 s (load the 6 race cars + the chosen track only; lazy-load the rest).
- Cars are ~13k tris (AV8 ~27k). Share materials between copies of the same car; on Low, swap physical (clearcoat) materials for standard ones.
- Use `InstancedMesh` for barriers, streetlights, containers and tunnel segments. Merge static
  track meshes per material.
- Allow at most 4 dynamic lights. Glow comes from emissive materials + bloom, not real lights.
- Pool particles, tracers and rockets. No allocation in the hot loop (reuse vectors and quaternions).
- Offer quality presets (Low/Med/High) for shadows, bloom, pixel ratio and particle counts.

## Testing

- Unit test the pure logic: lap/checkpoint order, race positions, damage states, MG heat, nitro
  bars, pickup respawn, data-file schema validation.
- Smoke test: the game boots, a race starts, the car drives forward for 5 s, and no console errors appear.
- After changing driving physics, play-test it in `npm run dev` and say what you tuned and why.

## Milestones (the original build order; all done)

| #   | Scope                                                                                                                          | Done when                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| M0  | Vite scaffold, loop, input, Kestrel GT on a flat plane with Rapier raycast vehicle, chase camera, drift, nitro, lil-gui tuning | driving is fun on an empty plane at 60 fps |
| M1  | Track from `cat_lai.json`: road ribbon (`road_lanes.png`), barriers, checkpoints, laps, timer, countdown, reset                | a solo 3-lap time trial works end to end   |
| M2  | Pulse MG, rockets, pickups, HP and damage states, wreck + respawn, dummy targets                                               | you can wreck a dummy and respawn cleanly  |
| M3  | 5 AI rivals (drive + shoot + pickups), live positions                                                                          | races are close; the AI wins about 50%     |
| M4  | HUD, menu → car select → race → results, pause, settings, all SFX                                                              | a new player can play with no explanation  |
| M5  | City dressing (buildings, cranes, tunnel, lights, water), all VFX, quality presets, perf pass, deploy                          | every MVP criterion passes                 |

## Not built yet (open an issue before starting)

Career and upgrades, a paint editor, leaderboards, accounts, reconnecting into a race in progress, per-player tints online,
dynamic weather beyond Phạm Văn Đồng's storm. Multiplayer (v1) is built: see `docs/multiplayer-release-plan.md`.

## Deploy

The game is a static build (`dist/`): `amplify.yml` for AWS Amplify, `public/_headers` for Cloudflare Pages / Netlify. Give
`/assets/*` long-term immutable cache headers. The online race server is a separate Node process: `docs/server-deploy.md`.
The Content-Security-Policy `connect-src` must list the race server's `wss://` origin.

## Online testing without a human

`npm run netlab` (docs/netlab.md): real browsers race on a real server through an impaired link and report the F9 numbers; use it to A/B any net change (`--params`) and compare against `netlab-baseline.json`. Server telemetry: `scripts/netlog-summary.mjs`.
