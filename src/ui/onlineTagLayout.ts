import { ONLINE } from './screens/onlineCommon';

/** Name-tag rules from data/online_ui.json `nameTags`: pure maths, no DOM. */
const NT = ONLINE.nameTags;

export interface TagInput {
  id: string;
  /** Distance from the camera to the car (m). */
  dist: number;
  /** Where the tag's pointer tip goes on screen (px). */
  x: number;
  y: number;
  /** Characters in the displayed name (sizes the box). */
  nameLen: number;
  /** Faded out by the occlusion test (0 = hidden by a wall, 1 = in the clear). */
  seen: number;
}

export interface TagLayout {
  id: string;
  x: number;
  /** The tip's y after stacking (the box sits above it). */
  y: number;
  /** How far the tag was lifted off its car to avoid another tag (px); a leader line is drawn when > 0. */
  lift: number;
  opacity: number;
  scale: number;
  /** Nearest first = 0; the nearest is drawn on top. */
  rank: number;
}

export interface LayoutOpts {
  maxTags: number;
  phone: boolean;
  width: number;
  height: number;
  /** Reticle centre (px). */
  reticle: { x: number; y: number };
}

/** 1 within `fullOpacityWithinM`, fading linearly to 0 at `showWithinM`. */
export function tagOpacity(distM: number): number {
  if (distM > NT.showWithinM) return 0;
  if (distM <= NT.fullOpacityWithinM) return 1;
  return 1 - (distM - NT.fullOpacityWithinM) / (NT.showWithinM - NT.fullOpacityWithinM);
}

/** 1.0 at or below `scale.atOrBelowM`, shrinking linearly to `scale.min` at `scale.atM`. */
export function tagScale(distM: number): number {
  const s = NT.scale;
  if (distM <= s.atOrBelowM) return s.max;
  if (distM >= s.atM) return s.min;
  return s.max - ((distM - s.atOrBelowM) / (s.atM - s.atOrBelowM)) * (s.max - s.min);
}

/** UPPERCASE, at most 12 characters, with an ellipsis when cut. */
export function tagName(name: string): string {
  const up = name.toUpperCase();
  return up.length > 12 ? `${up.slice(0, 11)}…` : up;
}

/** Box size in px at scale 1 (name text plus the position chip, the hull bar and padding). */
export function boxSize(nameLen: number, phone: boolean): { w: number; h: number } {
  return phone ? { w: 46 + nameLen * 7.5, h: 32 } : { w: 56 + nameLen * 9, h: 40 };
}

/**
 * Which tags to draw and where: those inside 60 m and on screen, the nearest `maxTags`; each fades and shrinks with
 * distance; when two boxes overlap the farther one moves up by its height + 4 px; a box within 60 px of the reticle
 * is dimmed to 35% so it never hides the target.
 */
export function layoutTags(inputs: readonly TagInput[], o: LayoutOpts): TagLayout[] {
  const margin = 20;
  const near = inputs
    .filter(
      (t) =>
        t.dist <= NT.showWithinM &&
        t.seen > 0 &&
        t.x > -margin &&
        t.x < o.width + margin &&
        t.y > -margin &&
        t.y < o.height + margin,
    )
    .sort((a, b) => a.dist - b.dist)
    .slice(0, o.maxTags);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  return near.map((t, rank) => {
    const scale = tagScale(t.dist);
    const { w, h } = boxSize(t.nameLen, o.phone);
    const bw = w * scale;
    const bh = (h + 7) * scale; // the pointer triangle is 7 px
    let y = t.y;
    let lift = 0;
    const box = (): { l: number; r: number; t: number; b: number } => ({
      l: t.x - bw / 2,
      r: t.x + bw / 2,
      t: y - bh,
      b: y,
    });
    for (let guard = 0; guard < o.maxTags; guard++) {
      const b = box();
      if (!placed.some((p) => b.l < p.r && b.r > p.l && b.t < p.b && b.b > p.t)) break;
      y -= bh + 4;
      lift += bh + 4;
    }
    const b = box();
    placed.push(b);
    // Distance from the reticle to the nearest point of the box.
    const dx = Math.max(b.l - o.reticle.x, 0, o.reticle.x - b.r);
    const dy = Math.max(b.t - o.reticle.y, 0, o.reticle.y - b.b);
    const nearReticle = Math.hypot(dx, dy) < 60;
    return {
      id: t.id,
      x: t.x,
      y,
      lift,
      scale,
      rank,
      opacity: tagOpacity(t.dist) * t.seen * (nearReticle ? 0.35 : 1),
    };
  });
}
