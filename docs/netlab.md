# netlab: online races without a human

`npm run netlab` starts a real race server, puts a WebSocket proxy in front of each player that makes the link bad on
purpose (delay, jitter, TCP-style stalls), opens one real browser per player on the dev server, turns the autopilots
on and measures a window of racing. The numbers are the same ones the in-game F9 report prints, plus what the server
saw, so a change to the net code can be judged without anyone playing.

```
npm run netlab -- --profile 60ms,mobile --track cong_hoa,ardennes --players 2 --seconds 40
npm run netlab -- --profile all --track ardennes --baseline netlab-baseline.json      # print the change vs a saved run
npm run netlab -- --profile 60ms --track cong_hoa --players 2 --params ghosts=1       # A/B a ?switch in the game
NETLAB_TRACE=1 npm run netlab -- --profile lan --track cong_hoa --players 1 --seconds 30   # every correction over 0.5 m
```

Profiles (`scripts/netlab/impair.mjs`): `lan`, `60ms` (30 ms each way, 8 ms jitter), `150ms` (75 ms, 20 ms jitter, 1%
stalls), `mobile` (45 ms, 40 ms jitter, 2% stalls). `--render skip` (default) leaves the GPU draw out so several clients
fit on one machine at a steady 60 fps; `--render gpu` keeps it (slow under software GL).

What to read in the headline (worst client of the run): `reconOver50cm` / `reconSnap` / `reconMaxErrM` (how often the
server had to move the player's car: contact, wrecks, drift), `holdPerMin` / `catchUpPerMin` (the lead controller
stalling or racing ahead: visible hitches), `extrapolatingPct` (other cars drawn past their newest snapshot),
`interpDelayMs`, `hitches`, and `serverMissedTicksP95` (ticks the server had no input for).

`NETLAB_TRACE=1` prints, for each correction over 0.5 m, the client's predicted car and the server's car at that tick:
a server speed far below the client's at the same place means the server had a contact the client did not see.

`netlab-baseline.json` is the last saved headline per profile/map; machine-dependent in the frame numbers only.
Results land in `netlab-out/` (ignored).

## Findings so far

- Hard corrections come from contact the server resolves and the client cannot see (the server's bots and other
  players are puppets locally). Solid stand-ins at the server's predicted positions (ghosts) made it worse in this lab,
  and in a headless one, and were dropped.
- On the `mobile` profile the lead controller holds and catches up hundreds of times a minute and other cars are
  extrapolated 8-9% of frames: jitter handling is the second thing to improve.

- Lead controller (ardennes, 2 players): reviewing a 10th-percentile margin over 30 snapshots with a band of 6-18 ticks
  (was the minimum over 10, band 2-8) cut holds/catch-ups on `mobile` from ~310/120 to ~40/25 per minute and, on
  `60ms`, hitches from 233 to 0. `serverMissedTicksP95` on `mobile` stays high (stall-driven, 100-200), so the next step
  there is the input redundancy / bots-local work.

## Client authority and no bots (switches, off by default)

- `?auth=client` (netlab: `--params auth=client`): the browser sends its own car's state with every input frame; the server puts that human car there before each step and keeps running the bots, combat and race rules. The own car is never corrected (the reconciler only measures), and remote cars get solid colliders so the own car bumps them. A pose is ignored while a server reset (wreck respawn, fall recovery) is in flight (`rs` mismatch). Server log: `poses: {applied, skipped}` per player in `race_sample`.
- Bots are a host setting in the online lobby (BOTS OFF / ON pills next to the laps), default off: with it off only the humans race. The server env `BOTS=1` makes new rooms start with bots on (netlab sets it unless `NETLAB_BOTS=0`).
- Measured on xa_lo_ha_noi, 2 players, 60 ms, 90 s: with bots, standard mode 899 corrections over 0.5 m and 40 hard snaps; without bots 328 and 11. With `auth=client` and no bots the only differences left are the server's copy being one tick off (0.5 to 0.9 m at 40 to 60 m/s), which the browser does not apply; no hard snaps in two runs. Contact damage between cars is not yet decided by the clients in this mode.
