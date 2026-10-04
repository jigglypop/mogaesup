import { useCallback, type RefObject } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { useInteractionSystem } from 'gaesup-world';
import { useClickNavigationRoute } from 'gaesup-world/navigation';

import { SPAWN } from '../minihome/village';
import type { Vec3 } from './protocol';

/** How far above the ground point the body is put, as at the island's spawn, so it settles onto the ground. */
const LIFT = SPAWN[1];
const STILL = { x: 0, y: 0, z: 0 };

/**
 * Moves the local player's body to stand at `ground` (a point on the island's ground, such as a spot from `spots.ts`)
 * at once: it is put there, stopped, and woken so physics settles it. False when there is no body yet.
 */
export function teleport(body: RapierRigidBody | null | undefined, [x, y, z]: Vec3): boolean {
  if (!body) return false;
  try {
    body.setTranslation({ x, y: y + LIFT, z }, true);
    body.setLinvel(STILL, true);
    body.setAngvel(STILL, true);
    body.wakeUp();
    return true;
  } catch {
    // A body the physics world already let go of (the canvas was set up again).
    return false;
  }
}

/** Where the body stands now, or null without one. */
export function standing(body: RapierRigidBody | null | undefined): Vec3 | null {
  try {
    const at = body?.translation();
    return at ? [at.x, at.y, at.z] : null;
  } catch {
    return null;
  }
}

/**
 * The same for this island's player, also ending a click-to-move walk underway (as the engine's own stop does), so the
 * player does not walk on toward where they clicked before. Use inside the world (`GaesupWorld`).
 */
export function useTeleport(playerRef: RefObject<RapierRigidBody | null>): (ground: Vec3) => boolean {
  const { updateMouse } = useInteractionSystem();
  const route = useClickNavigationRoute();
  return useCallback(
    (ground: Vec3) => {
      route.nextClickNavigationRequest();
      route.clearClickNavigationRoute();
      updateMouse({ isActive: false, shouldRun: false });
      return teleport(playerRef.current, ground);
    },
    [playerRef, route, updateMouse],
  );
}
