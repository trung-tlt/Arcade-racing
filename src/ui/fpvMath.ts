import type { CameraView, HudMode } from '../core/ViewState';

/** Radius of the reticle's heat ring (SVG units) and the share of the circle it sweeps (270°). */
export const HEAT_RING_R = 27;
const SWEEP_FRACTION = 0.75;
const RING_LEN = 2 * Math.PI * HEAT_RING_R;

/** Stroke dash for the heat ring: `[filled, rest]` lengths, with 0 heat = nothing and full heat = the whole sweep. */
export function heatDash(heat: number): [number, number] {
  const h = Math.min(1, Math.max(0, heat));
  return [Math.round(RING_LEN * SWEEP_FRACTION * h * 10) / 10, Math.round(RING_LEN * 10) / 10];
}

/** The dim track behind the heat ring (the full 270° sweep). */
export const HEAT_TRACK_DASH: [number, number] = heatDash(1);

/** Which parts of the HUD a camera view and HUD mode show. */
export interface HudParts {
  /** The helmet visor layer (vignette and arcs) exists at all: hood and cockpit views, HUD not off. */
  visor: boolean;
  position: boolean;
  reticle: boolean;
  lock: boolean;
  threat: boolean;
  hull: boolean;
  /** Full mode only. */
  minimap: boolean;
  tags: boolean;
  checkpoint: boolean;
  weapons: boolean;
  nitro: boolean;
  hint: boolean;
}

export function hudParts(view: CameraView, mode: HudMode): HudParts {
  const first = view !== 'chase';
  const full = mode === 'full';
  const on = mode !== 'off';
  return {
    visor: first && on,
    position: on,
    reticle: first && on,
    lock: first && on,
    threat: first && on,
    hull: on,
    minimap: full,
    tags: full,
    checkpoint: first && full,
    weapons: first && full,
    nitro: first && full,
    hint: first && full,
  };
}

/** Body classes the CSS keys off: `view-<camera>` and `hud-<full|min|off>`. */
export function bodyClasses(view: CameraView, mode: HudMode): string[] {
  return [`view-${view}`, `hud-${mode === 'minimal' ? 'min' : mode}`];
}

export interface Rel {
  /** Rocket relative to the player on the ground plane (m). */
  dx: number;
  dz: number;
}

const SIDES = ['front', 'front left', 'left', 'rear left', 'rear', 'rear right', 'right', 'front right'] as const;
export type Side = (typeof SIDES)[number];

/** Bearing of a point as seen from the car: 0 = dead ahead, + = to the left (radians, -π..π). The car faces (fx, fz). */
export function bearing(dx: number, dz: number, fx: number, fz: number): number {
  // Left of a car facing (fx, fz) is (fz, -fx) in this game's +X-is-left world.
  return Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
}

export function sideOf(bearingRad: number): Side {
  const a = (bearingRad * 180) / Math.PI;
  const i = Math.round((((a % 360) + 360) % 360) / 45) % 8;
  return SIDES[i];
}

export interface Threat {
  bearingRad: number;
  side: Side;
  /** Seconds until the rocket reaches the car at the current closing speed. */
  impactSec: number;
  distM: number;
}

export interface ThreatInput {
  /** Player position, ground-plane velocity and facing. */
  px: number;
  pz: number;
  vx: number;
  vz: number;
  fx: number;
  fz: number;
  /** Rocket position, unit direction (3D) and speed. */
  rx: number;
  ry: number;
  rz: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speedMps: number;
  py: number;
  rangeM: number;
  /** A rocket pointing further than this from the car is not coming for it. */
  coneDeg: number;
}

/** Is this rocket coming for the player? Returns bearing, side and time to impact, or null. */
export function incomingThreat(t: ThreatInput): Threat | null {
  const dx = t.px - t.rx;
  const dy = t.py - t.ry;
  const dz = t.pz - t.rz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6 || dist > t.rangeM) return null;
  // Heading toward the car.
  const cosToCar = (t.dirX * dx + t.dirY * dy + t.dirZ * dz) / dist;
  if (cosToCar < Math.cos((t.coneDeg * Math.PI) / 180)) return null;
  // Closing speed along the line between them (rocket velocity minus player velocity).
  const closing =
    (t.dirX * t.speedMps - t.vx) * (dx / dist) +
    t.dirY * t.speedMps * (dy / dist) +
    (t.dirZ * t.speedMps - t.vz) * (dz / dist);
  if (closing <= 0.5) return null;
  const b = bearing(-dx, -dz, t.fx, t.fz);
  return { bearingRad: b, side: sideOf(b), impactSec: dist / closing, distM: dist };
}

/** Threat beep rate: `minHz` while the rocket is `fromSec` out, rising to `maxHz` at `toSec`. */
export function beepHz(impactSec: number, minHz: number, maxHz: number, fromSec: number, toSec: number): number {
  const k = Math.min(1, Math.max(0, (fromSec - impactSec) / Math.max(1e-6, fromSec - toSec)));
  return minHz + (maxHz - minHz) * k;
}

/** CSS rotation (deg) that points a 12-o'clock arc at the threat: left bearings turn it counter-clockwise. */
export function arcRotationDeg(bearingRad: number): number {
  return Math.round((-bearingRad * 180) / Math.PI) || 0;
}

/** Pixel width of the lock brackets for a target `radiusM` across at `distM`, clamped. */
export function lockWidthPx(
  radiusM: number,
  distM: number,
  fovDeg: number,
  viewHeightPx: number,
  minPx: number,
  maxPx: number,
): number {
  const px = ((radiusM * 2) / (2 * Math.tan((fovDeg * Math.PI) / 360) * Math.max(0.5, distM))) * viewHeightPx;
  return Math.min(maxPx, Math.max(minPx, Math.round(px)));
}

/** Where a projected point lands in pixels; points off screen are pinned inside `margin` (px) of the edge. */
export function clampToScreen(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
  margin: number,
): { x: number; y: number; off: boolean } {
  const x = (ndcX * 0.5 + 0.5) * w;
  const y = (-ndcY * 0.5 + 0.5) * h;
  const cx = Math.min(w - margin, Math.max(margin, x));
  const cy = Math.min(h - margin, Math.max(margin, y));
  return { x: cx, y: cy, off: cx !== x || cy !== y };
}

/** Gap to the car ahead in seconds: laps of progress times the lap length, over the player's speed (floored). */
export function gapAheadSec(progressAhead: number, progressYou: number, lapLengthM: number, speedMps: number): number {
  return (Math.max(0, progressAhead - progressYou) * lapLengthM) / Math.max(15, speedMps);
}
