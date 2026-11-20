import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { ACESFilmicToneMapping, Color, Fog, Matrix4, Vector3, type DirectionalLight, type Object3D, type OrthographicCamera, type Scene } from 'three';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { color as tone, distance, float, mix, orthographicDepthToViewZ, pass, pow, screenUV, smoothstep, toneMapping, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { PMREMGenerator, RenderPipeline, type Node, type WebGPURenderer } from 'three/webgpu';

import { setLampGain } from './build';
import { GRASS_LAYER } from './Built';
import { AZIMUTH, cameraRange, ELEVATION, NO_INSET, openArea, stand, turnedExtent, zoomOf, type Frame, type Inset, type Spot } from './frames';
import { Ocean, type OceanIsland } from './Ocean';
import { skyTexture, WATER_LEVEL, type Mood } from './mood';
import { WorksContext } from './works';

// How the village is photographed: one isometric camera that moves between frames and that the viewer turns, tilts,
// moves and zooms about what it looks at, the low sun and its shadows, the sky that lights what the sun does not, the
// lake, and the darkroom after (shade in the corners things meet in, the glow of what is bright, film's roll-off), all
// drawn by WebGPU (or WebGL 2 where a browser has no WebGPU) through node materials. Everything in view is drawn
// sharp, to the picture's edges.

/** `high` draws everything; `low` leaves out what a phone's graphics chip pays most for. */
export type Quality = 'high' | 'low';

/** The renderer the village's canvases are drawn with. */
const useRenderer = () => useThree((state) => state.gl) as unknown as WebGPURenderer;

/** How far from the point the camera looks at the sun's light stands, at the least; it draws its shadows as far again and more. */
const SUN_DISTANCE = 90;
/** How quickly the view follows a new frame: about a second to settle. */
const FOLLOW = 3.4;
/** How near (in metres) the frame's middle and reach, and (in pixels) the open part of the canvas, count as arrived. */
const FRAME_SETTLED = 0.0005;
const VIEW_SETTLED = 0.05;
/** How quickly it follows the hand that turns and tilts it: a tenth of a second behind. */
const TURN_FOLLOW = 18;
/** A turn or tilt still to make, in radians, under which the camera has arrived. */
const TURN_SETTLED = 0.0005;
/** How quickly it follows the wheel, the fingers or the buttons that zoom it or move it, and what still to make counts as none. */
const ZOOM_FOLLOW = 12;
const ZOOM_SETTLED = 0.001;
const PAN_SETTLED = 0.002;
/** The haze begins past the middle of the view and thickens toward the far water: metres beyond the point the camera looks at. */
const HAZE_NEAR = 4;
const HAZE_FAR = 95;
/** Shadows are cast over this many metres more than the picture shows, for what stands outside it and shades what is in it. */
const SHADOW_MARGIN = 9;
/** Frames apart the sun's shadows are cast again while neither the view nor the sun moves. */
const SHADOW_STILL_EVERY = 4;

/**
 * Shade where things meet (N8AO's look): how far it reaches, how deep in front of a surface something still shades it
 * (a wall over the lawn at its foot), how strongly it darkens, toward what colour.
 */
const SHADE = { radius: 1.3, thickness: 3, power: 2.4, color: new Color('#241538') } as const;
/**
 * The glow of what is brighter than white: how much, how wide, from what brightness and how softly it begins. Three's
 * glow adds five blurred sizes of the bright part, each nearly whole, where the composer's spread one over its sizes:
 * less of it, and weighted toward the smaller sizes, gives a lamp's halo the size it had.
 */
const GLOW = { strength: 0.3, radius: 0.35, threshold: 1.05, soft: 0.3 } as const;
/** A little more colour after the film's roll-off: each colour moves from the grey of the three this share further away. */
const SATURATE = 1 / (1.001 - 0.14) - 1;
/** The corners darkened: from how far out, and how much. */
const VIGNETTE = { offset: 0.26, darkness: 0.46 } as const;

export function initialQuality(): Quality {
  if (typeof matchMedia !== 'function') return 'high';
  return matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'high';
}

/** Where the viewer has taken the camera from where the frame stands it. */
export type Gaze = {
  /** Turned about the vertical from its own side, in radians, without end. */
  turn: number;
  /** How far above the ground it looks down from, in radians (see TILT_RANGE). */
  tilt: number;
  /** How far over the ground the point it looks at has been moved from the frame's, in metres. */
  pan: Spot;
  /** How large the picture is drawn against the size at which the frame just fits. */
  zoom: number;
};

export const UNMOVED: Gaze = { turn: 0, tilt: ELEVATION, pan: { x: 0, z: 0 }, zoom: 1 };

type LookProps = {
  frame: Frame;
  /** Jump to the frame instead of easing there. */
  snap?: boolean;
  /** Where the viewer has taken the camera; it eases there. */
  gaze?: RefObject<Gaze>;
  /** The parts of the canvas the page's panels cover: the frame is fitted to, and centred in, what is left. */
  inset?: RefObject<Inset>;
  /** Every island in the lake, for the water about them. */
  islands: readonly OceanIsland[];
  mood: Mood;
  quality: Quality;
  /** Told once the scene can be drawn without a wait: its islands built and every shader they are drawn with made. */
  onWarm: () => void;
  /**
   * Whose village it is. Another one is waited for as the first was (its islands built, its shaders made), and the
   * camera is there at once, not eased over from a lake laid out about another home.
   */
  village?: string;
};

const UNTOUCHED: RefObject<Gaze> = { current: UNMOVED };
const UNCOVERED: RefObject<Inset> = { current: NO_INSET };

/** The darkroom's dials, set every frame before the picture is developed. */
type Dials = ReturnType<typeof makeDials>;
const makeDials = () => ({
  near: uniform(1),
  far: uniform(400),
  hazeNear: uniform(0),
  hazeFar: uniform(1),
  exposure: uniform(1),
});

/** What the darkroom is made of, to be let go together; `shot` is its picture of the scene. */
type Darkroom = { pipeline: RenderPipeline; shot: ReturnType<typeof pass>; dispose: () => void };

/**
 * The picture as it is developed: the scene drawn into light's own values, shaded where things meet (on `fine` devices
 * only), the glow of what is brighter than white added, rolled off as film does, given a little more colour and
 * darkened toward the corners.
 */
function darkroom(renderer: WebGPURenderer, scene: Scene, camera: OrthographicCamera, fine: boolean, dials: Dials): Darkroom {
  const shot = pass(scene, camera);
  const unflatten = flatten(renderer, shot.renderTarget);
  const color = shot.getTextureNode('output');
  const depth = shot.getTextureNode('depth');
  // The camera is orthographic: depth is a straight share of the way from its near plane to its far one.
  const viewZ = orthographicDepthToViewZ(depth, dials.near, dials.far);
  const parts: { dispose: () => void }[] = [shot];
  /** The picture so far. */
  let developed: Node<'vec4'> = color;
  if (fine) {
    // Normals are worked out from depth, as N8AO did: the scene is drawn once, into one picture and its depth.
    const shade = ao(depth, null as unknown as Node, camera);
    shade.resolutionScale = 0.5;
    shade.radius.value = SHADE.radius;
    shade.thickness.value = SHADE.thickness;
    parts.push(shade);
    // The shade fades with the haze, as the distance does.
    const hazed = smoothstep(dials.hazeNear, dials.hazeFar, viewZ.negate());
    const open = mix(pow(shade.getTextureNode().r, SHADE.power), float(1), hazed);
    developed = vec4(color.rgb.mul(mix(tone(SHADE.color), vec3(1), open)), 1);
  }
  // What glows is what is bright before it is shaded: shade does not reach a lamp's light.
  const glow = bloom(color, GLOW.strength, GLOW.radius, GLOW.threshold);
  glow.smoothWidth.value = GLOW.soft;
  parts.push(glow);
  const light = developed.rgb.add(glow.rgb);
  // The roll-off gives back the colour with its alpha.
  const film = toneMapping(ACESFilmicToneMapping, dials.exposure, vec4(light, 1)).rgb;
  const grey = film.r.add(film.g).add(film.b).div(3);
  const vivid = film.add(film.sub(grey).mul(SATURATE)).min(1);
  // Turned round, not with its edges given the other way about: Metal leaves a smoothstep from high to low undefined.
  const corners = float(1).sub(smoothstep(VIGNETTE.offset * 0.799, 0.8, distance(screenUV, vec2(0.5)).mul(VIGNETTE.darkness + VIGNETTE.offset)));
  const pipeline = new RenderPipeline(renderer, vec4(vivid.mul(corners), 1));
  return {
    pipeline,
    shot,
    dispose: () => {
      unflatten();
      pipeline.dispose();
      for (const part of parts) part.dispose();
    },
  };
}

type RenderContexts = { get: (renderTarget: unknown, mrt: unknown, callDepth?: number) => unknown };

/** The pictures each renderer draws in one render context, however deep in other renders it draws them (see flatten). */
const flat = new WeakMap<object, Set<unknown>>();

/**
 * Has `renderer` draw into `target` in one render context, however deep in other renders the call that draws it is,
 * until the returned function is called. Three keys the shaders it builds by the render context, and a context by how
 * deep the render call is: the darkroom draws the scene two calls down (from its output pass, through the glow), while
 * a compile draws at the top, so the first frame built every shader the compile had built again, all at once. Only the
 * scene pass draws into its own picture, so one context for it is never shared by two renders at a time.
 */
function flatten(renderer: WebGPURenderer, target: unknown): () => void {
  let targets = flat.get(renderer);
  if (!targets) {
    const own = new Set<unknown>();
    targets = own;
    flat.set(renderer, own);
    const contexts = (renderer as unknown as { _renderContexts: RenderContexts })._renderContexts;
    const get = contexts.get;
    contexts.get = (renderTarget, mrt, callDepth) => get.call(contexts, renderTarget, mrt, own.has(renderTarget) ? 0 : callDepth);
  }
  targets.add(target);
  return () => void targets.delete(target);
}

/**
 * Whether the page can be handed back between tasks at once (`scheduler.yield`). Three's compile yields after every
 * object and every stage of a shader; without it each yield waits for a frame, which for a village's hundreds of
 * objects takes longer than building them all in the first frame.
 */
const yieldsQuickly = () => typeof (globalThis as { scheduler?: { yield?: unknown } }).scheduler?.yield === 'function';

/**
 * Builds the shaders of everything the scene pass draws, a little at a time between tasks (three yields as it builds
 * them), before the first frame: built there, all at once, they held the page for seconds (see flatten for why the
 * first frame used to build them again). Its pipelines are made in the background as it goes (see making). A browser
 * that cannot yield quickly (see yieldsQuickly) builds them in the first frame instead.
 */
async function prebuild(renderer: WebGPURenderer, room: Darkroom): Promise<void> {
  if (!yieldsQuickly()) return;
  await compileFor(renderer, room, room.shot.scene, room.shot.scene as Scene);
}

/**
 * Builds the shaders `object` is drawn with in the scene pass, in the background, lit as `scene` is. What the compile
 * is for is taken as it starts: the pass's picture, its outputs, and `object` as it stands (shown, wherever it is).
 */
function compileFor(renderer: WebGPURenderer, room: Darkroom, object: Object3D, scene: Scene): Promise<void> {
  const { shot } = room;
  const target = renderer.getRenderTarget();
  const mrt = renderer.getMRT();
  renderer.setRenderTarget(shot.renderTarget);
  renderer.setMRT(shot.getMRT());
  try {
    return renderer.compileAsync(object, shot.camera, scene);
  } finally {
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt);
  }
}

