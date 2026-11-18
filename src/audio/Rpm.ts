export interface EngineState {
  /** 1-based gear. */
  gear: number;
  /** 0..1 revs. */
  rpm: number;
}

/** Fake gearbox: the speed range is split evenly into `gears`; revs climb within each gear. */
export function engineState(
  speedMps: number,
  topSpeedMps: number,
  gears: number,
  idleRpm: number,
  gearBaseRpm: number,
): EngineState {
  const f = Math.min(0.9999, Math.max(0, Math.abs(speedMps) / topSpeedMps));
  const gear = Math.floor(f * gears) + 1;
  const within = f * gears - (gear - 1);
  return { gear, rpm: Math.max(idleRpm, gearBaseRpm + (1 - gearBaseRpm) * within) };
}
