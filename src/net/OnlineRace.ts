import type { GridEntry } from '../shared/protocol';
import type { NetClient } from './NetClient';
import type { OnlineSession } from './OnlineSession';

/** Everything `Game` needs to play an online race: the connection, the snapshot session and who is on the grid. */
export interface OnlineRace {
  client: NetClient;
  session: OnlineSession;
  /** This player's id on the server (`p1`...). */
  selfId: string;
  /** The grid announced by the server (humans and bots, with their grid slots). */
  grid: GridEntry[];
}
