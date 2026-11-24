import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { AudioBus } from '../audio/AudioBus';
import { EngineSound } from '../audio/EngineSound';
import { ArdennesAudio, trackAudioFiles as ardennesAudioFiles } from '../audio/ArdennesAudio';
import { CatLaiAudio, trackAudioFiles as catLaiAudioFiles } from '../audio/CatLaiAudio';
import { MonteCarloAudio, trackAudioFiles } from '../audio/MonteCarloAudio';
import { bindSfx, playCountdown, playStartGo, playStartLamp, sfxFiles } from '../audio/Sfx';
import { AIDriver, type OtherCar } from '../ai/AIDriver';
import { RacingLine } from '../ai/RacingLine';
import { type Rival, applyTrackRoster, rollRoster } from '../ai/Roster';
import { noFireZoneAt } from '../race/NoFire';
import { StartLights } from '../race/StartLights';
import { CombatSystem } from '../combat/CombatSystem';
import { expandPickups } from '../combat/Pickups';
import { PickupVisuals } from '../combat/PickupVisuals';
import { Particles } from '../fx/Particles';
import { PostFX } from '../fx/PostFX';
import { type SkidEmitter, Skidmarks } from '../fx/Skidmarks';
import { SpeedLines } from '../fx/SpeedLines';
import { Tracers } from '../fx/Tracers';
import { CombatHud } from '../ui/combatHud';
import { Minimap } from '../ui/minimap';
import { NameTags } from '../ui/nameTags';
import { OnlineNameTags, type OnlineTag } from '../ui/onlineTags';
import { NetDebugPanel } from '../ui/netDebug';
import { pickAimTarget } from '../combat/AutoAim';
import { type CarRaceView, effectiveT, rankCars, rubberBandSignal } from '../race/Standings';
import { RaceManager } from '../race/RaceManager';
import { HitRules } from '../sim/HitRules';
import type { OnlineRace } from '../net/OnlineRace';
import { rapierBody } from '../net/RapierBody';
import {
  FLAG_AIRBORNE,
  FLAG_BRAKING,
  FLAG_GUN_LOCKED,
  FLAG_INVULNERABLE,
  FLAG_NITRO,
  FLAG_WRECKED,
  type NetEvent,
} from '../shared/protocol';
import { rotateBy } from '../sim/lagcomp';
import { StuckWatch, upY } from '../sim/Recovery';
import { gridPose, respawnPose } from '../race/Respawn';
import { RaceHud } from '../ui/raceHud';
import { CongHoaDressing } from '../world/CongHoaDressing';
import { CongHoaLandmarks } from '../world/CongHoaLandmarks';
import { CatLai } from '../world/CatLai';
import { PvdDressing } from '../world/PvdDressing';
import { PvdStructures, pvdTerrainHoles } from '../world/PvdStructures';
import { PvdTraffic } from '../world/PvdTraffic';
import { Ardennes } from '../world/Ardennes';
import { MonteCarlo } from '../world/MonteCarlo';
import { Sponsors } from '../world/Sponsors';
import { WeatherSystem } from '../weather/WeatherSystem';
import { XaLoDressing } from '../world/XaLoDressing';
import { XaLoMetro } from '../world/XaLoMetro';
import { XaLoStructures, xaLoTerrainHoles } from '../world/XaLoStructures';
import { XaLoTraffic } from '../world/XaLoTraffic';
import { Track } from '../world/Track';
import { relaxTightBends } from '../world/relaxBends';
import { TrackPath } from '../world/TrackPath';
import { Hud } from '../ui/hud';
import { FpvHud, type FpvRocket, type FpvState, type FpvTarget } from '../ui/fpvHud';
import { gapAheadSec } from '../ui/fpvMath';
import { ViewState, type CameraView } from './ViewState';
import { COCKPIT_RIG } from '../vehicle/CockpitView';
import { engineState } from '../audio/Rpm';
import { Car } from '../vehicle/Car';
import { IDLE_CONTROLS } from '../vehicle/CarPhysics';
import { ChaseCamera } from '../vehicle/ChaseCamera';
import { CockpitView } from '../vehicle/CockpitView';
import { availableViews, nextAvailableView, resolveView } from '../vehicle/FpvMath';
import { ViewCamera } from '../vehicle/ViewCamera';
import { ViewToast } from '../ui/viewToast';
import { Environment } from '../world/Environment';
import { Lighting } from '../world/Lighting';
import type { Assets } from './Assets';
import {
  FPV,
  AI,
  AUDIO,
  COMBAT,
  HANDLING,
  CARS,
  CAT_LAI,
  GATE_LEAD_M,
  RACE,
  WEAPONS,
  getCarDef,
  getTrack,
  roadWidthAt,
  XA_LO,
  ARDENNES,
  MONTE_CARLO,
  PHAM_VAN_DONG,
  type TrackDef,
} from './Data';
import { setupDevTools } from './DevTools';
import { EventBus } from './Events';
import { Input } from './Input';
import { Loop, STEP } from './Loop';
import { saveBestLap } from './Records';
import { onSettingsChange, settings, userSettings } from './Settings';
import { formatTime } from '../ui/format';
import type { Difficulty, ResultRow, ResultsData } from '../ui/types';

export type GameMode = 'race' | 'practice';

export interface GameConfig {
  carId: string;
  trackId: string;
  laps: number;
  difficulty: Difficulty;
  mode: GameMode;
  /** Who the five rivals are this race (random names and cars); rolled from the player's car when omitted. */
  rivals?: Rival[];
  /** An online race: the other cars are puppets of the server's cars and the player's car is predicted. */
  online?: OnlineRace;
}

export interface GameHooks {
  /** The player pressed Esc / Start. */
  onPause(): void;
  /** Called about 4×/s once the player has finished; `final` when the standings can no longer change. */
  onResults(data: ResultsData, final: boolean): void;
}

