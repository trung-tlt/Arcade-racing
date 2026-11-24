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
