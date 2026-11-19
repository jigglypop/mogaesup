import { useCallback, useRef, useState } from 'react';

import { Canvas, useFrame, useThree } from '@react-three/fiber';

import type { Profile } from '../profile';
import { PICTURE_SIZE } from '../snapshot';
import { DecorLayer, type IslandDecor } from './Decor';
import { frameOf } from './frames';
import { HomeEstate } from './HomeEstate';
import { createRenderer, Scene, SHADOWS, type StageIsland } from './Stage';
import { ISLANDS } from './terrain';
import { PhotoAssets, useMood } from './works';

/** Frames drawn, once the canvas is ready (see Stage's Ready), before the picture is taken: the shadows cast and the lake's mirror drawn. */
const SETTLE_FRAMES = 3;
const FRAME = frameOf([{ x: 0, z: 0, kind: 'home' }]);
const ORIGIN = [0, 0, 0] as const;
const ISLAND: readonly StageIsland[] = [{ x: 0, z: 0, ...ISLANDS.home }];

/**
 * Copies what the canvas has just drawn into a picture of its own. A WebGPU canvas gives back what it drew only in the
 * task that drew it (a WebGL one without a kept buffer, likewise), so the copy is made there and then, after the
 * darkroom has developed the frame.
 */
function Shutter({ ready, assets, onShot }: { ready: boolean; assets: { pending: number }; onShot: (canvas: HTMLCanvasElement) => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  const frames = useRef(0);
  useFrame(() => {
    if (!ready || assets.pending > 0) {
      frames.current = 0;
      return;
    }
    frames.current += 1;
    if (frames.current !== SETTLE_FRAMES) return;
    const picture = document.createElement('canvas');
    picture.width = canvas.width;
    picture.height = canvas.height;
    picture.getContext('2d')?.drawImage(canvas, 0, 0);
    onShot(picture);
  }, 2);
  return null;
}

/**
 * Draws one home alone, held still, on a square canvas off the page, and hands over a picture of it once it is drawn.
 * Mounted only while a picture is being taken.
 */
export function Snapshot({ profile, decor, onShot }: { profile: Profile; decor: IslandDecor; onShot: (canvas: HTMLCanvasElement) => void }) {
  const [composition] = useState(() => ({ decor, profile }));
  const [assets] = useState(() => ({ pending: 0 }));
  const mood = useMood();
  const [warm, setWarm] = useState(false);
  const warmed = useCallback(() => setWarm(true), []);
  const [ready, setReady] = useState(false);
  const readied = useCallback(() => setReady(true), []);
  return (
    <div className="mg-saju-snapshot" style={{ width: PICTURE_SIZE, height: PICTURE_SIZE }} aria-hidden="true">
      <Canvas orthographic flat shadows={SHADOWS} dpr={1} frameloop={warm ? 'always' : 'never'} gl={createRenderer} camera={{ near: 1, far: 400, position: [60, 60, 60] }}>
        <Scene frame={FRAME} snap islands={ISLAND} mood={mood} quality="high" still onWarm={warmed} onReady={readied}>
          <HomeEstate profile={composition.profile} origin={ORIGIN} terrain={composition.decor.terrain ?? 'default'} {...(composition.decor.tiles ? { tiles: composition.decor.tiles } : {})} />
          <PhotoAssets.Provider value={assets}>
            <DecorLayer {...composition.decor} selectedId={null} />
          </PhotoAssets.Provider>
        </Scene>
        <Shutter ready={ready} assets={assets} onShot={onShot} />
      </Canvas>
    </div>
  );
}
