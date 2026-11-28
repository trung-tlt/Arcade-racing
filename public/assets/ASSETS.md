# VOLTLINE — MVP asset pack

Everything in this folder is original and procedurally generated for this project. Drop it into the
game repo as `public/assets/` (models, textures, sfx) and `data/` (json). Claude Code should write
code only; it should not need to create or edit any art.

## Conventions (all models)
- Format: glTF 2.0 binary (`.glb`), validated with Khronos glTF-Validator (0 errors, 0 warnings).
- Units: meters. Axes: **+Y up, +Z forward**, +X = the model's left. Origin on the ground plane.
- Shading: flat low-poly, PBR `MeshStandardMaterial`. Glow comes from **emissive** materials
  (exported with `KHR_materials_emissive_strength`) — use `UnrealBloomPass` (threshold ~0.6).
- Stable material names: `Paint`, `Paint_Dark`, `Paint_Secondary`, `Paint_Accent`, `Glass`, `Trim`,
  `Metal`, `Vent`, `Tire`, `Caliper`, `Light_Head`, `Light_Tail`, `Light_Siren_Red`, `Light_Siren_Blue`,
  `Muzzle`, `Underglow`, `Rider_Suit`, `Rider_Helmet`, `Rider_Visor`, `Neon_*`.
- Materials are shared inside a file. **Clone materials per instance** before tinting / damage effects.

