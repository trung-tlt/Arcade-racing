/** Which camera the player is looking through, and how much HUD is drawn. Shared by the camera, the HUD and the menus. */
export type CameraView = 'chase' | 'hood' | 'cockpit';
export type HudMode = 'full' | 'minimal' | 'off';

export const CAMERA_VIEWS: readonly CameraView[] = ['chase', 'hood', 'cockpit'];
export const HUD_MODES: readonly HudMode[] = ['full', 'minimal', 'off'];

const KEY = 'voltline.view';

interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const next = <T>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length];

/** V cycles the camera, H the HUD, M the mirror. Remembered between races. */
export class ViewState {
  camera: CameraView = 'chase';
  hud: HudMode = 'full';
  mirror = true;
  private readonly listeners = new Set<(s: ViewState) => void>();

  constructor(private readonly store: Store | null = null) {
    this.load();
  }

  cycleCamera(): CameraView {
    return this.set({ camera: next(CAMERA_VIEWS, this.camera) }).camera;
  }

  cycleHud(): HudMode {
    return this.set({ hud: next(HUD_MODES, this.hud) }).hud;
  }

  toggleMirror(): boolean {
    return this.set({ mirror: !this.mirror }).mirror;
  }

  /** Back to the chase camera (a view the current vehicle can't show, e.g. a missing rig). */
  setCamera(camera: CameraView): void {
    this.set({ camera });
  }

  /** Called after every change; returns an unsubscribe function. */
  onChange(fn: (s: ViewState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<Pick<ViewState, 'camera' | 'hud' | 'mirror'>>): ViewState {
    Object.assign(this, p);
    this.save();
    for (const l of this.listeners) l(this);
    return this;
  }

  private load(): void {
    try {
      const o = JSON.parse(this.store?.getItem(KEY) ?? 'null') as Partial<ViewState> | null;
      if (o && CAMERA_VIEWS.includes(o.camera as CameraView)) this.camera = o.camera as CameraView;
      if (o && HUD_MODES.includes(o.hud as HudMode)) this.hud = o.hud as HudMode;
      if (o && typeof o.mirror === 'boolean') this.mirror = o.mirror;
    } catch {
      /* corrupt or blocked storage: defaults */
    }
  }

  private save(): void {
    try {
      this.store?.setItem(KEY, JSON.stringify({ camera: this.camera, hud: this.hud, mirror: this.mirror }));
    } catch {
      /* storage blocked */
    }
  }
}
