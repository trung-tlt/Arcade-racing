# Notices and third-party material

VOLTLINE's source code is released under the [MIT License](LICENSE). The original 3D models, textures, music and base
sound effects in `public/assets/` were made for this project and are released under the same license (see
`public/assets/ASSETS.md`). The items below are **not** covered by that grant.

## Brand marks (not licensed)

The logos and marks of **CraftMann**, **CaptureMann** and **Emesoft** are trademarks of their owners. They appear in
`public/assets/brand/`, on the sponsor billboards and banners in the maps, and as decals on some cars. Reading, building
and running this repository does not give you a license to use them. If you publish a fork, replace them with your own
marks (or remove them) and drop the "a CraftMann app" endorsement from the title and loading screens.

## Sound effects

The race-car sound effects in `public/assets/sfx/elevenlabs/` were generated with
[ElevenLabs](https://elevenlabs.io/sound-effects/race-car) and are used under ElevenLabs' terms (free plan: attribution
required, **"Sound effects by elevenlabs.io"**). They are not relicensed under the MIT License. Check ElevenLabs' current
terms before using them outside this project; see `public/assets/sfx/elevenlabs/ATTRIBUTION.md`.

## Fonts

The game loads Inter, JetBrains Mono and Space Grotesk from Google Fonts at runtime (SIL Open Font License 1.1). The font
files are not part of this repository.

## Libraries

Runtime dependencies: [three.js](https://threejs.org) (MIT), [Rapier](https://rapier.rs) via
`@dimforge/rapier3d-compat` (Apache-2.0) and [ws](https://github.com/websockets/ws) (MIT, race server only). Development
tools (Vite, Vitest, Playwright, ESLint, Prettier, TypeScript and others) are listed in `package.json` and keep their own
licenses.
