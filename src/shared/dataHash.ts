import { AI, CARS, COMBAT, HANDLING, RACE, TRACKS, WEAPONS } from '../core/Data';

/** 32-bit FNV-1a over a string, as 8 hex digits. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let cached: string | null = null;

/** Hash of every data file the simulation reads. Client and server must agree or the sim diverges. */
export function dataHash(): string {
  cached ??= fnv1a(JSON.stringify([CARS, HANDLING, RACE, AI, COMBAT, WEAPONS, TRACKS.map((t) => t.raw)]));
  return cached;
}
