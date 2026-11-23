export type Difficulty = 'easy' | 'normal' | 'hard';

/** Everything the race needs from the menus. */
export interface RaceSetup {
  carId: string;
  /** Id of the map (data/tracks/<id>.json). */
  trackId: string;
  /** 1, 2, 3 or 5: each map offers 1, its own default (data `laps`), 3 and 5. */
  laps: number;
  difficulty: Difficulty;
}

/** A full-screen DOM overlay. `show` makes it visible and focusable; `dispose` removes it and its listeners. */
export interface Screen {
  readonly el: HTMLElement;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface ResultRow {
  pos: number;
  name: string;
  car: string;
  /** Formatted total time, or 'DNF' / 'RACING'. */
  total: string;
  best: string;
  takedowns: number;
  score: number;
  isPlayer: boolean;
  /** The lap this car is on (online "finished, waiting" panel). */
  lap?: number;
}

export interface ResultsData {
  subtitle: string;
  position: number;
  rows: ResultRow[];
  /** Formatted best lap of this race and whether it beat the saved record. */
  bestLap: string;
  newBest: boolean;
  takedowns: number;
  score: number;
  footnote: string;
}

/** A live 3D car on a stand, rendered into a container (menus use it for Title and Car select). */
export interface CarPreview {
  setCar(carId: string): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

export type PreviewFactory = (container: HTMLElement, carId: string) => CarPreview;
