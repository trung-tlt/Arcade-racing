import { getTrack } from '../core/Data';
import { LobbyClient, protocolVersionLabel, type EnterOptions, type HubError, type RoomView } from '../net/LobbyClient';
import { OnlineSession } from '../net/OnlineSession';
import type { OnlineRace } from '../net/OnlineRace';
import type { GridEntry, JoinMode } from '../shared/protocol';
import { OnlineRaceOverlay } from './onlineRaceOverlay';
import type { ResultsData } from './types';
import { OnlineHubScreen } from './screens/onlineHub';
import type { CarThumbs } from './carThumbs';
import { LobbyScreen } from './screens/lobby';
import { OnlineResultsScreen } from './screens/onlineResults';
import { OnlineNameScreen } from './screens/onlineName';
import { playerName, saveName, savedName, suggestedName } from './screens/onlineCommon';
import type { Screen } from './types';

export type OnlineScreenId = 'online' | 'oname' | 'lobby' | 'oresults';

export interface OnlineFlowDeps {
  screensRoot: HTMLElement;
  serverUrl: string;
  /** Show one of the online screens (the main menu stack hides the rest). */
  show(id: OnlineScreenId, screen: Screen): void;
  /** The car, map and laps picked offline: they seed a room this player creates. */
  getSetup(): { carId: string; trackId: string; laps: number };
  /** Build the race on the announced grid; resolves when it is running. */
  startRace(race: OnlineRace, track: string, laps: number): void;
  /** Tear the running race down (the server moved on to the results or the lobby). */
  stopRace(): void;
  /** Open the car picker from the lobby; `setCar` below is called with the choice. */
  changeCar(): void;
  /** Renders car pictures for the lobby (one offscreen GL context, released once every car is drawn). */
  createThumbs?: () => CarThumbs;
  onBackToTitle(): void;
  onOffline(): void;
}

const RETRY_SECONDS = 5;
const MAX_AUTO_RETRIES = 3;

/**
 * The online menu flow: hub -> lobby -> race -> results -> (rematch | lobby). It owns the connection (`LobbyClient`)
 * and the three screens; `main.ts` only supplies how to show a screen and how to build or tear down a race.
 */
export class OnlineFlow {
  readonly hub: OnlineHubScreen;
  readonly nameScreen: OnlineNameScreen;
  private readonly overlay = new OnlineRaceOverlay();
  readonly lobbyScreen: LobbyScreen;
  readonly results: OnlineResultsScreen;
  private thumbs: CarThumbs | null = null;
  private lobby: LobbyClient | null = null;
  private session: OnlineSession | null = null;
  private view: RoomView | null = null;
  /** Which screen the player is on, so a state message never yanks them somewhere else. */
  private at: 'hub' | 'lobby' | 'race' | 'results' = 'hub';
  private last: { mode: JoinMode; code?: string } | null = null;
  private retryTimer: number | null = null;
  private retries = 0;
  /** The room the connection was lost from: a join to that code that finds nothing means it closed. */
  private lostRoom: string | null = null;
  /** Bumped on every attempt and cancel: a slow earlier connection must not seat anyone after a newer one. */
  private attempt = 0;

