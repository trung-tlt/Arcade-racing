import * as THREE from 'three';
import { pickAimTarget } from '../combat/AutoAim';
import type { EventBus } from '../core/Events';
import type { ViewState } from '../core/ViewState';
import { AUDIO, COMBAT, WEAPONS } from '../core/Data';
import {
  HEAT_RING_R,
  HEAT_TRACK_DASH,
  arcRotationDeg,
  beepHz,
  bodyClasses,
  clampToScreen,
  heatDash,
  hudParts,
  incomingThreat,
  lockWidthPx,
  type Threat,
} from './fpvMath';
import { formatTime } from './format';
import './fpv.css';

const CFG = COMBAT.fpvHud;
const HAS_TICKS = '-22 -22 L-15 -15 M22 -22 L15 -15 M-22 22 L-15 15 M22 22 L15 15';

export interface FpvTarget {
  id: string;
  name: string;
  car: string;
  x: number;
  y: number;
  z: number;
  hullFraction: number;
}

/** A rocket in flight that someone else fired (world position, unit heading, speed). */
export interface FpvRocket {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speedMps: number;
  owner: string;
}

export interface FpvState {
  camera: THREE.PerspectiveCamera;
  position: number;
  totalCars: number;
  lap: number;
  totalLaps: number;
  timeSec: number;
  bestLapSec: number | null;
  /** Seconds behind the car ahead (null = leading). */
  gapAheadSec: number | null;
  hullFraction: number;
  hp: number;
  maxHp: number;
  heat: number;
  overheated: boolean;
  rockets: number;
  nitroBars: number;
  nitroActive: boolean;
  /** Player pose: position, facing (horizontal unit) and ground velocity. */
  player: { x: number; y: number; z: number; fx: number; fz: number; vx: number; vz: number };
  /** The gun sweeps all round (APC): the soft aim cone is replaced by the full circle. */
  fullTurret: boolean;
  targets: readonly FpvTarget[];
  /** Rockets in flight that other cars fired. */
  incoming: readonly FpvRocket[];
  checkpoint: { x: number; y: number; z: number; index: number; distM: number } | null;
  /** Wrecked or finished: the visor goes quiet. */
  hidden: boolean;
}

export interface FpvHudOptions {
  view: ViewState;
  events: EventBus;
  /** Called with true while a rocket is incoming (the mirror's red border), false when it clears. */
  onThreat?: (on: boolean) => void;
  /** Called at the threat beep cadence. */
  beep?: () => void;
}

const ndc = new THREE.Vector3();
const setText = (el: HTMLElement, last: Map<HTMLElement, string>, v: string): void => {
  if (last.get(el) === v) return;
  last.set(el, v);
  el.textContent = v;
};

/**
 * First-person helmet HUD (hood and cockpit views): position and lap, reticle with heat ring and hit marks, target
 * lock, checkpoint pin, incoming-rocket warning, weapon / hull / nitro panels and a hint strip. Which parts show comes
 * from the camera view and HUD mode (`fpvMath.hudParts`); the CSS keys off the `view-*` / `hud-*` body classes this
 * class keeps in step. In the chase view the existing HUD is used and only the body classes matter.
 */
export class FpvHud {
  private readonly root = document.createElement('div');
  private readonly last = new Map<HTMLElement, string>();
  private readonly q: Record<string, HTMLElement>;
  private readonly offs: (() => void)[] = [];
  private hits = 0;
  private hitAge = 99;
  private hitMark = 99;
  private beepT = 0;
  private threatOn = false;
  private hintLeft = CFG.hintSec;
  private width = window.innerWidth;
  private height = window.innerHeight;
  private cur: Threat | null = null;
  private bodyApplied: string[] = [];
  private readonly onResize = (): void => {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  };

