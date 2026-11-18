/** m:ss.mmm, or "--:--.---" for a missing time. */
export function formatTime(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '--:--.---';
  const ms = Math.round(sec * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