  constructor(private readonly deps: OnlineFlowDeps) {
    const root = deps.screensRoot;
    this.hub = new OnlineHubScreen(root, {
      playerName,
      onQuick: () => void this.enter('quick'),
      onCreate: () => void this.enter('create'),
      onJoin: (code) => void this.enter('join', code),
      onEnterLobby: () => this.toLobby(),
      onCancel: () => this.cancel(),
      onRetry: () => this.retry(),
      onOffline: () => {
        this.cancel();
        deps.onOffline();
      },
      onReload: () => location.reload(),
      onEditName: () => this.editName(false),
      onBack: () => {
        this.cancel();
        deps.onBackToTitle();
      },
    });
    this.nameScreen = new OnlineNameScreen(root, {
      suggestion: () => savedName() ?? suggestedName(),
      onSave: (name) => {
        saveName(name);
        this.open(true);
      },
      onCancel: (first) => {
        // Skipping the first-time screen keeps the suggestion, so it is not asked again.
        if (first) saveName(suggestedName());
        this.open(true);
      },
    });
    this.lobbyScreen = new LobbyScreen(root, {
      onReady: (r) => this.lobby?.ready(r),
      onStart: () => this.lobby?.start(),
      onSettings: (t, l, b) => this.lobby?.settings(t, l, b),
      onChangeCar: () => deps.changeCar(),
      onLeave: () => this.leave(),
      thumb: (id) => (this.thumbs ??= deps.createThumbs?.() ?? null)?.get(id) ?? '',
    });
    this.results = new OnlineResultsScreen(root, {
      onRematch: () => this.lobby?.rematch('yes'),
      onLobby: () => this.lobby?.rematch('lobby'),
      onWithdraw: () => this.lobby?.rematch('none'),
      onLeave: () => this.leave(),
    });
  }

  /** The title screen's ONLINE entry: the first time with no saved name it asks for one. */
  open(skipName = false): void {
    if (!skipName && !savedName()) return this.editName(true);
    this.at = 'hub';
    this.hub.setState({ kind: 'idle' });
    this.deps.show('online', this.hub);
  }

  private editName(first: boolean): void {
    this.at = 'hub';
    this.nameScreen.open(first);
    this.deps.show('oname', this.nameScreen);
  }

  /** This player crossed the line: the "finished, waiting" layer (called about 4×/s with the standings). */
  finished(data: ResultsData): void {
    if (this.at === 'race') this.overlay.onFinished(data);
  }

  /** Back from the car picker. */
  returnToLobby(carId?: string): void {
    if (carId) this.lobby?.car(carId);
    this.at = 'lobby';
    this.deps.show('lobby', this.lobbyScreen);
    if (this.view) this.lobbyScreen.update(this.view);
  }

  /** The host's pause-menu Restart: the server reloads the race for everyone. */
  restartRace(): void {
    if (this.view?.isHost) this.lobby?.restart();
  }

  get isHost(): boolean {
    return !!this.view?.isHost;
  }

  /** True while a seat in a room is held (the pause menu's Quit must leave it). */
  get inRoom(): boolean {
    return this.lobby !== null;
  }

  /** Drop the seat without touching any screen (the pause menu's Quit goes to the title itself). */
  leaveQuiet(): void {
    this.attempt++;
    this.last = null;
    this.overlay.clear();
    this.lobby?.leave();
    this.lobby = null;
    this.view = null;
    this.session = null;
  }

  leave(): void {
    this.lobby?.leave();
    this.lobby = null;
    this.view = null;
    this.session = null;
    this.stopRace();
    this.open();
  }

  private async enter(mode: JoinMode, code?: string): Promise<void> {
    this.clearRetry();
    this.last = { mode, code };
    const mine = ++this.attempt;
    this.hub.setState({ kind: 'search', startedAt: performance.now() });
    const setup = this.deps.getSetup();
    const opts: EnterOptions = {
      name: playerName(),
      car: setup.carId,
      room: code,
      // A room you create starts on the map and laps picked offline; quick match joins whatever is open.
      track: mode === 'create' || mode === 'quick' ? setup.trackId : undefined,
      laps: mode === 'create' || mode === 'quick' ? setup.laps : undefined,
    };
    const r = await LobbyClient.enter(this.deps.serverUrl, mode, opts, {
      onView: (v) => this.onView(v),
      onGrid: (grid, track, laps) => this.onGrid(grid, track, laps),
      onSnapshot: (m) => this.session?.onSnapshot(m, performance.now() / 1000),
      onClosed: () => this.onClosed(),
    });
    // Cancelled while connecting: drop the seat that just opened.
    if (this.last === null || mine !== this.attempt) {
      if ('lobby' in r) r.lobby.leave();
      return;
    }
    if (!('lobby' in r)) {
      this.fail(r.err, code, r.serverV);
      return;
    }
    this.lobby = r.lobby;
    const v = r.lobby.view;
    if (mode === 'create') {
      this.toLobby();
    } else if (v) {
      const t = getTrack(v.track);
      this.hub.setState({ kind: 'found', code: v.code, racers: v.roster.length, trackName: t.name, laps: v.laps });
    }
  }