  constructor(
    hudRoot: HTMLElement,
    private readonly o: FpvHudOptions,
  ) {
    const track = HEAT_TRACK_DASH.join(' ');
    this.root.className = 'fpv';
    this.root.innerHTML = `
      <div class="fpv-vignette"></div>
      <svg class="fpv-arcs" viewBox="0 0 1280 720" preserveAspectRatio="none" aria-hidden="true">
        <path d="M40 150 Q60 70 160 46"/><path d="M1240 150 Q1220 70 1120 46"/><path d="M300 702 Q640 668 980 702"/>
      </svg>
      <svg class="fpv-cracks" viewBox="0 0 1280 720" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 40 L120 90 L150 150 L230 170 M120 90 L90 20 M150 150 L110 230 M1280 640 L1160 600 L1120 520 L1040 500 M1160 600 L1200 690 M1120 520 L1160 450"/>
      </svg>
      <div class="fpv-pos">
        <div class="p"></div>
        <div class="meta"><span class="lap"></span><span class="dim best"></span></div>
      </div>
      <svg class="fpv-reticle" viewBox="-80 -80 160 160" aria-hidden="true">
        <defs><linearGradient id="fpvHeat" x1="0" x2="1"><stop offset="0" stop-color="#2EC5FF"/><stop offset="1" stop-color="#FF6A1A"/></linearGradient></defs>
        <circle r="15" class="ring"/><circle r="2.5" class="dot"/>
        <circle r="${HEAT_RING_R}" class="heat-track" stroke-dasharray="${track}" transform="rotate(135)"/>
        <circle r="${HEAT_RING_R}" class="heat" stroke="url(#fpvHeat)" stroke-dasharray="0 170" transform="rotate(135)"/>
        <path class="ticks" d="M${HAS_TICKS}"/>
        <g class="threat-arc"><path d="M-26 -52 A58 58 0 0 1 26 -52"/></g>
      </svg>
      <div class="fpv-lock" hidden>
        <svg viewBox="0 0 150 90" preserveAspectRatio="none" aria-hidden="true"><path class="br" d="M2 18 V2 H18 M132 2 H148 V18 M148 72 V88 H132 M18 88 H2 V72"/><path class="lead" d="M75 40 l6 6 -6 6 -6 -6 z"/></svg>
        <div class="tag"><div class="txt"></div><div class="hp"><i></i></div></div>
      </div>
      <div class="fpv-hit" hidden></div>
      <div class="fpv-cp fpv-full" hidden><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1 L15 8 L8 15 L1 8 Z"/></svg><div class="txt"></div></div>
      <div class="fpv-threat" hidden>
        <svg viewBox="0 0 34 60" width="34" height="60" aria-hidden="true"><path d="M30 4 L6 30 L30 56"/></svg>
        <div><div class="t1">ROCKET INCOMING</div><div class="t2"></div></div>
      </div>
      <div class="fpv-panel fpv-weapons fpv-full">
        <div class="row"><b>PULSE MG</b><span><kbd>J</kbd> <small>/ LMB</small></span></div>
        <div class="bar"><i class="heatbar"></i></div>
        <div class="row"><b>ROCKETS <em class="rk"></em></b><span><kbd>K</kbd> <small>/ RMB</small></span></div>
      </div>
      <div class="fpv-panel fpv-hull">
        <div class="row mono"><span>HULL</span><span class="hulltxt"></span></div>
        <div class="bar"><i class="hullbar"></i></div>
        <div class="row nitro fpv-full"><div class="bars"><i></i><i></i><i></i></div><span><kbd>Shift</kbd> <small>nitro</small></span></div>
      </div>
      <div class="fpv-hint fpv-full"><span><kbd>V</kbd> view</span><span><kbd>H</kbd> HUD</span><span><kbd>M</kbd> mirror</span><span><kbd>C</kbd> look back</span></div>`;
    hudRoot.append(this.root);
    const g = (s: string): HTMLElement => this.root.querySelector(s) as HTMLElement;
    this.q = {
      pos: g('.p'),
      lap: g('.lap'),
      best: g('.best'),
      heat: g('.heat'),
      ticks: g('.ticks'),
      arc: g('.threat-arc'),
      lock: g('.fpv-lock'),
      lockTxt: g('.fpv-lock .txt'),
      lockHp: g('.fpv-lock .hp i'),
      hit: g('.fpv-hit'),
      cp: g('.fpv-cp'),
      cpTxt: g('.fpv-cp .txt'),
      threat: g('.fpv-threat'),
      t2: g('.fpv-threat .t2'),
      heatbar: g('.heatbar'),
      rk: g('.rk'),
      hulltxt: g('.hulltxt'),
      hullbar: g('.hullbar'),
      nitro: g('.nitro .bars'),
      hint: g('.fpv-hint'),
    };
    window.addEventListener('resize', this.onResize);
    this.offs.push(
      o.events.on('carHit', (e) => {
        if (e.attackerId !== 'player' || e.carId === 'player') return;
        this.hits = this.hitAge > CFG.hitWindowSec ? 1 : this.hits + 1;
        this.hitAge = 0;
        this.hitMark = 0;
      }),
      o.view.onChange(() => this.onViewChange()),
    );
    this.onViewChange();
  }

