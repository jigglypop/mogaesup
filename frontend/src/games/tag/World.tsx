import { useEffect, useMemo, useRef } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Mesh } from 'three';

import { useLive } from '../../minihome/live';
import type { GameProps } from '../game';
import type { GameSession, Vec3 } from '../protocol';
import { useGameRoom } from '../room';
import { standing } from '../teleport';
import type { TagView } from './index';

/** Rings are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** How high over the ground a ring lies, in meters, and how quickly it catches up with its avatar (per second). */
const LIFT = 0.12;
const FOLLOW = 14;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Puts the viewer's character at `ground` once for each new place there (trying again until the island's world can),
 * for as long as the view has one.
 */
export function useArrive(ground: Vec3 | null | undefined, teleport: (ground: Vec3) => boolean) {
  const key = ground ? ground.join(',') : '';
  useEffect(() => {
    if (!key) return undefined;
    const place = key.split(',').map(Number) as Vec3;
    if (teleport(place)) return undefined;
    const retry = setInterval(() => {
      if (teleport(place)) clearInterval(retry);
    }, 250);
    return () => clearInterval(retry);
  }, [key, teleport]);
}

/** The its to ring: each by their avatar in the live room (`peer`, null while they are out of it), or the viewer. */
export function ringed(view: TagView, session: GameSession): { id: string; peer: string | null; self: boolean }[] {
  return view.its.map((id) => ({
    id,
    peer: session.players.find((player) => player.id === id)?.peer ?? null,
    self: id === session.you,
  }));
}

/** A ring on the ground around wherever `locate` says, hidden while it says nowhere. */
function Ring({ locate, color }: { locate: () => Vec3 | null; color: string }) {
  const mesh = useRef<Mesh>(null);
  const placed = useRef(false);
  useFrame((_, delta) => {
    const ring = mesh.current;
    if (!ring) return;
    const at = locate();
    ring.visible = !!at;
    if (!at) {
      placed.current = false;
      return;
    }
    const [x, y, z] = [at[0], at[1] + LIFT, at[2]];
    if (!placed.current) {
      placed.current = true;
      ring.position.set(x, y, z);
      return;
    }
    // The avatars ease toward the positions the room sends; the ring eases along with them.
    const k = 1 - Math.exp(-delta * FOLLOW);
    ring.position.set(ring.position.x + (x - ring.position.x) * k, ring.position.y + (y - ring.position.y) * k, ring.position.z + (z - ring.position.z) * k);
  });
  // Drawn over the scene, so tall grass and whatever stands between do not hide who is it.
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={10} raycast={noRaycast}>
      <torusGeometry args={[0.75, 0.08, 10, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} depthTest={false} depthWrite={false} />
    </mesh>
  );
}

/** A ring at every it's feet, the viewer's own included; nothing marks a runner. The viewer goes to their start spot. */
export function TagWorld({ view, session, teleport }: GameProps<TagView>) {
  useArrive(view.spot, teleport);
  const color = useMemo(() => token('--mg-tag-it'), []);
  const players = useLive()?.players;
  const body = useGameRoom()?.playerRef;
  return (
    <group>
      {ringed(view, session).map(({ id, peer, self }) => (
        <Ring
          key={id}
          color={color}
          locate={() => (self ? standing(body?.current) : peer ? (players?.get(peer)?.position ?? null) : null)}
        />
      ))}
    </group>
  );
}
