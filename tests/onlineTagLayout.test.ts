import { describe, expect, it } from 'vitest';
import {
  boxSize,
  layoutTags,
  tagName,
  tagOpacity,
  tagScale,
  type LayoutOpts,
  type TagInput,
} from '../src/ui/onlineTagLayout';

const desk: LayoutOpts = { maxTags: 5, phone: false, width: 1280, height: 720, reticle: { x: 640, y: 360 } };
const tag = (id: string, dist: number, x = 200, y = 500, over: Partial<TagInput> = {}): TagInput => ({
  id,
  dist,
  x,
  y,
  nameLen: 6,
  seen: 1,
  ...over,
});

describe('name tag rules (board 40)', () => {
  it('opacity is full to 25 m, fades linearly and is gone at 60 m', () => {
    expect(tagOpacity(17)).toBe(1);
    expect(tagOpacity(25)).toBe(1);
    expect(tagOpacity(38)).toBeCloseTo(0.63, 2); // the board's 38 m rival
    expect(tagOpacity(60)).toBe(0);
    expect(tagOpacity(64)).toBe(0);
  });

  it('scale is 1.0 to 10 m and 0.8 at 60 m', () => {
    expect(tagScale(5)).toBe(1);
    expect(tagScale(10)).toBe(1);
    expect(tagScale(17)).toBeCloseTo(0.97, 2); // the board's 17 m tag
    expect(tagScale(38)).toBeCloseTo(0.89, 2); // the board's 38 m tag
    expect(tagScale(60)).toBeCloseTo(0.8, 5);
  });

  it('names are uppercase and cut at 12 characters with an ellipsis', () => {
    expect(tagName('minh.k')).toBe('MINH.K');
    expect(tagName('SAIGONRUSH99X')).toBe('SAIGONRUSH9…');
    expect(tagName('exactly12chr')).toBe('EXACTLY12CHR');
  });

  it('shows at most 5 tags on desktop and 3 on a phone, nearest first', () => {
    const many = [10, 20, 30, 40, 50, 55].map((d, i) => tag(`c${i}`, d, 100 + i * 200, 500));
    expect(layoutTags(many, desk).map((t) => t.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(layoutTags(many, { ...desk, phone: true, maxTags: 3 }).map((t) => t.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('drops tags beyond 60 m, off screen or hidden behind a wall', () => {
    const out = layoutTags(
      [tag('far', 64), tag('off', 20, -200), tag('wall', 20, 300, 500, { seen: 0 }), tag('ok', 20, 900, 500)],
      desk,
    );
    expect(out.map((t) => t.id)).toEqual(['ok']);
  });

  it('moves the farther of two overlapping tags up by its height + 4 px', () => {
    const [near, far] = layoutTags([tag('near', 17, 300, 500), tag('far', 38, 310, 500)], desk);
    expect(near.lift).toBe(0);
    const { h } = boxSize(6, false);
    expect(far.lift).toBeCloseTo((h + 7) * far.scale + 4, 5);
    expect(far.y).toBeCloseTo(500 - far.lift, 5);
    expect(near.rank).toBe(0);
  });

  it('leaves tags that do not overlap where they are', () => {
    const out = layoutTags([tag('a', 17, 200, 500), tag('b', 38, 900, 500)], desk);
    expect(out.every((t) => t.lift === 0)).toBe(true);
  });

  it('dims a tag within 60 px of the reticle to 35%', () => {
    const [t] = layoutTags([tag('a', 17, 640, 420)], desk); // box ends at y=420, 60 px under the reticle... just inside
    const [away] = layoutTags([tag('b', 17, 640, 700)], desk);
    expect(t.opacity).toBeCloseTo(0.35, 5);
    expect(away.opacity).toBe(1);
  });

  it('multiplies in the occlusion fade', () => {
    const [t] = layoutTags([tag('a', 17, 200, 500, { seen: 0.5 })], desk);
    expect(t.opacity).toBeCloseTo(0.5, 5);
  });
});