  /** Is the visor layer live (hood / cockpit view and the HUD not off)? Games skip building a frame otherwise. */
  get active(): boolean {
    return hudParts(this.o.view.camera, this.o.view.hud).visor;
  }

  /** Rocket threat shown right now. */
  get threatened(): boolean {
    return this.threatOn;
  }

  private onViewChange(): void {
    const b = document.body.classList;
    for (const c of this.bodyApplied) b.remove(c);
    this.bodyApplied = bodyClasses(this.o.view.camera, this.o.view.hud);
    for (const c of this.bodyApplied) b.add(c);
    this.hintLeft = CFG.hintSec;
  }

  /** `build` runs only while the visor is live, so the per-frame state costs nothing in the chase view. */
  update(dt: number, build: () => FpvState): void {
    if (!this.active) {
      this.setThreat(null, dt, false);
      return;
    }
    const s = build();
    const parts = hudParts(this.o.view.camera, this.o.view.hud);
    const q = this.q;
    const L = this.last;
    const quiet = s.hidden;
    this.hitAge += dt;
    this.hitMark += dt;

    // position + lap
    q.pos.innerHTML = `P${s.position}<small>/${s.totalCars}</small>`;
    setText(q.lap, L, `LAP ${Math.min(s.lap, s.totalLaps)}/${s.totalLaps} · ${formatTime(s.timeSec)}`);
    setText(
      q.best,
      L,
      `best ${formatTime(s.bestLapSec)}${s.gapAheadSec !== null ? ` · gap −${s.gapAheadSec.toFixed(2)} s` : ''}`,
    );

    // reticle: heat ring, hit marks
    const [fill] = heatDash(s.heat);
    const dash = `${fill} 170`;
    if (L.get(q.heat) !== dash) {
      L.set(q.heat, dash);
      q.heat.setAttribute('stroke-dasharray', dash);
    }
    q.heat.classList.toggle('over', s.overheated);
    q.ticks.classList.toggle('on', this.hitMark < CFG.hitMarkSec);

    // target lock
    const pl = s.player;
    const cone = s.fullTurret ? 180 : WEAPONS.pulse_mg.autoAimConeDeg;
    let locked: FpvTarget | null = null;
    let lockDist = 0;
    if (parts.lock && !quiet && s.targets.length > 0) {
      const aim = pickAimTarget(
        { x: pl.x, y: pl.y + 0.8, z: pl.z },
        { x: pl.fx, y: 0, z: pl.fz },
        s.targets.map((t) => ({ id: t.id, pos: { x: t.x, y: t.y, z: t.z } })),
        cone,
        WEAPONS.pulse_mg.rangeM,
      );
      if (aim) {
        locked = s.targets.find((t) => t.id === aim.id) ?? null;
        lockDist = aim.dist;
      }
    }
    if (locked) {
      ndc.set(locked.x, locked.y, locked.z).project(s.camera);
      if (ndc.z > 1) locked = null;
    }
    if (locked) {
      const p = clampToScreen(ndc.x, ndc.y, this.width, this.height, 40);
      const w = lockWidthPx(CFG.lockRadiusM, lockDist, s.camera.fov, this.height, CFG.lockMinPx, CFG.lockMaxPx);
      q.lock.hidden = false;
      q.lock.style.width = `${w}px`;
      q.lock.style.height = `${Math.round(w * 0.6)}px`;
      q.lock.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
      setText(q.lockTxt, L, `LOCK · ${locked.name} · ${locked.car} · ${Math.round(lockDist)} m`);
      const hp = `${Math.round(locked.hullFraction * 100)}%`;
      if (L.get(q.lockHp) !== hp) {
        L.set(q.lockHp, hp);
        q.lockHp.style.width = hp;
      }
    } else if (!q.lock.hidden) q.lock.hidden = true;

    // hit read-out
    const showHit = this.hitAge < CFG.hitWindowSec && !quiet;
    if (showHit) {
      const pct = Math.round(this.hits * WEAPONS.pulse_mg.nitroGainOnHit * 100);
      q.hit.innerHTML = `HIT ×${this.hits} <small>+${pct}% nitro</small>`;
      q.hit.hidden = false;
    } else if (!q.hit.hidden) q.hit.hidden = true;

    // next checkpoint pinned in the world
    if (parts.checkpoint && s.checkpoint && !quiet) {
      const c = s.checkpoint;
      ndc.set(c.x, c.y + 4, c.z).project(s.camera);
      if (ndc.z < 1) {
        const p = clampToScreen(ndc.x, ndc.y, this.width, this.height, 70);
        q.cp.hidden = false;
        q.cp.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
        setText(q.cpTxt, L, `CP ${c.index} · ${Math.round(c.distM)} m`);
      } else q.cp.hidden = true;
    } else if (!q.cp.hidden) q.cp.hidden = true;

    // incoming rockets: the nearest impact wins
    let threat: Threat | null = null;
    let by = '';
    if (parts.threat && !quiet) {
      for (const r of s.incoming) {
        const t = incomingThreat({
          px: pl.x,
          py: pl.y,
          pz: pl.z,
          vx: pl.vx,
          vz: pl.vz,
          fx: pl.fx,
          fz: pl.fz,
          rx: r.x,
          ry: r.y,
          rz: r.z,
          dirX: r.dirX,
          dirY: r.dirY,
          dirZ: r.dirZ,
          speedMps: r.speedMps,
          rangeM: CFG.threatRangeM,
          coneDeg: CFG.threatConeDeg,
        });
        if (t && (!threat || t.impactSec < threat.impactSec)) {
          threat = t;
          by = r.owner;
        }
      }
    }
    this.setThreat(threat, dt, true, by);

    // weapons, hull, nitro
    const heatPct = `${Math.round(s.heat * 100)}%`;
    if (L.get(q.heatbar) !== heatPct) {
      L.set(q.heatbar, heatPct);
      q.heatbar.style.width = heatPct;
    }
    q.heatbar.classList.toggle('over', s.overheated);
    setText(q.rk, L, `×${s.rockets}`);
    setText(q.hulltxt, L, `${Math.ceil(s.hp)} / ${s.maxHp}`);
    const hullPct = `${Math.round(s.hullFraction * 100)}%`;
    if (L.get(q.hullbar) !== hullPct) {
      L.set(q.hullbar, hullPct);
      q.hullbar.style.width = hullPct;
      q.hullbar.style.background = s.hullFraction > 0.6 ? '#5FE0C2' : s.hullFraction > 0.3 ? '#FFB37A' : '#FF3D6E';
    }
    const bars = q.nitro.children;
    for (let i = 0; i < 3; i++) {
      const f = Math.round(Math.min(1, Math.max(0, s.nitroBars - i)) * 4) / 4;
      const bar = bars[i] as HTMLElement;
      const key = `${f}${s.nitroActive}`;
      if (L.get(bar) !== key) {
        L.set(bar, key);
        bar.style.opacity = String(0.25 + 0.75 * f);
        bar.classList.toggle('active', s.nitroActive);
      }
    }
    // cracks under a quarter hull
    const crack = Math.max(0, Math.min(1, (CFG.crackBelowHull - s.hullFraction) / CFG.crackBelowHull));
    const crackStr = crack.toFixed(2);
    if (L.get(this.root) !== crackStr) {
      L.set(this.root, crackStr);
      this.root.style.setProperty('--crack', crackStr);
    }
    // hint strip fades after a few seconds
    this.hintLeft = Math.max(0, this.hintLeft - dt);
    const hint = this.hintLeft > 0 ? '1' : '0';
    if (L.get(q.hint) !== hint) {
      L.set(q.hint, hint);
      q.hint.style.opacity = hint;
    }
  }

