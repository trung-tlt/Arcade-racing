# VOLTLINE Online Multiplayer: Release Plan (DRAFT)

Status: draft, owner decisions recorded (section 12). Nothing here is built. Numbers marked **(est.)** are estimates to be validated by the Phase 1 spike.

**Release strategy: ship the smallest thing that works, as soon as possible.** The launch bar is: *at least 2 players can race each other online.* Everything else is a follow-up release.

## 1. Goal and scope

Let human players race each other (and AI bots) online, on a dedicated authoritative server.

**v1 (launch): "Race online"**
- 2–6 players per race on all 5 maps; bots fill empty slots (public and private rooms).
- Guest play: the player types a name, no accounts.
- Any vehicle; two players may pick the same one.
- Create/join room by code and quick-match; lobby with ready-up; shared countdown; online results.
- Racing, collisions and **full combat**: guns, rockets, pickups, wrecks and respawns, with server-side lag compensation.
- **Desktop and phone (touch) both supported at launch.** The touch HUD, rotate screen and Low preset carry over; phones need a lobby layout and an online-friendly connection indicator.

**v1.1 (fast follow)**
- Reconnect within 30 s, ping display polish, per-player tint/livery, split of the Low/Med snapshot rate for weak mobile links.

**Launch bar and staging.** You said launch as soon as two players can race each other. Combat and phone are in v1, so v1 ships when the combat race works for 2 players; an internal 2-player racing-only build exists earlier (end of Phase 3) and is the first thing to test with friends.

**Out of scope for now**
- Accounts, friends, ranked ladder, persistent leaderboards, chat, spectators, replays, voice, cross-region matchmaking.

## 2. Success criteria
- A 6-player race finishes with no desync and no player seeing another car "teleport" more than 1 m outside of recovery/respawn.
- Own-car input feel: no perceived delay at 60 ms RTT (prediction).
- Hosting cost stays **under $20/month** at launch.
- Server holds **(est.)** 8–20 concurrent rooms on one small VM at <50% CPU (measured in Phase 1; sets the room cap).
- Server tick never below 60 Hz; p99 tick time under 8 ms.
- Client stays inside the existing budget (<350 draw calls, <400k triangles, 60 fps on M1/Iris Xe).
- `npm run build`, `npm test` and Playwright pass; no new console errors.

## 3. Architecture

```
Browser (client)                     Race server (Node)
  render / audio / UI                  rooms, matchmaking, lobby
  input -> InputFrame (60/s) ----->    per room: Rapier world @ 60 Hz
  prediction + reconciliation          cars (players + AI), race, combat,
  <----- Snapshot (20-30/s) -------    pickups, lap/position logic
```

- **Authority:** the server owns physics, damage, laps, pickups, results.
- **Client:** predicts its own car; interpolates all others ~100 ms in the past; shows HUD from snapshots.
- **Transport:** WebSocket (v1). WebRTC data channels only if latency data demands it.
- **Stack:** Node 22, `ws` (or Colyseus for rooms; decide in spike), TypeScript, shared `sim/` package used by client and server.

### 3.1 Code split (Phase 1)
`src/` becomes:
- `sim/`: Rapier world, `Car`, `CarPhysics`, combat, race, AI, pickups, track colliders. **No three.js, no DOM, no Web Audio.**
- `client/`: rendering, audio, HUD, menus, input, net client.
- `server/`: rooms, matchmaking, net server.
- `shared/`: protocol types, data loading (`data/*.json`).

`Game.ts` is split along that line. The track collider is built from data without meshes.

## 4. Network protocol (v1 sketch)

| Message | Dir | Rate | Contents |
|---|---|---|---|
| `join` / `leave` / `ready` | C→S | event | room code, name, car id |
| `input` | C→S | 60 Hz | seq, throttle, brake, steer, drift, nitro, fire, fireSecondary |
| `snapshot` | S→C | 20–30 Hz | tick, per car: pos, rot, vel, wheel/steer, hp, nitro, flags; ack of last input seq |
| `event` | S→C | event | hit, wreck, respawn, pickup, lap, finish, countdown/light, weather |
| `state` | S→C | event | lobby roster, race phase, results |

- Encoding: JSON in v1, binary (compact) once stable. **(est.)** 60–100 B per car per snapshot.
- Version field on `join`; server rejects mismatched client builds.
- Server clock offset sent on join for countdown and light sync.

