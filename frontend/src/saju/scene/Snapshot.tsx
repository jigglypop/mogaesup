import { useCallback, useRef, useState } from 'react';

import { Canvas, useFrame, useThree } from '@react-three/fiber';

import type { Profile } from '../profile';
import { PICTURE_SIZE } from '../snapshot';
import { frameOf } from './frames';
import { Diorama, Scene, useMood } from './Stage';

/** Frames drawn before the picture is taken: the first have the shadows cast and the lake's mirror drawn. */
const SETTLE_FRAMES = 8;
const FRAME = frameOf([{ x: 0, z: 0 }]);
const ORIGIN = [0, 0, 0] as const;

function Shutter({ onShot }: { onShot: (canvas: HTMLCanvasElement) => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  const frames = useRef(0);
  // After the frame is drawn (the darkroom draws at 1), while the drawing buffer still holds it.
  useFrame(() => {
    frames.current += 1;
    if (frames.current === SETTLE_FRAMES) onShot(canvas);
  }, 2);
  return null;
}

/**
 * Draws one home alone, held still, on a square canvas off the page, and hands the canvas over once it is drawn. Mounted
 * only while a picture is being taken.
 */
export function Snapshot({ profile, onShot }: { profile: Profile; onShot: (canvas: HTMLCanvasElement) => void }) {
  const mood = useMood();
  const [warm, setWarm] = useState(false);
  const warmed = useCallback(() => setWarm(true), []);
  return (
    <div className="mg-saju-snapshot" style={{ width: PICTURE_SIZE, height: PICTURE_SIZE }} aria-hidden="true">
      <Canvas orthographic flat shadows="percentage" dpr={1} frameloop={warm ? 'always' : 'never'} gl={{ antialias: false, alpha: false, preserveDrawingBuffer: true }} camera={{ near: 1, far: 400, position: [60, 60, 60] }}>
        <Scene frame={FRAME} snap mood={mood} quality="high" still onWarm={warmed}>
          <Diorama profile={profile} origin={ORIGIN} />
        </Scene>
        <Shutter onShot={onShot} />
      </Canvas>
    </div>
  );
}
