import online from '../../../data/online_ui.json';
import { CARS, TRACKS, type TrackDef } from '../../core/Data';
import { formatRoomCode } from '../../shared/protocol';

export { formatRoomCode };

export const ONLINE = online;
export type StrKey = keyof typeof online.strings;

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** A string from `data/online_ui.json` with `{name}` holes filled in (values are HTML-escaped). */
export function str(key: StrKey, vars: Record<string, string | number> = {}): string {
  return online.strings[key].replace(/\{(\w+(?::\w+)?)\}/g, (_, k: string) => esc(String(vars[k] ?? `{${k}}`)));
}

/** Signal strength 1..4 from a round trip in ms (`ping` in the data file); 0 = not measured yet. */
export function pingLevel(ms: number): 0 | 1 | 2 | 3 | 4 {
  if (ms < 0) return 0;
  return ms < 60 ? 4 : ms < 100 ? 3 : ms < 180 ? 2 : 1;
}

/** The ping bars icon and the number next to it. */
export function pingHtml(ms: number): string {
  const lvl = pingLevel(ms);
  if (lvl === 0) return '<span class="ol-ping-ms">–</span>';
  return `<img class="ol-ping" src="/assets/${online.icons[`ping_${lvl}` as 'ping_1']}" alt="" width="20" height="20" /><span class="ol-ping-ms ping${lvl}">${ms} ms</span>`;
}

export const icon = (name: keyof typeof online.icons, size = 18): string =>
  `<img class="ol-icon" src="/assets/${online.icons[name]}" alt="" width="${size}" height="${size}" aria-hidden="true" />`;

export const carName = (id: string): string => CARS.find((c) => c.id === id)?.name ?? id;
export const trackOf = (id: string): TrackDef => TRACKS.find((t) => t.id === id) ?? TRACKS[0];
export const trackPreview = (id: string): string => `/assets/ui/previews/${id}.jpg`;
/** The laps a host can pick for a map: the same set as the single-player setup. */
export const lapOptions = (t: TrackDef): number[] => [...new Set([1, t.laps, 3, 5])].sort((a, b) => a - b);

const NAME_KEY = 'voltline.online.name';
/** The player's online name: saved, else a generated `RACER-123` (name entry is not in v1). */
export function playerName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
    const made = `RACER-${100 + Math.floor(Math.random() * 900)}`;
    localStorage.setItem(NAME_KEY, made);
    return made;
  } catch {
    return 'RACER';
  }
}
