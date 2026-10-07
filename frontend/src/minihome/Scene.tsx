import { memo, Suspense, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

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
  type WorldQuality,
} from 'gaesup-world';
import { BuildingController } from 'gaesup-world/building';

import { useGameStage } from '../games/room';
import { createWorldRenderer } from '../rendering/worldRenderer';
import { MINIME_SCALE } from './character';
import { EditCanvas } from './edit/EditCanvas';
import { IdleFrameRate } from './IdleFrameRate';
import { forest } from './islands/forest';
import type { IslandTemplate, SkyPreset } from './islands/types';
import { Shore } from './Shore';
import { SPAWN } from './village';

/** World GI's sky for an island's daylight (the hemisphere's colours at its strength); GI takes the hemisphere's place. */
function giSky({ hemisphere, environment }: SkyPreset): Partial<GiEnvironment> {
  const scaled = (hex: string) => hexToLinearRgb(hex).map((channel) => channel * hemisphere.intensity) as [number, number, number];
  return { skyZenith: scaled(hemisphere.sky), skyHorizon: scaled(environment.horizon ?? '#c4d9d0'), skyGround: scaled(hemisphere.ground) };
}
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
  /** The island's pet. */
  pet?: ReactNode;
  /** The island's game, when one is playing. */
  game?: ReactNode;
  /** Where the player starts (the crossroads unless given). */
  spawn?: [number, number, number];
  /** The kind of island: its sky, rooms and arrival areas (the forest unless given). */
  template?: IslandTemplate;
};

/**
 * The island canvas: the player, the village, visitors, residents, a game and the rule engine's trigger areas. Memoized: the
 * page around it re-renders with the live room and the panels, and every render of the canvas reconfigures its root.
 */
export const Scene = memo(function Scene({ quality, postProcessing, cinematic, idleThrottle, playerRef, visualRotationRef, visitors, residents, pet, game, spawn = SPAWN, template = forest }: SceneProps) {
  // A lost GPU device remounts the canvas with a fresh renderer; the island's state lives outside it.
  const canvasKey = useRendererRecovery();
  // The ratio the engine last drew at, given back to the canvas so that applying its prop changes nothing.
  const [dpr, setDpr] = useState<number>();
  // While a game's map takes the island's place, the island's own things give way (and come back as they were); a game
  // that drives the viewer's body has their figure and walking off meanwhile. World GI bounces light off the island's
  // own buildings, so it waits too.
  const stage = useGameStage();
  const onIsland = stage === 'island';
  const driving = stage === 'drive';
  const worldGi = postProcessing && !!cinematic && onIsland;
  const { sky } = template;
  const gi = useMemo(() => giSky(sky), [sky]);
  return (
    <Canvas key={canvasKey} dpr={dpr ?? FIRST_DPR} shadows="percentage" gl={createWorldRenderer} camera={{ position: [spawn[0], 14, spawn[2] + 12], fov: 38 }}>
      <ReportDpr onDpr={setDpr} />
      <color attach="background" args={[sky.background]} />
      {/* Daylight: sky and bounced ground fill, a warm sun, and a small sky map for PBR reflections. */}
      <hemisphereLight args={[sky.hemisphere.sky, sky.hemisphere.ground, worldGi ? 0 : sky.hemisphere.intensity]} />
      <SkyEnvironment {...sky.environment} />
      <Suspense fallback={null}>
        <GaesupWorldContent quality={quality} postProcessing={postProcessing && (cinematic ? CINEMATIC : true)}>
          <CascadedSun position={sky.sun.position} intensity={sky.sun.intensity} color={sky.sun.color} />
          {worldGi && <WorldGi environment={gi} />}
          {idleThrottle && onIsland && <IdleFrameRate />}
          <WorldPhysics>
            <group visible={!driving}>
              <GaesupController rigidBodyRef={playerRef} innerGroupRef={visualRotationRef} position={spawn} scale={MINIME_SCALE} materialPolicy="figure" modelHierarchy clickToMove={!driving} />
            </group>
            {onIsland && <BuildingController />}
            {onIsland && <Shore />}
            {visitors}
            {onIsland && residents}
            {onIsland && pet}
            {game}
          </WorldPhysics>
          {onIsland && <InteractionTracker />}
          <EditCanvas />
          {onIsland && template.areas.map((area) => <GameplayArea key={`${template.id}:${area.id}`} {...area} />)}
          {onIsland && template.rooms.map((room) => <LightingZone key={`${template.id}:${room.id}`} {...room} />)}
          <ContactShadows />
          <Nameplates />
        </GaesupWorldContent>
      </Suspense>
    </Canvas>
  );
});
