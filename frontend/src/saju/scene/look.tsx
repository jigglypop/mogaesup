import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, DepthOfField, EffectComposer, HueSaturation, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode, type DepthOfFieldEffect } from 'postprocessing';
import { Fog, HalfFloatType, Plane, PMREMGenerator, Vector3, type DirectionalLight, type OrthographicCamera } from 'three';

import { setLampGain } from './build';
import { GRASS_LAYER } from './Built';
import { AZIMUTH, ELEVATION, zoomOf, type Frame } from './frames';
import { Lake } from './Lake';
import { skyTexture, type Mood } from './mood';

// How the village is photographed: one fixed isometric camera that moves between frames, the low sun and its shadows,
// the sky that lights what the sun does not, the lake, and the darkroom after (shade in the corners things meet in, a
// lens that keeps one distance sharp, the glow of what is bright, film's roll-off).

/** `high` draws everything; `low` leaves out what a phone's graphics chip pays most for. */
export type Quality = 'high' | 'low';

/** From the middle of the view toward the camera. */
const TO_CAMERA = new Vector3(Math.cos(ELEVATION) * Math.sin(AZIMUTH), Math.sin(ELEVATION), Math.cos(ELEVATION) * Math.cos(AZIMUTH));
const CAMERA_DISTANCE = 120;
const SUN_DISTANCE = 90;
/** How quickly the view follows a new frame: about a second to settle. */
const FOLLOW = 3.4;
/**
 * The lake's mirror is drawn with everything under the water cut away, which the graphics card needs its own version of
 * every material for. The picture itself is drawn with a cut that removes nothing, so both share one version.
 */
const CUT_NOTHING = [new Plane(new Vector3(0, 1, 0), 1e5)];
/** The haze begins past the middle of the view and thickens toward the far water. */
const HAZE_NEAR = CAMERA_DISTANCE + 4;
const HAZE_FAR = CAMERA_DISTANCE + 95;

export function initialQuality(): Quality {
  if (typeof matchMedia !== 'function') return 'high';
  return matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'high';
}

type LookProps = {
  frame: Frame;
  /** Jump to the frame instead of easing there. */
  snap?: boolean;
  mood: Mood;
  quality: Quality;
};

/** Everything about the picture that is not the village itself. Mounted once in a canvas, beside the homes. */
export function Look({ frame, snap = false, mood, quality }: LookProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const sun = useRef<DirectionalLight>(null);
  const lens = useRef<DepthOfFieldEffect>(null);
  const shown = useRef<Frame | null>(null);
  const last = useRef(0);
  const frames = useRef(0);
  const focus = useMemo(() => new Vector3(), []);
  const sky = useMemo(() => skyTexture(mood), [mood]);
  useEffect(() => () => sky.dispose(), [sky]);

  // The sky lights the scene, the air hazes its distance, and where nothing is drawn is deep water.
  useLayoutEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const lit = pmrem.fromEquirectangular(sky);
    pmrem.dispose();
    scene.environment = lit.texture;
    scene.environmentIntensity = mood.skyPower;
    scene.fog = new Fog(mood.haze, HAZE_NEAR, HAZE_FAR);
    gl.setClearColor(mood.deep, 1);
    gl.toneMappingExposure = mood.exposure;
    gl.clippingPlanes = CUT_NOTHING;
    setLampGain(mood.lamps);
    camera.layers.enable(GRASS_LAYER);
    return () => {
      scene.environment = null;
      scene.fog = null;
      gl.clippingPlanes = [];
      lit.dispose();
    };
  }, [gl, scene, camera, sky, mood]);

  useFrame(() => {
    // Shadows are cast afresh every other frame, the frames the lake's mirror is not drawn: almost nothing moves.
    frames.current += 1;
    gl.shadowMap.autoUpdate = false;
    if (frames.current < 4 || frames.current % 2 === 1) gl.shadowMap.needsUpdate = true;
    const now = performance.now();
    const elapsed = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    const current = (shown.current ??= { ...frame, target: [frame.target[0], frame.target[1], frame.target[2]] });
    const step = snap ? 1 : 1 - Math.exp(-elapsed * FOLLOW);
    for (const axis of [0, 1, 2] as const) current.target[axis] += (frame.target[axis] - current.target[axis]) * step;
    current.halfWidth += (frame.halfWidth - current.halfWidth) * step;
    current.halfHeight += (frame.halfHeight - current.halfHeight) * step;
    const [x, y, z] = current.target;
    camera.position.set(x + TO_CAMERA.x * CAMERA_DISTANCE, y + TO_CAMERA.y * CAMERA_DISTANCE, z + TO_CAMERA.z * CAMERA_DISTANCE);
    camera.lookAt(x, y, z);
    camera.zoom = zoomOf(current, size.width, size.height);
    camera.updateProjectionMatrix();
    focus.set(x, y, z);
    if (lens.current) {
      lens.current.target?.copy(focus);
      // What is in view is in focus to about its edges, which go soft: softer in a close view than in a wide one.
      lens.current.cocMaterial.focusRange = Math.max(10, current.halfHeight * 2);
      lens.current.bokehScale = Math.min(3, Math.max(0.5, camera.zoom / 26));
    }
    const light = sun.current;
    if (!light) return;
    light.position.set(x + mood.toSun.x * SUN_DISTANCE, y + mood.toSun.y * SUN_DISTANCE, z + mood.toSun.z * SUN_DISTANCE);
    light.target.position.set(x, y, z);
    light.target.updateMatrixWorld();
    // A low sun throws long shadows: what stands outside the view still shades what is in it.
    const reach = Math.max(current.halfWidth, current.halfHeight) + 9;
    const shadow = light.shadow.camera;
    if (Math.abs(shadow.right - reach) > 0.01) {
      shadow.left = shadow.bottom = -reach;
      shadow.right = shadow.top = reach;
      shadow.updateProjectionMatrix();
    }
  });

  const fine = quality === 'high';
  const map = fine ? 4096 : 2048;
  return (
    <>
      <directionalLight ref={sun} castShadow intensity={mood.sunPower} color={mood.sun} shadow-mapSize={[map, map]} shadow-bias={-0.0004} shadow-normalBias={0.05} shadow-radius={2.2}>
        <orthographicCamera attach="shadow-camera" args={[-12, 12, 12, -12, 1, 220]} />
      </directionalLight>
      <Lake mood={mood} sky={sky} scale={fine ? 0.5 : 0.35} every={fine ? 2 : 3} />
      <EffectComposer multisampling={0} frameBufferType={HalfFloatType} enableNormalPass={false}>
        {fine ? <N8AO halfRes aoRadius={1.3} distanceFalloff={1} intensity={2.4} quality="medium" color="#241538" /> : <></>}
        {fine ? <DepthOfField ref={lens} target={[0, 0, 0]} worldFocusRange={9} bokehScale={2} resolutionScale={0.5} /> : <></>}
        <Bloom mipmapBlur luminanceThreshold={1.05} luminanceSmoothing={0.3} intensity={0.7} radius={0.72} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <HueSaturation saturation={0.14} />
        <Vignette offset={0.26} darkness={0.46} />
      </EffectComposer>
    </>
  );
}
