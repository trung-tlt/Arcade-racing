export interface BestLap {
  ms: number;
  car: string;
}

const KEY_PREFIX = 'voltline.bestLap';
const keyFor = (trackId: string): string => `${KEY_PREFIX}.${trackId}`;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null | undefined): BestLap | null {
  try {
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<BestLap>;
    return typeof v.ms === 'number' && v.ms > 0 && typeof v.car === 'string' ? { ms: v.ms, car: v.car } : null;
  } catch {
    return null;
  }
}

/** Best lap for one map (the old pre-maps Harbor Loop key is ignored: that map no longer exists). */
export function loadBestLap(trackId: string, store: Store | null = defaultStore()): BestLap | null {
  try {
    return parse(store?.getItem(keyFor(trackId)));
  } catch {
    return null;
  }
}

/** Saves `sec` when it beats the stored record for that map. Returns true when a new record was set. */
export function saveBestLap(trackId: string, sec: number, car: string, store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  const ms = Math.round(sec * 1000);
  const cur = loadBestLap(trackId, store);
  if (!Number.isFinite(ms) || ms <= 0 || (cur && cur.ms <= ms)) return false;
  try {
    store.setItem(keyFor(trackId), JSON.stringify({ ms, car }));
    return true;
  } catch {
    return false;
  }
}

/** '1:04.912 · Kestrel GT' or 'No lap yet'. */
export function bestLapText(b: BestLap | null): string {
  if (!b) return 'No lap yet';
  const m = Math.floor(b.ms / 60000);
  const s = Math.floor((b.ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(b.ms % 1000).padStart(3, '0')} · ${b.car}`;
}