/** Each renderer's darkroom while its Look is mounted: what {@link makeAhead} builds shaders for. */
const rooms = new WeakMap<object, Darkroom>();

/**
 * Builds the shaders `object` will be drawn with before it is first drawn, in the background: one built in the frame
 * that first draws it holds that frame (a guest's dog stalled the picture for a quarter of a second). `object` is made
 * as if shown wherever it stands, its own visibility and the camera's view aside. Resolves when they are made, or at
 * once where the renderer cannot be asked.
 */
export async function makeAhead(renderer: unknown, object: Object3D, scene: Scene): Promise<void> {
  const room = rooms.get(renderer as object);
  if (!room || typeof (renderer as Partial<WebGPURenderer>).compileAsync !== 'function') return;
  const hidden: Object3D[] = [];
  const culled: Object3D[] = [];
  object.traverse((part) => {
    if (!part.visible) hidden.push(part);
    if (part.frustumCulled) culled.push(part);
  });
  for (const part of hidden) part.visible = true;
  for (const part of culled) part.frustumCulled = false;
  let compiling: Promise<void>;
  try {
    compiling = compileFor(renderer as WebGPURenderer, room, object, scene);
  } finally {
    for (const part of hidden) part.visible = false;
    for (const part of culled) part.frustumCulled = true;
  }
  await compiling.catch(() => undefined);
}