## Vehicles — `models/cars/*.glb` (11 vehicles)
| file | type | tris | notes |
|---|---|---|---|
| kestrel_gt.glb | car | ~12.9k | balanced starter, orange |
| rhino_x4.glb | car | ~13.9k | heavy brawler, cyan, bull bar, treaded tires |
| wisp_r.glb | car | ~12.8k | light hypercar, lime, rear wing, bigger rear wheels |
| warden_px.glb | car | ~12.8k | police interceptor (fictional Harbor Patrol), push bar, light bar — alternate `Light_Siren_Red` / `Light_Siren_Blue` at ~2 Hz |
| bastion_m8.glb | car | ~18.8k | military armored 4x4, olive + sand camo, slat armor, heavy twin cannon |
| raijin_rx.glb | car | ~91k | original late-90s twin-turbo AWD coupe: silver, projector headlamps, big intake + corner ducts, NACA bonnet duct, fender vents, tall wing, quad round tail lamps, gunmetal six-spoke wheels, orange calipers, roof turret |
| hauler_ht.glb | car | ~13.9k | pickup with shielded bed turret (360° yaw) |
| truongson_av8.glb | apc8x8 | ~26.9k | original 8x8 armored personnel carrier, olive, autocannon turret (360°), antenna. 8 wheels `wheel_1L…wheel_4R`; axles 1–2 steer |
| mantis_650r.glb | bike | ~29k | rebuilt original 650-class sport bike: lofted fairing with twin LED eyes, tinted screen, gold USD fork, twin-spar frame, mono-shock, chain drive, carbon end can. 2 wheels `wheel_F`, `wheel_R`; twin fairing guns (±15°). Tucked armoured rider |
| mira_150.glb | bike | ~30k | original retro step-through scooter (12" wheels), red with tan seat, chrome trim, horn grille, rear rack with an olive ammo can. 2 wheels `wheel_F`, `wheel_R`; twin pulse pods on a legshield crash bar (±12°). Upright armoured rider. Smallest turning circle, very fragile |
| fulmine_fx.glb | car (openWheel) | ~20k | original open-wheel hybrid racer: halo, sculpted sidepods, multi-element front wing, rear wing with DRS flap, beam wing, diffuser, rain light (`Light_Tail`), exposed wheels with wishbones/pushrods, driver helmet. Compact Pulse MG on the roll hoop (±10°). Livery variants: override `paint` / `accent` / `glow` per AI car |

**Realism pass (all vehicles):** smooth creased-normal body with rounded profile corners, a hood/roof crown and flared wheel haunches; `MeshPhysicalMaterial` clearcoat paint (`KHR_materials_clearcoat`, GLTFLoader reads it) and tinted clearcoat glass; textured LED headlight clusters (projectors + DRL) and tail-light bars; hex-mesh grilles; black window seals and B-pillars; door seams and chrome handles; side mirrors; wipers; front/rear race plates (fictional `VL …`, Warden `POLICE 01`); carbon splitter, side skirts and diffuser on road cars; chrome exhaust tips; shark-fin antenna; rubber arch lips. Wheels: rounded lathe tyres with tread texture (block lugs on off-road/military), dished twin-spoke alloys with lug nuts, brake discs and coloured calipers; Bastion uses beadlock steel wheels, the AV8 military steel wheels. Bike rider now uses capsule limbs and a round helmet. Gun turrets have rounded housings, cooling-jacket rings, ammo box and an optic. Rig names, origins, collider and gun_mount positions are unchanged, so code that loads the old models keeps working.
**Draw calls:** ~35 per car (wheel meshes have 4 materials each). Clone one loaded template per car type and share its materials between AI copies. On the Low preset swap `MeshPhysicalMaterial` for `MeshStandardMaterial` (copy color/roughness/metalness). Optional: `gltf-transform meshopt` for ~3× smaller downloads (needs `MeshoptDecoder` in GLTFLoader).

**Sponsor decals (logos supplied by the project owner, used unchanged):**
- kestrel_gt — Emesoft: white stacked logo on both doors, ink mark on the hood.
- mantis_650r — Emesoft: colour mark on both nose flanks, white stacked logo on the belly fairing and the tail, both sides.
- mira_150 — Emesoft: white stacked logo on both rear side cowls, ink mark on the front of the legshield.
- rhino_x4 — CaptureMann: patch (0.90 × 0.28 m) on the bolted door armour plate, both sides; on-light mark (0.42 m) on the bonnet.
- fulmine_fx — Emesoft: colour mark on both sidepods, ink mark on the nose; CaptureMann patch on the engine cover; CraftMann patch on both rear-wing endplates.
- wisp_r — CraftMann: patch (0.75 × 0.23 m) on the doors ahead of the side intake, both sides; on-light mark (0.50 m) on the bonnet.

All decals live in a separate `decals` mesh (materials `Decal_<kind>`, e.g. `Decal_cm_patch`, `Decal_crm_mark_light`, `Decal_stacked_white`; alpha-tested PNG, matte, polygon offset) so code can hide or swap them. Textures: `textures/decal_emesoft_{stacked_white,mark_color,mark_ink}.png`, `textures/decal_capturemann_{patch,mark}.png`, `textures/decal_craftmann_{patch,mark}.png`. Source SVGs in `brand/` (`capturemann_mark_{on_light,on_dark,mono_black}.svg`, `craftmann_mark_{on_light,on_dark,mono_black}.svg`, plus the Emesoft files).

Node hierarchy (all vehicles):
```
Car_<id>
├─ chassis          static body (multi-material mesh)
├─ wheel_*          origin at hub; spin around local X; steering wheels (see cars.json "steer") also yaw around Y
├─ rider            (bike only) separate mesh so it can lean/tuck or be hidden in first person
├─ gun_mount        empty → yaw within ±turretYawDeg (cars.json)
│  └─ gun           turret/barrels mesh
│     └─ muzzle     empty at barrel tip → fire origin (+Z)
├─ exhaust_L, exhaust_R   empties → nitro flame sprites, pointing −Z
```
`data/cars.json` has, per vehicle: `vehicleType` (car | apc8x8 | bike), stats, role, collider,
every wheel (position, radius, width, steer), gun mount, `turretYawDeg`, and `maxLeanDeg` for the bike.

### Bike riders — military kit (mantis_650r, mira_150)
The `rider` mesh is an armoured operator (original design): digital woodland camo uniform (`Gear_Camo_DigitalWoodland`, one tileable 256² pixel texture, box-projected UVs), ranger-green plate carrier with MOLLE rows, mag pouches, hydration pack and radio with whip antenna (`Gear_Armor_RangerGreen`, `Gear_Webbing`), high-cut ballistic helmet with a camo cover, NVG shroud, side rails, comms ear cups and boom mic, counterweight pouch and strobe; ballistic goggles (`Gear_Goggle_Lens`, faint team-colour glow), scarf, shoulder/elbow/knee armour (`Gear_Pads`), black gloves and coyote boots (`Gear_Boots_Coyote`). The chest marker uses `Underglow`, so the player colour also shows on the rider.
- Squad recolour: swap only `Gear_Armor_RangerGreen` / `Gear_Webbing` colours; leave the camo texture alone.
- The rider is about 8–9k of each bike's triangles; both bikes stay under 31k tris and 43 draw calls (clone one template per bike type and share materials).

### Physics notes for special vehicles
- **openWheel (fulmine_fx):** normal 4-wheel raycast car, but add downforce = `downforce` × v² × 0.5 (N, v in m/s) pushed through the chassis; grip ×1.25 above 150 km/h. Very light (800 kg) and the lowest hull (70) — wheel-to-wheel contact damages it ×1.5. Wheels are exposed: a wheel hit to the side of another car launches it slightly (small upward impulse).
- **apc8x8:** one Rapier raycast vehicle with 8 wheels; drive all 8, steer the wheels flagged `steer`
  (rear steer axle at ~60% angle). Heavy mass, low centre of gravity, high ram damage.
- **bike:** don't simulate a real two-wheeler. Use a raycast vehicle with **4 virtual wheels**
  (front pair at the front hub, rear pair at the rear hub, ±0.25 m apart) and render only the two real
  wheels. Visual lean = clamp(steer × speedFactor) up to `maxLeanDeg` around the forward axis; lean the
  whole visual root, not the physics body. Rider is part of the hit box (collider in cars.json).

## Weapons & pickups
- `models/weapons/hornet_rocket.glb` — 0.8 m, flies along +Z, `trail` empty at the tail.
- `models/pickups/pickup_{rocket,repair,nitro}.glb` — 1.2 m holo cube, origin at cube center.
  Place at y ≈ 1.2, bob the root, spin child `icon` around Y. `holo_fill` is a transparent glow box.

## Track props — `models/props/*.glb`
| file | size (m) | use |
|---|---|---|
| container_red / container_blue | 2.44 × 2.59 × 6.06 | stacks in Container chicane; InstancedMesh |
| barrier_jersey | 0.6 × 0.85 × 3.0 | tile along both road edges every 3 m |
| streetlight | 8.2 tall, arm toward +X | every 30 m; `light_point` empty for an optional real light (≤ 4 real lights) |
| building_a / b / c | 20×42×20, 30×24×26, 14×64×14 | city blocks; windows glow via emissive map |
| crane_gantry | ~18 × 42 × 60 | dock cranes along the water |
| jump_ramp | 18 × 10 × 2.5, rises toward +Z | Bridge jump |
| checkpoint_gate | 24 m span | one per checkpoint (8) |
| start_gantry | 24 m span | `lamp_1`…`lamp_5` start at emissiveIntensity 0 — light them for the countdown |
| tunnel_segment | 26 × 10 × 10, open ends | repeat every 10 m through Neon tunnel |

Budget: 6 vehicles on the grid ≈ 20–30k tris. Instance repeated props to stay under 150 draw calls.

## Map 1 props — `models/props_catlai/*.glb` (Cát Lái Port, night — replaces Harbor Loop)
| file | notes |
|---|---|
| sts_quay_crane.glb | 68 m ship-to-shore crane; rails along Z, legs at x ±15 (the quay lane runs between them), boom to +X over the water; `trolley`, `spreader` empties to animate |
| rtg_crane.glb | rubber-tyred gantry, 23.5 m span over 6 container rows + the yard lane; `trolley` empty |
| container_block_a/b/c.glb | 6 rows × 5 bays of 40 ft boxes, 1–5 high, one mesh each — instance them to build the yard; solid walls |
| container_ship.glb | generic 150 m feeder ship (invented livery), bow +Z, lit bridge, nav lights |
| port_gate.glb | 6-lane terminal gate, booths, barrier arms, lane lights, place-name sign (no operator logo) |
| flood_mast.glb | 35 m high mast with LED ring (`light_point`) |
| reach_stacker.glb | container handler crossing the Reefer-lane shortcut |
| river_ferry.glb | generic 42 m river car ferry with ramps |
| cable_stayed_bridge.glb | skyline backdrop, 300 m deck, lit stays |
| quay_edge.glb | 20 m quay lip with bollards, fenders, yellow edge |
Sponsor banners `models/props/sponsor_banner_{emesoft,capturemann,craftmann,voltline}.glb`: 8 × 2 m printed board on two posts (bottom edge 0.9 m), printed on both faces, front looks −Z, ~40 tris. Tracks list them with `position` and `yawDeg` (90 = long side parallel to a north–south road). Placements: `cat_lai.json` → `sponsors.{banners,billboards,quayBanners}`; `cong_hoa.json` → `dressing.{sponsorBanners,rooftopBillboards}`; `xa_lo_ha_noi.json` → `dressing.billboards` (now 9 boards); `pham_van_dong.json` → `sponsors.{billboards,banners,mallScreens}`.

Older Harbor props (`models/props/*`: containers, crane_gantry, barrier, streetlight, buildings, ramp, gates, tunnel) stay as shared props for all maps.

## Map 2 props — `models/props_conghoa/*.glb` (Cong Hoa Boulevard, daytime)
| file | notes |
|---|---|
| shophouse_a…d.glb | narrow tube houses, 4–6 m wide, 3–6 floors; **front faces +Z**, depth 14 m behind the origin; signboards use the embedded `day_shop_signs` atlas. Rotate ±90° to face the road and pack them edge to edge |
| power_pole.glb | 10 m concrete pole + transformer; `cable_0..3` empties — draw sagging cables (TubeGeometry on a quadratic curve) between consecutive poles |
| street_tree_a/b.glb | low-poly canopies for the median and sidewalks |
| median_segment.glb | 10 m raised median with striped curb and hedges, tiles along Z |
| pedestrian_overpass.glb | 34 m span across X, deck at 5.5 m; centre it on the median |
| flyover_pier.glb | pier + cap for the roundabout flyover (deck generated from `flyover.points`) |
| airliner.glb | generic twin-jet (invented livery), +Z forward; fly it along the approach path in cong_hoa.json |
| scooter_red/white.glb | parked on sidewalks and as ambient traffic (tint `Scooter_Body` for variety) |
| traffic_light.glb | `lamp_red`, `lamp_amber`, `lamp_green` meshes, toggle emissiveIntensity |
| office_tower.glb, bus_stop.glb, airport_fence.glb | dressing for sections C and A |
| car_sedan_white/silver.glb, car_hatch_red/blue.glb, car_taxi.glb | generic ambient cars (no brands), +Z forward, single `body` mesh; size ≈ 1.8 × 1.5 × 4.4 m (hatch 3.9 m). Tint `Civ_Paint` for more colours; `Light_Tail` brightens when they brake |
| city_bus.glb | generic 11 m city bus, green livery, emissive `Route_Sign`; doors on the right (−X) side for bus stops |

Ambient traffic in `cong_hoa.json` → `ambientTraffic.models` lists scooters, cars and buses separately, and `vehicleSizesM` gives box colliders. Wheels are baked into the body (no spin) — they move slowly enough that it doesn't show.

## Map 3 props — `models/props_xalo/*.glb` (Hanoi Highway / Xa lộ Hà Nội, dusk)
| file | notes |
|---|---|
| metro_viaduct_span.glb | 30 m span + pier at z = 0, deck top y = 10, two tracks at x ±1.5; tile along the metro path |
| metro_station.glb | 40 m elevated station straddling the viaduct; `skywalk_anchor_east/west` empties |
| metro_car_cab.glb, metro_car_mid.glb | generic 20 m metro cars (invented white/orange livery); chain cab-mid-mid-cab (last cab rotated 180°) |
| skywalk.glb | 24 m covered pedestrian bridge (deck 6 m) with stair at +X |
| sign_gantry_outbound/inbound.glb | 34 m overhead gantry, green direction signs (place names only) |
| billboard_emesoft / voltline / apartments / ev / capturemann / craftmann.glb | 12 × 5 m billboards on 13 m poles, ad faces −Z (toward traffic driving +Z). Usable on any map. Sponsor boards use the owner's logos |
| river_bridge_segment.glb + river_bridge_pier.glb | 40 m × 32 m deck (both directions), deck top at y = 0 → raise to the spline elevation |
| underpass_open/covered.glb | 20 m retaining-wall trough (covered = cross-street deck with tunnel lamps) |
| apartment_tower_a/b.glb | 96 m / 72 m towers, windows lit via the window atlas |
| factory_shed.glb | 60 × 40 m sawtooth-roof factory |
| highway_lamp.glb | 12 m double-arm sodium lamp (`light_L/R` empties) |
| container_truck_blue/red.glb | generic 16.5 m container trucks for ambient traffic |

## Map 4 props — `models/props_pvd/*.glb` (Pham Van Dong Boulevard / Đại lộ Phạm Văn Đồng, monsoon storm)
| Model | Notes |
|---|---|
| boulevard_median.glb | 20 m × 8 m tree median: striped curbs, grass, 2 tall shade trees, double-arm LED lamp (`light_L`/`light_R` empties) |
| lane_separator.glb | 20 m × 1.6 m divider between car lanes and motorbike/mixed lanes: planters, yellow rail |
| poncho_rider_{blue,yellow,pink,clear}.glb | scooter + rider in a rain poncho, 1.85 m, +Z forward, head/tail lights emissive |
| bridge_branch_segment.glb / bridge_branch_pier.glb | Bình Lợi bridge: one 24 m branch per direction, 40 m segment, deck top y = 0; pier cap at −3 m |
| arch_rail_bridge.glb | 120 m red steel tied-arch railway bridge, backdrop only |
| ramp_span.glb | 30 m × 11 m elevated deck with LED parapet strip — lay along the U-turn flyover spline |
| cross_overpass.glb | ring-road overpass, 64 m across X, deck at 8 m, piers in the median/separators |
| mall_capturemann.glb / mall_craftmann.glb | 80 × 24 × 46 m mall, front +Z, LED screen showing the sponsor billboard row |
| flood_sign.glb | "ĐƯỜNG NGẬP · FLOODED · SLOW" sign with amber blinkers, faces −Z |
| rain_shelter.glb | 8 m covered bus stop for the mixed-lane side |
| sign_gantry_outbound / inbound.glb | direction gantries (Linh Xuân, Gò Dưa, Ring Road 2 / Sân bay Tân Sơn Nhất) |

Reuses: shophouses, street trees, pedestrian overpass, flyover pier, civilian cars, city bus (props_conghoa); apartment towers, billboards (props_xalo); sponsor banners (props).

## Map 5 props — `models/props_monaco/*.glb` (Monte-Carlo Harbour, daylight street circuit)
Linear trackside pieces run along Z with the road side at +X (rotate 180° for the other side of the road).
| Model | Notes |
|---|---|
| armco_4m.glb / armco_ad_{emesoft,capturemann,craftmann,voltline}.glb | double-rail steel barrier on posts; ad versions carry a sponsor panel on the road face. Instance every 4 m, every 3rd one an ad |
| catch_fence_4m.glb | 3.8 m posts with 45° outrigger, alpha-tested mesh (`mc_catch_fence`), sits 0.25 m behind the Armco |
| tyre_wall_4m.glb | 4-high tyre stack with blue/white belt — run-off of every slow corner |
| kerb_4m.glb | 1.2 m red/white kerb, 6 cm high |
| grandstand_40m.glb | 14 rows, crowd texture, roof, flags, VOLTLINE banner along the front; faces +X |
| pit_building_60m.glb | 2-storey garages with 8 coloured doors and glass control room |
| start_gantry.glb | 16 m span, 5 lamp pods (2 red lenses each) with empties `start_light_1..5`, banner on the back |
| marshal_post.glb | orange post with a yellow flag |
| belle_epoque_{a,b,c,d}.glb | 5–8 floor terraces: arched shopfronts, cornices, mansard or tiled roof, chimneys; 4 facade colours. Front = +Z |
| modern_tower_{a,b}.glb | 18 / 30 floor glass towers with roof gardens (hillside backdrop) |
| grand_casino.glb | original Belle Époque casino: copper central dome + 2 corner domes, colonnade, gilt details. Front = +Z |
| hotel_over_tunnel.glb | curved 8-block hotel that sits on top of the tunnel |
| tunnel_segment_20m.glb | 14 m wide, walls with lamp strips and yellow stripe, roof slab |
| palm_{a,b}.glb · cypress.glb · flower_bed.glb · fountain.glb | Casino gardens and quay planting |
| superyacht_{white,navy,grey}.glb | 62 / 48 / 36 m motor yachts, length along Z, waterline y = 0 |
| sail_yacht_{a,b}.glb | 24 / 18 m sloops with furled main |
| pontoon_40m.glb · harbour_light.glb · swimming_pool.glb | harbour pieces (pool 54 × 24 m with loungers and parasols) |
| rock_headland.glb | the old-town headland across the harbour (520 m wide, 62 m high) with fortress wall and houses — backdrop |
| mountain_backdrop.glb | 1.6 km × 420 m cliff wall, faces +Z — place far north, never collides |
| tv_helicopter.glb | follows the race leader (rotor discs are semi-transparent; add a slight yaw wobble) |


road_lanes (road ribbon, u across 18 m, v along) · window_atlas · checker · fx_muzzle_flash · fx_tracer ·
fx_spark · fx_smoke · fx_explosion_4x4 (16-frame flipbook) · fx_nitro_flame · fx_glow · fx_skidmark.
Map 2: day_road_3lane (one carriageway, u across 11 m, v tiles every ~12 m; flip 180° for the other direction) ·
day_shop_signs (8-row atlas) · day_sky_gradient (scene.background).
Map 1: catlai_apron (port concrete with yellow lanes) · catlai_gate_sign.
Map 5: mc_road (12 m, white edge lines) · mc_kerb · mc_facade_{cream,ochre,pink,white,modern} · mc_shopfront · mc_roof_tiles · mc_catch_fence (alpha) · mc_crowd · mc_sea · mc_pool · mc_cliff · mc_yacht_windows · mc_sky_gradient (fallback for the physical sky).
Map 4: pvd_road_car_3lane (11 m, wet asphalt, "Ô TÔ") · pvd_road_moto_2lane (7 m, "XE MÁY" + scooter glyph) · pvd_puddle (alpha decal) · rain_sky_gradient · pvd_direction_signs (4 rows) · pvd_flood_sign · fx_rain_streaks · fx_splash · fx_lightning.
Map 3: xalo_road_4lane (main carriageway, 15 m) · dusk_sky_gradient · xalo_direction_signs (4 rows) · xalo_billboards (6 rows: Emesoft, VOLTLINE, apartments, EV, CaptureMann, CraftMann) · sponsor_banners (4 rows: Emesoft, CaptureMann, CraftMann, VOLTLINE).

## Sound — `sfx/*.wav` (44.1 kHz mono, normalized)
engine_loop and skid_loop are seamless loops (engine playbackRate ≈ 0.6 + rpm × 1.4; use 1.4× pitch for
the bike, 0.7× for the APC). One-shots: mg_shot, overheat, hit_metal, rocket_launch, explosion, nitro,
pickup, checkpoint, countdown_beep, countdown_go, ui_click. Map 4 ambience: rain_loop (4 s seamless), thunder (5.5 s), splash.

## Map 5 sounds (all original, synthesized)
- `sfx/engine_openwheel_loop.wav` — seamless turbo-hybrid V6 scream with ERS whine (base 420 Hz). Use it for fulmine_fx instead of engine_loop: playbackRate ≈ 0.55 + rpm × 1.6.
- `sfx/monaco/passby_openwheel.wav` — Doppler pass-by for AI cars within 6 m of the camera.
- `sfx/monaco/start_lights.wav` — 5 lamp clunks + lights-out, synced to the gantry (1 s apart).
- `sfx/monaco/harbour_ambience_loop.wav` (8 s: water, gulls, halyards), `crowd_loop.wav`, `crowd_cheer.wav`, `yacht_horn.wav`, `helicopter_loop.wav`.
- `sfx/monaco/tunnel_ir.wav` — impulse response for a ConvolverNode while inside the tunnel.
- `music/monaco_riviera_loop.wav` — 16-bar bossa loop, 124 BPM, D major (Rhodes, mandolin, shaker) for this map's track select / pre-race.

## Menu sounds & music (all original, synthesized)
- `sfx/ui/*.wav` — 13 UI sounds: ui_move, ui_select, ui_back, ui_error, ui_toggle_on/off, ui_slider_tick, ui_whoosh,
  ui_car_switch, ui_car_confirm (engine rev + stab), ui_track_switch, ui_start_race (riser + hit), ui_title_sting.
- `music/menu_loop.ogg` (+ .wav) — seamless 17.1 s synthwave loop, 112 BPM, A minor, for all menus.
- `data/ui_sounds.json` — event → file, volume, pitch jitter, per-vehicle pitch, which screen/key plays what, music rules.
- Hear them all on the design canvas artboard 23 (Sound board); screens 09–19 play them in Play mode.

## Data — `data/`
- `cars.json` — 11 vehicles (see above).
- `tracks/monte_carlo.json` — Map 5: 3339 m clockwise spline with elevation (2 → 42 m), 15 named corners, sections, checkpoints, pickups, `noFireZones`, start lights, barrier/fence/tyre-wall rules, pits, grandstands, buildings, harbour (water, pool, 59 yachts, pontoons), tunnel, backdrop, helicopter, audio zones and daylight lighting.
- `weapons.json` — Pulse MG, Hornet rocket, pickups, damage states, wreck/respawn rules.
- `tracks/pham_van_dong.json` — Map 4, monsoon storm, 4.8 km, 2 laps, **elevation in the spline** (Bình Lợi bridge +12 m, Gò Dưa
  hump +3.5 m, U-turn flyover +8 m, flooded dip −2.5 m). Outbound on the car lanes, inbound on the motorbike/mixed lanes with
  poncho scooter traffic. Has a `weather` block (rain, wet grip, 13 puddles, flood zone, spray, lightning, audio) — see CLAUDE.md.
- `tracks/xa_lo_ha_noi.json` — Map 3, dusk, 4.3 km, **with elevation in the spline** (bridge crest +11 m, underpass −6.5 m,
  U-turn hump +5 m). Includes metro viaduct path, stations, trains, gantries, billboards, bridge/underpass ranges,
  ambient traffic (trucks, cars, buses, scooters) and the dusk lighting setup.
- `tracks/cong_hoa.json` — Map 2, daytime, 3.1 km: outbound → U-turn → inbound → counter-clockwise roundabout under a
  flyover. Includes lane layout, checkpoints, pickups, overpasses, traffic lights, ambient traffic, dressing rules and
  the full daylight setup (sun, hemi, fog, bloom). Coordinates: X = east, Z = −north.
- `tracks/cat_lai.json` — Map 1, night, 2.8 km: truck road with a parked truck queue → terminal gate chicane →
  container-yard lanes (RTGs) → 1 km quay apron under 6 quay cranes beside two ships → ferry road. Reefer-lane
  shortcut with a jump. Includes crane/ship/block/gate/truck-queue/ferry placement and night lighting.

## Cockpit rig — `models/cars/cockpit_rig.glb`
Generic first-person cockpit (5.4k tris, 11 materials, origin = driver eye, left-hand drive): dashboard with binnacle and `Dash_Screen`, centre screen, door cards, A-pillars with a roll-cage halo, roof liner, sun visor, rear-view mirror (`Mirror_Glass`), bonnet in `Cockpit_Paint`, flat-bottom alcantara wheel with carbon spokes, hub screen and paddles + gloved hands (`steering_wheel` node), forearms, steering column. Empties: `eye`, `rear_mirror_cam`, `muzzle_fpv`. Per-car placement in `cars.json → fpv`.

## Branding — `branding/`
VOLTLINE logo (horizontal + stacked, on dark/on light, SVG + PNG), wordmark, mark (colour + mono), app icon (SVG, 1024/512/192 PNG, maskable 512, apple-touch 180), favicon (SVG, ICO 16/32/48, PNGs), `site.webmanifest`, `head_snippet.html`. All shapes are paths, no fonts.

## UI reference
All screens are on the VOLTLINE design canvas: HUD (05), screens 09–19, vehicles 03, 07, 20, 21, Map 2 on 22, Map 3 on 24, sponsors on 33, Map 4 on 34, brand identity on 35, driver FPV HUD on 36–37.
