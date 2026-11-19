import { Assets } from './core/Assets';
import { CARS, TRACKS, getTrack } from './core/Data';
import { Game, type GameConfig } from './core/Game';
import { bestLapText, loadBestLap } from './core/Records';
import { applyMobileDefaults, loadSettings, updateSettings } from './core/Settings';
import { detectTouch, touchInput } from './core/TouchInput';
import { PICKUP_MODELS } from './combat/PickupVisuals';
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
import { TRACK_MODELS, TRACK_TEXTURES } from './world/Track';
import { CONG_HOA_MODELS, CONG_HOA_TEXTURES } from './world/trackAssets';
import { CAT_LAI_TEXTURES, XALO_TEXTURES } from './world/trackAssets';
import { CAT_LAI_QUAY_MODELS } from './world/CatLaiQuay';
import { CAT_LAI_YARD_MODELS } from './world/CatLaiYard';
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

type State = 'title' | 'carSelect' | 'raceSetup' | 'settings' | 'controls' | 'racing' | 'paused' | 'results';

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
        ...new Set([
          ...CAT_LAI_QUAY_MODELS,
          ...CAT_LAI_YARD_MODELS,
          ...XALO_DRESSING_MODELS,
          ...XALO_METRO_MODELS,
          ...XALO_STRUCTURE_MODELS,
          ...XALO_TRAFFIC_MODELS,
        ]),
        ...PICKUP_MODELS,
        ROCKET_MODEL,
      ],
      textures: [
        'textures/fx_nitro_flame.png',
        ...TRACK_TEXTURES,
        ...CONG_HOA_TEXTURES,
        ...XALO_TEXTURES,
        ...CAT_LAI_TEXTURES,
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
  let resultsShown = false;
  const createPreview = makeShowroomFactory(assets);
  const bestText = (trackId: string = setup.trackId): string => bestLapText(loadBestLap(trackId));

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
      onBack: () => show('title', title),
      onConfirm: (id) => {
        setup = { ...setup, carId: id };
        show('raceSetup', raceSetupScreen);
      },
    }),
  );
  const raceSetupScreen: RaceSetupScreen = reg(
    new RaceSetupScreen(screensRoot, {
      getCarId: () => setup.carId,
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

  function quitRace(next: 'title' | 'carSelect'): void {
    game?.dispose();
    game = null;
    stage.replaceChildren();
    resultsShown = false;
    title.setTrackName(getTrack(setup.trackId).name);
    title.refresh();
    show(next, next === 'title' ? title : carSelect);
  }

  async function startRace(s: RaceSetup, mode: GameConfig['mode'] = 'race'): Promise<void> {
    setup = s;
    for (const sc of all) sc.hide();
    state = 'racing';
    touchHud?.setActive(true);
    syncMusic('racing');
    resultsShown = false;
    // A fresh canvas per race: a disposed WebGL context can't be reused.
    const canvas = document.createElement('canvas');
    canvas.id = 'game';
    stage.replaceChildren(canvas);
    game = await Game.create(
      canvas,
      assets,
      { carId: s.carId, trackId: s.trackId, laps: s.laps, difficulty: s.difficulty, mode },
      {
        onPause: () => {
          if (state !== 'racing') return;
          game?.pause();
          pause.setSummary(game?.summaryText() ?? '');
          show('paused', pause);
        },
        onResults: (data) => {
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
