import { createContext, useContext, useRef, type ReactNode } from 'react';

import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';

import type { V3 } from './kit';
import { MOVING, Static } from './Static';

// How the scene's moving things keep time, and how they are all held still at once.

const StillContext = createContext(false);
/** Holds everything inside it still, at one chosen moment: for a picture, and for a viewer who asked for less motion. */
export const Stillness = StillContext.Provider;
/** The moment a still scene shows: smoke part way up, a flame mid-flicker. */
const STILL_AT = 1.7;

/**
 * Draws what moves: every frame with the scene's clock, or once, at {@link STILL_AT}, where the scene is held still
 * (`still` then tells what plays only once, like a bridge being built, to show itself finished).
 */
export function useAnimation(draw: (time: number, still: boolean) => void): void {
  const still = useContext(StillContext);
  const drawn = useRef(false);
  useFrame(({ clock }) => {
    if (!still) return draw(clock.elapsedTime, false);
    if (drawn.current) return;
    drawn.current = true;
    draw(STILL_AT, true);
  });
}

/** Whether the scene is held still. */
export const useStill = () => useContext(StillContext);

/** Something that hovers: bobbing a little about `position`, and turning when `spin` is set. */
export function Hover({ position, height = 0.08, speed = 1.6, spin = 0, children }: { position: V3; height?: number; speed?: number; spin?: number; children: ReactNode }) {
  const group = useRef<Group>(null);
  useAnimation((time) => {
    if (!group.current) return;
    group.current.position.y = position[1] + Math.sin(time * speed + position[0]) * height;
    if (spin) group.current.rotation.y = time * spin;
  });
  return (
    <group ref={group} position={position} userData={MOVING}>
      <Static>{children}</Static>
    </group>
  );
}