## 5. Gameplay rules online
- **Prediction:** own car runs `sim/` locally; reconcile to server state by smooth correction; hard snap above a distance threshold.
- **Other cars:** interpolate; short extrapolation (<150 ms).
- **Car-to-car contact:** server resolves; clients show remote cars as kinematic locally.
- **Guns, rockets, pickups:** server-authoritative. Hitscan uses lag compensation (rewind targets by shooter latency, capped **(est.)** 150 ms); rockets and pickups are server entities. Guns stay disabled while airborne and inside no-fire zones.
- **Start:** server picks the light-out delay; jump-start penalty enforced server-side.
- **Recovery/reset:** requested by input, executed by server, broadcast as an event.
- **Disconnect:** v1: car is handed to AI for the rest of the race (reconnect is v1.1).
- **AI:** server-side, same `AIDriver`; difficulty from room settings.
- **Pause:** removed online (leave race only).
- **Balance:** vehicle stats unchanged (`data/cars.json`); server loads the same data files; client/server data hash must match.

## 6. Server specs
- Node 22 LTS, TypeScript strict, one process per VM core, rooms spread across processes.
- Room: 6 slots, states `lobby → countdown → racing → results → closed`.
- Quick-match: fill the oldest open public room for the chosen map; start when ≥2 ready or after a timeout **(est.** 20 s), bots fill the rest.
- Private rooms: 5-character code.
- Limits: input rate cap, message size cap, per-IP connection cap, idle timeout.
- Observability: structured logs, tick-time and player-count metrics, health endpoint.
- Hosting (budget **< $20/month**): one small VM in one region (**(est.)** 2 vCPU / 2-4 GB, ~$6-15/month on a budget provider or an Azure B-series), TLS via a reverse proxy (Caddy), process supervisor (systemd/pm2). Client stays on Azure Static Web Apps. Room cap is set from the Phase 1 load test so the VM never saturates. If the cap is hit, new players wait in the lobby (no autoscaling at this price).
- Deploy: GitHub Actions builds both; server deploy is manual-approved.
- Security: server validates every input range; no client-sent state is trusted; rate limiting; name sanitising.

## 7. Client work
- Net client with reconnect, clock sync, ping display.
- Prediction/reconciliation/interpolation module, unit-tested against recorded traces.
- Lobby, quick-match and room-code screens; waiting/countdown states; disconnect and error screens; online results table.
- HUD: ping indicator, player names over cars, position list from snapshot.
- Touch HUD unchanged apart from "leave race" in place of pause.

## 8. Design work required (needs design assets)

**v1 needs items 1, 2 and 4 (phone and desktop layouts of each), plus name tags from item 3 (shown only when near another car). Items 5-7 can wait or reuse existing assets.** Two players with the same vehicle: tell them apart by name tag and the existing player/enemy colour (own = orange, others = pink/cyan).
Per CLAUDE.md, code does not create art or UI design. These are needed from design:

1. **Lobby / room screen**: player list (slots, name, car, ready state), map and laps picker, room code with copy button, start/ready button. Desktop and phone layouts.
2. **Quick-match / join flow**: title-screen entry point "ONLINE", join-by-code input, searching/waiting state, error states (room full, version mismatch, server down).
3. **In-race online HUD pieces**: ping indicator, name tags above cars (own/enemy/team colours), disconnected-player marker, "reconnecting" banner.
4. **Online results screen**: positions, times, best lap, rematch / back to lobby.
5. **Player identity**: name entry, colour/livery choice per slot (if wanted) so 6 players are tell-apart-able; decide whether liveries need new art.
6. **Copy and sounds**: lobby ready/join/leave and countdown sounds, new strings.
7. **Icons/states**: ready, waiting, host, disconnected, ping bars.

Decided: name tags appear only when another car is near (distance threshold to tune, fades with range). Open: per-player tint beyond own-vs-others.

## 9. Phases and milestones **(all est.)**

**v1 (two players race and fight online, desktop + phone)**

| Phase | Deliverable | Exit criterion | Effort |
|---|---|---|---|
| 0. Design + decisions | Lobby, online entry, results, name-tag designs (desktop + phone) | Sign-off | ~1 wk (parallel) |
| 1. Headless sim spike | `sim/` runs a full AI-only race in Node | Same winner/lap times as browser within tolerance; room cap measured | 2 wk |
| 2. Net core | Protocol, 1 room, a remote client driving a server car | Drive a lap online | 1.5 wk |
| 3. Prediction + multiplayer | Reconcile/interpolate, N players, race flow, bots fill | 2 then 6 players finish a race, no teleports (**first internal build**) | 2 wk |
| 4. Combat online | Guns, rockets, pickups, wrecks, lag comp | Full combat race, hits feel fair at 100 ms | 2 wk |
| 5. Lobby + phone | Name entry, room codes, quick-match, results, touch lobby/HUD | Two strangers race and fight, phone and desktop, unaided | 2 wk |
| 6. Hardening + deploy + launch | Latency/loss harness, security pass, metrics, VM deploy | Section 2 criteria met, go/no-go | 1.5 wk |

