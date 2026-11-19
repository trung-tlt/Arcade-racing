export interface CoverBox {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  /** Underside of the deck (world y). */
  deckY: number;
}

/** Rain gets quieter under a bridge or overpass: `mute` (e.g. 0.5) when (x, y, z) is under a deck, else 1. */
export function coverFactor(boxes: readonly CoverBox[], x: number, y: number, z: number, mute: number): number {
  for (const b of boxes) {
    if (Math.abs(x - b.x) <= b.halfX && Math.abs(z - b.z) <= b.halfZ && y < b.deckY) return mute;
  }
  return 1;
}

/** The ring-road overpass of a track's JSON (`crossOverpass.position`), as a cover box. Missing = none. */
export function coversFromTrack(
  raw: Record<string, unknown>,
  halfX: number,
  halfZ: number,
  deckHeightM: number,
): CoverBox[] {
  const o = raw.crossOverpass as { position?: number[] } | undefined;
  if (!o?.position || o.position.length < 3) return [];
  return [{ x: o.position[0], z: o.position[2], halfX, halfZ, deckY: o.position[1] + deckHeightM }];
}
