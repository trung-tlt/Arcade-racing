# Contributing to VOLTLINE

Thanks for taking a look. Bug reports, fixes, new maps and cars, translations and docs are all welcome. For anything
bigger than a small fix, please open an issue first so we can agree on the direction before you spend time on it.

## Setup

Needs Node 20.19 or newer (22 recommended).

```bash
git clone https://github.com/trung-tlt/racing.git
cd racing
npm install
npm run dev          # http://localhost:5173
```

Before you open a pull request, these three must pass (CI runs them too):

```bash
npm run lint
npm run build        # tsc --noEmit + vite build
npm test             # Vitest
```

Browser tests (Playwright) are slower and need a Chromium: `npx playwright install chromium`, or
`CHROMIUM_PATH=/path/to/chrome npx playwright test`. Run the specs that match your change (for example
`tests/online*.spec.ts` for anything online). They run serially because software WebGL is slow. Do not edit source files
while a Playwright run is in progress (Vite hot reload restarts the page).

## Ground rules

- **TypeScript strict**, no `any`, no `@ts-ignore`. Prettier and ESLint are the style guide (`npm run lint`).
- **Gameplay numbers live in `data/*.json`**, not in code. Tuning a car or a weapon should be a data change.
- **Shared simulation stays DOM-free.** `src/sim/`, `src/shared/` and `src/server/` must not import three.js or touch the
  DOM: the same code runs in the browser and on the race server.
- **Online changes need a test.** The server is authoritative; anything that changes the protocol (`src/shared/protocol.ts`)
  needs parser tests and, if it changes behaviour, a Room or server test. See `docs/multiplayer-release-plan.md` for how
  prediction, lag compensation and the lobby fit together.
- **Performance budget:** under 350 draw calls and 400k triangles on screen, 60 fps on an integrated GPU. Use instancing for
  repeated props. See the README.
- **Assets:** do not add third-party art, audio or brand marks without saying where they come from and under what license.
  Models are glTF 2.0 (`.glb`); see `public/assets/ASSETS.md` for the conventions and material names the code relies on.
- Keep commits focused, with a message that says why. Small pull requests are reviewed faster.

## Project map

See the "Project layout" section of the [README](README.md). `CLAUDE.md` is a longer architecture guide (written for AI
coding assistants, useful for people too).

## License

By contributing you agree that your contribution is licensed under the MIT License of this project (see
[LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the exceptions that apply to brand marks and some audio).
