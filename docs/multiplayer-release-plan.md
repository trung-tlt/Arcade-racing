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
Open: weather (Pham Van Dong's storm slows traffic and grip) is not in the headless race and must become server state; Low preset skips traffic bodies in the browser (the server must always build them); the room cap needs a networked load test.
