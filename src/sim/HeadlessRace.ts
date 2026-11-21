import { AI, RACE } from '../core/Data';
import { STEP } from '../core/Loop';
import { RaceSim, initSim, type SlotSpec } from './RaceSim';

export { initSim };

export interface HeadlessRaceOpts {
  trackId: string;
  laps: number;
  /** Cars on the grid: the autopilot player plus the first `cars - 1` rivals in `data/ai.json` (default 6). */
  cars?: number;
  /** The autopilot player's vehicle (default kestrel_gt). */
  playerCar?: string;
  /** Guns, rockets, pickups, wrecks and contact damage (default true). */
  combat?: boolean;
  /** Rivals never fire (the browser's `debugAiHoldFire`); pickups are still collected. */
  holdFire?: boolean;
  /** Ambient traffic (default true). */
  traffic?: boolean;
  /** Rebuild the baked scenery colliders (default true; skipped if the map has no bake). */
  scenery?: boolean;
  /** Safety stop in simulated seconds. */
  maxSec?: number;
}

export interface HeadlessRaceResult {
  /** Car ids, first to last. */
  order: string[];
  /** Finish time per car in seconds (null = did not finish). */
  finishSec: Record<string, number | null>;
  /** Fastest lap per car in seconds (null = none completed). */
  bestLapSec: Record<string, number | null>;
  /** Times each car was put back on the road (stuck, flipped or fallen). */
  recoveries: Record<string, number>;
  /** Wrecks suffered / takedowns scored per car (combat on). */
  wrecks: Record<string, number>;
  takedowns: Record<string, number>;
  simSec: number;
  steps: number;
  /** Wall-clock ms spent in one fixed step (all cars + world.step), per step. */
  stepMs: number[];
}

/**
 * An AI-only race (an autopilot "player" on its grid slot, rivals on the rest, like the browser's `debugAutopilot`),
 * run to the flag as fast as the CPU allows. Used to compare the headless sim with the browser.
 */
export async function runHeadlessRace(opts: HeadlessRaceOpts): Promise<HeadlessRaceResult> {
  await initSim();
  const count = opts.cars ?? 6;
  const playerSlot = RACE.ai.playerGridSlot;
  const free = Array.from({ length: RACE.track.gridSlotCount }, (_, i) => i).filter((i) => i !== playerSlot);
  const slots: SlotSpec[] = [
    { id: 'player', carId: opts.playerCar ?? 'kestrel_gt', kind: 'pilot', skill: 0.9, gridSlot: playerSlot },
    ...AI.rivals.slice(0, count - 1).map((r, i): SlotSpec => ({
      id: r.id,
      carId: r.car,
      kind: 'ai',
      skill: r.skill,
      laneOffsetM: r.laneOffsetM,
      gridSlot: free[i],
    })),
  ];
  const sim = new RaceSim({
    trackId: opts.trackId,
    laps: opts.laps,
    slots,
    combat: opts.combat,
    holdFire: opts.holdFire,
    traffic: opts.traffic,
    scenery: opts.scenery,
  });
  const ids = slots.map((s) => s.id);
  const bestLap: Record<string, number | null> = Object.fromEntries(ids.map((id) => [id, null]));
  const wrecks: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const takedowns: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const lapStart = new Map<string, number>();
  sim.events.on('lapComplete', (ev) => {
    const e = sim.entry(ev.carId);
    if (!e) return;
    const lap = e.race.timeSec - (lapStart.get(ev.carId) ?? 0);
    lapStart.set(ev.carId, e.race.timeSec);
    const best = bestLap[ev.carId];
    if (best === null || lap < best) bestLap[ev.carId] = lap;
  });
  sim.events.on('carWrecked', (ev) => {
    wrecks[ev.carId]++;
    if (ev.attackerId && ev.attackerId !== ev.carId) takedowns[ev.attackerId]++;
  });

  const maxSteps = Math.round((opts.maxSec ?? 900) / STEP);
  const stepMs: number[] = [];
  while (sim.tick < maxSteps) {
    const t0 = performance.now();
    sim.step();
    stepMs.push(performance.now() - t0);
    if (sim.finished) break;
  }
  const finishSec: Record<string, number | null> = {};
  for (const e of sim.entries) finishSec[e.id] = e.race.finishTimeSec;
  const result: HeadlessRaceResult = {
    order: sim.ranking(),
    finishSec,
    bestLapSec: bestLap,
    recoveries: Object.fromEntries(sim.entries.map((e) => [e.id, e.recoveries])),
    wrecks,
    takedowns,
    simSec: sim.tick * STEP,
    steps: sim.tick,
    stepMs,
  };
  sim.dispose();
  return result;
}