  private setThreat(t: Threat | null, dt: number, visorLive: boolean, owner = ''): void {
    this.cur = t;
    const q = this.q;
    const on = t !== null && visorLive;
    if (on && t) {
      q.threat.hidden = false;
      q.arc.style.transform = `rotate(${arcRotationDeg(t.bearingRad)}deg)`;
      q.arc.classList.add('on');
      setText(q.t2, this.last, `${owner.toUpperCase()} · ${t.side} · impact ${t.impactSec.toFixed(1)} s`);
      this.beepT -= dt;
      if (this.beepT <= 0) {
        this.o.beep?.();
        const th = AUDIO.threat;
        this.beepT = 1 / beepHz(t.impactSec, th.minHz, th.maxHz, th.fromSec, th.toSec);
      }
    } else {
      if (!q.threat.hidden) q.threat.hidden = true;
      q.arc.classList.remove('on');
      this.beepT = 0;
    }
    if (on !== this.threatOn) {
      this.threatOn = on;
      this.o.onThreat?.(on);
    }
  }

  /** The most urgent threat last frame (for tests and the mirror). */
  get currentThreat(): Threat | null {
    return this.cur;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const off of this.offs) off();
    const b = document.body.classList;
    for (const c of this.bodyApplied) b.remove(c);
    this.root.remove();
  }
}
