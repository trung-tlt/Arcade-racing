/** One AI opponent: who they are (random each race) and how they drive (fixed per grid slot in data/ai.json). */
export interface Rival {
  id: string;
  name: string;
  car: string;
  laneOffsetM: number;
  skill: number;
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
