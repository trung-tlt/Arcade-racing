import type { HandlingDef } from './Data';

interface Range {
  min: number;
  max: number;
  step: number;
}

const RANGES: Record<string, Range> = {
  'body.comY': { min: -0.5, max: 1, step: 0.01 },
  'body.linearDamping': { min: 0, max: 1, step: 0.005 },
  'body.angularDamping': { min: 0, max: 5, step: 0.05 },
  'body.downforcePerSpeedSq': { min: 0, max: 5, step: 0.05 },
  'suspension.restLength': { min: 0.1, max: 0.8, step: 0.01 },
  'suspension.maxTravel': { min: 0.05, max: 0.8, step: 0.01 },
  'suspension.stiffness': { min: 5, max: 100, step: 0.5 },
  'suspension.compression': { min: 0, max: 15, step: 0.1 },
  'suspension.relaxation': { min: 0, max: 15, step: 0.1 },
  'suspension.maxForce': { min: 10000, max: 500000, step: 1000 },
  'steering.maxAtStandstillRad': { min: 0.1, max: 1, step: 0.01 },
  'steering.maxAtHighSpeedRad': { min: 0.02, max: 0.6, step: 0.01 },
  'steering.highSpeedMps': { min: 20, max: 120, step: 1 },
  'steering.ratePerSec': { min: 0.5, max: 15, step: 0.1 },
  'steering.returnRatePerSec': { min: 0.5, max: 20, step: 0.1 },
  'steering.handlingRefRating': { min: 1, max: 10, step: 0.1 },
  'camera.fovBase': { min: 40, max: 110, step: 1 },
  'camera.fovNitro': { min: 40, max: 120, step: 1 },
};

function rangeFor(path: string, value: number): Range {
  const r = RANGES[path];
  if (r) return r;
  const span = Math.max(1, Math.abs(value) * 3);
  return { min: value < 0 ? -span : 0, max: span, step: span / 400 };
}

export interface DevTools {
  begin(): void;
  end(): void;
  dispose(): void;
}

export async function setupDevTools(opts: { handling: HandlingDef; onReset: () => void }): Promise<DevTools> {
  const [{ default: GUI }, { default: Stats }] = await Promise.all([import('lil-gui'), import('stats.js')]);

  const gui = new GUI({ title: 'Handling' });
  const groups = ['suspension', 'engine', 'steering', 'grip', 'nitro', 'camera', 'body'] as const;
  for (const g of groups) {
    const folder = gui.addFolder(g);
    folder.close();
    const obj = opts.handling[g] as Record<string, number>;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] !== 'number') continue;
      const r = rangeFor(`${g}.${key}`, obj[key]);
      folder.add(obj, key, r.min, r.max, r.step);
    }
  }
  gui.add({ reset: opts.onReset }, 'reset').name('Reset car (R)');

  const stats = new Stats();
  stats.showPanel(0);
  stats.dom.style.pointerEvents = 'none';
  document.body.appendChild(stats.dom);

  return {
    begin: () => stats.begin(),
    end: () => stats.end(),
    dispose: () => {
      gui.destroy();
      stats.dom.remove();
    },
  };
}
