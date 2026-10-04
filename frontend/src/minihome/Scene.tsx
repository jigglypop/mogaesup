import { memo, Suspense, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';

import { Canvas, useThree } from '@react-three/fiber';
import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';

import {
  CascadedSun,
  ContactShadows,
  GaesupController,
  GaesupWorldContent,
  GameplayArea,
  hexToLinearRgb,
  InteractionTracker,
  LightingZone,
  Nameplates,
  SkyEnvironment,
  useRendererRecovery,
  WorldGi,
  WorldPhysics,
  type GiEnvironment,
  type LightingProfile,
  type WorldQuality,
} from 'gaesup-world';
import { BuildingController } from 'gaesup-world/building';

import { createWorldRenderer } from '../rendering/worldRenderer';
import { MINIME_SCALE } from './character';
import { EditCanvas } from './edit/EditCanvas';
import { IdleFrameRate } from './IdleFrameRate';
import { Shore } from './Shore';
import { SPAWN } from './village';
import { AREAS } from './world';

const MINIROOM = AREAS.find((area) => area.id === 'miniroom')!;
/** Inside the miniroom most daylight stays out; a warm fill and the ceiling lamp light the room. */
const ROOM_LIGHT: LightingProfile = { sun: 0.3, fill: 0.72, sky: '#ffe8d2', ground: '#8a6d58', environment: 0.45 };
const ROOM_LAMP = { color: '#ffcf8f', intensity: 9, distance: 10, height: 3 };
/** Daylight from the sky and the grass it bounces off; world GI takes this over when it is on. */
const SKY = { color: '#eaf6ff', ground: '#6f8a57', intensity: 1.22 };
const scaled = (hex: string) => hexToLinearRgb(hex).map((channel) => channel * SKY.intensity) as [number, number, number];
const GI_SKY: Partial<GiEnvironment> = {
  skyZenith: scaled(SKY.color),
  skyHorizon: scaled('#c4d9d0'),
  skyGround: scaled(SKY.ground),
};
/**
 * High-quality lighting on WebGPU devices: world GI probes bounce the sun and sky off the island, and the post-process
 * adds reflections and contact shadows. Its screen-space GI stays off so the bounce is not counted twice.
 */
const CINEMATIC = { quality: 'cinematic', globalIllumination: false, ambientOcclusion: false } as const;
/** The canvas's pixel ratio until the engine sets its own: the engine's cap of 1.5. */
const FIRST_DPR: [number, number] = [1, 1.5];

/**
 * Hands the pixel ratio the engine's quality controller chose (at most 1.5, lower on slow devices) back to the scene.
 * The canvas applies its `dpr` prop again every time it renders: left at R3F's default it set 2 on every live-room
 * update, the engine set its own back, and each change reallocated the drawing buffers.
 */
function ReportDpr({ onDpr }: { onDpr: (dpr: number) => void }) {
  const dpr = useThree((state) => state.viewport.dpr);
  useLayoutEffect(() => {
    if (dpr > 0) onDpr(dpr);
  }, [dpr, onDpr]);
  return null;
}

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
  /** The engine turns this group while the character's physics body stays upright. */
  visualRotationRef: RefObject<Group>;
  /** Other people in the live room. */
  visitors?: ReactNode;
  /** The island's residents. */
  residents?: ReactNode;
  /** Where the player starts (the crossroads unless given). */
  spawn?: [number, number, number];
};

/**
 * The island canvas: the player, the village, visitors, residents and the rule engine's trigger areas. Memoized: the
 * page around it re-renders with the live room and the panels, and every render of the canvas reconfigures its root.
 */
export const Scene = memo(function Scene({ quality, postProcessing, cinematic, idleThrottle, playerRef, visualRotationRef, visitors, residents, spawn = SPAWN }: SceneProps) {
  // A lost GPU device remounts the canvas with a fresh renderer; the island's state lives outside it.
  const canvasKey = useRendererRecovery();
  // The ratio the engine last drew at, given back to the canvas so that applying its prop changes nothing.
  const [dpr, setDpr] = useState<number>();
  const worldGi = postProcessing && !!cinematic;
  return (
    <Canvas key={canvasKey} dpr={dpr ?? FIRST_DPR} shadows="percentage" gl={createWorldRenderer} camera={{ position: [spawn[0], 14, spawn[2] + 12], fov: 38 }}>
      <ReportDpr onDpr={setDpr} />
      <color attach="background" args={['#8fd3ee']} />
      {/* Daylight: sky and bounced ground fill, a warm sun, and a small sky map for PBR reflections. */}
      <hemisphereLight args={[SKY.color, SKY.ground, worldGi ? 0 : SKY.intensity]} />
      <SkyEnvironment intensity={0.32} />
      <Suspense fallback={null}>
        <GaesupWorldContent quality={quality} postProcessing={postProcessing && (cinematic ? CINEMATIC : true)}>
          <CascadedSun position={[18, 36, 22]} intensity={2.55} color="#fff3da" />
          {worldGi && <WorldGi environment={GI_SKY} />}
          {idleThrottle && <IdleFrameRate />}
          <WorldPhysics>
            <GaesupController rigidBodyRef={playerRef} innerGroupRef={visualRotationRef} position={spawn} scale={MINIME_SCALE} materialPolicy="figure" modelHierarchy clickToMove />
            <BuildingController />
            <Shore />
            {visitors}
            {residents}
          </WorldPhysics>
          <InteractionTracker />
          <EditCanvas />
          {AREAS.map((area) => <GameplayArea key={area.id} {...area} />)}
          <LightingZone center={MINIROOM.center} size={MINIROOM.size} profile={ROOM_LIGHT} lamp={ROOM_LAMP} />
          <ContactShadows />
          <Nameplates />
        </GaesupWorldContent>
      </Suspense>
    </Canvas>
  );
});