v1 total roughly **10-11 weeks** (est.), with the first two-player racing build after about 6-7 weeks.

**v1.1**: reconnect, tint/livery, mobile snapshot-rate options (~1-2 wk).

## 10. Testing
- Unit: protocol encode/decode, reconciliation math, lag-comp rewind, room state machine.
- Determinism checks: browser sim vs server sim on recorded inputs.
- Network harness: injected latency (0–250 ms), jitter, loss (0–5%), reorder.
- Playwright: two pages vs a local server, full race, no console errors.
- Soak: 20 rooms for an hour; memory flat.
- Regression: all single-player specs stay green; all 5 maps online.

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `Game.ts` is hard to split without behaviour change | Schedule | Phase 1 spike first; compare outputs; stop and re-plan if tolerance can't be met |
| Prediction with raycast car + rams feels bad | Core feel | Tune with latency harness; keep own-car correction smooth; server-side event for rams |
| Large speed gap (95–360 km/h) amplifies lag | Fairness | Cap prediction error; test slow vs fast cars at 150 ms |
| Phone players on weak connections | Reach | Lower snapshot rate option, bot takeover on drop |
| Server cost/ops burden | Budget | One small VM at launch, metrics, cap rooms |
| Cheating via modified clients | Fairness | Server authority and input validation |

## 12. Decisions (owner) and remaining questions

**Decided**
1. Bots fill empty slots in public matches: **yes**.
2. Identity: **guest play with a typed name**, no accounts.
3. Hosting budget: **under $20/month**.
4. Same vehicle twice in a room: **allowed**.
5. Launch: **as soon as possible; launch bar is 2 players racing each other**.

6. Hosting: **Singapore** (Vietnam if a provider offers it at the budget); any provider is fine, one VM + public IP, not a blocker.
7. Name tags: **only when near**.
8. Weapons online: **yes, in v1**.
9. Phone support: **yes, in v1**.

**Still open (small)**
- Per-player tint beyond own-vs-others (can wait).
- Name-tag distance threshold (tune in play).

## 13. Next steps
1. Review and trim this plan (the sections to clean up).
2. Answer the open items in section 12; send the v1 designs in section 8 to design.
3. Start Phase 1 (headless sim spike): it decides the schedule and the room cap.

## 14. Phase 1 status (2026-11-21)

Done: `src/sim/` runs a 6-car AI race with full combat in Node (no three.js, no DOM) on all 5 maps: road/wall colliders (verified against the browser to 2 mm), baked scenery colliders (`scripts/bake-colliders.mjs` -> `data/colliders/`), all ambient traffic, pickups, guns, rockets, wrecks and respawns (`CombatSim`, `RocketSim`, `HitRules`, `CarSim`), stuck/fall recovery. The browser draws from the same sim classes (`Car extends CarSim`, `CombatSystem` wraps `CombatSim` with an fx sink, traffic scenery draws from the traffic sims).
Measured: 0.08-0.10 ms mean per 60 Hz tick for a 6-car combat race (p99 under 0.3 ms), so CPU alone would allow dozens of rooms per core; the real cap must be measured with networking and snapshot encoding (Phase 6). Parity vs the browser (`scripts/parity-browser.mjs`, FIGHT=1 for combat): mean lap-1 time across the 6 cars within ~11% on every map (0-3% on four of five); total wrecks over 3 laps on all maps 109 headless vs 105 browser. Individual finishing order is chaotic (traffic, wrecks), so the tolerance is statistical.
Open: weather (see "Server-owned weather" under section 18; done); Low preset skips traffic bodies in the browser (the server must always build them); the room cap needs a networked load test.

## 15. Phase 2 status (2026-11-21): net core