/** The one allowed singleton: owns the renderer, the Rapier world and every system. */
/** localStorage, or null where it is blocked (private windows, sandboxed frames). */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class Game {
  readonly events = new EventBus();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly chase: ChaseCamera;
  private readonly viewCam: ViewCamera;
  /** The player's cockpit rig, mirror and dash (null for cars with a helmet view only). */
  private cockpit: CockpitView | null = null;
  private readonly viewToast: ViewToast;
  private readonly carQuat = new THREE.Quaternion();
  private lastSteer = 0;
  private readonly postfx: PostFX;
  private readonly lighting: Lighting;
  private readonly input: Input;
  private readonly hud: Hud;
  /** Camera view (V), HUD mode (H) and mirror (M). */
  readonly view = new ViewState(safeStorage());
  private readonly fpvHud: FpvHud;
  private readonly raceHud: RaceHud;
  private readonly loop: Loop;
  private readonly carId: string;
  /** The map being raced. */
  readonly trackDef: TrackDef;
  private readonly mode: GameMode;
  private paused = false;
  private resumeUntil = 0;
  private postFinishSec = 0;
  private resultsTimer = 0;
  private newBest = false;
  private bestSaved = false;
  private playerWrecks = 0;
  private fpsEl: HTMLElement | null = null;
  private fpsAcc = { t: 0, n: 0 };
  private offSettings: (() => void) | null = null;
  private world!: RAPIER.World;
  private env!: Environment;
  private car!: Car;
  private cars: Car[] = [];
  private readonly spawnPoses = new Map<string, { x: number; y: number; z: number; yaw: number }>();
  private particles!: Particles;
  private tracers!: Tracers;
  private skidmarks!: Skidmarks;
  private speedLines!: SpeedLines;
  private skidEmitters: SkidEmitter[] = [];
  private smokeTimer = 0;
  private readonly smokePos = new THREE.Vector3();
  private combat!: CombatSystem;
  private readonly combatHud: CombatHud;
  private banner = { text: '', left: 0 };
  private feed: { text: string; left: number }[] = [];
  private path!: TrackPath;
  private track!: Track;
  private readonly rivals: Rival[];
  /** Online race state (null offline): the other cars follow server snapshots. */
  private readonly online: OnlineRace | null;
  private onlineLive = false;
  /** Sim ticks completed locally (the same count the server's snapshots carry, plus our lead). */
  private localTick = 0;
  private readonly puppets = new Map<string, Car>();
  /** Online: which cars the server last said were wrecked (to freeze / unfreeze them on the transition). */
  private readonly wasWrecked = new Set<string>();
  /** Dev/e2e: how many events of each kind the server has sent. */
  private readonly netEventCounts: Record<string, number> = {};
  private readonly netVec = new THREE.Vector3();
  private readonly netVec2 = new THREE.Vector3();
  /** Dev/e2e only: where and why cars were put back on the road by recoverFallen. */
  private readonly fallLog: string[] = [];
  private readonly sunkRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private sponsors: Sponsors | null = null;
  private pvd: {
    structures: PvdStructures;
    dressing: PvdDressing;
    traffic: PvdTraffic;
  } | null = null;
  private weather: WeatherSystem | null = null;
  /** Map 5 (Monte-Carlo Harbour): terrain, circuit furniture, city, harbour, sky and the helicopter. */
  private monte: MonteCarlo | null = null;
  private monteAudio: MonteCarloAudio | null = null;
  /** Map 6 (Ardennes Forest Circuit): heightmap terrain, forest, circuit furniture and the start gantry. */
  private ardennes: Ardennes | null = null;
  private ardennesAudio: ArdennesAudio | null = null;
  private catLaiAudio: CatLaiAudio | null = null;
  private dressing: CongHoaDressing | null = null;
  private landmarks: CongHoaLandmarks | null = null;
  /** Map 1 (Cat Lai Port v2): river, port slab, cranes, ships, containers, the ferry and the surroundings. */
  private catLai: CatLai | null = null;
  private xaLo: { dressing: XaLoDressing; structures: XaLoStructures; metro: XaLoMetro; traffic: XaLoTraffic } | null =
    null;
  private race!: RaceManager;
  private readonly races = new Map<string, RaceManager>();
  private readonly carTs = new Map<string, number>();
  private readonly slots = new Map<string, number>();
  private readonly lanes = new Map<string, number>();
  private readonly views: CarRaceView[] = [];
  private readonly otherViews = new Map<string, OtherCar[]>();
  private readonly places = new Map<string, number>();
  private minimap!: Minimap;
  private nameTags!: NameTags;
  /** Online only: the rival tags of board 40 (the offline game keeps `nameTags`). */
  private onlineTags: OnlineNameTags | null = null;
  /** F8 network panel (online only) and the counters it reads. */
  private netDebug: NetDebugPanel | null = null;
  private netDebugAcc = 0;
  private netDebugLogIdx = 0;
  private extrapFrames = 0;
  private renderFrames = 0;
  private readonly tagSeen = new Map<string, { at: number; occluded: boolean }>();
  private drawCalls = 0;
  private triangles = 0;
  /** Per AI car: progress anchor (to detect "not getting anywhere") and seconds upside down. */
  private readonly aiStuck = new Map<string, StuckWatch>();
  /** Dev/e2e: how many times each AI car was put back on the road. */
  readonly aiRecoveries = new Map<string, number>();
  /** Dev/e2e only: rivals never fire, so a race-finish test measures blocking rather than wrecks. */
  private devAiHoldFire = false;
  /** Dev/e2e only: an AI driver steering the player's car, to drive a whole lap through the real world. */
  private devPilot: AIDriver | null = null;
  /** Dev/e2e only: per-car counters collected while fast-forwarding (null = off). */
  private devStats: Map<
    string,
    {
      impacts: number[];
      stuckSec: number;
      stuckAt: number[];
      maxOff: number;
      maxOffAt: number;
      highAt: string[];
      lowAt: string[];
    }
  > | null = null;
  private lampKey = '';
  private audio!: AudioBus;
  private engineSound!: EngineSound;
  private unbindSfx: (() => void) | null = null;
  private lastCountdown: number | null = null;
  private lastControls = { throttle: 0, brake: 0 };
  /** Light-sequence start (Map 5); null on the maps with the 3-2-1 countdown. One instance for every car. */
  private startLights: StartLights | null = null;
  /** Seconds before a car can take another wall / contact hit (stops one scrape counting every step). */
  private hitRules!: HitRules;
  private readonly passbyCooldown = new Map<string, number>();
  private readonly sparkPos = new THREE.Vector3();
  private dev: Awaited<ReturnType<typeof setupDevTools>> | null = null;
  private readonly carPos = new THREE.Vector3();
  private readonly onResize = (): void => this.resize();

  private constructor(
    canvas: HTMLCanvasElement,
    private readonly assets: Assets,
    private readonly cfg: GameConfig,
    private readonly hooks: GameHooks,
  ) {
    this.carId = cfg.carId;
    this.mode = cfg.mode;
    this.online = cfg.online ?? null;
    // Maps with their own grid (Map 5's open-wheel field) override the rolled cars and give each a livery.
    // Online, the grid is whatever the server announced: everyone keeps the vehicle they picked.
    this.rivals = this.online
      ? (cfg.rivals ?? [])
      : applyTrackRoster(
          cfg.rivals ??
            rollRoster(
              AI.rivals,
              AI.rosterNames,
              CARS.map((c) => c.id),
              cfg.carId,
            ),
          cfg.trackId,
          AI.trackRosters,
        );
    this.trackDef = getTrack(cfg.trackId);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(settings.pixelRatio);
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.info.autoReset = false;

    this.chase = new ChaseCamera(innerWidth / innerHeight, HANDLING);
    this.lighting = new Lighting(this.scene, this.trackDef, this.assets);
    this.postfx = new PostFX(this.renderer, this.scene, this.chase.camera, this.trackDef);
    this.viewCam = new ViewCamera(this.chase, getCarDef(cfg.carId));
    this.viewToast = new ViewToast(document.getElementById('hud') as HTMLElement);
    this.input = new Input(window);
    this.hud = new Hud(document.getElementById('hud') as HTMLElement);
    this.raceHud = new RaceHud(document.getElementById('hud') as HTMLElement);
    this.combatHud = new CombatHud(document.getElementById('hud') as HTMLElement);
    this.fpvHud = new FpvHud(document.getElementById('hud') as HTMLElement, {
      view: this.view,
      events: this.events,
      beep: () => this.audio?.play(AUDIO.oneShots.countdownBeep, AUDIO.threat.pitch),
      onThreat: (on) => this.setMirrorThreat(on),
    });
    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
    );
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, assets: Assets, cfg: GameConfig, hooks: GameHooks): Promise<Game> {
    await RAPIER.init();
    const g = new Game(canvas, assets, cfg, hooks);
    const mapDef = getTrack(cfg.trackId);
    g.audio = await AudioBus.load(
      sfxFiles(
        mapDef.id === MONTE_CARLO.id
          ? trackAudioFiles(mapDef)
          : mapDef.id === ARDENNES.id
            ? ardennesAudioFiles(mapDef)
            : mapDef.id === CAT_LAI.id
              ? catLaiAudioFiles(mapDef)
              : [],
      ),
    );
    g.engineSound = new EngineSound(g.audio, g.carId);
    g.unbindSfx = bindSfx(g.audio, g.events, () => g.carPos);
    g.buildWorld();
    g.engineSound.setPitchMul(AUDIO.vehiclePitch[g.car.def.vehicleType]);
    g.offSettings = onSettingsChange(() => g.applySettings());
    g.applySettings();
    if (import.meta.env.DEV) g.dev = await setupDevTools({ handling: HANDLING, onReset: () => g.resetPlayer() });
    return g;
  }

  private buildWorld(): void {
    this.world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
    this.world.timestep = STEP;
    this.path = new TrackPath(
      relaxTightBends(this.trackDef.spline.points, RACE.track.minTurnRadiusM),
      RACE.track.sampleSpacingM,
      RACE.track.projectWindowSamples,
    );
    const isXaLo = this.trackDef.id === XA_LO.id;
    const isPvd = this.trackDef.id === PHAM_VAN_DONG.id;
    this.env = new Environment(
      this.scene,
      RAPIER,
      this.world,
      this.trackDef,
      isXaLo ? xaLoTerrainHoles(this.trackDef, this.path) : isPvd ? pvdTerrainHoles(this.trackDef, this.path) : [],
    );
    this.track = new Track(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path);
    if (this.trackDef.id === CAT_LAI.id) {
      this.catLai = new CatLai(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path, {
        camera: this.chase.camera,
        renderer: this.renderer,
        quality: userSettings.preset,
      });
      this.catLaiAudio = new CatLaiAudio(
        this.audio,
        this.trackDef,
        this.events,
        () => this.places.get('player') ?? 1,
        () => this.car.physics.curr.p,
      );
    } else if (isXaLo) {
      const a: [THREE.Scene, typeof RAPIER, RAPIER.World, Assets, TrackDef, TrackPath] = [
        this.scene,
        RAPIER,
        this.world,
        this.assets,
        this.trackDef,
        this.path,
      ];
      this.xaLo = {
        dressing: new XaLoDressing(...a),
        structures: new XaLoStructures(...a),
        metro: new XaLoMetro(...a),
        traffic: new XaLoTraffic(...a),
      };
    } else if (isPvd) {
      const a: [THREE.Scene, typeof RAPIER, RAPIER.World, Assets, TrackDef, TrackPath] = [
        this.scene,
        RAPIER,
        this.world,
        this.assets,
        this.trackDef,
        this.path,
      ];
      this.pvd = {
        structures: new PvdStructures(...a),
        dressing: new PvdDressing(...a),
        traffic: new PvdTraffic(...a),
      };
      this.weather = new WeatherSystem({
        scene: this.scene,
        renderer: this.renderer,
        camera: this.chase.camera,
        assets: this.assets,
        track: this.trackDef,
        path: this.path,
        roadMaterials: this.track.roadMaterials,
        audio: this.audio,
        lighting: this.lighting,
        getCars: () => this.cars,
      });
    } else if (this.trackDef.id === MONTE_CARLO.id) {
      this.monte = new MonteCarlo(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path, {
        renderer: this.renderer,
        camera: this.chase.camera,
        reflections: userSettings.preset !== 'low',
        hooks: {
          setExposureMul: (k) => this.postfx.setExposureMul(k),
          setBloomBoost: (v) => this.postfx.setBloomBoost(v),
          setFill: (v) => this.lighting.setHemiBoost(v),
        },
      });
      this.monteAudio = new MonteCarloAudio(
        this.audio,
        this.trackDef,
        this.events,
        () => this.places.get('player') ?? 1,
        () => this.car.physics.curr.p,
      );
    } else if (this.trackDef.id === ARDENNES.id) {
      this.ardennes = new Ardennes(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path, {
        camera: this.chase.camera,
        quality: userSettings.preset,
      });
      this.ardennesAudio = new ArdennesAudio(
        this.audio,
        this.trackDef,
        this.events,
        () => this.places.get('player') ?? 1,
        () => this.car.physics.curr.p,
      );
    } else {
      this.dressing = new CongHoaDressing(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path);
      this.landmarks = new CongHoaLandmarks(this.scene, RAPIER, this.world, this.assets, this.trackDef, this.path);
    }
    // Hanoi places its own billboards (XaLoMetro), Cat Lai its rooftop ones (CatLai).
    if (!isXaLo && !this.catLai) this.sponsors = new Sponsors(this.scene, this.assets, this.trackDef);
    const playerSlot = this.online
      ? this.gridSlotOf(this.online.selfId)
      : this.mode === 'race'
        ? RACE.ai.playerGridSlot
        : RACE.ai.practiceGridSlot;
    const line = new RacingLine(this.path, RACE.track.sampleSpacingM);
    const grid = this.gridPoseForSlot(playerSlot);
    this.slots.set('player', playerSlot);
    this.car = new Car({
      id: 'player',
      kind: 'player',
      R: RAPIER,
      world: this.world,
      assets: this.assets,
      def: getCarDef(this.carId),
      handling: HANDLING,
      controller: { read: () => this.readControls() },
      events: this.events,
      spawn: { x: grid.x, y: grid.y + 0.4, z: grid.z, yaw: grid.yaw },
      scene: this.scene,
    });
    this.cars = [this.car];
    this.online?.session.setBody(rapierBody(this.car.physics.body));
    this.spawnPoses.set('player', grid);
    this.setupFirstPerson();

    if (this.mode === 'race') {
      const free = Array.from({ length: RACE.track.gridSlotCount }, (_, i) => i).filter((i) => i !== playerSlot);
      this.rivals.forEach((r, i) => {
        const slot = this.online ? this.gridSlotOf(r.id) : free[i];
        const pose = this.gridPoseForSlot(slot);
        this.slots.set(r.id, slot);
        if (this.online) {
          // A remote player's (or the server's bot's) car: a puppet that follows snapshots.
          const puppet = new Car({
            id: r.id,
            kind: 'ai',
            R: RAPIER,
            world: this.world,
            assets: this.assets,
            def: getCarDef(r.car),
            handling: HANDLING,
            controller: { read: () => IDLE_CONTROLS },
            events: this.events,
            spawn: { x: pose.x, y: pose.y + 0.4, z: pose.z, yaw: pose.yaw },
            scene: this.scene,
            tint: COMBAT.enemyTint,
            livery: r.livery,
          });
          puppet.physics.makePuppet();
          this.puppets.set(r.id, puppet);
          this.spawnPoses.set(r.id, pose);
          this.cars.push(puppet);
          return;
        }
        // The data's lane offsets are for the 18 m Harbor road; scale them to this map's carriageway.
        const lane = this.laneFor(r.laneOffsetM);
        this.lanes.set(r.id, lane);
        const car: Car = new Car({
          id: r.id,
          kind: 'ai',
          R: RAPIER,
          world: this.world,
          assets: this.assets,
          def: getCarDef(r.car),
          handling: HANDLING,
          controller: { read: () => this.aiControls(r.id, driver) },
          events: this.events,
          spawn: { x: pose.x, y: pose.y + 0.4, z: pose.z, yaw: pose.yaw },
          scene: this.scene,
          tint: COMBAT.enemyTint,
          livery: r.livery,
        });
        const driver = new AIDriver({
          carId: r.id,
          line,
          laneOffsetM: lane,
          centreRanges: this.centreRanges(),
          halfWidthAt: (t) => roadWidthAt(this.trackDef, t) / 2,
          skill: r.skill,
          difficulty: this.cfg.difficulty,
          handling: car.def.handling,
          wet: this.wetForAi(),
          topSpeedMps: car.def.topSpeedKmh / 3.6,
          self: () => {
            const p = car.physics;
            return {
              x: p.curr.p.x,
              z: p.curr.p.z,
              yaw: p.yaw,
              forwardSpeed: p.forwardSpeed,
              lateralSpeed: p.lateralSpeed,
              t: this.carTs.get(r.id) ?? 0,
              nitroBars: p.nitro.bars,
              airborne: p.airborne,
            };
          },
          others: () => this.otherViews.get(r.id) ?? [],
          pickups: () => this.combat.availablePickups(),
          rubberBand: () =>
            rubberBandSignal(this.progressOf(r.id), this.progressOf('player'), RACE.ai.rubberBandScaleLaps),
          rocketAmmo: () => car.ammo.count,
          hullFraction: () => car.hull.fraction,
        });
        this.spawnPoses.set(r.id, pose);
        this.cars.push(car);
      });
    } else {
      COMBAT.dummies.forEach((d, i) => {
        const pose = respawnPose(this.path, d.t, this.trackDef.laneOffsetsM[d.lane] ?? 0);
        const id = `dummy${i + 1}`;
        this.spawnPoses.set(id, pose);
        this.cars.push(
          new Car({
            id,
            kind: 'dummy',
            R: RAPIER,
            world: this.world,
            assets: this.assets,
            def: getCarDef(this.carId),
            handling: HANDLING,
            controller: { read: () => IDLE_CONTROLS },
            events: this.events,
            spawn: { x: pose.x, y: pose.y + 0.4, z: pose.z, yaw: pose.yaw },
            scene: this.scene,
            tint: COMBAT.enemyTint,
          }),
        );
      });
    }
    this.particles = new Particles(this.scene, this.assets);
    this.tracers = new Tracers(this.scene, this.assets);
    this.skidmarks = new Skidmarks(this.scene, this.assets);
    this.speedLines = new SpeedLines(document.getElementById('stage') as HTMLElement);
    for (const c of this.cars) {
      for (const w of c.physics.wheelLayout) {
        if (!w.rear) continue;
        this.skidEmitters.push({
          key: `${c.id}:${w.name}`,
          x: 0,
          y: 0,
          z: 0,
          dx: 0,
          dz: 1,
          active: false,
          intensity: 0,
        });
      }
    }
    const pickupDefs = expandPickups(this.trackDef.pickups);
    this.combat = new CombatSystem({
      R: RAPIER,
      world: this.world,
      scene: this.scene,
      assets: this.assets,
      events: this.events,
      particles: this.particles,
      tracers: this.tracers,
      tracerOrigin: (car, out) => {
        const ck = this.cockpit;
        if (!ck || car !== this.car || !this.viewCam.cockpitVisible) return false;
        ck.muzzleWorld(car.physics.curr.p as unknown as THREE.Vector3, this.carQuat, out);
        return true;
      },
      cars: () => this.cars,
      respawnPoseFor: (c) => {
        const r = this.races.get(c.id);
        if (c.kind === 'dummy' || !r) return this.spawnPoses.get(c.id) as { x: number; z: number; yaw: number };
        return respawnPose(this.path, r.respawnT, this.lanes.get(c.id) ?? 0);
      },
      pickupDefs,
      remote: !!this.online,
      pickupVisuals: new PickupVisuals(this.scene, this.assets, pickupDefs, this.path, this.trackDef),
    });
    if (this.online) {
      this.online.session.onEvents = (ev) => this.handleNetEvents(ev);
      // A wreck respawn or reset on the server: bring our frozen car back before its state is adopted.
      this.online.session.onOwnTeleport = () => {
        this.car.unfreeze();
        this.wasWrecked.delete('player');
        this.chase.snap();
      };
    }
    this.hitRules = new HitRules(
      !!(this.trackDef.raw.barriers as { armco?: unknown } | undefined)?.armco,
      (x, y, z) => {
        this.sparkPos.set(x, y, z);
        this.particles.burst(
          'spark',
          this.sparkPos,
          COMBAT.wall.sparkCount,
          COMBAT.wall.sparkSpeed,
          COMBAT.wall.sparkLifeSec,
        );
      },
    );
    this.bindHudEvents();
    if (this.trackDef.startLights) {
      this.startLights = new StartLights(RACE.startLights);
      this.startLights.onLit(() => playStartLamp(this.audio));
      this.startLights.onGo(() => playStartGo(this.audio));
    }
    for (const c of this.cars) {
      this.races.set(
        c.id,
        new RaceManager(
          {
            carId: c.id,
            startLights: this.startLights ?? undefined,
            jumpStartPenaltySec: RACE.startLights.jumpStartPenaltySec,
            totalLaps: this.cfg.laps,
            checkpointTs: this.trackDef.checkpoints.map((k) => k.t),
            countdownSteps: RACE.countdown.steps,
            countdownStepSec: RACE.countdown.stepSec,
            goHoldSec: RACE.countdown.goHoldSec,
          },
          this.events,
        ),
      );
      this.views.push({
        id: c.id,
        lap: 1,
        t: 0,
        nextGateT: 0,
        checkpointsPassed: 0,
        finished: false,
        finishTimeSec: null,
      });
    }
    this.race = this.races.get('player') as RaceManager;
    for (const c of this.cars) {
      this.otherViews.set(
        c.id,
        this.cars.filter((o) => o !== c).map((o) => ({ id: o.id, x: 0, y: 0, z: 0, wrecked: false })),
      );
    }
    this.minimap = new Minimap(
      document.getElementById('hud') as HTMLElement,
      this.trackDef.spline.points,
      this.trackDef.roadWidthM,
    );
    this.nameTags = new NameTags(document.getElementById('hud') as HTMLElement);
    if (this.online) {
      this.onlineTags = new OnlineNameTags(document.getElementById('hud') as HTMLElement);
      this.netDebug = new NetDebugPanel(document.body);
    }
    this.restartRace();
  }

  private readonly fpvBuild = (): FpvState => this.fpvState();
  private readonly fpvTargets: FpvTarget[] = [];
  private readonly fpvRockets: FpvRocket[] = [];

  /** Everything the first-person visor draws this frame (only built while it is live). */
  private fpvState(): FpvState {
    const car = this.car;
    const p = car.physics;
    const yaw = p.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const v = p.body.linvel();
    const targets = this.fpvTargets;
    targets.length = 0;
    for (const c of this.cars) {
      if (c.kind === 'player' || c.hull.wrecked) continue;
      const q = c.physics.curr.p;
      targets.push({
        id: c.id,
        name: this.nameOf(c.id),
        car: c.def.name,
        x: q.x,
        y: q.y + COMBAT.aimTargetHeightM,
        z: q.z,
        hullFraction: c.hull.fraction,
      });
    }
    const rockets = this.fpvRockets;
    rockets.length = 0;
    const speed = WEAPONS.hornet_rocket.speedMps;
    this.combat.forEachRocket((owner, pos, dir) => {
      if (owner === 'player') return;
      rockets.push({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        dirX: dir.x,
        dirY: dir.y,
        dirZ: dir.z,
        speedMps: speed,
        owner: this.nameOf(owner),
      });
    });
    const place = this.places.get('player') ?? 1;
    let gap: number | null = null;
    if (place > 1) {
      const ahead = [...this.places].find(([, pl]) => pl === place - 1)?.[0];
      if (ahead)
        gap = gapAheadSec(this.progressOf(ahead), this.progressOf('player'), this.path.lengthM, Math.hypot(v.x, v.z));
    }
    const gateT = this.race.nextGateT;
    const cpIndex = this.race.laps.nextCheckpoint;
    const tNow = this.carTs.get('player') ?? 0;
    const cpPoint = this.path.pointAt(gateT);
    const cp =
      cpIndex < this.trackDef.checkpoints.length
        ? {
            x: cpPoint.x,
            y: cpPoint.y,
            z: cpPoint.z,
            index: cpIndex + 1,
            distM: ((((gateT - tNow) % 1) + 1) % 1) * this.path.lengthM,
          }
        : null;
    return {
      camera: this.chase.camera,
      position: place,
      totalCars: this.cars.length,
      lap: this.race.laps.lap,
      totalLaps: this.cfg.laps,
      timeSec: this.race.timeSec,
      bestLapSec: this.race.laps.bestLap,
      gapAheadSec: gap,
      hullFraction: car.hull.fraction,
      hp: car.hull.hp,
      maxHp: car.hull.maxHp,
      heat: car.gun.heat,
      overheated: car.gun.locked,
      rockets: car.ammo.count,
      nitroBars: p.nitro.bars,
      nitroActive: p.nitroActive,
      player: { x: p.curr.p.x, y: p.curr.p.y, z: p.curr.p.z, fx, fz, vx: v.x, vz: v.z },
      fullTurret: car.def.turretYawDeg >= COMBAT.turret.fullTurretDeg,
      targets,
      incoming: rockets,
      checkpoint: cp,
      hidden: car.hull.wrecked || this.race.phase === 'finished',
    };
  }

  private nameOf(id: string): string {
    if (id === 'player') return 'YOU';
    return this.rivals.find((r) => r.id === id)?.name ?? id.replace('dummy', 'DUMMY ').toUpperCase();
  }

  /** The views this car can show (the driver's view needs its fpv data and, for a cockpit, the rig). */
  private carViews(): CameraView[] {
    return availableViews(this.car.def, this.assets.hasModel(COCKPIT_RIG));
  }

  /** Builds the cockpit for cars that have one and starts following the V / H / M state. */
  private setupFirstPerson(): void {
    const def = this.car.def;
    if (def.fpv?.mode === 'cockpit' && this.assets.hasModel(def.fpv.rig ?? COCKPIT_RIG)) {
      this.cockpit = new CockpitView(this.assets, def, userSettings.preset === 'low');
      this.postfx.setOverlay(this.cockpit.scene, this.cockpit.camera);
    }
    this.applyView();
    this.offView = this.view.onChange(() => this.applyView());
  }

  private offView: (() => void) | null = null;

  /** Cockpit rig, dash, mirror and which of the player's meshes are hidden, once the camera has moved this frame. */
  private updateFirstPerson(dt: number): void {
    const def = this.car.def;
    const inside = this.viewCam.current === 'cockpit' && this.viewCam.blendAmount >= FPV.cockpitShowAt * 0.7;
    this.car.visual.setFirstPerson(!inside ? 'none' : def.fpv?.mode === 'cockpit' ? 'all' : 'rider');
    const ck = this.cockpit;
    if (!ck) return;
    const show = this.viewCam.cockpitVisible && !this.car.hull.wrecked;
    this.postfx.setOverlayVisible(show);
    if (!show) return;
    const p = this.car.physics;
    const top = def.topSpeedKmh / 3.6;
    const es = engineState(p.forwardSpeed, top, AUDIO.engine.gears, AUDIO.engine.idleRpm, AUDIO.engine.gearBaseRpm);
    ck.update(
      dt,
      {
        steer: this.lastSteer,
        speedMps: p.forwardSpeed,
        reversing: p.forwardSpeed < -0.5,
        gear: es.gear,
        rpm: es.rpm,
        nitroBars: p.nitro.bars,
        mph: userSettings.speedUnit === 'mph',
      },
      this.viewCam.pose,
      this.chase.camera.aspect,
      this.viewCam.fov,
      this.carQuat,
      this.scene,
    );
    ck.setMirror(this.view.mirror);
    ck.renderMirror(this.renderer, this.scene, dt, this.carPos, this.carQuat, this.postfx.sceneCalls);
  }

  /** Puts the camera, the player's car meshes and the cockpit in the state the view calls for. */
  private applyView(): void {
    const v = resolveView(this.view.camera, this.carViews());
    if (v !== this.view.camera) this.view.setCamera(v);
    this.viewCam.setView(v);
    this.cockpit?.setMirror(this.view.mirror);
  }

  /** V / H / M. */
  private handleViewKeys(): void {
    if (this.input.wasPressed('view')) {
      const next = nextAvailableView(this.view.camera, this.carViews());
      this.view.setCamera(next);
      this.viewToast.show(`CAMERA · ${next.toUpperCase()}`);
    }
    if (this.input.wasPressed('hud')) {
      const mode = this.view.cycleHud();
      this.viewToast.show(`HUD · ${mode === 'off' ? 'OFF (DASH ONLY)' : mode.toUpperCase()}`);
    }
    if (this.input.wasPressed('mirror')) {
      this.viewToast.show(`MIRROR · ${this.view.toggleMirror() ? 'ON' : 'OFF'}`);
    }
  }

  /** Red tint and outline on the cockpit mirror while a rocket is locked on the player (the HUD sets this). */
  setMirrorThreat(on: boolean): void {
    this.cockpit?.setMirrorThreat(on);
  }

  /** The render camera, for HUD layers that pin things to the world (target lock, checkpoint). */
  get camera(): THREE.PerspectiveCamera {
    return this.chase.camera;
  }

  /** Camera shake and the takedown banner / kill feed, driven by gameplay events. */
  private bindHudEvents(): void {
    const sh = COMBAT.shake;
    const near = (p: { x: number; y: number; z: number }): number =>
      Math.max(0, 1 - Math.hypot(p.x - this.carPos.x, p.y - this.carPos.y, p.z - this.carPos.z) / 40);
    const shake = (v: number): void => {
      if (!userSettings.cameraShake) return;
      this.chase.addShake(v);
      this.viewCam.addShake(v);
    };
    this.events.on('carHit', (e) => {
      if (e.carId === 'player') shake(sh.hit);
    });
    this.events.on('explosion', (e) => shake(sh.explosion * near(e.pos)));
    this.events.on('rocketLaunched', (e) => {
      if (e.carId === 'player') shake(sh.launch);
    });
    this.events.on('carWrecked', (e) => {
      if (e.carId === 'player') {
        shake(sh.wreck);
        this.playerWrecks++;
      }
      if (e.attackerId === 'player' && e.carId !== 'player') {
        const nitro = WEAPONS.wreck.takedownNitroBars;
        this.banner = { text: `TAKEDOWN +${WEAPONS.wreck.takedownScore} · +${nitro} NITRO`, left: 2 };
      }
      this.feed.push({
        text:
          e.attackerId === null
            ? `<b>${this.nameOf(e.carId)}</b> hit the wall`
            : `<b>${this.nameOf(e.attackerId)}</b> wrecked <b>${this.nameOf(e.carId)}</b>`,
        left: 4,
      });
      if (this.feed.length > 3) this.feed.shift();
    });
  }

  /** 0-based lap that sets the rain: ours offline, the server's count for our car online (the server owns the race). */
  private weatherLap(): number {
    const own = this.online?.session.snap?.cars.find((c) => c.id === this.online?.selfId);
    return Math.max(0, (own ? own.lap : this.race.laps.lap) - 1);
  }

  /** Rain: rivals assume the wet grip and brake earlier, as the weather's multipliers apply to them too. */
  private wetForAi(): { gripMul: number; brakeDistanceMul: number } | undefined {
    const g = this.trackDef.weather?.grip;
    return g ? { gripMul: g.wetMul, brakeDistanceMul: g.brakeDistanceMul } : undefined;
  }

  private resetPlayer(): void {
    if (this.online) {
      // The server executes the reset and tells us (the respawn counter in our snapshots).
      this.online.client.reset();
      return;
    }
    if (this.car.hull.wrecked || this.race.phase === 'finished') return;
    this.car.respawn(respawnPose(this.path, this.race.respawnT, 0));
    this.chase.snap();
  }

  /** Stretches rivals hold the centre line: narrow profiles (yard lanes, frontage road) and the port gate. */
  private centreRanges(): { fromT: number; toT: number }[] {
    const def = this.trackDef;
    const out = def.widthProfile.filter((p) => p.widthM < def.roadWidthM * 0.75);
    const sections = (def.raw.sections as { name: string; fromT: number; toT: number }[] | undefined) ?? [];
    const lead = GATE_LEAD_M / def.lapLengthM;
    return [...out, ...sections.filter((x) => /gate/i.test(x.name)).map((x) => ({ ...x, fromT: x.fromT - lead }))].map(
      (x) => ({ fromT: x.fromT, toT: x.toT }),
    );
  }

  private laneFor(offsetM: number): number {
    // Rivals keep one lane offset for the whole lap, so it has to fit the narrowest stretch (Map 3's 8 m frontage road).
    const width = Math.min(this.trackDef.roadWidthM, ...this.trackDef.widthProfile.map((p) => p.widthM));
    const half = width / 2 - 1.8;
    // A map with a parked queue (Cat Lai) or slow ambient traffic (Cong Hoa, Hanoi) in its right-hand lane: + offsets
    // are the car's left, so rivals keep clear of that lane plus a car width.
    const laneW = this.trackDef.roadWidthM / this.trackDef.laneOffsetsM.length;
    const lowest = this.trackDef.blockedLane === 'right' ? -(this.trackDef.roadWidthM / 2 - laneW - 2) : -half;
    const highest = this.trackDef.blockedLane === 'left' ? this.trackDef.roadWidthM / 2 - laneW - 2 : half;
    return Math.max(lowest, Math.min(highest, (offsetM * width) / RACE.ai.laneReferenceWidthM));
  }

  private gridPoseForSlot(slot: number): { x: number; y: number; z: number; yaw: number } {
    const [lateral, behind] = this.trackDef.startLine.grid[slot];
    return gridPose(this.path, lateral, Math.abs(behind), this.path.lengthM);
  }

  /** Lap + along-track progress (staged cars behind the line count as slightly negative). */
  private progressOf(id: string): number {
    const r = this.races.get(id);
    if (!r) return 0;
    return r.laps.lap + effectiveT({ lap: r.laps.lap, t: r.progressT, checkpointsPassed: r.laps.nextCheckpoint });
  }

  private aiControls(id: string, driver: AIDriver): ReturnType<Input['read']> {
    const r = this.races.get(id);
    if (!r || r.controlsLocked) return IDLE_CONTROLS;
    if (r.phase === 'finished') return { ...IDLE_CONTROLS, brake: RACE.ai.finishedCoastBrake };
    const c = driver.read();
    // No shooting during the opening seconds, so the grid isn't wiped out before the race develops.
    if (this.devAiHoldFire || r.timeSec < RACE.ai.holdFireSec) return { ...c, fire: false, fireSecondary: false };
    return c;
  }

  private readControls(): ReturnType<Input['read']> {
    const out = this.pickControls();
    // Online: this step's input is for server tick `localTick`; the server applies it when it simulates that tick.
    // Frames for ticks the server has already simulated are useless (they would only arrive late): while catching up, skip them.
    if (this.online && this.onlineLive && this.localTick >= (this.online.session.snap?.tick ?? 0))
      this.online.client.sendInput(this.localTick, out, this.online.session.viewTick(performance.now() / 1000));
    return out;
  }

  /** The controls for this step: the keyboard / pad (or the dev autopilot), idle while the race is locked. */
  private pickControls(): ReturnType<Input['read']> {
    const c = this.input.read(); // always read: gamepad edge detection happens inside
    if (this.devPilot) return this.race.controlsLocked ? IDLE_CONTROLS : { ...this.devPilot.read() };
    this.lastControls.throttle = c.throttle;
    this.lastControls.brake = c.brake;
    this.lastSteer = c.steer;
    return this.race.controlsLocked ? IDLE_CONTROLS : c;
  }

  private gridSlotOf(id: string): number {
    return this.online?.grid.find((g) => g.id === id)?.slot ?? 0;
  }

  /** Back to the grid with a fresh countdown. */
  private restartRace(): void {
    for (const c of this.cars) {
      c.resetCombat();
      const slot = this.slots.get(c.id);
      const pose = slot !== undefined ? this.gridPoseForSlot(slot) : this.spawnPoses.get(c.id);
      if (!pose) continue;
      c.respawn(pose);
      const t = this.path.project(pose.x, pose.z);
      this.carTs.set(c.id, t);
      this.races.get(c.id)?.restart(t);
    }
    this.startLights?.restart();
    this.hitRules.clear();
    this.chase.snap();
    this.lastCountdown = null;
    this.skidmarks?.clear();
    this.postFinishSec = 0;
    this.resultsTimer = 0;
    this.newBest = false;
    this.bestSaved = false;
    this.playerWrecks = 0;
  }

  /** Push the user's settings into the renderer, audio, lighting and post-processing. */
  private applySettings(): void {
    this.renderer.setPixelRatio(settings.pixelRatio);
    this.renderer.shadowMap.enabled = settings.shadows;
    this.lighting.setShadows(settings.shadows);
    this.postfx.setBloom(settings.bloom);
    this.postfx.setSamples(settings.msaa);
    this.resize();
    this.audio.setVolumes(
      userSettings.volumeMaster / 100,
      userSettings.volumeEffects / 100,
      userSettings.volumeEngine / 100,
    );
    if (userSettings.showFps && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-counter';
      document.getElementById('hud')?.appendChild(this.fpsEl);
    } else if (!userSettings.showFps && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  }

  private updateFps(frameDt: number): void {
    if (!this.fpsEl) return;
    this.fpsAcc.t += frameDt;
    this.fpsAcc.n++;
    if (this.fpsAcc.t >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.fpsAcc.n / this.fpsAcc.t)} FPS`;
      this.fpsAcc.t = 0;
      this.fpsAcc.n = 0;
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.audio.suspend();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeUntil = performance.now() + 250; // the Esc that closed the pause menu also sets the pause edge
    this.audio.resume();
  }

  /** Back to the grid with a fresh countdown (also un-pauses). */
  restart(): void {
    this.restartRace();
    this.resume();
  }

  /** e.g. 'Lap 2/3 · P3 · 1:42.380' for the pause screen. */
  summaryText(): string {
    const lap = Math.min(this.race.laps.lap, this.cfg.laps);
    return `Lap ${lap}/${this.cfg.laps} · P${this.places.get('player') ?? 1} · ${formatTime(this.race.timeSec)}`;
  }

  private speedLineIntensity(): number {
    const p = this.car.physics;
    const frac = Math.min(1, Math.abs(p.forwardSpeed) / (this.car.def.topSpeedKmh / 3.6));
    return Math.min(1, Math.max(0, (frac - 0.55) * 1.2) + (p.nitroActive ? 0.45 : 0));
  }

  /** Tyre smoke puffs from slipping rear wheels. */
  private emitTireSmoke(dt: number): void {
    this.smokeTimer -= dt;
    if (this.smokeTimer > 0 || dt === 0) return;
    this.smokeTimer = 0.05;
    const pos = this.smokePos;
    for (const e of this.skidEmitters) {
      if (!e.active) continue;
      pos.set(e.x, 0.25, e.z);
      this.particles.spawn('smoke', pos, undefined, 0.9 + e.intensity);
    }
  }

  /** Once the player has finished, hand standings to the results screen (4×/s). */
  private updateResults(frameDt: number): void {
    if (this.race.phase !== 'finished') return;
    if (!this.bestSaved) {
      this.bestSaved = true;
      const best = this.race.laps.bestLap;
      if (best !== null) this.newBest = saveBestLap(this.trackDef.id, best, this.car.def.name);
    }
    this.resultsTimer -= frameDt;
    if (this.resultsTimer > 0) return;
    this.resultsTimer = 0.25;
    const final = this.postFinishSec >= RACE.ai.dnfAfterPlayerFinishSec || this.views.every((v) => v.finished);
    this.hooks.onResults(this.buildResults(final), final);
  }

  private buildResults(final: boolean): ResultsData {
    const order = rankCars(this.views);
    const rows: ResultRow[] = order.map((id, i) => {
      const c = this.cars.find((x) => x.id === id) as Car;
      const r = this.races.get(id) as RaceManager;
      const done = r.phase === 'finished';
      return {
        pos: i + 1,
        name: this.nameOf(id),
        car: c.def.name,
        total: done ? formatTime(r.finishTimeSec) : final ? 'DNF' : 'RACING',
        best: formatTime(r.laps.bestLap),
        takedowns: c.takedowns,
        score: c.score,
        isPlayer: id === 'player',
        lap: r.laps.lap,
      };
    });
    const me = rows.find((r) => r.isPlayer) as ResultRow;
    const wrecks = this.playerWrecks;
    return {
      subtitle: `${this.trackDef.name.toUpperCase()} · ${this.cfg.laps} ${this.cfg.laps === 1 ? 'LAP' : 'LAPS'} · ${this.cfg.difficulty.toUpperCase()}`,
      position: me.pos,
      rows,
      bestLap: formatTime(this.race.laps.bestLap),
      newBest: this.newBest,
      takedowns: this.car.takedowns,
      score: this.car.score,
      footnote: wrecks === 0 ? 'Clean race · no wrecks' : `Wrecked ${wrecks} ${wrecks === 1 ? 'time' : 'times'}`,
    };
  }

  /** Read-only snapshot for e2e tests (exposed on window in dev builds only). */
  debugState(): {
    score: number;
    takedowns: number;
    rockets: number;
    hp: number;
    heat: number;
    lap: number;
    phase: string;
    pos: { x: number; y: number; z: number };
    airborne: boolean;
    nitroBars: number;
    position: number;
    drawCalls: number;
    sceneCalls: number;
    triangles: number;
    memory: { geometries: number; textures: number };
    cars: {
      id: string;
      kind: string;
      hp: number;
      wrecked: boolean;
      invulnerable: boolean;
      lap: number;
      t: number;
      speed: number;
      place: number;
      x: number;
      z: number;
    }[];
  } {
    const p = this.car.physics.curr.p;
    return {
      score: this.car.score,
      takedowns: this.car.takedowns,
      rockets: this.car.ammo.count,
      hp: this.car.hull.hp,
      heat: this.car.gun.heat,
      lap: this.race.laps.lap,
      phase: this.race.phase,
      pos: { x: p.x, y: p.y, z: p.z },
      airborne: this.car.physics.airborne,
      nitroBars: this.car.physics.nitro.bars,
      position: this.places.get('player') ?? 1,
      drawCalls: this.drawCalls,
      sceneCalls: this.postfx.sceneCalls,
      triangles: this.triangles,
      memory: { geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures },
      cars: this.cars.map((c) => ({
        id: c.id,
        vehicle: c.def.id,
        kind: c.kind,
        hp: c.hull.hp,
        wrecked: c.hull.wrecked,
        invulnerable: c.hull.invulnerable,
        lap: this.races.get(c.id)?.laps.lap ?? 0,
        t: this.races.get(c.id)?.progressT ?? 0,
        speed: c.physics.speedMps,
        place: this.places.get(c.id) ?? 0,
        x: c.physics.curr.p.x,
        z: c.physics.curr.p.z,
      })),
    };
  }

  /** Dev/e2e only: visible meshes per top-level group, to see where draw calls go. */
  debugSceneBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    const count = (o: THREE.Object3D): number => {
      let n = 0;
      o.traverseVisible((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.Sprite) {
          n += Array.isArray((c as THREE.Mesh).material) ? ((c as THREE.Mesh).material as THREE.Material[]).length : 1;
        }
      });
      return n;
    };
    for (const c of this.scene.children) {
      const k = `${c.name || c.type}#${c.id}`;
      out[k] = count(c);
    }
    return out;
  }

  /** Dev/e2e only: feed the player's race tracker a perfect run (all checkpoints, all laps) without driving. */
  debugFinishRace(): void {
    const cps = this.trackDef.checkpoints.map((c) => c.t);
    for (let lap = 0; lap < this.cfg.laps; lap++) {
      for (const t of [...cps, 1]) {
        this.race.update(0.2, (t - 0.001 + 1) % 1);
        this.race.update(0.2, (t + 0.001) % 1);
      }
    }
  }

  /**
   * Map 3 only (the one map with elevation and no solid land): the player's car goes back on the track if it ends up
   * in the pit beside or under the road, or is stood back up if a hard hit pressed it down through the road onto the
   * sheet below. Rivals keep the stuck-recovery below: respawning them here put them back at the underpass mouth and
   * they fell again.
   */
  private recoverFallen(): void {
    const def = this.trackDef;
    const c = this.car;
    if (!def.hasElevation || c.hull.wrecked || this.race.phase === 'finished') return;
    const p = c.physics.curr.p;
    if (def.groundY <= -1 && p.y <= def.groundY + RACE.fall.belowGroundM) {
      if (this.devStats && this.fallLog.length < 40)
        this.fallLog.push(`pit @${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)}`);
      this.resetPlayer();
      return;
    }
    const t = this.carTs.get(c.id) ?? 0;
    // Off a raised road (Map 5's Casino climb is 40 m up) the ground is far below it: back onto the track.
    if (def.groundY > -1 && p.y < this.path.pointAt(t).y - RACE.fall.belowRoadM) {
      if (this.devStats && this.fallLog.length < 40)
        this.fallLog.push(`off @${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)}`);
      this.resetPlayer();
      return;
    }
    if (c.physics.speedMps > RACE.fall.sunkSlowBelowMps) return;
    // Cheap pre-check: a sunk car is also well below the road height at its place along the track.
    if (p.y > this.path.pointAt(t).y - RACE.fall.sunkBelowRoadM / 2) return;
    // The road's real height comes from a ray onto the fixed collider just above the car. Both tests must agree, so a
    // car pressed against a side wall (the ray sees the wall top) or on the underpass ramp (the path height lags) is
    // never mistaken for a sunk one.
    this.sunkRay.origin.x = p.x;
    this.sunkRay.origin.y = p.y + RACE.fall.sunkRayAboveM;
    this.sunkRay.origin.z = p.z;
    const hit = this.world.castRay(
      this.sunkRay,
      RACE.fall.sunkRayAboveM + RACE.fall.sunkBelowRoadM + 1,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (col) => col.parent()?.bodyType() === RAPIER.RigidBodyType.Fixed,
    );
    if (hit && this.sunkRay.origin.y - hit.timeOfImpact > p.y + RACE.fall.sunkBelowRoadM) {
      if (this.devStats && this.fallLog.length < 40)
        this.fallLog.push(`sunk @${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)}`);
      c.respawn(respawnPose(this.path, t, 0));
    }
  }

  /**
   * Rivals that stop moving (or end up on their roof) are put back on the road a few metres ahead, like the player's
   * R key. Wall breaches, traffic pile-ups and failed jumps otherwise leave them parked for the whole race.
   */
  private recoverStuckAi(dt: number): void {
    const cfg = AI.recovery;
    for (const c of this.cars) {
      if (c.kind !== 'ai' || c.hull.wrecked) continue;
      const race = this.races.get(c.id);
      if (!race || race.phase !== 'racing' || race.timeSec < cfg.graceSec) continue;
      const t = this.carTs.get(c.id) ?? 0;
      const watch = this.aiStuck.get(c.id) ?? new StuckWatch();
      this.aiStuck.set(c.id, watch);
      if (!watch.update(dt, t, upY(c.physics.curr.q), this.path.lengthM)) continue;
      c.respawn(respawnPose(this.path, t + cfg.stepAheadM / this.path.lengthM, this.lanes.get(c.id) ?? 0));
      this.aiRecoveries.set(c.id, (this.aiRecoveries.get(c.id) ?? 0) + 1);
    }
  }

  private collectDevStats(dt: number): void {
    for (const c of this.cars) {
      const st = this.devStats?.get(c.id);
      if (!st || c.hull.wrecked) continue;
      const t = this.carTs.get(c.id) ?? 0;
      if (c.physics.impactStrength > 6 && st.impacts.length < 60) st.impacts.push(Math.round(t * 1000) / 1000);
      const racing = (this.races.get(c.id)?.timeSec ?? 0) > 6;
      if (racing && c.physics.speedMps < 2) {
        st.stuckSec += dt;
        if (st.stuckAt.length < 20 && st.stuckSec % 1 < dt) st.stuckAt.push(Math.round(t * 1000) / 1000);
      }
      const p = this.path.pointAt(t);
      // Launched well clear of the road (not just a crest jump): where, and how high.
      const high = c.physics.curr.p.y - p.y;
      if (high > 3.5 && st.highAt.length < 30) {
        st.highAt.push(
          `${t.toFixed(3)}@${c.physics.curr.p.x.toFixed(0)},${c.physics.curr.p.z.toFixed(0)}:${high.toFixed(1)}`,
        );
      }
      // Fell through the road (or off it) onto the ground far below.
      if (high < -2.5 && st.lowAt.length < 8) {
        st.lowAt.push(
          `${t.toFixed(3)}@${c.physics.curr.p.x.toFixed(0)},${c.physics.curr.p.z.toFixed(0)}:${high.toFixed(1)}`,
        );
      }
      const off = Math.hypot(c.physics.curr.p.x - p.x, c.physics.curr.p.z - p.z);
      if (off > st.maxOff) {
        st.maxOff = off;
        st.maxOffAt = t;
      }
    }
  }

  /** Dev/e2e only: the driver's view state (camera, rig, mirror, look-back, own-car visibility). */
  debugFpv(): {
    view: string;
    hud: string;
    mirror: boolean;
    hasRig: boolean;
    rigVisible: boolean;
    carHidden: boolean;
    riderHidden: boolean;
    lookBack: number;
    fov: number;
    blend: number;
    threat: boolean;
  } {
    const root = this.car.visual.root;
    const rider = root.getObjectByName('rider');
    let meshes = 0;
    let shown = 0;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
        if (o.visible) shown++;
      }
    });
    return {
      view: this.viewCam.current,
      hud: this.view.hud,
      mirror: this.view.mirror,
      hasRig: !!this.cockpit,
      rigVisible: this.viewCam.cockpitVisible,
      carHidden: meshes > 0 && shown === 0,
      riderHidden: rider ? !rider.visible : false,
      lookBack: this.viewCam.head.lookBackAmount,
      fov: this.viewCam.fov,
      blend: this.viewCam.blendAmount,
      threat: this.cockpit?.mirrorThreat ?? false,
    };
  }

  /** Dev/e2e only: step the simulation `seconds` of game time without rendering; returns per-car stats. */
  debugFastForward(seconds: number): Record<string, unknown> {
    if (!this.devStats) {
      this.devStats = new Map(
        this.cars.map((c) => [
          c.id,
          { impacts: [], stuckSec: 0, stuckAt: [], maxOff: 0, maxOffAt: 0, highAt: [], lowAt: [] },
        ]),
      );
    }
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) this.step(STEP);
    const out: Record<string, unknown> = {};
    for (const c of this.cars) {
      const r = this.races.get(c.id);
      const st = this.devStats.get(c.id);
      out[c.id] = {
        vehicle: c.def.id,
        place: this.places.get(c.id),
        phase: r?.phase,
        timeSec: +(r?.timeSec ?? 0).toFixed(1),
        laps: r?.laps.lapTimes.map((x) => +x.toFixed(1)),
        t: +(this.carTs.get(c.id) ?? 0).toFixed(3),
        hp: Math.round(c.hull.hp),
        pos: [Math.round(c.physics.curr.p.x), +c.physics.curr.p.y.toFixed(1), Math.round(c.physics.curr.p.z)],
        upY: +(1 - 2 * (c.physics.curr.q.x ** 2 + c.physics.curr.q.z ** 2)).toFixed(2),
        wrecked: c.hull.wrecked,
        impacts: st?.impacts.length,
        impactAt: st?.impacts.slice(0, 20),
        highAt: st?.highAt,
        lowAt: st?.lowAt,
        recoveries: this.aiRecoveries.get(c.id) ?? 0,
        offNow: (() => {
          const pp = this.path.pointAt(this.carTs.get(c.id) ?? 0);
          return +Math.hypot(c.physics.curr.p.x - pp.x, c.physics.curr.p.z - pp.z).toFixed(1);
        })(),
        stuckSec: +(st?.stuckSec ?? 0).toFixed(1),
        stuckAt: st?.stuckAt,
        maxOff: +(st?.maxOff ?? 0).toFixed(1),
        maxOffAt: +(st?.maxOffAt ?? 0).toFixed(3),
      };
    }
    return out;
  }

  /** Dev/e2e: the state of an online race (null offline). */
  debugOnline(): {
    live: boolean;
    localTick: number;
    serverTick: number;
    phase: string;
    me: { x: number; z: number; speed: number };
    puppets: { id: string; x: number; z: number; snapX: number; snapZ: number; speed: number }[];
    reconcile: Record<string, number>;
    netEvents: Record<string, number>;
    hp: number;
    pingMs: number;
    minMargin: number;
    advance: number;
    racePhase: string;
    lap: number;
  } | null {
    const net = this.online;
    if (!net) return null;
    const reconcile: Record<string, number> = {};
    for (const r of net.session.log) reconcile[r.kind] = (reconcile[r.kind] ?? 0) + 1;
    const p = this.car.physics.curr.p;
    return {
      live: this.onlineLive,
      localTick: this.localTick,
      serverTick: net.session.snap?.tick ?? -1,
      phase: net.session.snap?.phase ?? 'none',
      me: { x: p.x, z: p.z, speed: this.car.physics.speedMps },
      puppets: [...this.puppets].map(([id, c]) => {
        const sc = net.session.snap?.cars.find((x) => x.id === id);
        return {
          id,
          x: c.physics.curr.p.x,
          z: c.physics.curr.p.z,
          snapX: sc?.p[0] ?? 0,
          snapZ: sc?.p[2] ?? 0,
          speed: sc ? Math.hypot(sc.v[0], sc.v[2]) : 0,
        };
      }),
      reconcile,
      netEvents: { ...this.netEventCounts },
      hp: Math.round(this.car.hull.hp),
      pingMs: net.client.pingMs,
      minMargin: net.session.minMargin,
      advance: net.session.pendingAdvance,
      racePhase: this.race.phase,
      lap: this.race.laps.lap,
    };
  }

  /** Dev/e2e only: where and why cars were put back on the road by recoverFallen (first 40). */
  debugFallLog(): string[] {
    return this.fallLog;
  }

  /** Dev/e2e only: colliders overlapping a box around (x, z), to find invisible obstacles. */
  debugCollidersNear(x: number, z: number, r: number): string[] {
    const out: string[] = [];
    let total = 0;
    this.world.forEachCollider(() => total++);
    out.push(`total colliders ${total}`);
    this.world.intersectionsWithShape({ x, y: 0, z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Cuboid(r, 30, r), (c) => {
      const p = c.translation();
      const he = c.halfExtents();
      out.push(
        `shape ${c.shapeType()} body ${c.parent()?.bodyType()} at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}${he ? ` half ${he.x.toFixed(1)},${he.y.toFixed(1)},${he.z.toFixed(1)}` : ''}`,
      );
      return true;
    });
    return out;
  }

  /** Dev/e2e only: first hit of a ray (to find bumps in the road collider). */
  debugRay(o: [number, number, number], d: [number, number, number], maxToi: number): string {
    const ray = new RAPIER.Ray({ x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] });
    const hit = this.world.castRayAndGetNormal(ray, maxToi, true);
    if (!hit) return 'none';
    const p = ray.pointAt(hit.timeOfImpact);
    return `y=${p.y.toFixed(3)} n=${hit.normal.x.toFixed(2)},${hit.normal.y.toFixed(2)},${hit.normal.z.toFixed(2)} shape=${hit.collider.shapeType()}`;
  }

  /** Dev/e2e only: remove one Map 3 module to bisect a physics problem. */
  debugDropXaLo(name: 'traffic' | 'metro' | 'structures' | 'dressing'): void {
    this.xaLo?.[name].dispose();
  }

  /** `fight`: the autopilot also sees the other cars, so its gunner shoots at them (online combat tests). */
  debugAutopilot(on: boolean, fight = false): void {
    if (!on) {
      this.devPilot = null;
      return;
    }
    const car = this.car;
    this.devPilot = new AIDriver({
      carId: 'player',
      line: new RacingLine(this.path, RACE.track.sampleSpacingM),
      laneOffsetM: 0,
      centreRanges: this.centreRanges(),
      halfWidthAt: (t) => roadWidthAt(this.trackDef, t) / 2,
      skill: 0.9,
      difficulty: this.cfg.difficulty,
      handling: car.def.handling,
      topSpeedMps: car.def.topSpeedKmh / 3.6,
      self: () => {
        const p = car.physics;
        return {
          x: p.curr.p.x,
          z: p.curr.p.z,
          yaw: p.yaw,
          forwardSpeed: p.forwardSpeed,
          lateralSpeed: p.lateralSpeed,
          t: this.carTs.get('player') ?? 0,
          nitroBars: p.nitro.bars,
          airborne: p.airborne,
          locked: this.race.controlsLocked,
        };
      },
      others: () => (fight ? (this.otherViews.get('player') ?? []) : []),
      pickups: () => [],
      rubberBand: () => 0,
      rocketAmmo: () => (fight ? car.ammo.count : 0),
      hullFraction: () => car.hull.fraction,
    });
  }

  debugAiHoldFire(on: boolean): void {
    this.devAiHoldFire = on;
  }

  /** Dev/e2e only: along-track t of ambient vehicles (0 scooters, 1 cars, 2 buses). */
  debugTrafficTs(kind: number): number[] {
    return (
      this.landmarks?.debugTrafficTs(kind) ??
      this.xaLo?.traffic.debugTrafficTs(kind) ??
      this.pvd?.traffic.debugTrafficTs(kind) ??
      []
    );
  }

  /** Dev/e2e only: put the player on the centreline at along-track `t`, facing the road. */
  debugTeleport(t: number): void {
    this.car.respawn(respawnPose(this.path, t, 0));
    this.carTs.set('player', t);
    this.chase.snap();
  }

  /** The light-sequence start on maps that have one (the gantry visual reads `lit`), else null. */
  get startLightsState(): StartLights | null {
    return this.startLights;
  }

  start(): void {
    this.loop.start();
  }

  private step(dt: number): void {
    if (this.online) {
      this.stepOnline(dt);
      return;
    }
    if (this.paused) {
      this.input.endFrame();
      return;
    }
    if (this.input.wasPressed('pause') && performance.now() >= this.resumeUntil) {
      this.input.endFrame();
      this.hooks.onPause();
      return;
    }
    this.stepCore(dt);
  }

  /**
   * Online: nothing runs until the server's first snapshot; then the sim fast-forwards to the server's tick plus a few
   * ticks of lead and from there runs in step with it (`OnlineSession` decides each frame to hold, run or catch up).
   */
  private stepOnline(dt: number): void {
    const net = this.online as OnlineRace;
    if (!this.onlineLive) {
      const snap = net.session.snap;
      if (!snap || snap.phase === 'lobby' || snap.phase === 'loading') {
        this.input.endFrame();
        return;
      }
      const target = net.session.startTicks(snap);
      for (let i = 0; i < target; i++) this.stepCore(dt);
      this.onlineLive = true;
      return;
    }
    const n = net.session.planSteps();
    if (n === 0) this.input.endFrame();
    for (let i = 0; i < n; i++) this.stepCore(dt);
  }

  private localId(serverId: string): string {
    return serverId === this.online?.selfId ? 'player' : serverId;
  }

  private carById(id: string): Car | undefined {
    return this.cars.find((c) => c.id === id);
  }

  /** Where the car's gun muzzle is drawn right now (its drawn pose, not the server's). */
  private drawnMuzzle(car: Car, out: THREE.Vector3): THREE.Vector3 {
    const { p, q } = car.physics.curr;
    const gm = car.def.gunMount;
    const mo = COMBAT.muzzleOffset;
    rotateBy(gm[0] + mo[0], gm[1] + mo[1], gm[2] + mo[2], q, out);
    return out.set(out.x + p.x, out.y + p.y, out.z + p.z);
  }

  /**
   * Server events arrive with a snapshot: replay them into the local event bus (so the HUD, sounds, camera shake and
   * the kill feed work exactly as offline) and draw the shots. A tracer is drawn from where the shooter's car *is drawn*
   * (we show remote cars slightly in the past, and our own ahead of the server), keeping the server's shot direction.
   */
  private handleNetEvents(events: NetEvent[]): void {
    for (const e of events) {
      this.netEventCounts[e.k] = (this.netEventCounts[e.k] ?? 0) + 1;
      switch (e.k) {
        case 'gun': {
          const id = this.localId(e.c);
          const car = this.carById(id);
          if (!car) break;
          const from = this.netVec.set(e.f[0], e.f[1], e.f[2]);
          const to = this.netVec2.set(e.to[0], e.to[1], e.to[2]);
          const drawn = this.drawnMuzzle(car, this.carPos.clone());
          const shift = drawn.sub(from);
          from.add(shift);
          to.add(shift);
          this.tracers.fire(from, to);
          this.tracers.muzzleFlash(from, to.clone().sub(from).normalize());
          if (e.h) this.particles.burst('spark', to, 3, 6, 0.25);
          this.events.emit('gunFired', { carId: id, pos: { x: from.x, y: from.y, z: from.z } });
          break;
        }
        case 'heat': {
          const car = this.carById(this.localId(e.c));
          const p = car?.physics.curr.p ?? { x: 0, y: 0, z: 0 };
          this.events.emit('gunOverheated', { carId: this.localId(e.c), pos: { x: p.x, y: p.y, z: p.z } });
          break;
        }
        case 'rkt':
          this.events.emit('rocketLaunched', { carId: this.localId(e.c), pos: { x: e.p[0], y: e.p[1], z: e.p[2] } });
          break;
        case 'boom':
          this.particles.explosion(this.netVec.set(e.p[0], e.p[1], e.p[2]), e.r);
          this.events.emit('explosion', { pos: { x: e.p[0], y: e.p[1], z: e.p[2] }, radius: e.r });
          break;
        case 'hit':
          this.events.emit('carHit', {
            carId: this.localId(e.c),
            attackerId: e.by === null ? null : this.localId(e.by),
            damage: e.d,
          });
          break;
        case 'wreck':
          this.events.emit('carWrecked', {
            carId: this.localId(e.c),
            attackerId: e.by === null ? null : this.localId(e.by),
          });
          break;
        case 'pick':
          this.events.emit('pickupTaken', {
            carId: this.localId(e.c),
            kind: e.kind,
            pos: { x: e.p[0], y: e.p[1], z: e.p[2] },
          });
          break;
        case 'nitro':
          this.events.emit('nitroBarEarned', { carId: this.localId(e.c), source: e.src });
          break;
      }
    }
  }

  /** Mirror the server's combat state (hull, rockets in the rack, gun heat, wrecks) onto the local cars. */
  private syncOnlineCombat(): void {
    const net = this.online as OnlineRace;
    const snap = net.session.snap;
    if (!snap) return;
    for (const c of snap.cars) {
      const id = this.localId(c.id);
      const car = this.carById(id);
      if (!car) continue;
      const wrecked = (c.fl & FLAG_WRECKED) !== 0;
      car.hull.sync(c.hp, wrecked, (c.fl & FLAG_INVULNERABLE) !== 0);
      car.ammo.count = c.am;
      car.gun.sync(c.ht, (c.fl & FLAG_GUN_LOCKED) !== 0);
      const was = this.wasWrecked.has(id);
      if (wrecked && !was) {
        this.wasWrecked.add(id);
        car.freeze();
      } else if (!wrecked && was) {
        this.wasWrecked.delete(id);
        car.unfreeze();
      }
    }
    // Rockets in flight: drawn where they are by now, flying on from the snapshot's position.
    const age = Math.min(0.15, Math.max(0, performance.now() / 1000 - net.session.rocketsAtSec));
    const speed = WEAPONS.hornet_rocket.speedMps;
    this.combat.setRemoteState(
      net.session.rockets.map((r) => ({
        i: r.i,
        owner: this.localId(r.owner),
        p: { x: r.p[0] + r.d[0] * speed * age, y: r.p[1] + r.d[1] * speed * age, z: r.p[2] + r.d[2] * speed * age },
        d: { x: r.d[0], y: r.d[1], z: r.d[2] },
      })),
      net.session.takenPickups,
    );
  }

  /** Remote cars follow their (interpolated, smoothed) snapshot poses. */
  private updatePuppets(dt: number): void {
    const net = this.online as OnlineRace;
    const now = performance.now() / 1000;
    let extrapolating = false;
    for (const [id, car] of this.puppets) {
      const r = net.session.remotePose(id, now, dt);
      if (!r) continue;
      if (r.pose.extrapolating) extrapolating = true;
      const fl = r.pose.fl;
      car.physics.puppetTo(r.shown, r.pose.q, r.pose.v, r.pose.st, {
        braking: (fl & FLAG_BRAKING) !== 0,
        nitro: (fl & FLAG_NITRO) !== 0,
        airborne: (fl & FLAG_AIRBORNE) !== 0,
      });
    }
    this.renderFrames++;
    if (extrapolating) this.extrapFrames++;
  }

  /** Feed the F8 panel: every frame's duration, and a fresh sample about twice a second. */
  private updateNetDebug(frameDt: number): void {
    const panel = this.netDebug as NetDebugPanel;
    const net = this.online as OnlineRace;
    panel.frame(frameDt);
    this.netDebugAcc += frameDt;
    if (this.netDebugAcc < 0.5) return;
    this.netDebugAcc = 0;
    const log = net.session.log;
    const recon = log.slice(this.netDebugLogIdx).map((r) => ({ kind: r.kind, errM: r.errM }));
    this.netDebugLogIdx = log.length;
    panel.refresh({
      pingMs: net.client.pingMs,
      snapGaps: net.client.snapGaps,
      steps: net.session.stepStats,
      margin: net.session.lastMargin,
      minMargin: Number.isFinite(net.session.minMargin) ? net.session.minMargin : 0,
      recon,
      extrapFrames: this.extrapFrames,
      frames: this.renderFrames,
    });
  }

  private stepCore(dt: number): void {
    this.handleViewKeys();
    if (this.input.wasPressed('restart') && !this.online) this.restartRace();
    if (this.input.wasPressed('reset')) this.resetPlayer();
    this.weather?.update(dt, this.weatherLap());
    this.updateMonteCarlo(dt);
    this.updateArdennes(dt);
    this.startLights?.update(dt);
    this.updateWeaponLocks();
    if (this.online) {
      this.online.session.beforeStep();
      this.syncOnlineCombat();
      this.updatePuppets(dt);
    }
    for (const c of this.cars) c.preStep(dt);
    if (this.startLights && this.race.jumpStart(this.lastControls.throttle)) {
      this.banner = { text: `JUMP START · +${RACE.startLights.jumpStartPenaltySec} s`, left: 3 };
    }
    this.world.step();
    for (const c of this.cars) c.postStep();
    if (this.online) {
      // The server decides hits, guns and recoveries; here we only remember the predicted state for this tick.
      this.localTick++;
      this.online.session.afterStep(this.localTick);
    } else {
      this.applyHitRules(dt);
    }
    this.openWheelPassby(dt);
    this.combat.update(dt);
    if (this.devStats) this.collectDevStats(dt);
    if (!this.online) {
      this.recoverFallen();
      this.recoverStuckAi(dt);
    }
    this.landmarks?.setFocus(this.car.physics.curr.p.x, this.car.physics.curr.p.z);
    this.landmarks?.update(dt);
    this.catLai?.update(dt);
    if (this.catLaiAudio) {
      const pp = this.car.physics;
      this.catLaiAudio.update(dt, {
        t: this.carTs.get('player') ?? 0,
        x: pp.curr.p.x,
        y: pp.curr.p.y,
        z: pp.curr.p.z,
        yaw: pp.yaw,
        speedKmh: pp.speedMps * 3.6,
        cars: this.cars.map((c) => ({
          id: c.id,
          t: this.carTs.get(c.id) ?? 0,
          x: c.physics.curr.p.x,
          y: c.physics.curr.p.y,
          z: c.physics.curr.p.z,
          speedKmh: c.physics.speedMps * 3.6,
        })),
      });
    }
    if (this.pvd) {
      this.pvd.traffic.setFocus(this.car.physics.curr.p.x, this.car.physics.curr.p.z);
      this.pvd.traffic.update(dt);
      this.pvd.dressing.update(dt);
      this.pvd.structures.update(dt);
    }
    if (this.xaLo) {
      this.xaLo.traffic.setFocus(this.car.physics.curr.p.x, this.car.physics.curr.p.z);
      this.xaLo.traffic.update(dt);
      this.xaLo.metro.update(dt);
      this.xaLo.structures.update(dt);
    }
    this.updateSkids();
    this.views.forEach((v, i) => {
      const c = this.cars[i];
      const p = c.physics.curr.p;
      const t = this.path.project(p.x, p.z, this.carTs.get(c.id));
      this.carTs.set(c.id, t);
      const r = this.races.get(c.id) as RaceManager;
      r.update(dt, t);
      v.lap = r.laps.lap;
      v.t = t;
      v.nextGateT = r.nextGateT;
      v.checkpointsPassed = r.laps.nextCheckpoint;
      v.finished = r.phase === 'finished';
      v.finishTimeSec = r.finishTimeSec;
      for (const o of this.otherViews.get(c.id) ?? []) {
        const oc = this.cars.find((x) => x.id === o.id) as Car;
        o.x = oc.physics.curr.p.x;
        o.y = oc.physics.curr.p.y;
        o.z = oc.physics.curr.p.z;
        o.wrecked = oc.hull.wrecked;
      }
    });
    rankCars(this.views).forEach((id, i) => this.places.set(id, i + 1));
    if (this.race.phase === 'finished') this.postFinishSec += dt;
    const impact = this.car.physics.impactStrength;
    if (impact > AUDIO.thresholds.impactDecelMps) this.events.emit('carImpact', { carId: 'player', strength: impact });
    this.updateLamps();
    this.input.endFrame();
  }

  /** Rear-wheel contact points + slip → skid mark emitters (one pair per car). */
  private updateSkids(): void {
    let k = 0;
    for (const c of this.cars) {
      const ph = c.physics;
      const { p, q } = ph.curr;
      const sin = 2 * (q.w * q.y + q.x * q.z);
      const cos = 1 - 2 * (q.y * q.y + q.x * q.x);
      const yaw = Math.atan2(sin, cos);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const slipping = !c.hull.wrecked && !ph.airborne && Math.abs(ph.forwardSpeed) > 8 && ph.slipDeg > 7;
      const intensity = Math.min(1, ph.slipDeg / 30);
      const layout = ph.wheelLayout;
      for (let i = 0; i < layout.length; i++) {
        const w = layout[i];
        if (!w.rear) continue;
        const e = this.skidEmitters[k++];
        // Local (x, z) rotated by yaw: right-handed, +Z forward, +X left.
        e.x = p.x + w.x * fz + w.z * fx;
        e.z = p.z - w.x * fx + w.z * fz;
        e.y = 0;
        e.dx = fx;
        e.dz = fz;
        e.active = slipping && ph.wheels[i].inContact;
        e.intensity = intensity;
      }
    }
  }

  /** No-fire zones from the track JSON: the trigger does nothing for any car inside one. */
  private updateWeaponLocks(): void {
    const zones = this.trackDef.noFireZones;
    if (zones.length === 0) return;
    for (const c of this.cars) c.weaponsLocked = noFireZoneAt(zones, this.carTs.get(c.id) ?? 0) !== null;
  }

  /**
   * Hits that aren't weapons. A car that loses speed to a wall (maps whose JSON has `barriers.armco`) takes hull damage,
   * loses speed on a head-on hit and throws sparks on a scrape. Open-wheel cars (Fulmine FX) also take extra damage from
   * contact with another car, and clipping a car from the side makes it hop. Numbers: data/combat.json `wall` / `contact`.
   */
  private applyHitRules(dt: number): void {
    this.hitRules.apply(dt, this.cars, (v, amount, by) => this.combat.damageCar(v as Car, amount, by));
  }

  /** Doppler pass-by for a rival open-wheel car passing within a few metres of the player. */
  private openWheelPassby(dt: number): void {
    const P = AUDIO.passby;
    for (const [id, left] of this.passbyCooldown) {
      if (left <= dt) this.passbyCooldown.delete(id);
      else this.passbyCooldown.set(id, left - dt);
    }
    const me = this.car.physics.curr.p;
    for (const c of this.cars) {
      if (c === this.car || !c.def.openWheel || c.hull.wrecked || this.passbyCooldown.has(c.id)) continue;
      const q = c.physics.curr.p;
      if (Math.hypot(q.x - me.x, q.y - me.y, q.z - me.z) > P.withinM || c.physics.speedMps < P.minSpeedMps) continue;
      this.audio.play(P, 0.96 + Math.random() * 0.08);
      this.passbyCooldown.set(c.id, P.cooldownSec);
    }
  }

  /** Map 5: tunnel light, the TV helicopter over the race leader and the gantry's lamp sequence. */
  private updateMonteCarlo(dt: number): void {
    const mc = this.monte;
    if (!mc) return;
    const lead = this.cars.find((c) => this.places.get(c.id) === 1 && !c.hull.wrecked) ?? this.car;
    const p = lead.physics.curr.p;
    mc.update(dt, this.carTs.get('player') ?? 0, { x: p.x, y: p.y, z: p.z, yaw: lead.physics.yaw });
    const sl = this.startLights;
    mc.gantry.setLamps(sl && !sl.released ? sl.lit : 0);
    const pp = this.car.physics;
    this.monteAudio?.update(dt, {
      t: this.carTs.get('player') ?? 0,
      x: pp.curr.p.x,
      y: pp.curr.p.y,
      z: pp.curr.p.z,
      yaw: pp.yaw,
      place: this.places.get('player') ?? 1,
      tunnel: mc.tunnelAmount,
      helicopter: mc.helicopterPosition,
    });
  }

  /** Map 6: forest and scatter around the camera, and the gantry's lamp sequence. */
  private updateArdennes(dt: number): void {
    const a = this.ardennes;
    if (!a) return;
    a.update();
    const sl = this.startLights;
    a.gantry.setLamps(sl && !sl.released ? sl.lit : 0);
    const pp = this.car.physics;
    this.ardennesAudio?.update(dt, {
      t: this.carTs.get('player') ?? 0,
      lap: this.race.laps.lap,
      x: pp.curr.p.x,
      y: pp.curr.p.y,
      z: pp.curr.p.z,
      yaw: pp.yaw,
      speedKmh: pp.speedMps * 3.6,
      onKerb: false,
      inGravel: false,
      cars: this.cars.map((c) => ({
        id: c.id,
        t: this.carTs.get(c.id) ?? 0,
        x: c.physics.curr.p.x,
        y: c.physics.curr.p.y,
        z: c.physics.curr.p.z,
        speedKmh: c.physics.speedMps * 3.6,
      })),
    });
  }

  private updateLamps(): void {
    if (this.startLights) return; // the gantry's five lamps follow the light sequence instead
    const v = this.race.countdownValue;
    const cd = RACE.countdown;
    let lit = 0;
    let color = cd.stopColor;
    if (this.race.phase === 'countdown' && v !== null) {
      lit = cd.lampsLit[Math.min(cd.steps - v, cd.lampsLit.length - 1)];
    } else if (v === 0) {
      lit = 5;
      color = cd.goColor;
    }
    const key = `${lit}${color}`;
    if (key !== this.lampKey) {
      this.lampKey = key;
      this.track.setLamps(lit, color);
    }
  }

  private render(alpha: number, frameDt: number): void {
    const dt = this.paused ? 0 : frameDt;
    this.dev?.begin();
    this.renderer.info.reset();
    const { prev, curr } = this.car.physics;
    this.carPos.set(
      prev.p.x + (curr.p.x - prev.p.x) * alpha,
      prev.p.y + (curr.p.y - prev.p.y) * alpha,
      prev.p.z + (curr.p.z - prev.p.z) * alpha,
    );
    for (const c of this.cars) {
      // Shadows only for the player and cars within 45 m (20 m for the 60k+ triangle models): far ones are hazy
      // anyway and cost a second draw each.
      const dx = c.physics.curr.p.x - this.carPos.x;
      const dz = c.physics.curr.p.z - this.carPos.z;
      const d2 = dx * dx + dz * dz;
      const shadowM = c.visual.triangles > 40_000 ? 20 : 45;
      c.visual.setCastShadow(c === this.car || d2 < shadowM * shadowM);
      // Cars more than 250 m away are only a few pixels in the haze: skip their draw calls entirely.
      const far = c !== this.car && d2 > 250 * 250;
      if (far) {
        if (c.visual.root.visible && !c.hull.wrecked) c.visual.root.visible = false;
        continue;
      }
      if (!c.hull.wrecked && !c.hull.invulnerable) c.visual.root.visible = true;
      if (c.visual.root.visible) c.visual.update(alpha, dt);
    }
    this.particles.update(dt, this.chase.camera);
    this.tracers.update(dt, this.chase.camera);
    this.carQuat
      .set(
        prev.q.x + (curr.q.x - prev.q.x) * alpha,
        prev.q.y + (curr.q.y - prev.q.y) * alpha,
        prev.q.z + (curr.q.z - prev.q.z) * alpha,
        prev.q.w + (curr.q.w - prev.q.w) * alpha,
      )
      .normalize();
    this.viewCam.update({
      dt,
      carPos: this.carPos,
      carQuat: this.carQuat,
      carYaw: this.car.physics.yaw,
      physics: this.car.physics,
      steer: this.lastSteer,
      lookBack: this.input.lookBack,
      calm: !userSettings.cameraShake || userSettings.preset === 'low',
    });
    this.updateFirstPerson(dt);
    this.lighting.update(this.carPos);

    const p = this.car.physics;
    this.hud.update({
      speedKmh: Math.abs(p.forwardSpeed) * 3.6,
      nitroBars: p.nitro.bars,
      nitroActive: p.nitroActive,
      drifting: p.drifting,
      gear: this.engineSound.currentGear,
      mph: userSettings.speedUnit === 'mph',
    });
    this.raceHud.update({
      phase: this.race.phase,
      countdown: this.race.countdownValue,
      startLights: this.startLights && this.race.phase === 'countdown' ? this.startLights.lit : null,
      startLightsTotal: RACE.startLights.lamps,
      lap: this.race.laps.lap,
      totalLaps: this.cfg.laps,
      timeSec: this.race.timeSec,
      lapTimes: this.race.laps.lapTimes,
      bestLap: this.race.laps.bestLap,
      position: this.places.get('player') ?? 1,
      totalCars: this.cars.length,
    });
    const cd = this.race.countdownValue;
    if (cd !== this.lastCountdown) {
      if (cd !== null && !this.startLights) playCountdown(this.audio, cd);
      this.lastCountdown = cd;
    }
    // Underpass: the car's own height is below the trench threshold.
    if (!this.monteAudio && !this.ardennesAudio && !this.catLaiAudio)
      this.audio.setReverb(this.car.physics.curr.p.y < AUDIO.reverb.underRoadY ? 1 : 0);
    if (!this.paused)
      this.engineSound.update(dt, {
        forwardSpeed: p.forwardSpeed,
        topSpeedMps: this.car.def.topSpeedKmh / 3.6,
        throttle: this.race.controlsLocked ? 0 : this.lastControls.throttle,
        brake: this.race.controlsLocked ? 0 : this.lastControls.brake,
        slipDeg: p.slipDeg,
        drifting: p.drifting,
        nitroActive: p.nitroActive,
        airborne: p.airborne,
        countdown: this.race.phase === 'countdown',
      });
    this.banner.left -= dt;
    for (const f of this.feed) f.left -= dt;
    this.feed = this.feed.filter((f) => f.left > 0);
    this.combatHud.update({
      hullFraction: this.car.hull.fraction,
      hp: this.car.hull.hp,
      maxHp: this.car.hull.maxHp,
      heat: this.car.gun.heat,
      overheated: this.car.gun.locked,
      rockets: this.car.ammo.count,
      wrecked: this.car.hull.wrecked,
      respawnIn: this.car.hull.respawnIn,
      wreckedBy: this.car.hull.wrecked ? this.nameOf(this.car.hull.lastAttacker ?? '') : '',
      banner: this.banner.left > 0 ? this.banner.text : '',
      noFire: noFireZoneAt(this.trackDef.noFireZones, this.carTs.get('player') ?? 0)?.name ?? '',
      feed: this.feed.map((f) => f.text),
    });
    this.minimap.update(
      this.cars.map((c) => ({
        x: c.physics.curr.p.x,
        z: c.physics.curr.p.z,
        isPlayer: c.kind === 'player',
        wrecked: c.hull.wrecked,
      })),
      this.car.physics.yaw,
    );
    if (this.onlineTags) this.onlineTags.update(this.chase.camera, this.onlineTagList(), frameDt);
    if (this.netDebug) this.updateNetDebug(frameDt);
    else {
      this.nameTags.update(
        this.chase.camera,
        this.cars
          .filter((c) => c.kind !== 'player')
          .map((c) => ({
            id: c.id,
            name: this.nameOf(c.id),
            place: this.places.get(c.id) ?? 0,
            hullFraction: c.hull.fraction,
            world: { x: c.physics.curr.p.x, y: c.physics.curr.p.y + 2.6, z: c.physics.curr.p.z },
            visible: !c.hull.wrecked,
          })),
        120,
      );
    }
    this.fpvHud.update(frameDt, this.fpvBuild);
    this.skidmarks.update(dt, this.skidEmitters);
    this.emitTireSmoke(dt);
    this.speedLines.update(this.speedLineIntensity());
    this.updateResults(frameDt);
    this.updateFps(frameDt);
    this.postfx.render(dt);
    this.drawCalls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;
    this.dev?.end();
  }

  /** The rivals' name tags (online): anchor above the collider, the gun-lock target, and a wall test every 100 ms. */
  private onlineTagList(): OnlineTag[] {
    const now = performance.now();
    const cam = this.chase.camera.position;
    const me = this.car.physics.curr.p;
    const yaw = this.car.physics.yaw;
    const fwd = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    const rivals = this.cars.filter((c) => c.kind !== 'player' && !c.hull.wrecked);
    const cfg = WEAPONS.pulse_mg;
    const lock = userSettings.aimAssist
      ? pickAimTarget(
          { x: me.x, y: me.y + 0.8, z: me.z },
          fwd,
          rivals.map((c) => ({
            id: c.id,
            pos: { x: c.physics.curr.p.x, y: c.physics.curr.p.y + 0.8, z: c.physics.curr.p.z },
          })),
          cfg.autoAimConeDeg,
          cfg.rangeM,
        )
      : null;
    return rivals.map((c) => {
      const p = c.physics.curr.p;
      const col = c.def.collider;
      const world = {
        x: p.x,
        y: p.y + col.center[1] + col.halfExtents[1] + (c.def.vehicleType === 'bike' ? 0.35 : 0.45),
        z: p.z,
      };
      let seen = this.tagSeen.get(c.id);
      if (!seen || now - seen.at >= 100) {
        const dx = world.x - cam.x;
        const dy = world.y - cam.y;
        const dz = world.z - cam.z;
        const dist = Math.hypot(dx, dy, dz);
        // Static world only (walls, buildings, the road ribbon): other cars never hide a tag.
        const hit =
          dist > 2 &&
          this.world.castRay(
            new RAPIER.Ray(cam, { x: dx / dist, y: dy / dist, z: dz / dist }),
            dist - 1,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          );
        seen = { at: now, occluded: !!hit };
        this.tagSeen.set(c.id, seen);
      }
      return {
        id: c.id,
        name: this.nameOf(c.id),
        place: this.places.get(c.id) ?? 0,
        hullFraction: c.hull.fraction,
        targeted: lock?.id === c.id,
        occluded: seen.occluded,
        world,
      };
    });
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.postfx.setSize(innerWidth, innerHeight);
    this.chase.resize(innerWidth / innerHeight);
  }

  /** Disposes geometries, materials, textures and the Rapier world. */
  dispose(): void {
    if (this.online?.closeOnDispose) this.online.client.close();
    this.loop.stop();
    window.removeEventListener('resize', this.onResize);
    this.unbindSfx?.();
    this.catLaiAudio?.dispose(); // its loops stop on the bus, so before the context closes
    this.catLaiAudio = null;
    this.engineSound.dispose();
    this.audio.dispose();
    this.input.dispose();
    this.offView?.();
    this.viewToast.dispose();
    this.postfx.setOverlay(null, null);
    this.cockpit?.dispose();
    this.cockpit = null;
    this.hud.dispose();
    this.raceHud.dispose();
    this.combatHud.dispose();
    this.fpvHud.dispose();
    this.minimap.dispose();
    this.nameTags.dispose();
    this.onlineTags?.dispose();
    this.netDebug?.dispose();
    this.dev?.dispose();
    this.combat.dispose();
    this.particles.dispose();
    this.tracers.dispose();
    this.skidmarks.dispose();
    this.speedLines.dispose();
    for (const c of this.cars) c.dispose();
    this.sponsors?.dispose();
    this.dressing?.dispose();
    this.landmarks?.dispose();
    this.weather?.dispose();
    this.weather = null;
    this.monteAudio?.dispose();
    this.monteAudio = null;
    this.monte?.dispose();
    this.monte = null;
    this.ardennesAudio?.dispose();
    this.ardennesAudio = null;
    this.ardennes?.dispose();
    this.ardennes = null;
    if (this.pvd) for (const m of Object.values(this.pvd)) m.dispose();
    this.pvd = null;
    if (this.xaLo) for (const m of Object.values(this.xaLo)) m.dispose();
    this.xaLo = null;
    this.catLai?.dispose();
    this.catLai = null;
    this.track.dispose();
    this.env.dispose();
    this.lighting.dispose();
    this.postfx.dispose();
    this.world.free();
    this.offSettings?.();
    this.fpsEl?.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
