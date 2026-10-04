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

import { useFrame } from '@react-three/fiber';
import type { RapierRigidBody } from '@react-three/rapier';
import { Vector3, type Group } from 'three';

import { Link } from 'react-router-dom';

import {
  defaultMultiplayerConfig,
  RemotePlayers,
  SpeechBalloon,
  useMultiplayer,
  useUIConfigStore,
  type MultiplayerConfig,
} from 'gaesup-world';

import { authApi } from '../api/endpoints';
import type { User } from '../api/types';
import { useSignInPath } from '../auth/signIn';
import { useHiddenPeers, withoutPeers } from '../games/hiddenPeers';
import { Icon } from '../ui/icons';
import { MINIME_SCALE } from './character';
import { peerColor } from './peers';

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
  rendering: {
    ...defaultMultiplayerConfig.rendering,
    characterScale: MINIME_SCALE,
    nameTagHeight: 1.7 * MINIME_SCALE + 0.4,
    materialPolicy: 'figure',
    tintCharacter: false,
  },
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
  visualRotationRef: RefObject<Group>;
}): Multiplayer {
  const { username, viewer, characterUrl, playerRef, visualRotationRef } = options;
  const live = useMultiplayer({
    config: CONFIG,
    characterUrl: new URL(characterUrl, location.origin).href,
    rigidBodyRef: playerRef,
    visualRotationRef,
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
        const { ticket, user } = await authApi.realtimeTicket();
        if (stopped || user.id !== viewerId) return;
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

/** What the room's screens read: who is here, what they say, and the way to talk. */
type Live = Pick<
  Multiplayer,
  'isConnected' | 'localPlayerId' | 'players' | 'speechByPlayerId' | 'localSpeechText' | 'sendChat'
>;
const LiveContext = createContext<Live | null>(null);

/** Opens the live room for everything below it; render it under `GaesupWorld`, whose runtime the tracking reads. */
export function LiveRoom({ children, ...options }: Parameters<typeof useLiveRoom>[0] & { children: ReactNode }) {
  useBalloonStyle();
  const { isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat } = useLiveRoom(options);
  // The room answers a new object on every update, a visitor's moves (several a second) and pings included, and every
  // reader of this context re-renders with its value, the island's canvas too (R3F bridges contexts into it). Moves reach
  // the avatars through `players` itself; the value changes only when one of these does.
  const live = useMemo(
    () => ({ isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat }),
    [isConnected, localPlayerId, players, speechByPlayerId, localSpeechText, sendChat],
  );
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/** The room as its screens read it (`players` keeps each avatar's latest state between renders); null outside one. */
export const useLive = () => useContext(LiveContext);

/** The viewer's own place in the room: whether it is connected, and the `client_id` the room gave this page. */
export function useLiveSelf(): { connected: boolean; peer: string | null } {
  const live = useLive();
  return { connected: !!live?.isConnected, peer: live?.localPlayerId ?? null };
}

/** Everyone else in the room, each in their own 미니미, but those a game hides; mount inside the world's physics. */
export function LiveAvatars({ playerRef }: { playerRef: RefObject<RapierRigidBody> }) {
  const live = useLive();
  const hidden = useHiddenPeers();
  const everyone = live?.players;
  const players = useMemo(() => everyone && withoutPeers(everyone, hidden), [everyone, hidden]);
  if (!live || !players) return null;
  return (
    <>
      <RemotePlayers players={players} config={CONFIG} playerRef={playerRef} speechByPlayerId={live.speechByPlayerId} />
      {live.localSpeechText ? <LocalSpeech text={live.localSpeechText} playerRef={playerRef} /> : null}
    </>
  );
}

/** Where a balloon sits: just above a 미니미's name tag (`nameTagHeight`), sized for the island camera. */
const BALLOON_HEIGHT = 1.7 * MINIME_SCALE + 1.05;

/**
 * Speech balloons (the engine draws them for everyone in the room) in the glass colours, re-read when the theme changes;
 * the engine's own defaults float them 4.5 m up at 4 × 2 m and squeeze the words into a fifth of the balloon.
 */
function useBalloonStyle() {
  useEffect(() => {
    const apply = () => {
      const css = getComputedStyle(document.documentElement);
      const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      useUIConfigStore.getState().updateSpeechBalloonConfig({
        defaultOffset: { x: 0, y: BALLOON_HEIGHT, z: 0 },
        scaleMultiplier: 1,
        fontSize: 72,
        padding: 24,
        maxWidth: 400,
        borderRadius: 64,
        borderWidth: 4,
        backgroundColor: token('--mg-glass-strong', 'rgba(255, 255, 255, 0.86)'),
        textColor: token('--mg-ink', '#1d1830'),
        borderColor: token('--mg-hair-strong', 'rgba(29, 24, 48, 0.14)'),
      });
    };
    apply();
    const theme = new MutationObserver(apply);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => theme.disconnect();
  }, []);
}

/** What the member just said, above their own character, drawn as the others' words are drawn above theirs. */
function LocalSpeech({ text, playerRef }: { text: string; playerRef: RefObject<RapierRigidBody> }) {
  // The balloon follows this vector every frame; the body is where the room places the member for the others too.
  const position = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const body = playerRef.current;
    if (!body) return;
    const at = body.translation();
    position.set(at.x, at.y, at.z);
  });
  return <SpeechBalloon text={text} position={position} />;
}

/** How many are on the island now, counting the viewer, and who the others are; empty until the room connects. */
export function usePresence() {
  const live = useLive();
  if (!live?.isConnected) return { connected: false, count: 0, others: [] as { id: string; name: string; color: string }[] };
  const others = [...live.players.entries()].map(([id, player]) => ({ id, name: player.name, color: peerColor(player.color) }));
  return { connected: true, count: others.length + 1, others };
}

/** Who is here with you, and a line to say to whoever stands near; signed out, the way in (and back to this island). */
export function ChatBar({ signedIn }: { signedIn: boolean }) {
  const live = useLive();
  const signIn = useSignInPath();
  const [text, setText] = useState('');
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
          <i key={index} style={{ background: peerColor(player.color) }}>
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
