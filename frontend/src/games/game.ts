import type { ComponentType } from 'react';

import type { BuildingSerializedState } from 'gaesup-world/building';

import type { GameSession, SessionPlayer, Vec3 } from './protocol';

/**
 * What a game's components get, for the session as the server last showed it to this viewer. The functions keep their
 * identity while the game runs, so effects may depend on them.
 */
export type GameProps<View = unknown> = {
  /** The whole session: `players` (with each one's live-room `peer`), `host`, `you`, `phase`, `now`… */
  session: GameSession<View>;
  /** `session.game`: the game's view for this viewer, with only their own secrets. */
  view: View;
  /** The viewer as a player, or null when they only watch. */
  me: SessionPlayer | null;
  /** Sends `{"type":"Act","action"}` to the server; false while the game socket is down. */
  act: (action: unknown) => boolean;
  /** Listens for this game's events (`Ctx::emit*` on the server); returns the way to stop. */
  onEvent: (listener: (event: unknown) => void) => () => void;
  /** The server's clock now (ms), to count down to an absolute time in the view such as `endsAt`. */
  serverNow: () => number;
  /** Moves the viewer's own character to stand at a ground point, ending any click-to-move walk; false before it exists. */
  teleport: (ground: Vec3) => boolean;
};

export type GameResultProps<View = unknown, Result = unknown> = GameProps<View> & { result: Result };

/** What the host's page knows when it starts a game: the island it has loaded, where the host stands, and what they set. */
export type LayoutContext = {
  building: BuildingSerializedState;
  /** Open walkable spots on that island (`openSpots` in spots.ts), at most 200. */
  spots: () => Vec3[];
  /** The host's character, when it stands somewhere yet. */
  position: Vec3 | null;
  session: GameSession;
  /** What the host set in the lobby (`Lobby`); undefined when they set nothing or the game has no settings. */
  options: unknown;
};

/** What a game's lobby settings get: the host's choices so far (undefined until they choose), and how to change them. */
export type LobbyProps = {
  session: GameSession;
  options: unknown;
  setOptions: (options: unknown) => void;
};

/** One game on the client: its server `kind`, its name, and what it draws. */
export type GameDefinition<View = unknown, Result = unknown> = {
  /** The server's `Kind::kind`. */
  kind: string;
  /** Its name in the game list and the panel's heading. */
  label: string;
  /** As the server's `Kind` has them: the host's 시작 waits for `minPlayers`. */
  minPlayers: number;
  maxPlayers: number;
  /** The `layout` the host's 시작 sends, from the island as the host's page has it loaded. May throw to refuse. */
  layout: (context: LayoutContext) => unknown;
  /** The HUD and controls in the game panel while the game plays. */
  Panel: ComponentType<GameProps<View>>;
  /** Markers inside the island's canvas (React Three Fiber) while the game plays and after it ends. */
  World?: ComponentType<GameProps<View>>;
  /** The result in the game panel once the game has ended. */
  Result: ComponentType<GameResultProps<View, Result>>;
  /** The host's settings in the lobby, which `layout` gets as `options`. */
  Lobby?: ComponentType<LobbyProps>;
  /** Over the whole page while the game plays, whether the panel is open or folded (an alarm, a task's screen). */
  Overlay?: ComponentType<GameProps<View>>;
  /**
   * A key for something the player must answer in the panel (a meeting's vote): each new key brings the folded panel up
   * again, once; null when nothing waits.
   */
  attention?: (view: View) => string | null;
};

/** Checks a game's definition against its own view and result types, and lists it among the others. */
export function defineGame<View, Result>(game: GameDefinition<View, Result>): GameDefinition {
  return game as unknown as GameDefinition;
}
