# VOLTLINE

Browser 3D arcade combat racer. Neon night city, every car has a roof gun. Drift to charge nitro, shoot to clear the
line, finish first. Pick one of 10 vehicles and one of 4 maps, then race 5 AI rivals: 2-3 laps, pickups, rockets, wrecks
and respawns. Plays with keyboard, gamepad or touch (phones, landscape).

## Maps

| Map | Setting | Notes |
|---|---|---|
| Cat Lai Port | Night | Container yard, port gate, truck queue, quay cranes, a Reefer-lane shortcut |
| Cong Hoa Boulevard | Day | HCMC avenue with a median, landmarks and a U-turn |
| Hanoi Highway (Xa Lo Ha Noi) | Dusk | River bridge, underpass, metro viaduct, ambient traffic |
| Pham Van Dong Boulevard | Monsoon storm | 4.8 km, 2 laps. 12-lane boulevard with a tree median: out on the car lanes, back on the motorbike lanes with poncho scooters. Binh Loi bridge, a small hop at Go Dua, ring-road overpass, a U-turn flyover and a flooded dip. Weather: heavy rain (easing on lap 2), wet grip, 13 puddles, tyre spray, lightning and thunder |

Built with Vite + TypeScript (strict), three.js, Rapier (`DynamicRayCastVehicleController`), the Web Audio API and a
plain HTML/CSS overlay for the HUD and menus.

## Controls

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Throttle / brake | W / S | RT / LT |
| Steer | A / D | Left stick |
| Drift | Space | X |
| Nitro | Shift | A |
| Fire Pulse MG | J or left mouse | RB |
| Fire rocket | K or right mouse | LB |
| Reset to track | R | Y |
| Pause | Esc | Start |
| Restart race | Enter | Back |

Every menu works from the keyboard or gamepad (arrows, Enter, Esc, hotkey chips).

**Mobile:** landscape only (portrait shows a rotate screen). Default is on-screen pads with auto-gas; tilt and
swipe-wheel are in Settings. Phones default to the Low preset, a 1.5 DPR cap and no ambient traffic. Layout and sizes
come from `data/touch.json`.
## Commands

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # tsc --noEmit && vite build -> dist/
npm run preview    # serve the production build
npm run test       # Vitest unit tests
npm run lint       # ESLint + Prettier check
npx playwright test   # browser tests (starts the dev server itself)
```

Playwright needs a Chromium. Install one with `npx playwright install chromium`, or point at an existing binary with
`CHROMIUM_PATH=/path/to/chrome npx playwright test`. Tests run serially (software WebGL is slow).

Before finishing any change, `npm run build` and `npm run test` must pass and the browser console must stay clean.

## Dev URL parameters

- `?quick=1` skips the menus and starts a race with defaults.
- `?mode=practice` skips the menus and starts solo with dummy targets (no AI).
- `?car=<vehicle id>` picks the car for quick starts (e.g. `kestrel_gt`, `wisp_r`, `mantis_650r`).
- `?track=cat_lai|cong_hoa|xa_lo_ha_noi|pham_van_dong` picks the map for quick starts.

In dev builds `window.__voltline` exposes `debugState()` and test helpers used by the Playwright tests (fast-forward,
teleport, autopilot, collider and ray queries). They are not in production builds.

## Project layout

```
src/
  main.ts            boot: load assets -> menus -> race
  core/              Game, Loop (60 Hz fixed step), Events, Input, TouchInput, Assets, Settings, Data, Records
  world/             Track (spline -> road, barriers), TrackPath, Environment, Lighting, per-map dressing
                     (CatLai*, CongHoa*, XaLo*, Pvd*), Windowed/InstancedModel (draw-call budget)
  weather/           Map 4's storm: rain, wet road, puddles, flood, spray, lightning and rain audio
  vehicle/           Car, CarPhysics, CarVisual, ChaseCamera, Nitro, Turret
  combat/            Pulse MG, rockets, damage, pickups, CombatSystem
  ai/                RacingLine, AIDriver, AIGunner
  race/              RaceManager, Laps, Positions, Standings, Respawn
  fx/                Particles, Tracers, PostFX
  audio/             AudioBus (UI / music / game buses, underpass reverb), EngineSound, Sfx
  ui/                HUD, screens, results, minimap, name tags, touch HUD and rotate screen, styles
public/assets/       models/ textures/ sfx/ (the art and sound pack; code never edits these)
data/                tuning and design data (below)
tests/               Vitest unit tests (*.test.ts) and Playwright tests (*.spec.ts)
```

## Data-driven tuning (`data/*.json`)

Every gameplay number lives in data, not in TypeScript.

- `cars.json` - per-car stats, collider, wheel layout, HP, mass, grip, drift, nitro.
- `weapons.json` - Pulse MG, Hornet rockets, pickups, damage states, wreck/respawn rules.
- `handling.json` - driving model: suspension, engine, steering, grip/drift, nitro, camera.
- `combat.json` - muzzle offset, pickup radius, rocket pool, damage FX, camera shake, dummy targets.
- `ai.json` - AI steering, pace, rubber-banding, gunner behaviour, difficulty, the 5 rivals.
- `race.json` - countdown, track sampling, grid and AI race rules.
- `audio.json` - volumes, loop regions, one-shots, thresholds.
- `lighting.json` - hemisphere, moonlight and exposure.
- `ui_sounds.json` - menu event -> sound map.
- `touch.json` - touch control layout, sizes and mobile defaults.
- `tracks/cat_lai.json`, `tracks/cong_hoa.json`, `tracks/xa_lo_ha_noi.json`, `tracks/pham_van_dong.json` - spline,
  road layout, checkpoints, grid, pickups and dressing for each map. `pham_van_dong.json` also has an optional
  `weather` block (rain per lap, wet grip, puddles, flood zone, spray, lightning, audio); no other map has one.

## Performance budget

60 fps at 1080p on Apple M1 / Intel Iris Xe, under 150 draw calls, under 400k triangles on screen, first load under
5 s. Repeated props use `InstancedMesh`, particles/tracers/rockets are pooled, at most 4 dynamic lights.
Quality presets (Low / Medium / High) are in Settings. Far dressing is distance-culled and windowed to stay inside the
draw-call budget; Hanoi Highway near the start grid is the heaviest spot.

## Deployment

A static build (`dist/`) hosted on **AWS Amplify Hosting**.

- **Git-connected (recommended):** in the Amplify console choose *Hosting → Deploy from Git*, pick this repository and
  branch `main`. Amplify reads `amplify.yml` (Node 22, `npm ci`, `npm run build`, artifacts in `dist/`) and rebuilds on
  every push. The same file sets the headers: `/assets/**` is cached for a year (`immutable`), `/index.html` is
  `no-cache`, plus `nosniff`, a referrer policy and a CSP that allows only self, Google Fonts, `blob:` and WASM.
- **Asset filenames:** models, sounds and textures keep fixed names under `/assets/` and are cached for a year. When art
  or audio changes, rename the file or add a `?v=` query to its URL, or visitors will keep the old copy.
- **Other hosts:** `staticwebapp.config.json` (Azure Static Web Apps) and `public/_headers` (Cloudflare Pages) carry the
  same headers and are copied into `dist/`; they are harmless on Amplify.

## Credits

- Sound effects by [elevenlabs.io](https://elevenlabs.io/sound-effects/race-car) (free-plan attribution; files in
  `public/assets/sfx/elevenlabs/`).
- The models, textures and base sound pack in `public/assets/` are original assets made for this project.
