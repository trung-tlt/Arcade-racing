import { beforeAll, describe, expect, it } from 'vitest';
import { getTrack, RACE } from '../src/core/Data';
import { SimClient } from '../src/net/SimClient';
import { VirtualNet } from '../src/net/VirtualNet';
import { Room } from '../src/server/Room';
import { dataHash } from '../src/shared/dataHash';
import { puddleYawKick, WeatherSim, type WeatherBody } from '../src/sim/WeatherSim';
import { initSim, RaceSim } from '../src/sim/RaceSim';
import { rainIntensityAt } from '../src/weather/rainConfig';
import { WEATHER_FX } from '../src/weather/config';
import { relaxTightBends } from '../src/world/relaxBends';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await initSim();
});

const def = getTrack('pham_van_dong');
const weather = def.weather as NonNullable<typeof def.weather>;

function pathOf(): TrackPath {
  return new TrackPath(
    relaxTightBends(def.spline.points, RACE.track.minTurnRadiusM),
    RACE.track.sampleSpacingM,
    RACE.track.projectWindowSamples,
  );
}

function body(x: number, y: number, z: number, speed = 20): WeatherBody & { kicks: number[] } {
  const kicks: number[] = [];
  return {
    curr: { p: { x, y, z } },
    speedMps: speed,
    surfaceGripMul: 1,
    brakeDistanceMul: 1,
    dragMul: 1,
    addYawKick: (k) => kicks.push(k),
    kicks,
  };
}

describe('weather schedule', () => {
  it('rain intensity is a pure function of the lap: heavy, then easing, then held', () => {
    expect(rainIntensityAt(weather, 0)).toBe(0.9);
    expect(rainIntensityAt(weather, 1)).toBe(0.6);
    expect(rainIntensityAt(weather, 5)).toBe(0.6);
    expect(rainIntensityAt(weather, 1)).toBe(rainIntensityAt(weather, 1));
  });

  it('puddle yaw kicks are fixed per puddle, alternate in direction and stay within the authored size', () => {
    const max = (WEATHER_FX.puddle.yawKickDegS * Math.PI) / 180;
    for (let i = 0; i < weather.puddles.items.length; i++) {
      const k = puddleYawKick(i, WEATHER_FX.puddle.yawKickDegS);
      expect(k).toBe(puddleYawKick(i, WEATHER_FX.puddle.yawKickDegS));
      expect(Math.abs(k)).toBeLessThanOrEqual(max);
      expect(Math.abs(k)).toBeGreaterThan(max * 0.49);
      expect(Math.sign(k)).toBe(i % 2 === 0 ? 1 : -1);
    }
  });
});

describe('WeatherSim', () => {
  const path = pathOf();
  const roadY = RACE.track.roadY;

  it('puts every car on the wet road: grip 0.9, braking 1.2x, no drag', () => {
    const w = new WeatherSim(weather, path, roadY);
    const p = path.pointAt(0.1);
    const b = body(p.x, p.y + roadY + 0.4, p.z);
    w.stepCar('a', b, 1 / 60);
    expect(b.surfaceGripMul).toBe(weather.grip.wetMul);
    expect(b.brakeDistanceMul).toBe(weather.grip.brakeDistanceMul);
    expect(b.dragMul).toBe(1);
  });

  it('a puddle cuts grip for gripSec, kicks the yaw once and is the same for two identical runs', () => {
    const run = (): { grips: number[]; kicks: number[] } => {
      const w = new WeatherSim(weather, path, roadY);
      const s = w.spots[2];
      const t = weather.puddles.items[2].t;
      const b = body(s.x, s.y + 0.4, s.z);
      const grips: number[] = [];
      for (let i = 0; i < 40; i++) {
        w.stepCar('a', b, 1 / 60);
        grips.push(b.surfaceGripMul);
      }
      expect(t).toBeGreaterThan(0);
      return { grips, kicks: b.kicks };
    };
    const a = run();
    expect(a.grips[0]).toBe(weather.grip.puddleMul);
    const last = a.grips[a.grips.length - 1];
    expect(last).toBe(weather.grip.puddleMul > weather.grip.wetMul ? weather.grip.wetMul : last);
    expect(a.grips.indexOf(weather.grip.wetMul)).toBeGreaterThan(Math.floor(WEATHER_FX.puddle.gripSec * 60) - 2);
    expect(a.kicks).toHaveLength(1);
    expect(run()).toEqual(a);
  });

  it('no kick below the splash speed, and the flood dip adds grip loss and drag', () => {
    const w = new WeatherSim(weather, path, roadY);
    const s = w.spots[0];
    const slow = body(s.x, s.y + 0.4, s.z, 2);
    w.stepCar('slow', slow, 1 / 60);
    expect(slow.kicks).toHaveLength(0);
    expect(slow.surfaceGripMul).toBe(weather.grip.puddleMul);

    const mid = (weather.flood.fromT + weather.flood.toT) / 2;
    const p = path.pointAt(mid);
    const wet = body(p.x, weather.flood.waterY + 0.3, p.z);
    w.stepCar('wade', wet, 1 / 60);
    expect(wet.surfaceGripMul).toBe(weather.grip.floodMul);
    expect(wet.dragMul).toBe(weather.flood.dragMul);
  });
});

