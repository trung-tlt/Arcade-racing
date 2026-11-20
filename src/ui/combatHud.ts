export interface CombatHudState {
  hullFraction: number;
  hp: number;
  maxHp: number;
  heat: number;
  overheated: boolean;
  rockets: number;
  wrecked: boolean;
  respawnIn: number;
  wreckedBy: string;
  banner: string;
  /** Name of the no-fire zone the player is in ('' = weapons free). */
  noFire: string;
  feed: readonly string[];
}

/** Bottom-left hull / MG heat / rockets panel, top-centre takedown banner + feed, and the wrecked overlay. */
export class CombatHud {
  private readonly el = document.createElement('div');
  private readonly q: Record<
    'hull' | 'hullTxt' | 'heat' | 'heatLbl' | 'rockets' | 'banner' | 'feed' | 'wreck' | 'lock',
    HTMLElement
  >;
  private last: Record<string, string> = {};

  constructor(root: HTMLElement) {
    this.el.innerHTML = `
      <div class="cb-panel">
        <div class="cb-row"><span class="race-label">HULL</span><span class="cb-hull-txt"></span></div>
        <div class="cb-bar"><i class="cb-hull"></i></div>
        <div class="cb-row"><span class="race-label cb-heat-lbl">PULSE MG · HEAT</span></div>
        <div class="cb-bar thin"><i class="cb-heat"></i></div>
        <div class="cb-row"><span class="race-label">ROCKETS</span><span class="cb-rockets"></span><span class="cb-key">K / LB</span></div>
      </div>
      <div class="cb-top"><div class="cb-banner" hidden></div><div class="cb-feed"></div></div>
      <div class="cb-lock" hidden></div>
      <div class="cb-wreck" hidden></div>`;
    root.appendChild(this.el);
    const g = (s: string): HTMLElement => this.el.querySelector(s) as HTMLElement;
    this.q = {
      hull: g('.cb-hull'),
      hullTxt: g('.cb-hull-txt'),
      heat: g('.cb-heat'),
      heatLbl: g('.cb-heat-lbl'),
      rockets: g('.cb-rockets'),
      banner: g('.cb-banner'),
      feed: g('.cb-feed'),
      wreck: g('.cb-wreck'),
      lock: g('.cb-lock'),
    };
  }

  private set(key: string, value: string, apply: () => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply();
  }

  update(s: CombatHudState): void {
    const hullPct = Math.round(s.hullFraction * 100);
    this.set('hull', String(hullPct), () => {
      this.q.hull.style.width = `${hullPct}%`;
      this.q.hull.style.background = s.hullFraction > 0.6 ? '#7EE29A' : s.hullFraction > 0.3 ? '#FFB37A' : '#FF3D6E';
      this.q.hullTxt.textContent = `${Math.ceil(s.hp)} / ${s.maxHp}`;
    });
    const heatPct = Math.round(s.heat * 100);
    this.set('heat', `${heatPct}${s.overheated}`, () => {
      this.q.heat.style.width = `${heatPct}%`;
      this.q.heat.style.background = s.overheated ? '#FF3D6E' : '#FFB37A';
      this.q.heatLbl.textContent = s.overheated ? 'OVERHEATED' : 'PULSE MG · HEAT';
    });
    this.set('rockets', String(s.rockets), () => {
      const slots = Math.max(2, s.rockets);
      this.q.rockets.innerHTML = Array.from(
        { length: slots },
        (_, i) => `<b class="cb-rk${i < s.rockets ? ' on' : ''}"></b>`,
      ).join('');
    });
    this.set('banner', s.banner, () => {
      this.q.banner.hidden = s.banner === '';
      this.q.banner.textContent = s.banner;
    });
    this.set('lock', s.noFire, () => {
      this.q.lock.hidden = s.noFire === '';
      this.q.lock.innerHTML =
        s.noFire === ''
          ? ''
          : `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3h1.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7zm2 0h6V8a3 3 0 0 0-6 0v3z" fill="currentColor"/></svg><span>NO-FIRE ZONE<small>${s.noFire}</small></span>`;
    });
    this.set('feed', s.feed.join('|'), () => {
      this.q.feed.innerHTML = s.feed.map((f) => `<div>${f}</div>`).join('');
    });
    this.set('wreck', s.wrecked ? `${s.respawnIn.toFixed(1)}${s.wreckedBy}` : '', () => {
      this.q.wreck.hidden = !s.wrecked;
      this.q.wreck.innerHTML = s.wrecked
        ? `<div class="cb-wreck-title">WRECKED</div>${s.wreckedBy ? `<div class="cb-wreck-by">by <b>${s.wreckedBy}</b></div>` : ''}<div>Respawning in ${s.respawnIn.toFixed(1)}s · 2 s shield</div>`
        : '';
    });
  }

  dispose(): void {
    this.el.remove();
  }
}
