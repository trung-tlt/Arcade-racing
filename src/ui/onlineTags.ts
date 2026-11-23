import * as THREE from 'three';
import { ONLINE, str } from './screens/onlineCommon';
import { layoutTags, tagName, type TagInput } from './onlineTagLayout';
import './onlineTags.css';

export interface OnlineTag {
  id: string;
  name: string;
  /** 1-based race position. */
  place: number;
  hullFraction: number;
  /** The local player's gun is locked on this car. */
  targeted: boolean;
  /** A wall or building is between the camera and the car (sampled by the game every 100 ms). */
  occluded: boolean;
  /** Where the pointer tip goes: collider top + 0.45 m. */
  world: { x: number; y: number; z: number };
}

interface Entry {
  el: HTMLElement;
  box: HTMLElement;
  chip: HTMLElement;
  name: HTMLElement;
  target: HTMLElement;
  fill: HTMLElement;
  leader: HTMLElement;
  seen: number;
  shown: boolean;
  text: string;
  place: number;
  pct: number;
  targeted: boolean;
}

/** The occlusion fade: a tag behind a wall fades out over this long (data: `occlusion`). */
const OCCLUSION_FADE_S = 0.15;
const ndc = new THREE.Vector3();

/**
 * Rival name tags in a race (board 40): DOM over the canvas so the text stays sharp. Rules live in `onlineTagLayout`;
 * this class projects, smooths the occlusion fade and writes the DOM.
 */
export class OnlineNameTags {
  private readonly layer = document.createElement('div');
  private readonly entries = new Map<string, Entry>();
  private width = window.innerWidth;
  private height = window.innerHeight;
  private readonly onResize = (): void => {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  };

  constructor(root: HTMLElement) {
    this.layer.className = 'ot-layer';
    root.appendChild(this.layer);
    window.addEventListener('resize', this.onResize);
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    const el = document.createElement('div');
    el.className = 'ot-tag';
    el.hidden = true;
    el.innerHTML = `<div class="ot-box"><div class="ot-row"><span class="ot-chip"></span><span class="ot-name"></span><span class="ot-target"></span></div><div class="ot-bar"><i></i></div></div><div class="ot-tip"></div><div class="ot-leader"></div>`;
    this.layer.appendChild(el);
    e = {
      el,
      box: el.querySelector('.ot-box') as HTMLElement,
      chip: el.querySelector('.ot-chip') as HTMLElement,
      name: el.querySelector('.ot-name') as HTMLElement,
      target: el.querySelector('.ot-target') as HTMLElement,
      fill: el.querySelector('.ot-bar i') as HTMLElement,
      leader: el.querySelector('.ot-leader') as HTMLElement,
      seen: 1,
      shown: false,
      text: '',
      place: -1,
      pct: -1,
      targeted: false,
    };
    e.target.textContent = str('tag.target');
    this.entries.set(id, e);
    return e;
  }

  update(camera: THREE.PerspectiveCamera, tags: readonly OnlineTag[], dtSec: number): void {
    const phone = document.body.classList.contains('is-touch');
    const cp = camera.position;
    const inputs: TagInput[] = [];
    const byId = new Map<string, OnlineTag>();
    for (const t of tags) {
      const e = this.entry(t.id);
      // Fade toward visible / hidden over 150 ms instead of popping.
      const step = dtSec / OCCLUSION_FADE_S;
      e.seen = t.occluded ? Math.max(0, e.seen - step) : Math.min(1, e.seen + step);
      ndc.set(t.world.x, t.world.y, t.world.z).project(camera);
      if (ndc.z > 1) continue; // behind the camera
      byId.set(t.id, t);
      inputs.push({
        id: t.id,
        dist: Math.hypot(t.world.x - cp.x, t.world.y - cp.y, t.world.z - cp.z),
        x: (ndc.x * 0.5 + 0.5) * this.width,
        y: (-ndc.y * 0.5 + 0.5) * this.height,
        nameLen: tagName(t.name).length,
        seen: e.seen,
      });
    }
    const placed = layoutTags(inputs, {
      maxTags: phone ? ONLINE.nameTags.maxTags.phone : ONLINE.nameTags.maxTags.desktop,
      phone,
      width: this.width,
      height: this.height,
      reticle: { x: this.width / 2, y: this.height / 2 },
    });
    const live = new Set<string>();
    for (const p of placed) {
      const t = byId.get(p.id) as OnlineTag;
      const e = this.entry(p.id);
      live.add(p.id);
      const text = tagName(t.name);
      if (text !== e.text) {
        e.text = text;
        e.name.textContent = text;
      }
      if (t.place !== e.place) {
        e.place = t.place;
        e.chip.textContent = `P${t.place}`;
      }
      const pct = Math.round(Math.min(1, Math.max(0, t.hullFraction)) * 100);
      if (pct !== e.pct) {
        e.pct = pct;
        e.fill.style.width = `${pct}%`;
      }
      if (t.targeted !== e.targeted) {
        e.targeted = t.targeted;
        e.el.classList.toggle('targeted', t.targeted);
      }
      e.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%) scale(${p.scale.toFixed(3)})`;
      e.el.style.opacity = p.opacity.toFixed(2);
      e.el.style.zIndex = String(100 - p.rank);
      // A tag lifted off its car keeps a 1 px leader line back to it.
      e.leader.style.height = p.lift > 0 ? `${Math.round(p.lift / p.scale)}px` : '0';
      if (!e.shown) {
        e.shown = true;
        e.el.hidden = false;
      }
    }
    for (const [id, e] of this.entries) {
      if (!live.has(id) && e.shown) {
        e.shown = false;
        e.el.hidden = true;
      }
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.layer.remove();
    this.entries.clear();
  }
}
