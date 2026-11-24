import { Assets } from './core/Assets';
import { applyTrackRoster, rollRoster, type Rival } from './ai/Roster';
import { AI, ARDENNES, CARS, CAT_LAI, MONTE_CARLO, TRACKS, getTrack } from './core/Data';
import { Game, type GameConfig } from './core/Game';
import { NetClient } from './net/NetClient';
import { OnlineFlow } from './ui/onlineFlow';
import type { OnlineRace } from './net/OnlineRace';
import { OnlineSession } from './net/OnlineSession';
import { dataHash } from './shared/dataHash';
import { bestLapText, loadBestLap } from './core/Records';
import { applyMobileDefaults, loadSettings, updateSettings } from './core/Settings';
import { detectTouch, touchInput } from './core/TouchInput';
import { PICKUP_MODELS } from './combat/PickupVisuals';
import { COCKPIT_RIG } from './vehicle/CockpitView';
import { ROCKET_MODEL } from './combat/RocketPool';
import { CarSelectScreen } from './ui/screens/carSelect';
import { ControlsScreen } from './ui/screens/controls';
import { LoadingScreen } from './ui/screens/loading';
import { PauseScreen } from './ui/screens/pause';
import { RaceSetupScreen } from './ui/screens/raceSetup';
import { ResultsScreen } from './ui/screens/results';
import { SettingsScreen } from './ui/screens/settings';
import { TitleScreen } from './ui/screens/title';
import { makeThumbnailRenderer } from './ui/carThumbs';
import { makeShowroomFactory } from './ui/Showroom';
import { uiAudio } from './ui/uiAudio';
import type { RaceSetup, Screen } from './ui/types';
import { ARDENNES_MODELS, ARDENNES_TEXTURES } from './world/Ardennes';
import { MONTE_CARLO_MODELS, MONTE_CARLO_TEXTURES } from './world/MonteCarlo';
import { TRACK_MODELS, TRACK_TEXTURES } from './world/Track';
import { CONG_HOA_MODELS, CONG_HOA_TEXTURES } from './world/trackAssets';
import { PVD_MODELS, PVD_TEXTURES, XALO_TEXTURES } from './world/trackAssets';
import { CAT_LAI_MODELS, CAT_LAI_SHARED_MODELS, CAT_LAI_TEXTURES } from './world/CatLai';
import { PVD_DRESSING_MODELS } from './world/PvdDressing';
import { PVD_STRUCTURE_MODELS } from './world/PvdStructures';
import { PVD_TRAFFIC_MODELS } from './world/PvdTraffic';
import { SPONSOR_MODELS } from './world/Sponsors';
import { XALO_DRESSING_MODELS } from './world/XaLoDressing';
import { XALO_METRO_MODELS } from './world/XaLoMetro';
import { XALO_STRUCTURE_MODELS } from './world/XaLoStructures';
import { XALO_TRAFFIC_MODELS } from './world/XaLoTraffic';
import { installAutoFullscreen } from './ui/touch/fullscreen';
import { RotateScreen } from './ui/touch/rotate';
import { TouchHud } from './ui/touch/touchHud';
import './ui/styles.css';
import './ui/touch/touch.css';

const FX_TEXTURES = ['spark', 'smoke', 'explosion_4x4', 'glow', 'muzzle_flash', 'tracer', 'skidmark'].map(
  (n) => `textures/fx_${n}.png`,
);

type State =
  | 'title'
  | 'carSelect'
  | 'raceSetup'
  | 'settings'
  | 'controls'
  | 'racing'
  | 'paused'
  | 'results'
  | 'online'
  | 'oname'
  | 'lobby'
  | 'oresults';

const DEFAULT_SETUP: RaceSetup = { carId: CARS[0].id, trackId: TRACKS[0].id, laps: 3, difficulty: 'normal' };