/**
 * Says once that the scene can be drawn: when every island has been built (each says it is still to be built until it
 * is) and the shaders they are drawn with are built (see prebuild). Its first frames are then drawn out of sight while
 * the last of their pipelines are made (see making).
 */
function useWarm(renderer: WebGPURenderer, room: Darkroom, onWarm: () => void, village: string): void {
  const works = useContext(WorksContext);
  const darkroom = useRef(room);
  darkroom.current = room;
  useEffect(() => {
    let live = true;
    let frame = 0;
    const wait = () => {
      if (!live) return;
      if (works && works.pending > 0) {
        frame = requestAnimationFrame(wait);
        return;
      }
      void prebuild(renderer, darkroom.current)
        .catch(() => undefined)
        .then(() => {
          if (!live) return;
          if (works) works.warm = true;
          onWarm();
        });
    };
    // A frame on, when every island has said it is still to be built.
    frame = requestAnimationFrame(wait);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [renderer, works, onWarm, village]);
}

/** Everything about the picture that is not the village itself. Mounted once in a canvas, beside the homes. */
export function Look({ frame, snap = false, gaze = UNTOUCHED, inset = UNCOVERED, islands, mood, quality, onWarm, village = '' }: LookProps) {
  const renderer = useRenderer();
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const sun = useRef<DirectionalLight>(null);
  const shown = useRef<Frame | null>(null);
  /** Where the camera is on its way to the viewer's gaze. */
  const eased = useRef<Gaze>({ ...gaze.current, pan: { ...gaze.current.pan } });
  /** Where the middle of the frame is drawn, in pixels right and down of the canvas's own middle; it eases like the frame. */
  const shifted = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const last = useRef(0);
  const frames = useRef(0);
  const sky = useMemo(() => skyTexture(mood), [mood]);
  useEffect(() => () => sky.dispose(), [sky]);
  /** The air's haze; where it begins and ends follows the camera each frame. */
  const haze = useMemo(() => new Fog(mood.haze), [mood]);
  const dials = useMemo(makeDials, []);
  const fine = quality === 'high';
  const room = useMemo(() => darkroom(renderer, scene, camera, fine, dials), [renderer, scene, camera, fine, dials]);
  useEffect(() => {
    rooms.set(renderer, room);
    return () => {
      if (rooms.get(renderer) === room) rooms.delete(renderer);
      room.dispose();
    };
  }, [renderer, room]);
  useWarm(renderer, room, onWarm, village);
  // Another village is looked at from where the camera begins, at once: the viewer's gaze is put back there as well
  // (see Stage), and nothing of the lake laid out about the last home is eased over from.
  const arrived = useRef(village);
  useLayoutEffect(() => {
    if (arrived.current === village) return;
    arrived.current = village;
    shown.current = null;
    eased.current = { ...UNMOVED, pan: { ...UNMOVED.pan } };
  }, [village]);
  const works = useContext(WorksContext);
  /** Where the camera and the sun stood when they were last drawn from: a frame after either moved is a moving one. */
  const stood = useMemo(() => ({ view: new Matrix4(), projection: new Matrix4(), sun: new Vector3(), reach: 0 }), []);

  // The sky lights the scene, the air hazes its distance, and where nothing is drawn is deep water.
  useLayoutEffect(() => {
    const pmrem = new PMREMGenerator(renderer);
    const lit = pmrem.fromEquirectangular(sky);
    pmrem.dispose();
    scene.environment = lit.texture;
    scene.environmentIntensity = mood.skyPower;
    scene.fog = haze;
    renderer.setClearColor(mood.deep, 1);
    dials.exposure.value = mood.exposure;
    setLampGain(mood.lamps);
    camera.layers.enable(GRASS_LAYER);
    return () => {
      scene.environment = null;
      scene.fog = null;
      lit.dispose();
    };
  }, [renderer, scene, camera, sky, haze, mood, dials]);

  useFrame(() => {
    frames.current += 1;
    const light = sun.current;
    const now = performance.now();
    const elapsed = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    const current = (shown.current ??= { ...frame, target: [frame.target[0], frame.target[1], frame.target[2]] });
    const step = snap ? 1 : 1 - Math.exp(-elapsed * FOLLOW);
    // Each eases to where it is going and, near enough, is there: a camera that has arrived holds still (see Stage's Cadence).
    const near = (from: number, to: number, share: number, settled: number) => (Math.abs(to - from) <= settled ? to : from + (to - from) * share);
    for (const axis of [0, 1, 2] as const) current.target[axis] = near(current.target[axis], frame.target[axis], step, FRAME_SETTLED);
    for (const key of ['halfWidth', 'halfHeight', 'across', 'away', 'reach'] as const) current[key] = near(current[key], frame[key], step, FRAME_SETTLED);
    // The viewer's turn, tilt, move and zoom, each followed at its own pace; held still, the camera is there at once.
    const want = gaze.current;
    const at = eased.current;
    const swing = 1 - Math.exp(-elapsed * TURN_FOLLOW);
    const glide = 1 - Math.exp(-elapsed * ZOOM_FOLLOW);
    const follow = (from: number, to: number, share: number, settled: number) => (snap || Math.abs(to - from) <= settled ? to : from + (to - from) * share);
    at.turn = follow(at.turn, want.turn, swing, TURN_SETTLED);
    at.tilt = follow(at.tilt, want.tilt, swing, TURN_SETTLED);
    at.zoom = follow(at.zoom, want.zoom, glide, ZOOM_SETTLED);
    at.pan.x = follow(at.pan.x, want.pan.x, glide, PAN_SETTLED);
    at.pan.z = follow(at.pan.z, want.pan.z, glide, PAN_SETTLED);
    const azimuth = AZIMUTH + at.turn;
    const extent = turnedExtent(current, at.turn, at.tilt);
    // The frame is fitted to the part of the canvas the page's panels leave open, and drawn in the middle of it.
    const open = openArea(size.width, size.height, inset.current);
    const view = shifted.current;
    const first = view.width === 0;
    const ease = (from: number, to: number) => (first || snap ? to : near(from, to, step, VIEW_SETTLED));
    view.x = ease(view.x, open.x);
    view.y = ease(view.y, open.y);
    view.width = ease(view.width, open.width);
    view.height = ease(view.height, open.height);
    const target = [current.target[0] + at.pan.x, current.target[1], current.target[2] + at.pan.z] as const;
    const [x, y, z] = target;
    camera.zoom = zoomOf(extent, view.width, view.height) * at.zoom;
    // The camera stands as far back, and draws as far, as the lake runs in the canvas; the haze keeps its place over it.
    const { distance: away, far } = cameraRange(size.height, view.y, camera.zoom, y - WATER_LEVEL, camera.near, at.tilt);
    camera.far = far;
    stand(camera, target, azimuth, away, at.tilt);
    haze.near = away + HAZE_NEAR;
    haze.far = away + HAZE_FAR;
    // The whole canvas is drawn; the view is only moved so that the frame's middle falls in the open part's.
    if (Math.abs(view.x) > 0.5 || Math.abs(view.y) > 0.5) camera.setViewOffset(size.width, size.height, -view.x, -view.y, size.width, size.height);
    else if (camera.view?.enabled) camera.clearViewOffset();
    camera.updateProjectionMatrix();
    dials.near.value = camera.near;
    dials.far.value = camera.far;
    dials.hazeNear.value = haze.near;
    dials.hazeFar.value = haze.far;
    // A camera on the move (the viewer's hand, a new frame easing in) is drawn at the moving pace (see Stage's Cadence).
    const moving = !stood.view.equals(camera.matrixWorld) || !stood.projection.equals(camera.projectionMatrix);
    stood.view.copy(camera.matrixWorld);
    stood.projection.copy(camera.projectionMatrix);
    if (moving && works) works.activeAt = now;
    if (!light) return;
    // A low sun throws long shadows: what stands outside the view still shades what is in it. The view holds the
    // ground about the point it looks at as far as the frame reaches, foreshortened by the tilt, as much more zoomed out
    // (a home's neighbours come into it) and as much less zoomed in (the shadows of what is close are drawn as finely);
    // the shadows are cast over all of it as it lies to the sun: the light's square holds as much across the sun's way,
    // and along it as much as the sun's height foreshortens.
    const wide = extent.halfWidth / at.zoom;
    const deep = extent.halfHeight / Math.sin(at.tilt) / at.zoom;
    const facing = azimuth - Math.atan2(mood.toSun.x, mood.toSun.z);
    const across = wide * Math.abs(Math.cos(facing)) + deep * Math.abs(Math.sin(facing));
    const along = wide * Math.abs(Math.sin(facing)) + deep * Math.abs(Math.cos(facing));
    const reach = Math.max(across, along * mood.toSun.y) + SHADOW_MARGIN;
    // The sun stands back far enough for the ground nearest it to lie past its near plane, and draws as far again.
    const sunAway = Math.max(SUN_DISTANCE, (along + SHADOW_MARGIN) * Math.hypot(mood.toSun.x, mood.toSun.z) + SHADOW_MARGIN);
    light.position.set(x + mood.toSun.x * sunAway, y + mood.toSun.y * sunAway, z + mood.toSun.z * sunAway);
    light.target.position.set(x, y, z);
    light.target.updateMatrixWorld();
    const shadow = light.shadow.camera;
    const sunFar = sunAway * 2 + 40;
    if (Math.abs(shadow.right - reach) > 0.01 || Math.abs(shadow.far - sunFar) > 0.01) {
      shadow.left = shadow.bottom = -reach;
      shadow.right = shadow.top = reach;
      shadow.far = sunFar;
      shadow.updateProjectionMatrix();
    }
    // Shadows are cast afresh every other frame while the sun's square moves with the view (the frames the lake's mirror
    // is not drawn), and every fourth while it holds still: then only leaves sway and a guardian idles under it.
    const sunMoved = !stood.sun.equals(light.position) || stood.reach !== reach;
    stood.sun.copy(light.position);
    stood.reach = reach;
    light.shadow.autoUpdate = false;
    if (frames.current < 4 || frames.current % (sunMoved ? 2 : SHADOW_STILL_EVERY) === 1) light.shadow.needsUpdate = true;
  });

  // The picture is developed after everything in it has moved for the frame, in place of R3F's own drawing.
  useFrame(() => room.pipeline.render(), 1);

  // The shadow map keeps the size the canvas began with: a slower look taken up later does not make it again (three
  // would let go of the old one while a frame still drew with it).
  const [map] = useState(() => (fine ? 4096 : 2048));
  return (
    <>
      <directionalLight ref={sun} castShadow intensity={mood.sunPower} color={mood.sun} shadow-mapSize={[map, map]} shadow-bias={-0.0004} shadow-normalBias={0.05} shadow-radius={2.2}>
        <orthographicCamera attach="shadow-camera" args={[-12, 12, 12, -12, 1, SUN_DISTANCE * 2 + 40]} />
      </directionalLight>
      <Ocean mood={mood} sky={sky} islands={islands} quality={quality} />
    </>
  );
}