Done: `src/shared/protocol.ts` (JSON v1 messages, strict server-side validation: clamped ranges, length caps, sanitised names, version + data-hash check), `src/sim/RaceSim.ts` (a steppable race; `HeadlessRace` is now a thin wrapper), `src/server/Room.ts` (lobby -> countdown -> racing -> results, host start, bots fill the grid, humans start at the back like the single-player game, input seq/dup filtering, per-player token-bucket rate limit, snapshots every 3rd tick = 20 Hz), `src/server/NetServer.ts` (ws, per-IP cap, join and idle timeouts, 1 KB payload cap, room cap, fixed 60 Hz accumulator loop, `/health` with tick-time p99), `src/net/NetClient.ts` (browser + Node 22 global WebSocket), `src/net/NetPilot.ts` (the AI driver fed only by snapshots, with dead-reckoning: the bot for tests and load tests). `npm run server:build` / `server:start` bundle and run it (`PORT`, `HOST`, `MAX_ROOMS`; needs `data/colliders/` next to the working directory).
Exit criterion met: a remote client drives a lap online. In-process (60 Hz, 20 Hz snapshots) the lap is 80.8 s vs 80.9 s for the in-sim autopilot; over a real WebSocket in real time (`NET_LAP=1 npx vitest run tests/net.test.ts`) a solo-vs-5-bots lap is 94.8 s and results arrive. Snapshots measured at 20.2 Hz.
Notes: the room's rate limiter uses wall-clock time, so tests that run faster than real time inject a clock. A disconnected human's car coasts (hand-over to the AI is Phase 3). Phase 3 next: client prediction + reconciliation + interpolation, N players, race flow.

## 16. Phase 3 status (2026-11-21): prediction + multiplayer (first internal build)

Design that survived testing (details in code comments): **tick-stamped inputs**. The client runs a few ticks (about 8) ahead of the server and tags each input frame with the server tick it is for; the server applies the frame for tick N during step N (repeating the previous input if it is missing, counting late frames). Prediction history is therefore keyed by server tick and lines up exactly; the lead is steered by the margin the server reports (`ack - tick`), reviewed only once the previous correction has played out. The server announces the grid in a `loading` phase and starts the countdown when every human has said `ready` (or after a timeout), so slow loaders do not miss the start.
Client modules (`src/net/`): `OnlineSession` (the one class both the headless client and the browser `Game` drive), `Reconciler` (own car: smooth blend over ~100 ms, hard snap above 3 m that accounts for the lead, no re-simulation), `Interpolator` + `PoseSmoother` (remote cars drawn 100 ms behind, extrapolation capped at 150 ms, never blended across a respawn, rate-limited catch-up after stalls), `ClockSync`, `VirtualNet` + `SimClient` (deterministic latency/jitter/TCP-stall harness), `NetPilot`.
Browser: `?online=ws://host:port&room=CODE&name=..&car=..&track=..&laps=..&start=N` joins a room (dev entry; lobby UI is Phase 5). Remote cars are `Car` puppets (`CarPhysics.makePuppet`: kinematic, no local collisions, wheel/brake/nitro state from snapshots). No local combat, pickups or weather online yet (Phase 4 / server weather).
Evidence: headless two humans + four bots finish at LAN, 60 ms RTT and 150 ms RTT + stalls with **zero rendered remote-car jumps** (the success criterion), own car predicted to 0.16-0.48 m mean when alone; six humans all finish with zero jumps; a disconnected human is taken over by the AI; clients at 8-30 fps keep a bounded lead. `tests/online.spec.ts` runs two real Chromium tabs against the real server: both go live, hold a 7-9 tick lead, reconcile at 0.05-2.5 m and draw the other human where the server says (3/3 runs).
Bugs found by this work (all fixed, all have tests): input applied by sequence number let server and client drift apart (hence tick-stamping); hard snaps ignored the client's lead and re-snapped forever; the rate limiter hid late frames from the lead controller; a catch-up/clock-sync pair that could not recover from a late first snapshot; `readControls` skipped sending when the dev autopilot was on.
Open: car-to-car contacts are not predicted locally (a bump shows up as a reconcile blend or snap), so contact-heavy starts snap more (1-2% of snapshots); online results UI and name tags (Phase 5, needs design); the server must own weather; load test and room cap (Phase 6).

## 17. Phase 4 status (2026-11-22): combat online

