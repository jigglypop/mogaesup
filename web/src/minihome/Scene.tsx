import { Suspense, type ReactNode, type RefObject } from 'react';

import { Canvas } from '@react-three/fiber';
import type { RapierRigidBody } from '@react-three/rapier';

import {
  CascadedSun,
  ContactShadows,
  createRenderer,
  GaesupController,
  GaesupWorldContent,
  GameplayArea,
  IdleFrameRate,
  InteractionTracker,
  LightingZone,
  Nameplates,
  SkyEnvironment,
  useRendererRecovery,
  WorldPhysics,
  type LightingProfile,
  type WorldQuality,
} from 'gaesup-world';
import { BuildingController } from 'gaesup-world/building';

import { SPAWN } from './village';
import { AREAS } from './world';

const MINIROOM = AREAS.find((area) => area.id === 'miniroom')!;
/** Inside the miniroom most daylight stays out; a warm fill and the ceiling lamp light the room. */
const ROOM_LIGHT: LightingProfile = { sun: 0.3, fill: 0.72, sky: '#ffe8d2', ground: '#8a6d58', environment: 0.45 };
const ROOM_LAMP = { color: '#ffcf8f', intensity: 9, distance: 10, height: 3 };
/** Post-processing with screen-space bounced light and reflections, on WebGPU devices. */
const CINEMATIC = { quality: 'cinematic' } as const;

export type SceneSettings = {
  quality: WorldQuality;
  postProcessing: boolean;
  /** With post-processing on, light the island with bounced light and reflections. */
  cinematic?: boolean;
  /** Draw 30 frames a second after two idle seconds. */
  idleThrottle: boolean;
  /** What hides the player turns see-through instead of pulling the camera in front of it (on unless turned off). */
  cameraFade?: boolean;
};

type SceneProps = SceneSettings & {
  /** The player's body, which the live room samples to publish where we are. */
  playerRef: RefObject<RapierRigidBody>;
  /** Other people in the live room. */
  visitors?: ReactNode;
};

/** The island canvas: the player, the village, its residents, visitors and the rule engine's trigger areas. */
export function Scene({ quality, postProcessing, cinematic, idleThrottle, playerRef, visitors }: SceneProps) {
  // A lost GPU device remounts the canvas with a fresh renderer; the island's state lives outside it.
  const canvasKey = useRendererRecovery();
  return (
    <Canvas key={canvasKey} shadows="percentage" gl={createRenderer} camera={{ position: [SPAWN[0], 14, SPAWN[2] + 12], fov: 38 }}>
      <color attach="background" args={['#8fd3ee']} />
      {/* Daylight: sky and bounced ground fill, a warm sun, and a small sky map for PBR reflections. */}
      <hemisphereLight args={['#eaf6ff', '#6f8a57', 1.22]} />
      <SkyEnvironment intensity={0.32} />
      <Suspense fallback={null}>
        <GaesupWorldContent quality={quality} postProcessing={postProcessing && (cinematic ? CINEMATIC : true)}>
          <CascadedSun position={[18, 36, 22]} intensity={2.55} color="#fff3da" />
          {idleThrottle && <IdleFrameRate />}
          <WorldPhysics>
            <GaesupController rigidBodyRef={playerRef} position={SPAWN} materialPolicy="figure" clickToMove />
            <BuildingController />
            {visitors}
          </WorldPhysics>
          <InteractionTracker />
          {AREAS.map((area) => <GameplayArea key={area.id} {...area} />)}
          <LightingZone center={MINIROOM.center} size={MINIROOM.size} profile={ROOM_LIGHT} lamp={ROOM_LAMP} />
          <ContactShadows />
          <Nameplates />
        </GaesupWorldContent>
      </Suspense>
    </Canvas>
  );
}
