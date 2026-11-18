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
data/            cars.json weapons.json tracks/harbor.json (tuning only; keep the schema)
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
- Track = closed Catmull-Rom spline from `data/tracks/harbor.json`. Every along-track position is
  `t ∈ [0,1)` from the start line. Race position = `lap + t`; resolve ties by distance to the next checkpoint.
- A lap counts only if all 8 checkpoints were passed in order. Respawn puts the car on the spline
  at the last checkpoint, facing the tangent.

## Car rig (from the .glb files — don't rename)
`chassis`, `wheel_FL/FR/RL/RR` (spin around local X, front wheels steer around Y), `gun_mount`
(yaw around Y) › `gun` › `muzzle` (fire origin, +Z), `exhaust_L/R` (nitro flames).
Take collider half-extents, wheel positions, radius and width from `data/cars.json`.
Emissive materials to drive at runtime: `Light_Tail` (brake), `Underglow` (player colour),
`Muzzle` (flash), and `lamp_1..5` on `start_gantry` (countdown).

## Game rules (numbers live in data/)
- Race: Harbor Loop, 3 laps, 6 cars (1 player + 5 AI), grid from `harbor.json`, 3-2-1-GO countdown.
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
- HUD (top-left) position and lap/time · (top-centre) takedown banner · (top-right) round minimap ·
  (bottom-left) hull, MG heat, rockets · (bottom-right) speed, gear and 3 nitro bars.

## Performance budget (enforce it)
- 60 fps at 1080p on Apple M1 / Intel Iris Xe. Fewer than 150 draw calls, under 400k triangles on
  screen, first load under 5 s.
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
| M1 | Track from `harbor.json`: road ribbon (`road_lanes.png`), barriers, checkpoints, laps, timer, countdown, reset | a solo 3-lap time trial works end to end |
| M2 | Pulse MG, rockets, pickups, HP and damage states, wreck + respawn, dummy targets | you can wreck a dummy and respawn cleanly |
| M3 | 5 AI rivals (drive + shoot + pickups), live positions | races are close; the AI wins about 50% |
| M4 | HUD, menu → car select → race → results, pause, settings, all SFX | a new player can play with no explanation |
| M5 | City dressing (buildings, cranes, tunnel, lights, water), all VFX, quality presets, perf pass, deploy | every MVP criterion passes |

## Out of scope for the MVP (don't build unless asked)
Multiplayer, career and upgrades, more tracks, weather, paint and decals, mobile touch controls,
leaderboards, music system.

## Deploy
Static build, deployed by GitHub Actions to Azure Static Web Apps (or Cloudflare Pages).
Give `/assets/*` long-term immutable cache headers.
