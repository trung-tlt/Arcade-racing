export type PickupType = 'rocket' | 'repair' | 'nitro';

export interface PickupDef {
  id: number;
  t: number;
  lane: number;
  type: PickupType;
}

const TYPES: readonly string[] = ['rocket', 'repair', 'nitro'];

function isPickupType(s: string): s is PickupType {
  return TYPES.includes(s);
}

/** Flatten track pickup clusters into one def per item with sequential ids. */
export function expandPickups(clusters: { t: number; items: { type: string; lane: number }[] }[]): PickupDef[] {
  const out: PickupDef[] = [];
  for (const c of clusters) {
    for (const item of c.items) {
      if (!isPickupType(item.type)) throw new Error(`Unknown pickup type "${item.type}"`);
      out.push({ id: out.length, t: c.t, lane: item.lane, type: item.type });
    }
  }
  return out;
}

/** Pure pickup availability and respawn timers. */
export class PickupField {
  private readonly remaining: number[];

  constructor(
    readonly defs: readonly PickupDef[],
    private readonly respawnSec: Record<PickupType, number>,
  ) {
    this.remaining = defs.map(() => 0);
  }

  isAvailable(id: number): boolean {
    return this.remaining[id] === 0;
  }

  take(id: number): PickupType | null {
    if (!this.isAvailable(id)) return null;
    const def = this.defs[id];
    this.remaining[id] = this.respawnSec[def.type];
    return def.type;
  }

  /** Returns ids that respawned this tick. */
  update(dt: number): number[] {
    const back: number[] = [];
    for (let i = 0; i < this.remaining.length; i++) {
      if (this.remaining[i] <= 0) continue;
      this.remaining[i] -= dt;
      if (this.remaining[i] <= 1e-9) {
        this.remaining[i] = 0;
        back.push(i);
      }
    }
    return back;
  }

  /** 1 when available, otherwise 0..1 progress toward respawn. */
  respawnProgress(id: number): number {
    const rem = this.remaining[id];
    if (rem <= 0) return 1;
    return 1 - rem / this.respawnSec[this.defs[id].type];
  }
}

export function grantFor(type: PickupType, grants: Record<PickupType, Record<string, number>>): Record<string, number> {
  return grants[type];
}
