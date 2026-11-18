# VOLTLINE — MVP asset pack

Everything in this folder is original and procedurally generated for this project. Drop it into the
game repo as `public/assets/` (models, textures, sfx) and `data/` (json). Claude Code should write
code only; it should not need to create or edit any art.

## Conventions (all models)
- Format: glTF 2.0 binary (`.glb`), validated with Khronos glTF-Validator (0 errors, 0 warnings).
- Units: meters. Axes: **+Y up, +Z forward**, +X = the model's left. Origin on the ground plane.
- Shading: flat low-poly, PBR `MeshStandardMaterial`. Glow comes from **emissive** materials
  (exported with `KHR_materials_emissive_strength`) — use `UnrealBloomPass` (threshold ~0.6) to make them pop.
- Material names are stable so code can find them: `Paint`, `Paint_Dark`, `Glass`, `Trim`, `Metal`,
  `Tire`, `Caliper`, `Light_Head`, `Light_Tail`, `Muzzle`, `Underglow`, `Neon_*`.
- Materials are shared inside a file. **Clone materials per instance** before tinting / damage effects.

## Cars — `models/cars/*.glb`
| file | tris | notes |
|---|---|---|
| kestrel_gt.glb | ~2.9k | balanced starter, orange |
| rhino_x4.glb | ~3.9k | heavy brawler, cyan, bull bar, treaded tires |
| wisp_r.glb | ~3.0k | light hypercar, lime, rear wing, bigger rear wheels |

Node hierarchy (identical in all three):
```
Car_<id>
├─ chassis          static body (multi-material mesh)
├─ wheel_FL / wheel_FR / wheel_RL / wheel_RR
│                    origin at hub; spin = rotate around local X; front wheels also steer around Y
│                    (set rotation.order = 'YXZ' or wrap in a pivot Object3D)
├─ gun_mount         empty on the roof → yaw the turret by rotating this around Y
│  └─ gun            turret + barrels mesh
│     └─ muzzle      empty at barrel tip → raycast / tracer / muzzle-flash origin (+Z = fire direction)
├─ exhaust_L, exhaust_R   empties → nitro flame sprites (fx_nitro_flame.png), pointing −Z
```
Physics numbers per car (collider half-extents, wheel positions/radius/width, mass, grip, top speed…)
are in `data/cars.json`, measured from the actual meshes. Use `Underglow` (emissive) to tint team/player
colour, `Light_Tail` emissiveIntensity up when braking.

## Weapons & pickups
- `models/weapons/hornet_rocket.glb` — 0.8 m, flies along +Z, `trail` empty at the tail for smoke.
- `models/pickups/pickup_{rocket,repair,nitro}.glb` — 1.2 m holo cube, origin at cube center.
  Place at y ≈ 1.2, bob the root, spin child `icon` around Y. `holo_fill` is a transparent glow box.

## Track props — `models/props/*.glb`
| file | size (m) | use |
|---|---|---|
| container_red / container_blue | 2.44 × 2.59 × 6.06 | stacks in Container chicane; InstancedMesh |
| barrier_jersey | 0.6 × 0.85 × 3.0 | tile along both road edges every 3 m |
| streetlight | 8.2 tall, arm toward +X | every 30 m; `light_point` empty if you add a real light (keep ≤ 4 real lights) |
| building_a / b / c | 20×42×20, 30×24×26, 14×64×14 | city blocks; windows glow via emissive map |
| crane_gantry | ~18 × 42 × 60 | dock cranes along the water |
| jump_ramp | 18 wide × 10 long × 2.5 high, rises toward +Z | Bridge jump section |
| checkpoint_gate | 24 m span, 8.6 m tall | one per checkpoint (8) |
| start_gantry | 24 m span | start/finish; `lamp_1`…`lamp_5` start at emissiveIntensity 0 — light them for the countdown |
| tunnel_segment | 26 wide × 10 tall × 10 long, open ends | repeat every 10 m through Neon tunnel |

Budget check: a full grid of 6 cars ≈ 20k tris; the whole scene stays far under the 400k budget.
Instance repeated props (barriers, lights, containers, tunnel segments) to stay under 150 draw calls.

## Textures — `textures/*.png`
| file | use |
|---|---|
| road_lanes.png (1024²) | road ribbon: u = across the 18 m road (0→1), v = along; repeat v every ~18 m. Includes edge lines + 3-lane dashes |
| window_atlas.png | building facades (already embedded in building GLBs) |
| checker.png | start banner (embedded in start_gantry) |
| fx_muzzle_flash.png | additive sprite at `muzzle`, 1–2 frames per shot |
| fx_tracer.png | stretched additive billboard along the shot ray (bright end = head) |
| fx_spark.png | hit sparks particles |
| fx_smoke.png | damage smoke (HP < 60%), rocket trail, tire smoke |
| fx_explosion_4x4.png | 16-frame flipbook (left→right, top→bottom), ~0.8 s |
| fx_nitro_flame.png | billboards at `exhaust_*` while nitro is active (bright end at the pipe) |
| fx_glow.png | soft radial: headlight flares, pickup halo |
| fx_skidmark.png | decal ribbon texture for drift marks (alpha) |

## Sound — `sfx/*.wav` (44.1 kHz mono, normalized)
| file | notes |
|---|---|
| engine_loop.wav | seamless loop; set playbackRate ≈ 0.6 + rpm × 1.4 |
| skid_loop.wav | seamless loop; gain by lateral slip |
| mg_shot.wav | per shot (10/s) — randomize playbackRate 0.95–1.05 |
| overheat.wav | gun overheat lockout |
| rocket_launch.wav, explosion.wav | rockets, wrecks |
| hit_metal.wav | bullet impacts on cars |
| nitro.wav | nitro start |
| pickup.wav, checkpoint.wav | feedback |
| countdown_beep.wav ×3 then countdown_go.wav | race start |
| ui_click.wav | menus |
Music is not included in the MVP pack (use any CC0 synthwave loop, or ship without music).

## Data — `data/`
- `cars.json` — stats + collider + wheel layout per car (measured from the models).
- `weapons.json` — Pulse MG, Hornet rocket, pickups, damage states, wreck/respawn rules.
- `tracks/harbor.json` — Harbor Loop: 64-point closed Catmull-Rom spline (≈2.4 km), start grid,
  8 checkpoints, 6 pickup clusters (3 lanes each), ramp, tunnel range, shortcut, sections, dressing hints.
  All positions along the lap are `t` in [0,1) measured from the start line.
