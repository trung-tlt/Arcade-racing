/** Paint scheme override for one car (Fulmine FX liveries): body, accent stripes and underglow, as hex colours. */
export interface Livery {
  name?: string;
  paint: string;
  accent: string;
  glow: string;
}

/** One AI opponent: who they are (random each race) and how they drive (fixed per grid slot in data/ai.json). */
export interface Rival {
  id: string;
  name: string;
  car: string;
  laneOffsetM: number;
  skill: number;
  /** Set on maps with a track roster (Map 5's open-wheel grid). */
  livery?: Livery;
}

/** Fisher-Yates shuffle of a copy. */
function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Gives each rival slot a random name (upper-cased for the HUD) and a random vehicle. Names never repeat while the list
 * lasts, and vehicles never repeat or copy the player's while the garage lasts. Driving traits stay with the slot.
 */
export function rollRoster(
  slots: readonly Rival[],
  names: readonly string[],
  carIds: readonly string[],
  playerCarId: string,
  rnd: () => number = Math.random,
): Rival[] {
  const pickNames = shuffled(names, rnd);
  const others = carIds.filter((c) => c !== playerCarId);
  const pickCars = shuffled(others.length > 0 ? others : carIds, rnd);
  return slots.map((s, i) => ({
    ...s,
    name: (pickNames[i % pickNames.length] ?? s.name).toLocaleUpperCase('vi'),
    car: pickCars[i % pickCars.length] ?? s.car,
  }));
}

export interface TrackRoster {
  car: string;
  liveries: readonly Livery[];
}

/**
 * Maps with an entry in `ai.json` `trackRosters` field their own grid: every rival drives that car, each in a different
 * livery (shuffled, so who wears which changes per race). Other maps keep the random roster untouched.
 */
export function applyTrackRoster(
  rivals: readonly Rival[],
  trackId: string,
  rosters: Readonly<Record<string, TrackRoster>>,
  rnd: () => number = Math.random,
): Rival[] {
  const t = rosters[trackId];
  if (!t || t.liveries.length === 0) return rivals.map((r) => ({ ...r }));
  const pool = shuffled(t.liveries, rnd);
  return rivals.map((r, i) => ({ ...r, car: t.car, livery: pool[i % pool.length] }));
}