async function boot(): Promise<void> {
  loadSettings();
  // Phones: touch controls, the rotate prompt, and Low-preset defaults on the very first run.
  const isTouch = detectTouch();
  touchInput.enabled = isTouch;
  document.body.classList.toggle('is-touch', isTouch);
  applyMobileDefaults(isTouch);
  if (isTouch) updateSettings({}); // re-derive the render scale with the phone's DPR cap
  // Menu sound + music: start fetching now, unlock on the very first key / click (browsers block audio before that).
  uiAudio.preload();
  uiAudio.installUnlock();
  const stage = document.getElementById('stage') as HTMLElement;
  const screensRoot = document.getElementById('screens') as HTMLElement;
  const params = new URLSearchParams(location.search);
  const quick = params.get('quick') === '1' || params.get('mode') === 'practice';
  const requestedCar = params.get('car');
  const requestedTrack = params.get('track');
  const trackId = TRACKS.some((t) => t.id === requestedTrack) ? (requestedTrack as string) : DEFAULT_SETUP.trackId;
  const carId = CARS.some((c) => c.id === requestedCar) ? (requestedCar as string) : DEFAULT_SETUP.carId;

  const loading = new LoadingScreen(screensRoot);
  const assets = await Assets.load(
    {
      models: [
        ...CARS.map((c) => c.file),
        ...TRACK_MODELS,
        ...CONG_HOA_MODELS,
        ...PVD_MODELS,
        ...new Set([
          ...SPONSOR_MODELS,
          ...PVD_DRESSING_MODELS,
          ...PVD_STRUCTURE_MODELS,
          ...PVD_TRAFFIC_MODELS,
          ...XALO_DRESSING_MODELS,
          ...XALO_METRO_MODELS,
          ...XALO_STRUCTURE_MODELS,
          ...XALO_TRAFFIC_MODELS,
        ]),
        ...PICKUP_MODELS,
        COCKPIT_RIG,
        ROCKET_MODEL,
      ],
      textures: [
        'textures/fx_nitro_flame.png',
        ...TRACK_TEXTURES,
        ...CONG_HOA_TEXTURES,
        ...XALO_TEXTURES,
        ...PVD_TEXTURES,
        ...FX_TEXTURES,
      ],
    },
    (f) => loading.setProgress(f),
  );

  if (isTouch) installAutoFullscreen();
  const rotate = new RotateScreen(document.body);
  const touchHud = isTouch ? new TouchHud(document.body, touchInput) : null;
  if (isTouch) {
    // Turning the phone upright mid-race pauses it behind the rotate prompt.
    window.matchMedia('(orientation: portrait)').addEventListener('change', (e) => {
      if (e.matches && state === 'racing') touchInput.edge('pause');
    });
  }
  void rotate;

  let state: State = 'title';
  let returnTo: State = 'title';
  let setup: RaceSetup = { ...DEFAULT_SETUP, carId, trackId };
  let game: Game | null = null;
  // The five rivals (random names and cars) are rolled when the player confirms a car, so the setup grid shows
  // exactly who they will race. Starting with a different car re-rolls.
  let roster: Rival[] = [];
  let rosterCar = '';
  const rollFor = (carId: string): Rival[] => {
    roster = rollRoster(
      AI.rivals,
      AI.rosterNames,
      CARS.map((c) => c.id),
      carId,
    );
    rosterCar = carId;
    return roster;
  };
  // Dev/e2e only: `?roster=data` keeps the authored rivals (fixed cars), so finish tests don't depend on the dice.
  const fixedRoster = import.meta.env.DEV && params.get('roster') === 'data';
  const rosterFor = (carId: string): Rival[] =>
    fixedRoster ? AI.rivals : rosterCar === carId ? roster : rollFor(carId);
  let resultsShown = false;
  const createPreview = makeShowroomFactory(assets);
  const bestText = (trackId: string = setup.trackId): string => bestLapText(loadBestLap(trackId));

  /** Where the car picker returns to: the race setup, or the online lobby (changing car in a room). */
  let carSelectFor: 'race' | 'lobby' = 'race';
  const all: Screen[] = [];
  const reg = <T extends Screen>(s: T): T => {
    all.push(s);
    return s;
  };
  /** Menu music plays on every menu screen (40% on Pause and the screens opened from it) and stops for the race. */
  const syncMusic = (next: State): void => {
    if (next === 'racing') {
      uiAudio.stopMusic(0.6); // (a start_race sound has already begun a longer fade)
      uiAudio.duckMusic(false);
      return;
    }
    uiAudio.duckMusic(next === 'paused' || ((next === 'settings' || next === 'controls') && returnTo === 'paused'));
    uiAudio.startMusic();
  };
  const show = (next: State, screen: Screen | null): void => {
    for (const s of all) s.hide();
    state = next;
    touchHud?.setActive(next === 'racing');
    syncMusic(next);
    screen?.show();
  };

  const title: TitleScreen = reg(
    new TitleScreen(screensRoot, {
      createPreview,
      bestLapText: bestText,
      onRace: () => show('carSelect', carSelect),
      onOnline: () => online.open(),
      onGarage: () => show('carSelect', carSelect),
      onSettings: () => {
        returnTo = 'title';
        show('settings', settingsMenu);
      },
      onControls: () => {
        returnTo = 'title';
        show('controls', controlsMenu);
      },
    }),
  );
  const carSelect: CarSelectScreen = reg(
    new CarSelectScreen(screensRoot, {
      createPreview,
      createThumbs: () => makeThumbnailRenderer(assets),
      initialCarId: setup.carId,
      onBack: () => (carSelectFor === 'lobby' ? backToLobby() : show('title', title)),
      onConfirm: (id) => {
        setup = { ...setup, carId: id };
        if (carSelectFor === 'lobby') return backToLobby(id);
        rollFor(id);
        show('raceSetup', raceSetupScreen);
      },
    }),
  );
  const raceSetupScreen: RaceSetupScreen = reg(
    new RaceSetupScreen(screensRoot, {
      getCarId: () => setup.carId,
      getRoster: (trackId) => applyTrackRoster(rosterFor(setup.carId), trackId, AI.trackRosters),
      bestLapText: (id: string) => bestText(id),
      onBack: () => show('carSelect', carSelect),
      onStart: (s) => void startRace({ ...s, carId: setup.carId }),
    }),
  );
  const backToReturn = (): void => {
    if (returnTo === 'paused') show('paused', pause);
    else show('title', title);
  };
  const settingsMenu: SettingsScreen = reg(new SettingsScreen(screensRoot, { onBack: backToReturn }));
  const controlsMenu: ControlsScreen = reg(new ControlsScreen(screensRoot, { onBack: backToReturn }));

  const pause: PauseScreen = reg(
    new PauseScreen(screensRoot, {
      onResume: () => {
        show('racing', null);
        game?.resume();
      },
      onRestart: () => {
        show('racing', null);
        resultsShown = false;
        game?.restart();
      },
      onSettings: () => {
        returnTo = 'paused';
        show('settings', settingsMenu);
      },
      onControls: () => {
        returnTo = 'paused';
        show('controls', controlsMenu);
      },
      onQuit: () => quitRace('title'),
    }),
  );
  const results: ResultsScreen = reg(
    new ResultsScreen(screensRoot, {
      onRaceAgain: () => {
        show('racing', null);
        resultsShown = false;
        game?.restart();
      },
      onChangeCar: () => quitRace('carSelect'),
      onMainMenu: () => quitRace('title'),
    }),
  );

  /** The race server: `?server=ws://host:port` for testing, else the build's `VITE_RACE_SERVER`, else a local one. */
  const serverUrl =
    params.get('server') ??
    (import.meta.env.VITE_RACE_SERVER as string | undefined) ??
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`;
  const online: OnlineFlow = new OnlineFlow({
    screensRoot,
    serverUrl,
    createThumbs: () => makeThumbnailRenderer(assets),
    show: (id, screen) => show(id, screen),
    getSetup: () => setup,
    startRace: (race, track, laps) => {
      const mine = race.grid.find((g) => g.id === race.selfId);
      const rivals: Rival[] = race.grid
        .filter((g) => g.id !== race.selfId)
        .map((g) => ({ id: g.id, name: g.name, car: g.car, laneOffsetM: 0, skill: 0.9 }));
      game?.dispose();
      game = null;
      void startRace({ ...setup, carId: mine?.car ?? setup.carId, trackId: track, laps }, 'race', {
        online: race,
        rivals,
      });
    },
    stopRace: () => {
      game?.dispose();
      game = null;
      stage.replaceChildren();
      resultsShown = false;
    },
    changeCar: () => {
      carSelectFor = 'lobby';
      show('carSelect', carSelect);
    },
    onBackToTitle: () => show('title', title),
    onOffline: () => show('carSelect', carSelect),
  });
  reg(online.hub);
  reg(online.nameScreen);
  reg(online.lobbyScreen);
  reg(online.results);
  const backToLobby = (carId?: string): void => {
    carSelectFor = 'race';
    online.returnToLobby(carId);
  };

  function quitRace(next: 'title' | 'carSelect'): void {
    online.leaveQuiet(); // an online race: give the seat up
    game?.dispose();
    game = null;
    stage.replaceChildren();
    resultsShown = false;
    uiAudio.setMusicForTrack(null);
    title.setTrackName(getTrack(setup.trackId).name);
    title.refresh();
    show(next, next === 'title' ? title : carSelect);
  }

  /** `?online=ws://host:port&room=ABC&name=Linh&car=kestrel_gt&track=cat_lai&laps=1&start=2` */
  async function runOnline(url: string): Promise<void> {
    const room = params.get('room') ?? 'DEV';
    const name = params.get('name') ?? 'Player';
    const laps = Math.max(1, Number(params.get('laps') ?? 1));
    const startAt = Number(params.get('start') ?? 0);
    const client = new NetClient(url);
    let session: OnlineSession | null = null;
    let launched = false;
    let started = false;
    let selfId = '';
    const rejected = new Promise<never>((_, reject) => {
      client.events.onReject = (reason) => reject(new Error(`server refused the join: ${reason}`));
    });
    const welcomed = new Promise<{ id: string; track: string }>((resolve) => {
      client.events.onWelcome = (m) => resolve({ id: m.id, track: m.track });
    });
    client.events.onSnapshot = (m) => session?.onSnapshot(m, performance.now() / 1000);
    client.events.onState = (m) => {
      // Dev convenience: the host starts the race once enough players are in.
      const me = m.roster.find((r) => r.id === selfId);
      if (m.phase === 'lobby' && startAt > 0 && me?.host && m.roster.length >= startAt && !started) {
        started = true;
        client.start();
      }
      if (m.phase === 'loading' && m.grid && session && !launched) {
        launched = true;
        const rivals: Rival[] = m.grid
          .filter((g) => g.id !== selfId)
          .map((g) => ({ id: g.id, name: g.name, car: g.car, laneOffsetM: 0, skill: 0.9 }));
        void startRace({ ...setup, carId, trackId: m.track, laps: m.laps }, 'race', {
          online: { client, session, selfId, grid: m.grid, closeOnDispose: true },
          rivals,
        });
      }
    };
    await client.connect();
    client.join(name, carId, room, dataHash(), requestedTrack ?? undefined, laps);
    const w = await Promise.race([welcomed, rejected]);
    selfId = w.id;
    session = new OnlineSession(w.id);
    client.id = w.id;
  }

  async function startRace(
    s: RaceSetup,
    mode: GameConfig['mode'] = 'race',
    extra?: { online: OnlineRace; rivals: Rival[] },
  ): Promise<void> {
    setup = s;
    for (const sc of all) sc.hide();
    state = 'racing';
    touchHud?.setActive(true);
    syncMusic('racing');
    resultsShown = false;
    // Map 1's props (cranes, ships, ~60 houses and trucks, the yard) are fetched the first time it is raced.
    if (s.trackId === CAT_LAI.id) {
      await assets.extend({ models: [...CAT_LAI_MODELS, ...CAT_LAI_SHARED_MODELS], textures: CAT_LAI_TEXTURES });
    }
    // Map 5's props are not in the boot download: fetch them (3 MB) the first time that map is raced.
    if (s.trackId === MONTE_CARLO.id) {
      await assets.extend({ models: MONTE_CARLO_MODELS, textures: MONTE_CARLO_TEXTURES });
    }
    // Map 6's props are not in the boot download either (~5 MB): fetched the first time that map is raced.
    if (s.trackId === ARDENNES.id) {
      await assets.extend({ models: ARDENNES_MODELS, textures: ARDENNES_TEXTURES });
    }
    // A fresh canvas per race: a disposed WebGL context can't be reused.
    const canvas = document.createElement('canvas');
    canvas.id = 'game';
    stage.replaceChildren(canvas);
    game = await Game.create(
      canvas,
      assets,
      {
        carId: s.carId,
        trackId: s.trackId,
        laps: s.laps,
        difficulty: s.difficulty,
        mode,
        rivals: extra?.rivals ?? rosterFor(s.carId),
        online: extra?.online,
      },
      {
        onPause: () => {
          if (state !== 'racing') return;
          game?.pause();
          pause.setSummary(game?.summaryText() ?? '');
          show('paused', pause);
        },
        onResults: (data) => {
          // Online, the server's results (all racers, rematch vote) replace the single-player summary.
          if (extra?.online) {
            online.finished(data);
            return;
          }
          if (state !== 'racing' && state !== 'results') return;
          if (!resultsShown) {
            resultsShown = true;
            show('results', results);
          }
          results.update(data);
        },
      },
    );
    touchHud?.bindEvents(game.events);
    game.start();
    // Online: the race is built, tell the server so the countdown can begin.
    extra?.online.client.ready(true);
    if (import.meta.env.DEV) {
      (window as unknown as { __voltline: Game }).__voltline = game;
    }
  }

  if (import.meta.env.DEV) {
    // Used by e2e tests: tear down and rebuild a race N times.
    (window as unknown as { __voltlineApp: unknown }).__voltlineApp = {
      state: (): State => state,
      /** Tear down and start a fresh practice/race with another vehicle. */
      start: async (id: string, mode: GameConfig['mode'] = 'practice'): Promise<void> => {
        game?.dispose();
        game = null;
        stage.replaceChildren();
        await startRace({ ...setup, carId: id }, mode);
      },
      cycle: async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          game?.dispose();
          game = null;
          stage.replaceChildren();
          await startRace(setup);
        }
      },
    };
  }

  const onlineUrl = params.get('online');
  if (onlineUrl) {
    // Dev/internal build: join a room on the race server by URL (the lobby UI comes later).
    loading.hide();
    await runOnline(onlineUrl);
    return;
  }
  if (quick) {
    loading.hide();
    await startRace({ ...setup }, params.get('mode') === 'practice' ? 'practice' : 'race');
    return;
  }
  loading.ready(() => {
    loading.hide();
    // Next task: the key that dismissed the prompt must not also press the Title's focused RACE button.
    title.setTrackName(getTrack(setup.trackId).name);
    uiAudio.unlock(); // the key that dismissed the prompt is the first input
    uiAudio.play('title_enter'); // the sting, then (per its `then`) the menu music
    setTimeout(() => show('title', title), 120);
  });
}

boot().catch((e: unknown) => {
  console.error(e);
  document.body.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
