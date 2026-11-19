# CLAUDE.md — VOLTLINE

Browser 3D arcade combat racer. Neon night city, every car has a roof gun. Drift to charge nitro,
shoot to clear the line, finish first. This file is the source of truth for how to build it.

## Your role
- **You write code only.** All art, audio and design data are already done and live in
  `public/assets/` and `data/`. Never create, redraw or replace models, textures or sounds,
  and never put placeholder art over real assets. If an asset seems missing or wrong, stop and ask.
- Read `public/assets/ASSETS.md` before touching anything that loads a model, texture or sound.
- Build **one milestone per session** (see Milestones). Stay inside its scope, and make sure the game
  runs and is playable at the end of every milestone.
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
10 vehicles: kestrel_gt, rhino_x4, wisp_r, warden_px (police), bastion_m8 (military), sable_rs (rally),
hauler_ht (pickup), truongson_av8 (8x8 APC, 8 wheels `wheel_1L…4R`), mantis_650r (sport bike + `rider`,
wheels `wheel_F/R`), mira_150 (retro scooter + `rider`, `wheel_F/R`, vehicleType bike). Car select keys 1–9 and 0. Branch on `vehicleType` (car | apc8x8 | bike); see ASSETS.md "Physics notes" —
the bike uses 4 virtual raycast wheels plus visual lean. Turret yaw limit = `turretYawDeg` in cars.json.
Emissive materials to drive at runtime: `Light_Tail` (brake), `Underglow` (player colour),
`Light_Siren_Red/Blue` (warden_px, alternate at ~2 Hz),
`Muzzle` (flash), and `lamp_1..5` on `start_gantry` (countdown).

## Game rules (numbers live in data/)
- Tracks: `cat_lai.json` (night, Cát Lái Port), `cong_hoa.json` (day), `xa_lo_ha_noi.json` (dusk) and `pham_van_dong.json` (monsoon storm).
  Xa lộ and Phạm Văn Đồng have elevation in the spline — build the road ribbon from 3D spline points and bank nothing. Track code is data-driven: one `Track` class builds
  road, dressing, lighting and ambient traffic from the JSON — no per-map code paths beyond `timeOfDay` and the optional `weather` block.
- Race: chosen track (Cát Lái Port, Cong Hoa Boulevard, Hanoi Highway or Pham Van Dong Boulevard), laps from the track JSON (3; Phạm Văn Đồng 2), 6 cars (1 player + 5 AI picked from the 10-vehicle garage), grid from `cat_lai.json`, 3-2-1-GO countdown.
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

## Game branding (VOLTLINE identity)
`branding/` holds the game's own logo, app icon and favicons (designed for VOLTLINE, safe to use anywhere).
- Copy `branding/` to `public/branding/` and paste `branding/head_snippet.html` into `index.html` `<head>` (favicon.svg + .ico, apple-touch icon, `site.webmanifest` for the PWA: fullscreen, landscape, maskable icon).
- Loading and Title screens show `voltline_logo_horizontal_on_dark.svg` (desktop 640 px / 360 px wide, mobile 300 px / 240 px) with the "a CraftMann app" endorsement under it.
- Use the SVGs as `<img>`; never re-type the wordmark in a font. Mono marks are for watermarks and one-colour UI.

## Sponsor brands
Emesoft, CaptureMann and CraftMann are real sponsor logos supplied by the owner (`brand/*.svg`). Never redraw, recolour, stretch or add effects to them; only use the shipped textures/models. Car liveries are baked into the GLBs (`decals` mesh). For maps, place the shipped `billboard_*` and `sponsor_banner_*` models where the track JSON says; when adding new maps, mix brands so neighbouring banners don't repeat. Don't invent other real brands.

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

## Milestones
| # | Scope | Done when |
|---|---|---|
| M0 | Vite scaffold, loop, input, Kestrel GT on a flat plane with Rapier raycast vehicle, chase camera, drift, nitro, lil-gui tuning | driving is fun on an empty plane at 60 fps |
| M1 | Track from `cat_lai.json`: road ribbon (`road_lanes.png`), barriers, checkpoints, laps, timer, countdown, reset | a solo 3-lap time trial works end to end |
| M2 | Pulse MG, rockets, pickups, HP and damage states, wreck + respawn, dummy targets | you can wreck a dummy and respawn cleanly |
| M3 | 5 AI rivals (drive + shoot + pickups), live positions | races are close; the AI wins about 50% |
| M4 | HUD, menu → car select → race → results, pause, settings, all SFX | a new player can play with no explanation |
| M5 | City dressing (buildings, cranes, tunnel, lights, water), all VFX, quality presets, perf pass, deploy | every MVP criterion passes |

## Out of scope for the MVP (don't build unless asked)
Multiplayer, career and upgrades, more tracks, dynamic weather changes (only Phạm Văn Đồng's fixed storm is in scope), paint editor, mobile touch controls,
leaderboards, music system.

## Deploy
Static build, deployed by GitHub Actions to Azure Static Web Apps (or Cloudflare Pages).
Give `/assets/*` long-term immutable cache headers.
