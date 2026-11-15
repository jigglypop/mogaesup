import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, DepthOfField, EffectComposer, HueSaturation, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode, type DepthOfFieldEffect } from 'postprocessing';
import { Fog, HalfFloatType, Plane, PMREMGenerator, Vector3, type DirectionalLight, type OrthographicCamera } from 'three';

import { setLampGain } from './build';
import { GRASS_LAYER } from './Built';
import { AZIMUTH, cameraRange, NO_INSET, openArea, stand, turnedExtent, zoomOf, type Frame, type Inset } from './frames';
import { Lake } from './Lake';
import { skyTexture, WATER_LEVEL, type Mood } from './mood';

// How the village is photographed: one isometric camera that moves between frames and turns about what it looks at, the
// low sun and its shadows, the sky that lights what the sun does not, the lake, and the darkroom after (shade in the
// corners things meet in, a lens that keeps one distance sharp, the glow of what is bright, film's roll-off).

/** `high` draws everything; `low` leaves out what a phone's graphics chip pays most for. */
export type Quality = 'high' | 'low';

const SUN_DISTANCE = 90;
/** How quickly the view follows a new frame: about a second to settle. */
const FOLLOW = 3.4;
/** How quickly it follows the hand that turns it: a tenth of a second behind. */
const TURN_FOLLOW = 18;
/** A turn still to make, in radians, under which the camera has arrived. */
const TURN_SETTLED = 0.0005;
/** How quickly it follows the wheel, the fingers or the buttons that zoom it, and the zoom still to make that counts as none. */
const ZOOM_FOLLOW = 12;
const ZOOM_SETTLED = 0.001;
/**
 * The lake's mirror is drawn with everything under the water cut away, which the graphics card needs its own version of
 * every material for. The picture itself is drawn with a cut that removes nothing, so both share one version.
 */
const CUT_NOTHING = [new Plane(new Vector3(0, 1, 0), 1e5)];
/** The haze begins past the middle of the view and thickens toward the far water: metres beyond the point the camera looks at. */
const HAZE_NEAR = 4;
const HAZE_FAR = 95;

export function initialQuality(): Quality {
  if (typeof matchMedia !== 'function') return 'high';
  return matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'high';
}

type LookProps = {
  frame: Frame;
  /** Jump to the frame instead of easing there. */
  snap?: boolean;
  /** How far the camera is to stand turned about the vertical from its own side, in radians; a drag changes it. */
  turn?: RefObject<number>;
  /** How large the picture is to be drawn against the size at which the frame just fits; the viewer changes it. */
  zoom?: RefObject<number>;
  /** The parts of the canvas the page's panels cover: the frame is fitted to, and centred in, what is left. */
  inset?: RefObject<Inset>;
  mood: Mood;
  quality: Quality;
};

const UNTURNED: RefObject<number> = { current: 0 };
const UNZOOMED: RefObject<number> = { current: 1 };
const UNCOVERED: RefObject<Inset> = { current: NO_INSET };

