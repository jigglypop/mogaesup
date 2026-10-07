import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';

import { Link } from 'react-router-dom';

import {
  defaultMultiplayerConfig,
  RemotePlayers,
  useMultiplayer,
  useUIConfigStore,
  type MultiplayerConfig,
  type PlayerState,
} from 'gaesup-world';

import { authApi } from '../api/endpoints';
import type { User } from '../api/types';
import { requestSessionCheck } from '../auth/sessionWork';
import { useSignInPath } from '../auth/signIn';
import { useHiddenPeers, withoutPeers } from '../games/hiddenPeers';
import { useRoomQuiet } from '../games/quiet';
import { noSeat } from '../games/useGameSession';
import { Icon } from '../ui/icons';
import { BalloonLayer } from './balloons/BalloonLayer';
import { NAME_TAG_HEIGHT } from './balloons/board';
import { balloonOf, balloonTtl, readableInk, roomColor } from './balloons/designs';
import { MINIME_SCALE } from './character';
import { peerColor } from './peers';

type Multiplayer = ReturnType<typeof useMultiplayer>;

const MAX_CHAT = 200;
const CHECK_MS = 1_000;
/** A connect() this recent may not have rendered as `connecting` yet. */
const SETTLE_MS = 2_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_LAST_MS = 30_000;

/**
 * Tickets are single use, and the library's own reconnect would offer the spent one again, so it is off: the room
 * reconnects itself with a fresh ticket. Visitors stand as large as the player, names just above their heads.
 */
const CONFIG: MultiplayerConfig = {
  ...defaultMultiplayerConfig,
  logToConsole: false,
  websocket: { ...defaultMultiplayerConfig.websocket, url: '', reconnectAttempts: 0 },
  rendering: {
    ...defaultMultiplayerConfig.rendering,
    characterScale: MINIME_SCALE,
    nameTagHeight: NAME_TAG_HEIGHT,
    materialPolicy: 'figure',
    tintCharacter: false,
  },
};