  private fail(err: HubError, code: string | undefined, serverV: number | undefined): void {
    if (err === 'notfound' && code && code === this.lostRoom) {
      this.lostRoom = null;
      this.hub.setState({ kind: 'closed', code });
      return;
    }
    this.hub.setState({
      kind: 'error',
      err,
      code,
      roomV: protocolVersionLabel(serverV),
      myV: protocolVersionLabel(undefined),
      retryIn: err === 'down' ? RETRY_SECONDS : undefined,
    });
    if (err === 'down' && this.retries < MAX_AUTO_RETRIES) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry(false);
    let left = RETRY_SECONDS;
    this.retryTimer = window.setInterval(() => {
      left--;
      if (left > 0) {
        this.hub.setState({ kind: 'error', err: 'down', retryIn: left });
        return;
      }
      this.clearRetry(false);
      this.retries++;
      this.retry();
    }, 1000);
  }

  private clearRetry(reset = true): void {
    if (this.retryTimer !== null) window.clearInterval(this.retryTimer);
    this.retryTimer = null;
    if (reset) this.retries = 0;
  }

  private retry(): void {
    const l = this.last;
    void this.enter(l?.mode ?? 'quick', l?.code);
  }

  private cancel(): void {
    this.clearRetry();
    this.last = null;
    this.attempt++;
    this.lobby?.leave();
    this.lobby = null;
    this.hub.setState({ kind: 'idle' });
  }

  private toLobby(): void {
    this.at = 'lobby';
    this.deps.show('lobby', this.lobbyScreen);
    if (this.view) this.lobbyScreen.update(this.view);
  }

  private stopRace(): void {
    this.overlay.clear();
    this.deps.stopRace();
  }

  private onView(v: RoomView): void {
    this.view = v;
    if (v.phase === 'lobby') {
      if (this.at === 'race' || this.at === 'results') {
        this.stopRace();
        this.at = 'lobby';
        this.deps.show('lobby', this.lobbyScreen);
      }
      if (this.at === 'lobby') this.lobbyScreen.update(v);
    } else if (v.phase === 'loading' || v.phase === 'countdown' || v.phase === 'racing') {
      this.overlay.onView(v);
    } else if (v.phase === 'results') {
      if (this.at !== 'results') {
        this.stopRace();
        this.at = 'results';
        this.deps.show('oresults', this.results);
      }
      this.results.update(v);
    }
  }

  private onGrid(grid: GridEntry[], track: string, laps: number): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const selfId = lobby.client.id;
    this.session = new OnlineSession(selfId);
    this.at = 'race';
    this.thumbs?.dispose(); // frees the picture renderer's GL context; rendered pictures stay cached
    this.overlay.startLoading(lobby.view, laps);
    this.deps.startRace({ client: lobby.client, session: this.session, selfId, grid }, track, laps);
  }

  private onClosed(): void {
    // The connection dropped while in a room: back to the hub, saying where the player was.
    const code = this.view?.code;
    const where = this.at === 'race' || this.at === 'results' ? this.at : 'lobby';
    this.lobby = null;
    this.view = null;
    this.session = null;
    this.stopRace();
    this.at = 'hub';
    this.deps.show('online', this.hub);
    if (code) {
      this.lostRoom = code;
      this.hub.setState({ kind: 'lost', code, where });
    } else {
      this.fail('down', undefined, undefined);
    }
  }

  dispose(): void {
    this.clearRetry();
    this.lobby?.leave();
    this.hub.dispose();
    this.nameScreen.dispose();
    this.overlay.dispose();
    this.lobbyScreen.dispose();
    this.thumbs?.dispose();
    this.results.dispose();
  }
}