The server already ran the full combat sim; this phase makes the clients see and feel it.
- **Snapshots carry combat state**: per car rocket ammo and gun heat (HUD), a gun-locked flag; per snapshot the rockets in flight, the ids of taken pickups and the discrete events since the last snapshot (`gun` with its tracer endpoints and hit flag, `hit`, `wreck`, `boom`, `rkt`, `heat`, `pick`, `nitro`). Events ride in the snapshot so they stay ordered with state. The browser replays them into the same local `EventBus` the offline game uses, so the HUD, sounds, camera shake and kill feed need no online-specific code. Hull, ammo, heat and wrecks are mirrored from the snapshot (`Hull.sync`, `PulseGun.sync`, freeze/unfreeze).
- **Lag compensation** (`src/sim/lagcomp.ts`, `RaceSim`, `CombatSim`): each input frame carries `vt`, the server time (in ticks) the client was drawing the other cars at. For a human shooter the server tests the shot against every other car's box at the pose it had at `vt` (poses kept in a 24-tick ring per car), and auto-aim uses the same rewound positions; walls and scenery are tested in the live world, and the nearest hit wins. Rewind is capped by `data/combat.json` `lagComp.maxRewindMs` (250 ms = 15 ticks: a 100 ms RTT client sees targets about 200 ms old at the server, so the plan's 150 ms guess was too small); a client cannot claim more. Bots and offline play are unchanged (live positions).
- Tracers are drawn from where the shooter's car is *drawn* (remote cars are shown ~100 ms in the past, our own car ahead of the server) keeping the server's shot direction.
Evidence: `tests/lagcomp.test.ts` (box ray maths; a target teleported across the sights is hit where it was *seen* when 8 ticks of lag are claimed, and the claim is capped); `tests/netmodel.test.ts` (three humans + three bots: all clients receive the same event stream - 758/758/757 shots, 472 hits, 14 wrecks - and a wrecked car is respawned and re-adopted); `tests/online.spec.ts` (two real tabs fight bots: both see the same 151 shots / 135 hits / 4 wrecks, the HUD shows the server's hull damage).
Open: the player's own muzzle flash waits for the server event (about half an RTT); predicting it locally is a polish item. Pickups are collected on the server only (local pickup prediction not needed: the cube disappears when the server says). Online results screen / name tags need the Phase 5 designs.

## 18. Phase 5 status (2026-11-23): online screens and name tags

Built from the design handoff (canvas boards 40-48; `data/online_ui.json`, `ui/icons/*.svg` in `public/assets/ui/icons/`). Design source of truth for layout, strings and numbers is `data/online_ui.json` and the canvas; code reads strings and name-tag numbers from the data file.
- **Server/protocol** (`src/shared/protocol.ts`, `Room.ts`, `NetServer.ts`): `join` has modes `create` (private room, server-made 6-character code from the design alphabet), `join` (needs an existing code, else `not_found`) and `quick` (the fullest open public room, else opens one; `no_rooms` when the room cap blocks it). Without a mode the old join-or-create-by-name still works (dev entry, tests). New messages: `settings` (host: track, laps; un-readies everyone), `car` (change vehicle in the lobby), `rematch` (vote yes / ask for the lobby); `ping` carries the client's RTT into the roster. Start rule: host only, at least 2 humans, all ready (`SOLO_START=1` relaxes it for dev/e2e). Host leaves: lowest slot becomes host. Results rows carry car, takedowns and the lap a racer left on. Rematch: all yes -> the same race loads again; any "lobby" vote or the timer (30 s, `REMATCH_SEC`) -> everybody back to the lobby, un-readied. Departed players drop out of the roster. The lobby is re-sent every 2 s so pings stay fresh. `reject` carries the server protocol version.
- **Client**: `LobbyClient` (DOM-free: join modes, hub errors, room view, one grid announcement per race), `OnlineFlow` (hub -> lobby -> race -> results -> rematch/lobby; owns the connection; `Game.dispose` no longer closes it), screens `onlineHub`, `lobby`, `onlineResults` (+ `online.css`; phone landscape via a short-screen media query), title ONLINE entry (`O`). The server URL is `?server=`, else `VITE_RACE_SERVER`, else `ws(s)://<host>:8080`. Text fields now keep their keys in the menu navigation (`nav.ts`).
- **Name tags** (`onlineTagLayout.ts` pure rules, `onlineTags.ts` DOM): within 60 m, full opacity to 25 m, scale 1.0 -> 0.8, nearest 5 (desktop) / 3 (phone), overlapping tags stack with a leader line, dim near the reticle, targeted ring and marker for the gun-lock target, a wall/building test every 100 ms with a 150 ms fade. Online only; the offline tags are unchanged.
Evidence: 693 unit tests (new: `lobby`, `lobbyClient`, `onlineTagLayout`); `tests/onlineLobby.spec.ts` in real Chromium: hub (code filter incl. pasted `VX7·M4Q`, bad code, unreachable server), two players create/join/ready/start with name tags up, and a one-lap race to the flag -> results -> rematch -> second race. The e2e found three bugs that are fixed: a refused join showed "server down", a pasted code lost a character to `maxlength`, and ending a race closed the player's connection.
Known gaps / decisions for the owner: lobby rows show car names, not thumbnails (the board has thumbnails); "Change car" reuses the offline car picker; no player-name entry yet (design item 5), names are generated `RACER-###`; a rematch vote cannot be withdrawn (the board toggles it); a player who finishes sees their race until the server closes it (up to 30 s grace); "race already started" is worded as "room full"; the lobby's "need 2 racers" and the quick-match "searching" counter ("N/6 in the best room") have no design strings, so the lobby says "waiting on another racer" and the hub shows only elapsed time; the disconnected-tag variant, ping in the HUD and teammate colours are not v1.
Flaky: `menus.spec.ts` logged "Cannot resume a context that has been closed" once under full-suite load (passes alone twice).

### 18.1 Design gaps wired in (2026-11-23)
Boards 49–55 (`data/online_ui.json` now 125 strings): racer name entry (first ONLINE, then Edit name `N`; accent fix), hub states (connection lost with where the player was, race already started, room closed, searching shows elapsed + typical wait), lobby "need 2 racers" and host-change notice, the online loading layer and the "finished, waiting" layer (`src/ui/onlineRaceOverlay.ts`, pure logic in `onlineRaceStatus.ts`).
- Late loaders **join** the race when they finish loading (server starts the countdown at 20 s and keeps their seat), so `loading.anyway.join` is used.
- Deviations: no per-player load percentage (the server only knows loaded or not), so a racer shows loading, READY or SLOW. `finished.autopilot` was reworded to match the server (a finished car coasts to a stop, weapons off, can still be hit).
- e2e: the "finished, waiting" layer is asserted on at least one page (the client's own sim can lag the server's close under software GL).

### Server-owned weather

What the storm (Map 4 only) changes: **simulation** = wet-road grip x0.9 everywhere, braking distance x1.2, a puddle's grip x0.65 for 0.4 s plus a small yaw kick, the flooded dip's grip x0.55 and drag x1.6 (all functions of where the car is, not of rain intensity). **Visual/audio only** = rain intensity (0.9 on lap 1, 0.6 after), particles, spray, lightning, puddle and flood meshes, rain ambience. Traffic is not slowed by the storm: `setWetSpeedMul` exists but nothing calls it, so the earlier "slows traffic" note was wrong and the server's traffic already matched.

Design: the sim part moved into the three-free `src/sim/WeatherSim.ts` (puddle tracker, flood test, multipliers, per-car along-track t), stepped by `RaceSim` before each car's `preStep` and by the browser's `WeatherSystem` (which now only adds visuals). The one random input, the puddle yaw kick, is now fixed per puddle (`puddleYawKick`), so server and predicting client apply the same kick. Server AI drivers also get the wet braking/grip assumptions the browser rivals had. Protocol delta: none. Rain intensity is a pure function of the lap, and every snapshot already carries each car's `lap`; online `Game` feeds its own car's server lap to `WeatherSystem` (offline still uses the local lap). Offline behaviour is unchanged apart from the fixed kick.

Evidence: `tests/weatherSim.test.ts` (schedule, determinism, effects, RaceSim on Pham Van Dong vs a dry map, and an in-process client predicting a full rainy lap: worst alone reconcile error 2.8 m, 1.4% hard snaps, inside the dry-map bounds of 3 m and 3%). Not verified: a real browser (no Playwright run), and puddle timer state across a server-side respawn (the timer runs on, the client's does too).

### 18.2 Phase 6 security pass (2026-11-23)

Adversarial review of every client-controlled input on the race server; findings, enforcement points, env knobs and residual risks are in `docs/server-security.md`. Fixed: per-type control-message rate limit (state-broadcast amplification), far-future ticks poisoning `ack`, parser tick ceiling, name sanitising (bidi/zero-width/C1/lone surrogates/zalgo, code-point cap), room-code brute-force throttle per IP, per-IP room cap and creation rate, global connection cap, opt-in `TRUST_PROXY` for the client IP behind Caddy, slow-loris timeouts, `terminate()` for half-open sockets, write-buffer cap for non-reading clients, and exception containment per message and per room tick. Covered by `tests/security.test.ts`, which includes seeded fuzz runs against the parser and a live room. Before launch: set `TRUST_PROXY=1` and `LEGACY_JOIN=0`.