const roomUrl = (username: string, ticket: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${encodeURIComponent(username)}?ticket=${encodeURIComponent(ticket)}`;

/**
 * The socket the engine opens while `open` runs, caught as it is made: the engine keeps a close's code and reason to
 * itself, and the page says why the room had no seat. Null when none was made.
 */
function openedSocket(open: () => void): WebSocket | null {
  const Native = globalThis.WebSocket;
  if (typeof Native !== 'function') {
    open();
    return null;
  }
  const caught: { socket: WebSocket | null } = { socket: null };
  class Watched extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      caught.socket = this;
    }
  }
  globalThis.WebSocket = Watched;
  try {
    open();
  } finally {
    globalThis.WebSocket = Native;
  }
  return caught.socket;
}

/**
 * The home's live room: signed-in people on the same minihome see each other walk and talk. Once a second it checks
 * the connection; when it is down it asks the server for a new ticket and connects again, waiting longer after each
 * failed try, up to half a minute, and half a minute after the room had no seat (`refused` says why until it has one).
 * The viewer joins in their balloon's colour (their own colour for the default one), which tells everyone how to draw
 * what they say; another balloon joins again in its colour.
 */
function useLiveRoom(options: {
  username: string;
  viewer: User | null;
  /** The balloon the viewer talks in (`HomeProfile.balloon`); the default when not given. */
  viewerBalloon?: string;
  characterUrl: string;
  playerRef: RefObject<RapierRigidBody>;
  visualRotationRef: RefObject<Group>;
}): Multiplayer & { refused: string | null } {
  const { username, viewer, viewerBalloon, characterUrl, playerRef, visualRotationRef } = options;
  const live = useMultiplayer({
    config: CONFIG,
    characterUrl: new URL(characterUrl, location.origin).href,
    rigidBodyRef: playerRef,
    visualRotationRef,
  });
  const liveRef = useRef(live);
  liveRef.current = live;
  const [refused, setRefused] = useState<string | null>(null);
  const viewerId = viewer?.id;
  const viewerName = viewer?.displayName;
  const viewerColor = viewerId && roomColor(viewerBalloon, viewerId);

  useEffect(() => {
    if (!viewerId || !viewerName || !viewerColor) return undefined;
    let stopped = false;
    let busy = false;
    let delay = RETRY_FIRST_MS;
    let nextAt = 0;
    let triedAt = 0;
    const check = async () => {
      const status = liveRef.current.connectionStatus;
      if (status === 'connected') {
        delay = RETRY_FIRST_MS;
        setRefused(null);
      }
      const down = status === 'disconnected' || status === 'error';
      const now = Date.now();
      if (stopped || busy || !down || now < nextAt || now - triedAt < SETTLE_MS) return;
      busy = true;
      try {
        const { ticket, user } = await authApi.realtimeTicket();
        if (stopped) return;
        // The cookie is someone else's now (another tab signed in): the page finds out who, and joins as them.
        if (user.id !== viewerId) {
          requestSessionCheck();
          return;
        }
        liveRef.current.updateConfig({ websocket: { ...CONFIG.websocket, url: roomUrl(username, ticket) } });
        const socket = openedSocket(() =>
          liveRef.current.connect({ roomId: username, playerName: viewerName, playerColor: viewerColor }),
        );
        socket?.addEventListener('close', (event) => {
          const why = noSeat(event);
          if (stopped || !why) return;
          setRefused(why);
          // No seat: not again for a while (each try takes a ticket).
          delay = RETRY_LAST_MS;
          nextAt = Date.now() + RETRY_LAST_MS;
        });
        triedAt = Date.now();
      } catch {
        // Signed out or rate limited; the next try waits longer.
      } finally {
        busy = false;
        nextAt = Math.max(nextAt, Date.now() + delay);
        delay = Math.min(delay * 2, RETRY_LAST_MS);
      }
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      liveRef.current.disconnect();
    };
  }, [username, viewerId, viewerName, viewerColor]);

  return useMemo(() => ({ ...live, refused }), [live, refused]);
}

/**
 * What the room's screens read: who is here, what they say, the way to talk, why the room had no seat, and the balloon
 * the viewer talks in.
 */
type Live = Pick<
  Multiplayer,
  'isConnected' | 'localPlayerId' | 'players' | 'speechByPlayerId' | 'localSpeechText' | 'sendChat'
> & { refused: string | null; balloon: string };
const LiveContext = createContext<Live | null>(null);

/** Opens the live room for everything below it; render it under `GaesupWorld`, whose runtime the tracking reads. */
export function LiveRoom({ children, ...options }: Parameters<typeof useLiveRoom>[0] & { children: ReactNode }) {
  useEngineBalloonsOff();
  const { isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat, refused } = useLiveRoom(options);
  const balloon = balloonOf(options.viewerBalloon);
  // The room answers a new object on every update, a visitor's moves (several a second) and pings included, and every
  // reader of this context re-renders with its value, the island's canvas too (R3F bridges contexts into it). Moves reach
  // the avatars through `players` itself; the value changes only when one of these does.
  const live = useMemo(
    () => ({ isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat, refused, balloon }),
    [isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat, refused, balloon],
  );
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/**
 * The page draws the balloons (BalloonLayer); the engine's own (a canvas sprite of one shrinking line) stay off while
 * the room is open, should anything still hand it words.
 */
function useEngineBalloonsOff() {
  useEffect(() => {
    const config = useUIConfigStore.getState();
    const enabled = config.config.speechBalloon.enabled;
    config.updateSpeechBalloonConfig({ enabled: false });
    return () => useUIConfigStore.getState().updateSpeechBalloonConfig({ enabled });
  }, []);
}

/** The room as its screens read it (`players` keeps each avatar's latest state between renders); null outside one. */
export const useLive = () => useContext(LiveContext);

/** The viewer's own place in the room: whether it is connected, and the `client_id` the room gave this page. */
export function useLiveSelf(): { connected: boolean; peer: string | null } {
  const live = useLive();
  return { connected: !!live?.isConnected, peer: live?.localPlayerId ?? null };
}

/**
 * Everyone else in the room by `client_id` (a game player's `peer`), each with the state they last sent; null outside
 * the room. Entries change in place as people move, without a render: read positions when they are needed (in a frame).
 */
export function useLivePlayers(): ReadonlyMap<string, PlayerState> | null {
  return useLive()?.players ?? null;
}

/**
 * Everyone else in the room, each in their own 미니미, but those a game hides, and what everyone says (the viewer too)
 * in their own balloon; mount inside the world's physics.
 */
export function LiveAvatars({ playerRef }: { playerRef: RefObject<RapierRigidBody> }) {
  const live = useLive();
  const hidden = useHiddenPeers();
  const everyone = live?.players;
  const players = useMemo(() => everyone && withoutPeers(everyone, hidden), [everyone, hidden]);
  if (!live || !everyone || !players) return null;
  return (
    <>
      <RemotePlayers players={players} config={CONFIG} playerRef={playerRef} />
      <BalloonLayer
        speech={live.speechByPlayerId}
        ownKey={live.localPlayerId}
        ownDesign={live.balloon}
        players={everyone}
        hidden={hidden}
        playerRef={playerRef}
      />
    </>
  );
}

/** How many are on the island now, counting the viewer, and who the others are; empty until the room connects. */
export function usePresence() {
  const live = useLive();
  if (!live?.isConnected) return { connected: false, count: 0, others: [] as { id: string; name: string; color: string }[] };
  const others = [...live.players.entries()].map(([id, player]) => ({ id, name: player.name, color: peerColor(player.color) }));
  return { connected: true, count: others.length + 1, others };
}

/**
 * Who is here with you, and a line to say to whoever stands near; signed out, the way in (and back to this island).
 * `onOwnerLine` hears each line the island's owner says (their pet takes commands from it).
 */
export function ChatBar({ signedIn, onOwnerLine }: { signedIn: boolean; onOwnerLine?: ((line: string) => void) | undefined }) {
  const live = useLive();
  const signIn = useSignInPath();
  const [text, setText] = useState('');
  // A game that keeps its players quiet in the room now (임포스터 between meetings): nothing to send.
  const quiet = useRoomQuiet();
  if (!signedIn) {
    return (
      <Link className="mg-btn is-primary mg-chatbar-signin" to={signIn}>
        로그인
      </Link>
    );
  }
  if (!live?.isConnected) {
    return (
      <div className="mg-chatbar mg-glass is-hint" role="status">
        <span>{live?.refused ?? '함께 있는 사람을 찾는 중…'}</span>
      </div>
    );
  }
  const send = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim().slice(0, MAX_CHAT);
    if (!line || quiet) return;
    // Up over the viewer as long as it stays over them for the others.
    live.sendChat(line, { ttlMs: balloonTtl(line) });
    onOwnerLine?.(line);
    setText('');
  };
  const others = [...live.players.values()];
  return (
    <form className="mg-chatbar mg-glass" onSubmit={send}>
      <span className="mg-chatbar-people" aria-hidden="true">
        {others.slice(0, 3).map((player, index) => {
          const color = peerColor(player.color);
          return (
            <i key={index} style={{ background: color, color: readableInk(color) }}>
              {[...player.name][0] ?? '?'}
            </i>
          );
        })}
      </span>
      <b className="mg-chatbar-count">함께 {others.length + 1}명</b>
      {live.localSpeechText && <span className="mg-chip is-soft mg-chatbar-said">{live.localSpeechText}</span>}
      <input
        value={text}
        maxLength={MAX_CHAT}
        placeholder="말하기"
        aria-label="말하기"
        enterKeyHint="send"
        autoComplete="off"
        disabled={quiet}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <button className="mg-chatbar-send" type="submit" aria-label="말 보내기" disabled={quiet || !text.trim()}>
        <Icon name="send" />
      </button>
    </form>
  );
}
