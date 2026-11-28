/**
 * Map 7 (Suzuka Hills) layout maths, free of three.js and the DOM so node tests can cover it: where each placed model
 * stands, which of the ~27,000 instances are submitted for the camera's view, and the terrain colours.
 */
import { hash2 } from './ardennesLayout';

export interface RawPlacement {
  model: string;
  x: number;
  z: number;
  rotY: number;
  /** Absent: sample the heightmap at (x, z). `"road"`: the road height at lap fraction `t`. */
  y?: number | 'road';
  t?: number;
  scale?: number;
  yOff?: number;
}

export interface SuzukaPlacements {
  groups: Record<string, RawPlacement[]>;
}

export interface Item {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/** Every placed instance, by model path, with its height resolved. */
export function planPlacements(
  data: SuzukaPlacements,
  heightAt: (x: number, z: number) => number,
  roadYAt: (t: number) => number,
): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const rows of Object.values(data.groups)) {
    for (const r of rows) {
      const base =
        r.y === 'road' && r.t !== undefined ? roadYAt(r.t) : typeof r.y === 'number' ? r.y : heightAt(r.x, r.z) - 0.05;
      const item: Item = { x: r.x, y: base + (r.yOff ?? 0), z: r.z, yaw: r.rotY, scale: r.scale ?? 1 };
      const list = out.get(r.model);
      if (list) list.push(item);
      else out.set(r.model, [item]);
    }
  }
  return out;
}

/** How one model is drawn around the camera. */
export interface WindowCfg {
  /** Beyond this distance (m) it is not drawn. */
  radiusM: number;
  /** Most instances drawn at once (the nearest win). */
  cap: number;
  /** Only inside the view wedge (and always within `nearM`). */
  wedge: boolean;
  /** Share of instances kept close to the camera and at `radiusM` (deterministic per instance); 1 = all. */
  keepNear: number;
  keepFar: number;
}

/** Always drawn inside this distance (m), whichever way the camera looks. */
export const NEAR_M = 35;
/** The view wedge: half-angle 62 degrees. */
export const COS_HALF = Math.cos((62 * Math.PI) / 180);

const TREE: WindowCfg = { radiusM: 430, cap: 170, wedge: true, keepNear: 0.36, keepFar: 0.1 };
const FALLBACK: WindowCfg = { radiusM: 500, cap: 120, wedge: false, keepNear: 1, keepFar: 1 };

/** Per model family: radius, cap and thinning. Trees are cards of ~350 triangles, so they are thinned with distance. */
const WINDOWS: [RegExp, WindowCfg][] = [
  [/black_pine|cedar_|maple_|ginkgo|zelkova|camphor|bamboo/, TREE],
  [/house_/, { radiusM: 650, cap: 220, wedge: true, keepNear: 1, keepFar: 0.5 }],
  [/solar_array/, { radiusM: 450, cap: 120, wedge: true, keepNear: 1, keepFar: 0.4 }],
  [/hazagake/, { radiusM: 350, cap: 80, wedge: true, keepNear: 1, keepFar: 0.6 }],
  [/pylon/, { radiusM: 900, cap: 60, wedge: false, keepNear: 1, keepFar: 1 }],
  [/roadside_shrine/, { radiusM: 500, cap: 8, wedge: false, keepNear: 1, keepFar: 1 }],
  [/tyre_wall|tecpro/, { radiusM: 130, cap: 120, wedge: true, keepNear: 1, keepFar: 1 }],
  [/catch_fence|armco/, { radiusM: 200, cap: 320, wedge: true, keepNear: 1, keepFar: 1 }],
  [/marshal/, { radiusM: 260, cap: 30, wedge: false, keepNear: 1, keepFar: 1 }],
  [/spectators_/, { radiusM: 170, cap: 40, wedge: true, keepNear: 1, keepFar: 1 }],
  [
    /hill_stand|main_grandstand|pit_building|pit_wall|control_tower|transporter|vending|start_gantry/,
    { radiusM: 800, cap: 90, wedge: false, keepNear: 1, keepFar: 1 },
  ],
  [
    /corner_sign|distance_board|big_screen|tv_tower|footbridge|crossover_bridge/,
    { radiusM: 900, cap: 30, wedge: false, keepNear: 1, keepFar: 1 },
  ],
  [/ferris_wheel|coaster|circuit_hotel/, { radiusM: 2600, cap: 4, wedge: false, keepNear: 1, keepFar: 1 }],
];

