# VOLTLINE

Browser 3D arcade combat racer. Neon night city, every car has a roof gun. Drift to charge nitro, shoot to clear the
line, finish first. Race the Harbor Loop against 5 AI rivals: 3 laps, pickups, rockets, wrecks and respawns.

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
- `?car=kestrel_gt|rhino_x4|wisp_r` picks the car for quick starts.

In dev builds `window.__voltline` exposes `debugState()` and test helpers used by the Playwright tests.

## Project layout

```
src/
  main.ts            boot: load assets -> menus -> race
  core/              Game, Loop (60 Hz fixed step), Events, Input, Assets, Settings, Data, Records
  world/             Track (spline -> road, barriers, gates, ramp), Environment, Lighting
  vehicle/           Car, CarPhysics, CarVisual, ChaseCamera, Nitro
  combat/            Pulse MG, rockets, damage, pickups, CombatSystem
  ai/                RacingLine, AIDriver, AIGunner
  race/              RaceManager, Laps, Positions, Standings, Respawn
  fx/                Particles, Tracers, PostFX
  audio/             AudioBus, EngineSound, Sfx
  ui/                HUD, menus, results, minimap, name tags, styles
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
- `tracks/harbor.json` - Harbor Loop spline, checkpoints, grid, pickups, ramp, tunnel, dressing hints.

## Performance budget

60 fps at 1080p on Apple M1 / Intel Iris Xe, under 150 draw calls, under 400k triangles on screen, first load under
5 s. Repeated props use `InstancedMesh`, particles/tracers/rockets are pooled, at most 4 dynamic lights.
Quality presets (Low / Medium / High) are in Settings.

## Deployment

A static build (`dist/`) hosted on **AWS Amplify Hosting**.

- **Git-connected (recommended):** in the Amplify console choose *Hosting → Deploy from Git*, pick this repository and
  branch `main`. Amplify reads `amplify.yml` (Node 22, `npm ci`, `npm run build`, artifacts in `dist/`) and rebuilds on
  every push. The same file sets the headers: `/assets/**` is cached for a year (`immutable`), `/index.html` is
  `no-cache`, plus `nosniff`, a referrer policy and a CSP that allows only self, Google Fonts, `blob:` and WASM.
- **Manual deploy from CI:** `.github/workflows/deploy.yml` builds, zips `dist/` and uploads it with
  `aws amplify create-deployment` / `start-deployment`. It needs the secrets `AWS_ROLE_ARN` (an IAM role GitHub can
  assume via OIDC), `AWS_REGION` and `AMPLIFY_APP_ID`.
- **Asset filenames:** models, sounds and textures keep fixed names under `/assets/` and are cached for a year. When art
  or audio changes, rename the file or add a `?v=` query to its URL, or visitors will keep the old copy.
- **Other hosts:** `staticwebapp.config.json` (Azure Static Web Apps) and `public/_headers` (Cloudflare Pages) carry the
  same headers and are copied into `dist/`; they are harmless on Amplify.

## Credits

- Sound effects by [elevenlabs.io](https://elevenlabs.io/sound-effects/race-car) (free-plan attribution; files in
  `public/assets/sfx/elevenlabs/`).
- The models, textures and base sound pack in `public/assets/` are original assets made for this project.
