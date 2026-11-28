import { describe, expect, it } from 'vitest';
import { ALL_TRACKS, HIDDEN_TRACK_IDS, TRACKS, getTrack } from '../src/core/Data';
import { TRACK_IDS } from '../src/server/Room';

describe('hidden maps', () => {
  it('Cong Hoa, Hanoi and Pham Van Dong are off the menus and the online lobby but still exist', () => {
    expect(HIDDEN_TRACK_IDS).toEqual(['cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong']);
    expect(TRACKS.map((t) => t.id)).toEqual(['cat_lai', 'monte_carlo', 'ardennes', 'suzuka_hills']);
    expect(TRACK_IDS).toEqual(TRACKS.map((t) => t.id));
    expect(ALL_TRACKS).toHaveLength(7);
    for (const id of HIDDEN_TRACK_IDS) expect(getTrack(id).id).toBe(id);
  });
});
