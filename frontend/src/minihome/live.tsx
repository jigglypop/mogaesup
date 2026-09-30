import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { Link } from 'react-router-dom';

import { defaultMultiplayerConfig, RemotePlayers, useMultiplayer, type MultiplayerConfig } from 'gaesup-world';

import { authApi } from '../api/endpoints';
import type { User } from '../api/types';
import { Icon } from '../ui/icons';
import { MINIME_SCALE } from './character';

type Multiplayer = ReturnType<typeof useMultiplayer>;

const COLORS = ['#ff7a59', '#8b6cf0', '#2bb3a3', '#e89b16', '#5a8acf', '#e5534b'];
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
  rendering: { ...defaultMultiplayerConfig.rendering, characterScale: MINIME_SCALE, nameTagHeight: 1.7 * MINIME_SCALE + 0.4 },
};

const roomUrl = (username: string, ticket: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${encodeURIComponent(username)}?ticket=${encodeURIComponent(ticket)}`;

const colorOf = (id: string) => COLORS[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLORS.length]!;

/**
 * The home's live room: signed-in people on the same minihome see each other walk and talk. Once a second it checks
 * the connection; when it is down it asks the server for a new ticket and connects again, waiting longer after each
 * failed try, up to half a minute.
 */
function useLiveRoom(options: {
  username: string;
  viewer: User | null;
  characterUrl: string;
  playerRef: RefObject<RapierRigidBody>;
}): Multiplayer {
  const { username, viewer, characterUrl, playerRef } = options;
  const live = useMultiplayer({
    config: CONFIG,
    characterUrl: new URL(characterUrl, location.origin).href,
    rigidBodyRef: playerRef,
  });
  const liveRef = useRef(live);
  liveRef.current = live;
  const viewerId = viewer?.id;
  const viewerName = viewer?.displayName;

  useEffect(() => {
    if (!viewerId || !viewerName) return undefined;
    let stopped = false;
    let busy = false;
    let delay = RETRY_FIRST_MS;
    let nextAt = 0;
    let triedAt = 0;
    const check = async () => {
      const status = liveRef.current.connectionStatus;
      if (status === 'connected') delay = RETRY_FIRST_MS;
      const down = status === 'disconnected' || status === 'error';
      const now = Date.now();
      if (stopped || busy || !down || now < nextAt || now - triedAt < SETTLE_MS) return;
      busy = true;
      try {
        const { ticket } = await authApi.realtimeTicket();
        if (stopped) return;
        liveRef.current.updateConfig({ websocket: { ...CONFIG.websocket, url: roomUrl(username, ticket) } });
        liveRef.current.connect({ roomId: username, playerName: viewerName, playerColor: colorOf(viewerId) });
        triedAt = Date.now();
      } catch {
        // Signed out or rate limited; the next try waits longer.
      } finally {
        busy = false;
        nextAt = Date.now() + delay;
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
  }, [username, viewerId, viewerName]);

  return live;
}

const LiveContext = createContext<Multiplayer | null>(null);

/** Opens the live room for everything below it; render it under `GaesupWorld`, whose runtime the tracking reads. */
export function LiveRoom({ children, ...options }: Parameters<typeof useLiveRoom>[0] & { children: ReactNode }) {
  const live = useLiveRoom(options);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

const useLive = () => useContext(LiveContext);

/** Everyone else in the room, each in their own 미니미; mount inside the world's physics. */
export function LiveAvatars({ playerRef }: { playerRef: RefObject<RapierRigidBody> }) {
  const live = useLive();
  if (!live) return null;
  return (
    <RemotePlayers players={live.players} config={CONFIG} playerRef={playerRef} speechByPlayerId={live.speechByPlayerId} />
  );
}

/** How many are on the island now, counting the viewer, and who the others are; empty until the room connects. */
export function usePresence() {
  const live = useLive();
  if (!live?.isConnected) return { connected: false, count: 0, others: [] as { id: string; name: string; color: string }[] };
  const others = [...live.players.entries()].map(([id, player]) => ({ id, name: player.name, color: player.color }));
  return { connected: true, count: others.length + 1, others };
}

/** Who is here with you, and a line to say to whoever stands near. */
export function ChatBar({ signedIn }: { signedIn: boolean }) {
  const live = useLive();
  const [text, setText] = useState('');
  if (!signedIn) {
    return (
      <div className="mg-chatbar mg-glass is-hint">
        <span>로그인하면 같이 걷고 말할 수 있어요</span>
        <Link className="mg-btn is-primary is-small" to="/">
          로그인
        </Link>
      </div>
    );
  }
  if (!live?.isConnected) {
    return (
      <div className="mg-chatbar mg-glass is-hint" role="status">
        <span>함께 있는 사람을 찾는 중…</span>
      </div>
    );
  }
  const send = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    if (!line) return;
    live.sendChat(line.slice(0, MAX_CHAT));
    setText('');
  };
  const others = [...live.players.values()];
  return (
    <form className="mg-chatbar mg-glass" onSubmit={send}>
      <span className="mg-chatbar-people" aria-hidden="true">
        {others.slice(0, 3).map((player, index) => (
          <i key={index} style={{ background: player.color }}>
            {[...player.name][0] ?? '?'}
          </i>
        ))}
      </span>
      <b className="mg-chatbar-count">함께 {others.length + 1}명</b>
      {live.localSpeechText && <span className="mg-chip is-soft mg-chatbar-said">{live.localSpeechText}</span>}
      <input
        value={text}
        maxLength={MAX_CHAT}
        placeholder="근처에 있는 사람에게 말하기"
        aria-label="말하기"
        enterKeyHint="send"
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <button className="mg-chatbar-send" type="submit" aria-label="말 보내기" disabled={!text.trim()}>
        <Icon name="send" />
      </button>
    </form>
  );
}
