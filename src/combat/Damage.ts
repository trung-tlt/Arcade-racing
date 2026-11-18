export type DamageState = 'ok' | 'smoke' | 'fire' | 'wrecked';

export interface HullConfig {
  maxHp: number;
  respawnDelaySec: number;
  invulnerableSec: number;
  /** Fraction of max HP below which the hull smokes. */
  smokeBelow: number;
  /** Fraction of max HP below which the hull sparks and burns. */
  fireBelow: number;
}

/** Pure hull HP, damage states, wreck / respawn and spawn-shield bookkeeping for one car. */
export class Hull {
  hp: number;
  readonly maxHp: number;
  lastAttacker: string | null = null;
  private isWrecked = false;
  private respawnTimer = 0;
  private shieldTimer = 0;

  constructor(private readonly cfg: HullConfig) {
    this.maxHp = cfg.maxHp;
    this.hp = cfg.maxHp;
  }

  get fraction(): number {
    return this.hp / this.maxHp;
  }

  get state(): DamageState {
    if (this.isWrecked || this.hp <= 0) return 'wrecked';
    const f = this.fraction;
    if (f > this.cfg.smokeBelow) return 'ok';
    if (f > this.cfg.fireBelow) return 'smoke';
    return 'fire';
  }

  get wrecked(): boolean {
    return this.isWrecked;
  }

  get invulnerable(): boolean {
    return this.shieldTimer > 0;
  }

  get respawnIn(): number {
    return this.isWrecked ? Math.max(0, this.respawnTimer) : 0;
  }

  damage(amount: number, attackerId: string | null): { applied: number; wrecked: boolean } {
    if (this.isWrecked || this.invulnerable || amount <= 0) return { applied: 0, wrecked: false };
    const applied = Math.min(this.hp, amount);
    this.hp -= applied;
    this.lastAttacker = attackerId;
    if (this.hp <= 0) {
      this.hp = 0;
      this.isWrecked = true;
      this.respawnTimer = this.cfg.respawnDelaySec;
      return { applied, wrecked: true };
    }
    return { applied, wrecked: false };
  }

  heal(hp: number): void {
    if (this.isWrecked || hp <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + hp);
  }

  update(dt: number): 'respawn' | null {
    if (this.shieldTimer > 0) this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    if (!this.isWrecked) return null;
    this.respawnTimer -= dt;
    if (this.respawnTimer > 1e-9) return null;
    this.isWrecked = false;
    this.respawnTimer = 0;
    this.hp = this.maxHp;
    this.shieldTimer = this.cfg.invulnerableSec;
    return 'respawn';
  }
}
