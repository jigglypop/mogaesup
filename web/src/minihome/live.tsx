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
import { defaultMultiplayerConfig, RemotePlayers, useMultiplayer, type MultiplayerConfig } from 'gaesup-world';

import { authApi } from '../api/endpoints';
import type { User } from '../api/types';

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
 * reconnects itself with a fresh ticket. Names float just above a 1.7 m 미니미.
 */
const CONFIG: MultiplayerConfig = {
  ...defaultMultiplayerConfig,
  logToConsole: false,
  websocket: { ...defaultMultiplayerConfig.websocket, url: '', reconnectAttempts: 0 },
  rendering: { ...defaultMultiplayerConfig.rendering, nameTagHeight: 2.1 },
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

/** Who is here with you, and a line to say to whoever stands near. */
export function LiveBar() {
  const live = useLive();
  const [text, setText] = useState('');
  if (!live?.isConnected) return null;
  const send = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    if (!line) return;
    live.sendChat(line.slice(0, MAX_CHAT));
    setText('');
  };
  return (
    <form className="mh-live-bar" onSubmit={send}>
      <span className="mh-chip">👥 함께 {live.players.size + 1}명</span>
      {live.localSpeechText && <span className="mh-chip mh-live-said">{live.localSpeechText}</span>}
      <input
        value={text}
        maxLength={MAX_CHAT}
        placeholder="근처에 있는 사람에게 말하기"
        aria-label="말하기"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </form>
  );
}