/** Everything about the picture that is not the village itself. Mounted once in a canvas, beside the homes. */
export function Look({ frame, snap = false, turn = UNTURNED, zoom = UNZOOMED, inset = UNCOVERED, mood, quality }: LookProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const sun = useRef<DirectionalLight>(null);
  const lens = useRef<DepthOfFieldEffect>(null);
  const shown = useRef<Frame | null>(null);
  const turned = useRef(turn.current);
  const zoomed = useRef(zoom.current);
  /** Where the middle of the frame is drawn, in pixels right and down of the canvas's own middle; it eases like the frame. */
  const shifted = useRef({ x: 0, y: 0, width: 0, height: 0 });
  /** The camera is on its way round, in or out: the lake's mirror follows it frame by frame. */
  const turning = useRef(false);
  const last = useRef(0);
  const frames = useRef(0);
  const focus = useMemo(() => new Vector3(), []);
  const sky = useMemo(() => skyTexture(mood), [mood]);
  useEffect(() => () => sky.dispose(), [sky]);
  /** The air's haze; where it begins and ends follows the camera each frame. */
  const haze = useMemo(() => new Fog(mood.haze), [mood]);

  // The sky lights the scene, the air hazes its distance, and where nothing is drawn is deep water.
  useLayoutEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const lit = pmrem.fromEquirectangular(sky);
    pmrem.dispose();
    scene.environment = lit.texture;
    scene.environmentIntensity = mood.skyPower;
    scene.fog = haze;
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
  }, [gl, scene, camera, sky, haze, mood]);

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
    const left = turn.current - turned.current;
    const closer = zoom.current - zoomed.current;
    const moving = Math.abs(left) > TURN_SETTLED;
    const zooming = Math.abs(closer) > ZOOM_SETTLED;
    turned.current = moving && !snap ? turned.current + left * (1 - Math.exp(-elapsed * TURN_FOLLOW)) : turn.current;
    zoomed.current = zooming && !snap ? zoomed.current + closer * (1 - Math.exp(-elapsed * ZOOM_FOLLOW)) : zoom.current;
    const azimuth = AZIMUTH + turned.current;
    const extent = turnedExtent(current, turned.current);
    // The frame is fitted to the part of the canvas the page's panels leave open, and drawn in the middle of it.
    const open = openArea(size.width, size.height, inset.current);
    const view = shifted.current;
    const first = view.width === 0;
    const ease = (from: number, to: number) => (first || snap ? to : from + (to - from) * step);
    view.x = ease(view.x, open.x);
    view.y = ease(view.y, open.y);
    view.width = ease(view.width, open.width);
    view.height = ease(view.height, open.height);
    const settling = Math.abs(view.width - open.width) > 0.5 || Math.abs(view.height - open.height) > 0.5;
    turning.current = moving || zooming || settling;
    const [x, y, z] = current.target;
    camera.zoom = zoomOf(extent, view.width, view.height) * zoomed.current;
    // The camera stands as far back, and draws as far, as the lake runs in the canvas; the haze keeps its place over it.
    const { distance, far } = cameraRange(size.height, view.y, camera.zoom, y - WATER_LEVEL, camera.near);
    camera.far = far;
    stand(camera, current.target, azimuth, distance);
    haze.near = distance + HAZE_NEAR;
    haze.far = distance + HAZE_FAR;
    // The whole canvas is drawn; the view is only moved so that the frame's middle falls in the open part's.
    if (Math.abs(view.x) > 0.5 || Math.abs(view.y) > 0.5) camera.setViewOffset(size.width, size.height, -view.x, -view.y, size.width, size.height);
    else if (camera.view?.enabled) camera.clearViewOffset();
    camera.updateProjectionMatrix();
    focus.set(x, y, z);
    if (lens.current) {
      lens.current.target?.copy(focus);
      // What is in view is in focus to about its edges, which go soft: softer in a close view than in a wide one.
      lens.current.cocMaterial.focusRange = Math.max(10, (extent.halfHeight * 2) / Math.max(1, zoomed.current));
      lens.current.bokehScale = Math.min(3, Math.max(0.5, camera.zoom / 26));
    }
    const light = sun.current;
    if (!light) return;
    light.position.set(x + mood.toSun.x * SUN_DISTANCE, y + mood.toSun.y * SUN_DISTANCE, z + mood.toSun.z * SUN_DISTANCE);
    light.target.position.set(x, y, z);
    light.target.updateMatrixWorld();
    // A low sun throws long shadows: what stands outside the view still shades what is in it. Zoomed out, the view
    // holds that much more ground (a home's neighbours come into it), and the shadows are cast over all of it.
    const reach = (Math.max(extent.halfWidth, extent.halfHeight) + 9) / Math.min(1, zoomed.current);
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
      <Lake mood={mood} sky={sky} scale={fine ? 0.5 : 0.35} every={fine ? 2 : 3} moving={turning} />
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