describe('weather in the headless race', () => {
  it('RaceSim applies the storm to every car on Pham Van Dong and not on a dry map', () => {
    const sim = new RaceSim({
      trackId: 'pham_van_dong',
      laps: 1,
      slots: [{ id: 'a', carId: 'kestrel_gt', kind: 'pilot' }],
      combat: false,
    });
    for (let i = 0; i < 5; i++) sim.step();
    const ph = (sim.entry('a') as NonNullable<ReturnType<RaceSim['entry']>>).car.physics;
    expect(ph.surfaceGripMul).toBeLessThanOrEqual(weather.grip.wetMul);
    expect(ph.brakeDistanceMul).toBe(weather.grip.brakeDistanceMul);
    sim.dispose();

    const dry = new RaceSim({
      trackId: 'monte_carlo',
      laps: 1,
      slots: [{ id: 'a', carId: 'kestrel_gt', kind: 'pilot' }],
      combat: false,
    });
    for (let i = 0; i < 5; i++) dry.step();
    const dp = (dry.entry('a') as NonNullable<ReturnType<RaceSim['entry']>>).car.physics;
    expect(dp.surfaceGripMul).toBe(1);
    dry.dispose();
  });

  it('a wet lap is slower than the same lap with the weather removed would be (grip is really applied)', () => {
    const lapTime = (wet: boolean): number => {
      const sim = new RaceSim({
        trackId: 'pham_van_dong',
        laps: 1,
        slots: [{ id: 'a', carId: 'kestrel_gt', kind: 'pilot' }],
        combat: false,
        traffic: false,
      });
      if (!wet) (sim as unknown as { weather: null }).weather = null;
      for (let i = 0; i < 60 * 40 && !sim.finished; i++) sim.step();
      const e = sim.entry('a') as NonNullable<ReturnType<RaceSim['entry']>>;
      const progress = e.race.laps.lap + e.t;
      sim.dispose();
      return progress;
    };
    // After 40 s the dry car has gone further.
    expect(lapTime(false)).toBeGreaterThan(lapTime(true));
  });

  it('a client predicting its own car through a rainy Pham Van Dong lap stays reconciled with the server', () => {
    const net = new VirtualNet(11);
    const link = { latencyMs: 30, jitterMs: 8, loss: 0, rtoMs: 200 };
    const room = new Room({
      code: 'WET',
      trackId: 'pham_van_dong',
      laps: 1,
      hash: dataHash(),
      minPlayers: 1,
      needAllReady: false,
      now: () => net.now,
    });
    const client = new SimClient({
      net,
      room,
      trackId: 'pham_van_dong',
      carId: 'kestrel_gt',
      name: 'P1',
      up: link,
      down: link,
    });
    client.send({ t: 'start' });
    for (let i = 0; i < 60 * 260 && room.phase !== 'results'; i++) {
      net.now += 1000 / 60;
      net.flush();
      room.tick();
      client.frame();
    }
    room.dispose();
    const all = client.session.log.filter((r) => r.kind !== 'unknown');
    const alone = all.filter((r) => !r.nearOther);
    const worst = Math.max(0, ...alone.filter((r) => r.kind !== 'snap').map((r) => r.errM));
    const snaps = alone.filter((r) => r.kind === 'snap').length;
    console.log(`WETNET n=${all.length} phase=${room.phase} aloneWorst=${worst.toFixed(2)} aloneSnaps=${snaps}`);
    expect(room.phase).toBe('results');
    expect(all.length).toBeGreaterThan(100);
    // The same bounds as the dry-map network test.
    expect(worst).toBeLessThan(3);
    expect(snaps).toBeLessThan(all.length * 0.03);
  }, 240_000);
});