export function windowFor(model: string): WindowCfg {
  return WINDOWS.find(([re]) => re.test(model))?.[1] ?? FALLBACK;
}

/** A square-cell index over a model's instances, so a camera query only looks at nearby cells. */
export class ItemGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(
    readonly items: readonly Item[],
    private readonly cell = 128,
  ) {
    items.forEach((it, i) => {
      const k = this.key(Math.floor(it.x / cell), Math.floor(it.z / cell));
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    });
  }

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Indices of the items whose cell touches the disc around (x, z). */
  near(x: number, z: number, radius: number, out: number[] = []): number[] {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - radius) / c);
    const x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c);
    const z1 = Math.floor((z + radius) / c);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(this.key(cx, cz));
        if (list) for (const i of list) out.push(i);
      }
    }
    return out;
  }
}

export interface View {
  x: number;
  z: number;
  /** Unit heading in the XZ plane. */
  fx: number;
  fz: number;
}

const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

/** The instances to draw for this view: in range, in the wedge, thinned with distance, nearest first, at most `cap`. */
export function selectWindow(grid: ItemGrid, view: View, cfg: WindowCfg, scratch: number[] = []): Item[] {
  const r2 = cfg.radiusM * cfg.radiusM;
  const picked: { d2: number; it: Item }[] = [];
  for (const i of grid.near(view.x, view.z, cfg.radiusM, scratch)) {
    const it = grid.items[i];
    const dx = it.x - view.x;
    const dz = it.z - view.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    const d = Math.sqrt(d2);
    if (d > NEAR_M) {
      if (cfg.wedge && (dx * view.fx + dz * view.fz) / d < COS_HALF) continue;
      if (cfg.keepNear < 1 || cfg.keepFar < 1) {
        const keep = cfg.keepNear + (cfg.keepFar - cfg.keepNear) * smooth((d - NEAR_M) / (cfg.radiusM - NEAR_M));
        if (hash2(Math.round(it.x * 4), Math.round(it.z * 4), 7) > keep) continue;
      }
    }
    picked.push({ d2, it });
  }
  if (picked.length > cfg.cap) {
    picked.sort((a, b) => a.d2 - b.d2);
    picked.length = cfg.cap;
  }
  return picked.map((p) => p.it);
}

// ------------------------------------------------------------------------------------------------ terrain colours

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const GRASS = hex('#9BA05A');
const DRY = hex('#B59C55');
const FOREST = hex('#5A4529');
const PADDY = hex('#C9B468');
const BUILT = hex('#8F8B82');
const WATER = hex('#4C7A8C');
/** The mown run-off beside the circuit: a clean green that sets the asphalt apart from the ground next to it. */
const RUNOFF = hex('#5E8236');

/** Share (0..1) of the run-off tint at `roadD` metres from the centre line: full next to the road, gone by 34 m. */
export function runoffShare(roadD: number): number {
  const k = Math.min(1, Math.max(0, (roadD - 18) / 16));
  return 1 - k * k * (3 - 2 * k);
}

/**
 * Terrain vertex colour (sRGB 0..1) multiplying the tiled grass texture: autumn grass with dry patches, leaf litter in
 * the forest, straw-coloured harvested paddy, concrete grey in built-up land and car parks, blue-grey at the ponds.
 */
export function suzukaTerrainColor(
  land: { forest: number; paddy: number; built: number; water: number },
  noiseA: number,
  noiseB: number,
  out: [number, number, number] = [0, 0, 0],
  runoff = 0,
): [number, number, number] {
  const dry = Math.max(0, noiseB - 0.55) * 0.9 + noiseA * 0.15;
  const cl = (v: number): number => Math.min(1, Math.max(0, v));
  const f = cl(land.forest * 1.1);
  const p = cl(land.paddy);
  const b = cl(land.built);
  const w = cl(land.water);
  for (let c = 0; c < 3; c++) {
    let v = GRASS[c] + (DRY[c] - GRASS[c]) * cl(dry);
    v += (FOREST[c] - v) * f;
    v += (PADDY[c] - v) * p;
    v += (BUILT[c] - v) * b;
    v += (WATER[c] - v) * w;
    v += (RUNOFF[c] - v) * cl(runoff);
    out[c] = v;
  }
  return out;
}
