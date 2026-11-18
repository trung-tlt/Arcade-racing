export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GameEvents {
  gunFired: { carId: string; pos: Vec3 };
  gunOverheated: { carId: string; pos: Vec3 };
  rocketLaunched: { carId: string; pos: Vec3 };
  explosion: { pos: Vec3; radius: number };
  carHit: { carId: string; attackerId: string | null; damage: number };
  carWrecked: { carId: string; attackerId: string | null };
  checkpoint: { carId: string; index: number };
  lapComplete: { carId: string; lap: number; timeSec: number };
  pickupTaken: { carId: string; kind: 'rocket' | 'repair' | 'nitro'; pos: Vec3 };
  nitroBarEarned: { carId: string; source: 'drift' | 'pickup' | 'takedown' | 'hit' };
  raceFinished: { carId: string; totalTimeSec: number; bestLapSec: number | null };
  carImpact: { carId: string; strength: number };
  carReset: { carId: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object = GameEvents> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    this.handlers.get(type)?.forEach((h) => (h as Handler<E[K]>)(payload));
  }

  clear(): void {
    this.handlers.clear();
  }
}
