import * as THREE from 'three';

export interface TagInfo {
  id: string;
  name: string;
  /** 1-based race position. */
  place: number;
  hullFraction: number;
  world: { x: number; y: number; z: number };
  visible: boolean;
}

interface Entry {
  el: HTMLElement;
  label: HTMLElement;
  fill: HTMLElement;
  text: string;
  pct: number;
  x: number;
  y: number;
  opacity: number;
  shown: boolean;
  stamp: number;
}

const ndc = new THREE.Vector3();
const FADE_START = 0.55; // fraction of maxDist where tags start fading
const OFFSCREEN = 1.05;

export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Floating "NAME · 3rd" pills with a hull bar, projected from world space. DOM nodes are pooled by id. */
export class NameTags {
  private readonly layer = document.createElement('div');
  private readonly entries = new Map<string, Entry>();
  private width = window.innerWidth;
  private height = window.innerHeight;
  private frame = 0;
  private readonly onResize = (): void => {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  };

  constructor(private readonly root: HTMLElement) {
    this.layer.className = 'nt-layer';
    root.appendChild(this.layer);
    window.addEventListener('resize', this.onResize);
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    const el = document.createElement('div');
    el.className = 'nt-tag';
    el.style.display = 'none';
    const label = document.createElement('span');
    label.className = 'nt-name';
    const bar = document.createElement('div');
    bar.className = 'nt-bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    el.append(label, bar);
    this.layer.appendChild(el);
    e = { el, label, fill, text: '', pct: -1, x: NaN, y: NaN, opacity: -1, shown: false, stamp: 0 };
    this.entries.set(id, e);
    return e;
  }

  private show(e: Entry, on: boolean): void {
    if (e.shown === on) return;
    e.shown = on;
    e.el.style.display = on ? '' : 'none';
  }

  update(camera: THREE.PerspectiveCamera, tags: readonly TagInfo[], maxDistM: number): void {
    this.frame++;
    const cp = camera.position;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const e = this.entry(t.id);
      e.stamp = this.frame;
      if (!t.visible) {
        this.show(e, false);
        continue;
      }
      const dist = Math.hypot(t.world.x - cp.x, t.world.y - cp.y, t.world.z - cp.z);
      ndc.set(t.world.x, t.world.y, t.world.z).project(camera);
      if (dist > maxDistM || ndc.z > 1 || Math.abs(ndc.x) > OFFSCREEN || Math.abs(ndc.y) > OFFSCREEN) {
        this.show(e, false);
        continue;
      }
      const text = `${t.name} · ${ordinal(t.place)}`;
      if (text !== e.text) {
        e.text = text;
        e.label.textContent = text;
      }
      const pct = Math.round(Math.min(1, Math.max(0, t.hullFraction)) * 100);
      if (pct !== e.pct) {
        e.pct = pct;
        e.fill.style.width = `${pct}%`;
      }
      const f = dist / maxDistM;
      const fade = f <= FADE_START ? 1 : 1 - (f - FADE_START) / (1 - FADE_START);
      const opacity = Math.round(fade * 20) / 20;
      if (opacity !== e.opacity) {
        e.opacity = opacity;
        e.el.style.opacity = String(opacity);
      }
      const x = Math.round((ndc.x * 0.5 + 0.5) * this.width);
      const y = Math.round((-ndc.y * 0.5 + 0.5) * this.height);
      if (x !== e.x || y !== e.y) {
        e.x = x;
        e.y = y;
        e.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
      this.show(e, true);
    }
    // Tags whose car is no longer in the list.
    for (const e of this.entries.values()) {
      if (e.stamp !== this.frame) this.show(e, false);
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.layer.remove();
    this.entries.clear();
    void this.root;
  }
}
