import { Component, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type Ref, type RefObject } from 'react';

import { Canvas, useFrame, useThree, type Renderer } from '@react-three/fiber';
import { AdditiveBlending, CylinderGeometry, Matrix4, MeshBasicMaterial, PCFShadowMap, Plane, Raycaster, RingGeometry, Vector2, Vector3, type BufferGeometry, type Camera, type InstancedBufferGeometry, type Mesh, type Object3D, type Scene as World } from 'three';
import { WebGPURenderer } from 'three/webgpu';

import { Icon } from '../../ui/icons';
import type { Compat } from '../compat';
import type { Profile } from '../profile';
import { Bridge } from './Bridge';
import { Built, LampPool, Wind } from './Built';
import { FlagIsland, type StageFlag } from './Flag';
import { FLAG_ISLAND } from './flagIsland';
import { AZIMUTH, clampTilt, clampZoom, dragShift, ELEVATION, NO_INSET, wheelZoom, zoomShift, type Frame, type Inset, type Spot } from './frames';
import { loadDogModel, type DogModel } from './dogModel';
import { landingsOf } from './estateHome';
import { HomeEstate } from './HomeEstate';
import type { GuestNote } from './GuestPlaques';
import { Guardian } from './Guardian';
import { buildHome, buildLot, GUARDIAN_AT, type IslandKind } from './homes';
import { BOX } from './kit';
import { keptBuild } from './kept';
import { initialQuality, Look, UNMOVED, type Gaze, type Quality } from './look';
import { DUSK, WATER_LEVEL, type Mood } from './mood';
import { Stillness } from './parts';
import { ISLANDS, type IslandShape } from './terrain';
import { keepGlimpse, readGlimpse, takeGlimpse } from './glimpse';
import { makeInBackground, makingOf } from './making';
import { paintsPending } from './painter';
import { countWork, newWorks, useBuild, useMood, WorksContext, type Works } from './works';

// The village: every home on its own island in one lake at the day's last light, seen by one isometric camera that
// moves between a single home, two homes with their bridge, and the whole village, and that the viewer turns, tilts,
// moves and zooms about them. It is drawn with WebGPU, or with WebGL 2 where the browser has no WebGPU.

/** A home on the stage: where its island lies, and whose it is (nobody's yet when `profile` is null). */
export type StageHome = { id: string; x: number; z: number; profile: Profile | null };
/** A bridge the viewer built, from their own home to a neighbour's. */
export type StageBridge = { from: StageHome; to: StageHome; compat: Compat; colors: [string, string] };
/** An island's ground as the lake meets it: where its middle is, and its shape (see terrain). */
export type StageIsland = IslandShape & { x: number; z: number };

/** The guardian stands a little smaller than it was drawn, beside a house whose door is a metre high. */
const GUARDIAN_SCALE = 0.8;
/** Radians the camera turns, and tilts, for each pixel a drag crosses: a quarter turn across some 600 pixels. */
const TURN_PER_PIXEL = 0.0026;
const TILT_PER_PIXEL = 0.0026;
/** A press that has moved this far is a drag, as the islands count one: it moves the camera and visits nothing. */
const DRAG_PIXELS = 6;
/** Two presses this close in time and place are a double press: on the water it puts the camera back where it began. */
const DOUBLE_MS = 350;
const DOUBLE_PIXELS = 24;
const TAU = Math.PI * 2;
/**
 * The keys: how far they move the camera over the ground, in pixels of the picture a second, and how fast they turn it
 * and raise or lower it (radians a second); what one press of + or - zooms by.
 */
const KEY_MOVE = 560;
const KEY_TURN = 1.5;
const KEY_TILT = 0.9;
const KEY_ZOOM = 1.25;
/**
 * A press on something in the picture brings the camera to it and in at least this close (as a multiple of the
 * frame's own size), or by this much closer again when it is that close already.
 */
const CLOSE_IN = 2.6;
const CLOSER = 1.5;
/** A pressed point this far above the ground (metres) is something standing on it, not the lawn. */
const STANDING = 0.14;

/** What the keys do, by the key (its place on the keyboard, whatever it writes). */
type Move = 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight' | 'up' | 'down';
const KEYS: Readonly<Record<string, Move>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyQ: 'turnLeft',
  KeyE: 'turnRight',
  KeyR: 'up',
  PageUp: 'up',
  KeyF: 'down',
  PageDown: 'down',
};
const ZOOM_KEYS: Readonly<Record<string, number>> = { Equal: KEY_ZOOM, NumpadAdd: KEY_ZOOM, Minus: 1 / KEY_ZOOM, NumpadSubtract: 1 / KEY_ZOOM };

/**
 * Whether a key pressed in `target` is the page's own to use: typing, or moving within a panel, its tabs or a choice.
 * Elsewhere (nothing focused, the picture) the keys move the camera.
 */
function keptByPage(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], main, [role="dialog"], [role="tablist"], [role="radiogroup"], [role="menu"], [role="listbox"]');
}

/** Says nothing of a device that was let go on purpose: R3F lets the renderer go with its canvas. */
const SILENT = () => undefined;

/**
 * The village's renderer: WebGPU where the browser has it, else the same renderer on WebGL 2. R3F calls this with the
 * canvas and waits for it. A device lost afterwards is told to `lost`, unless it was let go with the canvas.
 */
export async function createRenderer({ canvas }: { canvas?: unknown }): Promise<Renderer> {
  const renderer = new WebGPURenderer({ canvas: canvas as HTMLCanvasElement, antialias: false, alpha: false, powerPreference: 'high-performance' });
  await renderer.init();
  // Its first frames are drawn out of sight, their pipelines made in the background (see making and Ready).
  makeInBackground(renderer);
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    renderer.onDeviceLost = SILENT;
    return dispose();
  };
  // R3F types the renderer it is given as WebGL's; it calls only what both have.
  return renderer as unknown as Renderer;
}

/**
 * The most device pixels the canvas draws to a CSS pixel. On a screen of twice the pixels the darkroom's passes (shade,
 * lens, glow) and every leaf would be drawn four times over; at one and a half the picture, soft with its lens and glow
 * already, reads as sharp for a little more than half of that.
 */
const MOST_DPR = 1.5;

/** Shadows from the sun, softened by sampling about each point (see the sun's `shadow-radius`). */
export const SHADOWS = { enabled: true, type: PCFShadowMap } as const;

/**
 * A dog's model once it has arrived. The canvas waits for it as it does for an island still to be built, until the dog
 * stands in the scene; a dog that cannot be fetched leaves its home without one.
 */
function useDog(id: string): DogModel | null {
  const works = useContext(WorksContext);
  const [loaded, setLoaded] = useState<{ id: string; model: DogModel } | null>(null);
  /** Gives back this dog's place among the works still to be done; only its first call counts. */
  const settle = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true;
    let counted = true;
    countWork(works, 1);
    const done = () => {
      if (counted && works) works.pending -= 1;
      counted = false;
    };
    settle.current = done;
    loadDogModel(id).then((model) => {
      if (live) setLoaded({ id, model });
    }, done);
    return () => {
      live = false;
      done();
    };
  }, [id, works]);
  const model = loaded?.id === id ? loaded.model : null;
  useEffect(() => {
    if (model) settle.current();
  }, [model]);
  return model;
}

/**
 * One home's island, house, garden and guardian, about the middle of its island; `origin` is where that is in the
 * village. Everything that stands still is built once for the chart's house (see homes), `turn` builds after the first.
 * The page's own island (`home`) is the larger and planted in full; a neighbour's is kept light.
 */
export function Diorama({ profile, origin, playful = false, lush = true, turn = 0, kind = 'home' }: { profile: Pick<Profile, 'house' | 'guardian'>; origin: readonly [number, number, number]; playful?: boolean; lush?: boolean; turn?: number; kind?: IslandKind }) {
  const { house, guardian } = profile;
  const make = useCallback(
    () => keptBuild(`home|${house.style}|${house.accent}|${house.symbol}|${lush}|${kind}`, () => buildHome({ style: house.style, accent: house.accent, symbol: house.symbol }, lush, kind)),
    [house.style, house.accent, house.symbol, lush, kind],
  );
  const build = useBuild(make, turn);
  const dog = useDog(guardian.dog);
  const charms = guardian.charms.map((item) => item.charm).join('+');
  if (!build) return null;
  return (
    <>
      <Built build={build} origin={origin} />
      {dog && (
        <group key={`${guardian.dog}:${charms}`} position={GUARDIAN_AT} scale={GUARDIAN_SCALE}>
          <Guardian guardian={guardian} model={dog} position={[0, 0, 0]} playful={playful} />
        </group>
      )}
    </>
  );
}

function EmptyLot({ origin, lush, turn, kind }: { origin: readonly [number, number, number]; lush: boolean; turn: number; kind: IslandKind }) {
  const make = useCallback(() => keptBuild(`lot|${lush}|${kind}`, () => buildLot(lush, kind)), [lush, kind]);
  const build = useBuild(make, turn);
  return build && <Built build={build} origin={origin} />;
}

/** The water about a neighbour's island that lights up under the pointer; a larger island's ring is as much larger. */
const HALO = new RingGeometry(6.3, 8.2, 72);
/**
 * What the pointer meets over the page's own island: an estate as round as its coast, which a box as wide would carry
 * out past its corners over the corner neighbours' islands.
 */
const DRUM = new CylinderGeometry(1, 1, 1, 48);

/**
 * A home's island in its place. The water about it lights up under the pointer when it can be visited. Memoized: the
 * page around the canvas renders again for every line in a guestbook, and a home is a great deal to go over.
 */
const Plot = memo(function Plot({ home, kind, turn, focused, lush, onVisit, landings, notes, onBoard }: { home: StageHome; kind: IslandKind; turn: number; focused: boolean; lush: boolean; onVisit: ((id: string) => void) | undefined; landings?: readonly number[]; notes?: readonly GuestNote[]; onBoard?: (() => void) | undefined }) {
  const [hovered, setHovered] = useState(false);
  const canvas = useThree((state) => state.gl.domElement);
  const glow = useMemo(() => new MeshBasicMaterial({ color: '#ffe2b0', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }), []);
  const origin = useMemo(() => [home.x, 0, home.z] as const, [home.x, home.z]);
  const visitable = !!onVisit && !focused;
  const { half, reach } = ISLANDS[kind];
  useEffect(() => () => glow.dispose(), [glow]);
  // Over an island that can be visited the canvas shows the hand that visits, in place of the one that turns it.
  useEffect(() => {
    if (!hovered) return undefined;
    canvas.style.cursor = 'pointer';
    return () => {
      canvas.style.cursor = '';
    };
  }, [hovered, canvas]);
  useEffect(() => {
    if (!visitable) setHovered(false);
  }, [visitable]);
  useFrame(() => {
    glow.opacity += ((hovered ? 0.2 : 0) - glow.opacity) * 0.16;
  });
  return (
    <group position={[home.x, 0, home.z]}>
      {/* The pointer meets one plain box about the island, not the thousands of shapes on it. */}
      {visitable && (
        <mesh
          geometry={kind === 'home' ? DRUM : BOX}
          position={[0, 1.8, 0]}
          scale={kind === 'home' ? [half, 5.4, half] : [(half - 0.2) * 2, 5.4, (half - 0.2) * 2]}
          visible={false}
          onClick={(event) => {
            // A drag across the island is not a visit.
            if (event.delta > DRAG_PIXELS) return;
            event.stopPropagation();
            onVisit(home.id);
          }}
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
        />
      )}
      <mesh geometry={HALO} material={glow} position={[0, WATER_LEVEL + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={reach / ISLANDS.neighbour.reach} renderOrder={1} />
      {home.profile ? (
        kind === 'home' ? (
          <HomeEstate profile={home.profile} origin={origin} playful={focused} lush={lush} turn={turn} bridges={landings} {...(notes ? { notes } : {})} onBoard={onBoard} />
        ) : (
          <Diorama profile={home.profile} origin={origin} playful={focused} lush={lush} turn={turn} kind={kind} />
        )
      ) : (
        <EmptyLot origin={origin} lush={lush} turn={turn} kind={kind} />
      )}
    </group>
  );
});

/** Keeps the page's labels over the islands they name: each `[data-pin]` in `layer` follows the home of that id. */
function Pins({ homes, layer }: { homes: readonly StageHome[]; layer: RefObject<HTMLDivElement | null> }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const point = useRef(new Vector3());
  /** What the labels were last placed for: they move only when the camera, the canvas or the labels themselves change. */
  const placed = useRef({ view: new Matrix4(), projection: new Matrix4(), width: 0, height: 0, count: -1, homes: null as readonly StageHome[] | null });
  useFrame(() => {
    const host = layer.current;
    if (!host) return;
    const last = placed.current;
    const count = host.childElementCount;
    if (last.homes === homes && last.count === count && last.width === size.width && last.height === size.height && last.view.equals(camera.matrixWorld) && last.projection.equals(camera.projectionMatrix)) return;
    last.homes = homes;
    last.count = count;
    last.width = size.width;
    last.height = size.height;
    last.view.copy(camera.matrixWorld);
    last.projection.copy(camera.projectionMatrix);
    // A browser without `overflow: clip` lets a focused label scroll the layer; the labels are placed for it unscrolled.
    if (host.scrollLeft || host.scrollTop) host.scrollLeft = host.scrollTop = 0;
    for (const element of host.querySelectorAll<HTMLElement>('[data-pin]')) {
      const home = homes.find((item) => item.id === element.dataset['pin']);
      if (!home) continue;
      point.current.set(home.x, home.profile ? 5.9 : 2.6, home.z).project(camera);
      const x = (point.current.x * 0.5 + 0.5) * size.width;
      const y = (-point.current.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      // A label whose island lies outside the picture is out of sight and out of the keyboard's way.
      const outside = x < 0 || x > size.width || y < 0 || y > size.height;
      if ((element.style.visibility === 'hidden') !== outside) element.style.visibility = outside ? 'hidden' : '';
      // A label stays out of sight until it has been put over its island.
      element.dataset['placed'] = '';
    }
  });
  return null;
}

type SceneProps = {
  frame: Frame;
  snap: boolean;
  /** Where the viewer has taken the camera. */
  gaze?: RefObject<Gaze>;
  /** The parts of the canvas under the page's panels. */
  inset?: RefObject<Inset>;
  /** Every island in the lake, for the water about them. */
  islands: readonly StageIsland[];
  mood: Mood;
  quality: Quality;
  still: boolean;
  /** Told once the scene can be drawn without a wait. */
  onWarm: () => void;
  /** Told, with whose village it is, once it has drawn every pipeline its first frames asked for: it can be shown. */
  onReady?: (village: string) => void;
  /** Whose village it is: another one is made ready, and told of, as the first was. */
  village?: string;
  children: ReactNode;
};

/** Everything the village's canvas and a saved picture's share: the hour, the camera's look, the lights, the wind. */
export function Scene({ frame, snap, gaze, inset, islands, mood, quality, still, onWarm, onReady, village = '', children }: SceneProps) {
  const works = useMemo<Works>(newWorks, []);
  return (
    <WorksContext.Provider value={works}>
      <Stillness value={still}>
        <Look frame={frame} snap={snap} {...(gaze ? { gaze } : {})} {...(inset ? { inset } : {})} islands={islands} mood={mood} quality={quality} onWarm={onWarm} village={village} />
        <Wind />
        <LampPool count={quality === 'high' ? 8 : 4} gain={mood.lamps}>
          <group dispose={null}>{children}</group>
        </LampPool>
        {onReady && <Ready village={village} onReady={onReady} />}
      </Stillness>
    </WorksContext.Provider>
  );
}

/** Frames drawn in a row asking for no pipeline still being made before the canvas shows: the shadows cast and the darkroom developed. */
const READY_FRAMES = 3;

/**
 * Says once that the canvas can be shown: its islands are built and the last few frames asked for no pipeline still
 * being made (see making). From then on a pipeline is made as a frame asks for it, and the canvas keeps its pace.
 * Another village (the page has gone to another 섬) is waited for again: out of sight, its islands built, its new
 * pipelines made in the background.
 */
function Ready({ village, onReady }: { village: string; onReady: (village: string) => void }) {
  const gl = useThree((state) => state.gl);
  const works = useContext(WorksContext);
  const seen = useRef({ frames: 0, done: false, village });
  useLayoutEffect(() => {
    const ready = seen.current;
    if (ready.village === village) return;
    ready.village = village;
    ready.frames = 0;
    ready.done = false;
    if (works) {
      works.warm = false;
      works.shown = false;
      // The bar counts this village's islands from here (see Meter).
      works.total = works.pending;
    }
    makingOf(gl)?.resume();
  }, [village, works, gl]);
  useFrame(() => {
    const ready = seen.current;
    if (ready.done || (works && !works.warm)) return;
    const making = makingOf(gl);
    // Its pipelines made, and the tiles its surfaces wear painted (see painter).
    if ((making && making.pending > 0) || paintsPending() > 0) {
      ready.frames = 0;
      return;
    }
    ready.frames += 1;
    if (ready.frames < READY_FRAMES) return;
    ready.done = true;
    making?.stop();
    if (works) works.shown = true;
    onReady(ready.village);
  }, 2);
  return null;
}

/** How far the bar over the canvas stands, 0 to 1: as a style property for its width and as its value for assistive technology. */
function setMeter(element: HTMLElement | null, value: number): void {
  if (!element) return;
  element.style.setProperty('--saju-progress', value.toFixed(3));
  element.setAttribute('aria-valuenow', String(Math.round(value * 100)));
}

/**
 * Moves the bar over the canvas (`bar`) while it makes `village` ready, by what it has done: the islands built (the
 * first half), then the shaders made for them, then the pipelines its first frames ask for and the tiles its surfaces
 * wear. The shaders are made in one go with nothing to count, so that stretch is crossed as time passes, never quite to
 * its end; the bar never goes back.
 */
function Meter({ bar, village }: { bar: RefObject<HTMLElement | null>; village: string }) {
  const gl = useThree((state) => state.gl);
  const works = useContext(WorksContext);
  useEffect(() => {
    if (!works) return undefined;
    let frame = 0;
    let shown = 0;
    let builtAt: number | null = null;
    const tick = (now: number) => {
      if (works.shown) {
        setMeter(bar.current, 1);
        return;
      }
      frame = requestAnimationFrame(tick);
      const making = makingOf(gl);
      let value: number;
      if (works.pending > 0 || (!works.warm && works.total === 0)) {
        value = 0.06 + 0.5 * (works.total > 0 ? (works.total - works.pending) / works.total : 0);
      } else if (!works.warm) {
        builtAt ??= now;
        value = 0.56 + 0.3 * (1 - Math.exp(-(now - builtAt) / 900));
      } else {
        value = 0.86 + 0.13 * (making && making.total > 0 ? (making.total - making.pending) / making.total : 1);
        if (paintsPending() > 0) value = Math.min(value, 0.9);
      }
      shown = Math.max(shown, value);
      setMeter(bar.current, shown);
    };
    setMeter(bar.current, 0.04);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [gl, works, bar, village]);
  return null;
}

/** How long the camera and the viewer's hand must have been still before the picture is kept (see glimpse). */
const KEEP_STILL_MS = 1500;
/** The pictures kept in this page's life: one for each, each visit. */
const kept = new Set<string>();

/**
 * Keeps what the canvas shows under `glimpse` (see glimpse) once it has shown its village and been still a moment, once
 * a visit: the next visit to it shows that picture while the canvas makes the village ready again. Taken right after a
 * frame is drawn (the callbacks after the darkroom's, in the same task).
 */
function Keepsake({ glimpse, touched }: { glimpse: string; touched: RefObject<number> }) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const works = useContext(WorksContext);
  useFrame(() => {
    if (!works?.shown || kept.has(glimpse) || document.visibilityState !== 'visible') return;
    if (performance.now() - Math.max(works.activeAt, touched.current ?? 0) < KEEP_STILL_MS) return;
    kept.add(glimpse);
    void takeGlimpse(gl.domElement, size.width, size.height).then((picture) => picture && keepGlimpse(glimpse, picture));
  }, 3);
  return null;
}

/** What a kept picture of the village is kept under: whose, framed how, at what size, under which light and look. */
function glimpseKey(village: string, frame: Frame, inset: Inset, area: { width: number; height: number }, mood: Mood, quality: Quality): string {
  const view = [...frame.target, frame.halfWidth, frame.halfHeight].map((value) => value.toFixed(1)).join(',');
  const cover = [inset.top, inset.right, inset.bottom, inset.left].map((value) => Math.round(value)).join(',');
  return [village, view, cover, `${Math.round(area.width)}x${Math.round(area.height)}`, mood === DUSK ? 'dusk' : 'day', quality].join('|');
}

/**
 * Frames a second while something moves (the camera, under the viewer's hand or easing to a new frame); while only the
 * scene's own life moves (waves, leaves, smoke); and while it is held still for a viewer who asked for less motion,
 * when nothing moves but what the page changes (another home built, a frame to go to).
 */
const MOVING_FPS = 60;
const LIVING_FPS = 30;
const STILL_FPS = 4;
/** How long after the camera last moved, or the viewer's hand was on the picture, the canvas keeps the moving pace. */
const MOVING_FOR_MS = 1200;

/**
 * Draws the canvas (its frame loop is R3F's `never`, each frame drawn with `advance`) as the screen refreshes, up to
 * {@link MOVING_FPS} a second, while it is being made ready or the camera moves; at {@link LIVING_FPS} while only the
 * scene's own life moves; at {@link STILL_FPS} when it is held still. A screen that refreshes 120 or 144 times a second
 * would otherwise have the village drawn as often, for nothing a viewer can see. `touched` is when the viewer's hand
 * was last on the picture (performance.now()): the camera moves from the next frame.
 */
function Cadence({ running, still, touched }: { running: boolean; still: boolean; touched: RefObject<number> }) {
  const advance = useThree((state) => state.advance);
  const works = useContext(WorksContext);
  useEffect(() => {
    if (!running) return undefined;
    let frame = 0;
    let last = -Infinity;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const moved = Math.max(works?.activeAt ?? 0, touched.current ?? 0);
      const moving = !works || !works.shown || now - moved < MOVING_FOR_MS;
      const fps = moving ? MOVING_FPS : still ? STILL_FPS : LIVING_FPS;
      if (works) works.interval = 1000 / fps;
      // A few milliseconds early still counts: a screen's refresh does not fall on the interval.
      if (now - last < 1000 / fps - 3) return;
      last = now;
      // R3F's clock reads the seconds it is given.
      advance(now / 1000);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, still, advance, works, touched]);
  return null;
}

/**
 * How much longer than the canvas's pace asks (see Cadence) the middle one of the measured frames may take before the
 * costly parts of the look are given up: at the moving pace, under 33 frames a second.
 */
const SLOW_EXCESS_MS = 30 - 1000 / 60;
const SETTLE_FRAMES = 90;
const MEASURED_FRAMES = 120;

/**
 * Watches how long frames take once the scene shows, against the pace they are drawn at, and says so once if they take
 * too long. It goes by the middle frame, not the average: a few stalls (a collection, a picture being taken, another
 * tab) are not the device's pace, and the slow look stays for as long as the page does.
 */
function Pace({ onSlow }: { onSlow: () => void }) {
  const works = useContext(WorksContext);
  const seen = useRef({ frames: 0, excess: [] as number[], last: 0, done: false });
  useFrame(() => {
    const pace = seen.current;
    const now = performance.now();
    const took = now - pace.last;
    pace.last = now;
    // A stall (the tab was hidden, a home was being built) is not the scene's own pace, nor a frame before it shows.
    if (pace.done || took > 250 || (works && !works.shown)) return;
    pace.frames += 1;
    if (pace.frames <= SETTLE_FRAMES) return;
    pace.excess.push(took - (works?.interval ?? 1000 / 60));
    if (pace.excess.length < MEASURED_FRAMES) return;
    pace.done = true;
    const middle = pace.excess.sort((a, b) => a - b)[Math.floor(MEASURED_FRAMES / 2)]!;
    if (middle > SLOW_EXCESS_MS) onSlow();
  });
  return null;
}

/** Shows `fallback` in place of a canvas that could not be made (a browser with neither WebGPU nor WebGL 2). */
class Failsafe extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the page around the canvas can ask of it. */
export type StageHandle = {
  /** Zooms in (a factor above 1) or out (below 1), within what the canvas allows. */
  zoomBy: (factor: number) => void;
};

/**
 * What a press at `point` on the canvas (a ray through it, as `camera` sees) meets first in `world` that stands above
 * the ground: what is drawn as scattered copies (leaves, grass) and the lake are passed through, and what is hidden.
 */
function standingAt(world: World, camera: Camera, point: Vector2): Vector3 | null {
  ray.setFromCamera(point, camera);
  const solid: Object3D[] = [];
  world.traverseVisible((object) => {
    const mesh = object as Mesh<BufferGeometry>;
    if (!mesh.isMesh || mesh.name === 'lake') return;
    if ((mesh.geometry as InstancedBufferGeometry).isInstancedBufferGeometry) return;
    solid.push(mesh);
  });
  const first = ray.intersectObjects(solid, false)[0];
  return first && first.point.y > STANDING ? first.point.clone() : null;
}

type StageProps = {
  ref?: Ref<StageHandle>;
  homes: readonly StageHome[];
  bridges: readonly StageBridge[];
  frame: Frame;
  /** The parts of the canvas the page's panels cover; the picture is fitted to the rest. */
  inset?: Inset;
  /** The island with the flag, for a village that has raised it. */
  flag?: StageFlag | null;
  /** The home in view, whose guardian plays; the others can be visited. */
  focus: string | null;
  onVisit?: (id: string) => void;
  /** Labels over the islands: elements carrying `data-pin` with a home's id. */
  pins?: ReactNode;
  /** What its owner has placed on the island at the village's middle (see Decor), in its own measure. */
  decor?: ReactNode;
  /**
   * Told of a press on the island at the village's middle, where on its ground, while something is being placed on it:
   * a press then places, and visits nothing.
   */
  onPlace?: ((spot: Spot) => void) | undefined;
  /** The guestbook's lines, hung on the page's own island's 기념 방명록; pressing it is told to `onBoard`. */
  notes?: readonly GuestNote[];
  onBoard?: (() => void) | undefined;
  /** Told of a press on the bare ground of the island at the village's middle, where (the viewer's dog walks there). */
  onWalk?: ((spot: Spot) => void) | undefined;
  /** Laid over the picture, under the labels: what the scene places over it (the walkers' names and clouds). */
  overlay?: ReactNode;
};

/** The page's own island stands at the village's middle; every other home's is a neighbour's. */
const kindAt = (index: number): IslandKind => (index === 0 ? 'home' : 'neighbour');

/** Whether `spot` on the water's level lies over the firm ground of `island` (a rounded square about its middle). */
function over(island: StageIsland, spot: Spot): boolean {
  const flat = island.half - island.corner;
  const dx = Math.max(Math.abs(spot.x - island.x) - flat, 0);
  const dz = Math.max(Math.abs(spot.z - island.z) - flat, 0);
  return Math.hypot(dx, dz) <= island.corner;
}

const ray = new Raycaster();
const pointer = new Vector2();
const level = new Plane(new Vector3(0, 1, 0), 0);
const hit = new Vector3();
const facing = new Vector3();

/**
 * The spot on the level plane `height` metres up that the canvas shows at (`x`, `y`), in pixels from its top left
 * corner, as `camera` sees it; null for a camera that has not looked yet.
 */
function groundAt(camera: Camera | null, box: DOMRect, x: number, y: number, height: number): Spot | null {
  if (!camera || box.width <= 0 || box.height <= 0) return null;
  pointer.set(((x - box.left) / box.width) * 2 - 1, -((y - box.top) / box.height) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  level.constant = -height;
  return ray.ray.intersectPlane(level, hit) ? { x: hit.x, z: hit.z } : null;
}

/**
 * The village's canvas. It draws while it is on screen, and holds still for a viewer who asked for less motion. A drag,
 * or a finger, moves what the camera looks at about the village, as a map is moved; a drag with the right button or
 * with shift held turns the camera about what it shows all the way round and tilts it between a low look across the
 * water and one nearly straight down, as two fingers turning about each other turn it and two fingers moved up or down
 * together tilt it. The wheel (toward the pointer), two fingers pinching, or the page's own buttons (through `ref`) zoom
 * it in and out. The keys move it too: W A S D or the arrows forward, back and to either side as it faces, Q and E turn
 * it, R and F (or Page Up and Page Down) raise and lower it, + and - zoom, Home puts it back. A press on something
 * standing on the island in view brings the camera to it and in close; a double press on the water puts it back where
 * it began.
 */
export function Stage({ ref, homes, bridges, frame, inset = NO_INSET, flag = null, focus, onVisit, pins, decor, onPlace, notes, onBoard, onWalk, overlay }: StageProps) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const gaze = useRef<Gaze>({ ...UNMOVED, pan: { ...UNMOVED.pan } });
  /** Whose village it is: the home at its middle. */
  const village = homes[0]?.id ?? '';
  // Another village begins where the camera begins, as the first did.
  useLayoutEffect(() => {
    gaze.current = { ...UNMOVED, pan: { ...UNMOVED.pan } };
  }, [village]);
  const cover = useRef(inset);
  cover.current = inset;
  /** The camera, once the canvas has made it: what lies under the pointer is found through it. */
  const eye = useRef<Camera | null>(null);
  /** The scene, once the canvas has made it: what a press lands on is found in it. */
  const world = useRef<World | null>(null);
  // The islands, and how far the point the camera looks at may be moved: over the village, no further than its islands go.
  // Where the bridges land on the page's own island: its estate lays a way to each.
  const landings = useMemo(() => landingsOf(bridges.map((bridge) => bridge.to)), [bridges]);
  const islands = useMemo<StageIsland[]>(
    () => [...homes.map((home, index) => ({ x: home.x, z: home.z, ...ISLANDS[kindAt(index)] })), ...(flag ? [{ x: flag.x, z: flag.z, ...FLAG_ISLAND }] : [])],
    [homes, flag],
  );
  const bounds = useRef({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  bounds.current = {
    minX: Math.min(...islands.map((island) => island.x - island.half)),
    maxX: Math.max(...islands.map((island) => island.x + island.half)),
    minZ: Math.min(...islands.map((island) => island.z - island.half)),
    maxZ: Math.max(...islands.map((island) => island.z + island.half)),
  };
  const aim = useRef(frame.target);
  aim.current = frame.target;
  /** Moves the point the camera looks at by `shift`, as far as the village's islands go. */
  const moveBy = (shift: Spot) => {
    const { pan } = gaze.current;
    const [x, , z] = aim.current;
    const { minX, maxX, minZ, maxZ } = bounds.current;
    pan.x = Math.min(maxX - x, Math.max(minX - x, pan.x + shift.x));
    pan.z = Math.min(maxZ - z, Math.max(minZ - z, pan.z + shift.z));
  };
  // A new frame (another home, or the whole village) is looked at from its own middle.
  const [aimX, , aimZ] = frame.target;
  useEffect(() => {
    gaze.current.pan = { x: 0, z: 0 };
  }, [aimX, aimZ]);
  /** The way the camera faces now, as it eases: its turn about the vertical and its height above the ground. */
  const bearing = () => {
    const camera = eye.current;
    if (!camera) return { azimuth: AZIMUTH + gaze.current.turn, tilt: gaze.current.tilt };
    camera.getWorldDirection(facing);
    return { azimuth: Math.atan2(-facing.x, -facing.z), tilt: Math.asin(Math.min(1, Math.max(-1, -facing.y))) };
  };
  /** Zooms by `factor` toward what lies at (`x`, `y`) on the page, or about the picture's middle without a place. */
  const zoomAt = (factor: number, x?: number, y?: number) => {
    const before = gaze.current.zoom;
    const after = clampZoom(before * factor);
    gaze.current.zoom = after;
    const element = box.current;
    if (x === undefined || y === undefined || !element || after === before) return;
    const [tx, ty, tz] = aim.current;
    const { pan } = gaze.current;
    const under = groundAt(eye.current, element.getBoundingClientRect(), x, y, ty);
    if (under) moveBy(zoomShift(under, { x: tx + pan.x, z: tz + pan.z }, before, after));
  };
  /** Puts the camera back where it began: unturned (the nearest whole turn round), untilted, unmoved and unzoomed. */
  const reset = () => {
    const now = gaze.current;
    gaze.current = { turn: Math.round(now.turn / TAU) * TAU, tilt: ELEVATION, pan: { x: 0, z: 0 }, zoom: 1 };
  };
  /**
   * Brings the camera to `point` and in close: the point it looks at becomes the one at its own height straight in front
   * of `point` as the camera will face, so that `point` is in the middle of the view.
   */
  const closeIn = (point: Vector3) => {
    const want = gaze.current;
    const azimuth = AZIMUTH + want.turn;
    const [tx, ty, tz] = aim.current;
    const back = (point.y - ty) / Math.sin(want.tilt);
    const x = point.x - Math.cos(want.tilt) * Math.sin(azimuth) * back;
    const z = point.z - Math.cos(want.tilt) * Math.cos(azimuth) * back;
    moveBy({ x: x - (tx + want.pan.x), z: z - (tz + want.pan.z) });
    want.zoom = clampZoom(want.zoom >= CLOSE_IN * 0.98 ? want.zoom * CLOSER : CLOSE_IN);
  };
  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor) => {
        touched.current = performance.now();
        gaze.current.zoom = clampZoom(gaze.current.zoom * factor);
      },
    }),
    [],
  );
  const drag = useRef<{ pointer: number; x: number; y: number; fromX: number; fromY: number; kept: boolean; turn: boolean } | null>(null);
  /** When the viewer's hand was last on the picture: the canvas draws at its moving pace from then (see Cadence). */
  const touched = useRef(0);
  /** Fingers on the picture, by pointer; two of them pinch and move, and how far apart they were and where their middle was is what the next move compares with. */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const spread = useRef(0);
  const middle = useRef<{ x: number; y: number } | null>(null);
  /** The way from one finger to the other: two fingers turning about each other turn the camera as far. */
  const twist = useRef<number | null>(null);
  /** The last press that was not a drag, for a double press. */
  const tapped = useRef<{ at: number; x: number; y: number } | null>(null);
  const apart = () => {
    const [a, b] = [...touches.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const centreOf = () => {
    const [a, b] = [...touches.current.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };
  const angleOf = () => {
    const [a, b] = [...touches.current.values()];
    return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : null;
  };
  // The wheel zooms. Heard as the page's own listener, not React's passive one: a pinch on a trackpad arrives as a
  // wheel with ctrl held, which the browser would otherwise take to zoom the whole page.
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      touched.current = performance.now();
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      zoomAt(wheelZoom(event.deltaY * lines, event.ctrlKey), event.clientX, event.clientY);
    };
    // Safari says a trackpad's pinch in events of its own, each with how far apart the fingers are against where they
    // began, and magnifies the whole page unless they are taken. Fingers on a touch screen are heard as pointers.
    let last = 1;
    const pinch = (event: Event) => {
      event.preventDefault();
      touched.current = performance.now();
      const { scale, clientX, clientY } = event as Event & { scale?: unknown; clientX?: number; clientY?: number };
      if (typeof scale !== 'number' || !(scale > 0)) return;
      if (event.type === 'gesturechange' && touches.current.size === 0) zoomAt(scale / last, clientX, clientY);
      last = scale;
    };
    // A drag with the right button turns the picture: the canvas keeps the menu that button would open.
    const menu = (event: MouseEvent) => {
      if (event.target instanceof HTMLCanvasElement) event.preventDefault();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', pinch);
    element.addEventListener('gesturechange', pinch);
    element.addEventListener('contextmenu', menu);
    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', pinch);
      element.removeEventListener('gesturechange', pinch);
      element.removeEventListener('contextmenu', menu);
    };
    // What the first render's handlers read, they read through refs.
  }, []);
  // The keys move, turn, raise and zoom the camera while they are held (a frame at a time), wherever the page leaves
  // them to it (see keptByPage).
  const pressed = useRef(new Set<Move>());
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const step = (now: number) => {
      const moves = pressed.current;
      if (moves.size === 0) {
        frame = 0;
        return;
      }
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      touched.current = now;
      const along = (moves.has('forward') ? 1 : 0) - (moves.has('back') ? 1 : 0);
      const across = (moves.has('right') ? 1 : 0) - (moves.has('left') ? 1 : 0);
      const zoom = eye.current && 'zoom' in eye.current ? (eye.current.zoom as number) : 0;
      if ((along || across) && zoom > 0) {
        const { azimuth } = bearing();
        const metres = (KEY_MOVE * elapsed) / zoom / Math.hypot(along, across);
        // Forward is the way the camera faces, over the ground; right is across it.
        moveBy({ x: (-Math.sin(azimuth) * along + Math.cos(azimuth) * across) * metres, z: (-Math.cos(azimuth) * along - Math.sin(azimuth) * across) * metres });
      }
      const turn = (moves.has('turnLeft') ? 1 : 0) - (moves.has('turnRight') ? 1 : 0);
      if (turn) gaze.current.turn += turn * KEY_TURN * elapsed;
      const rise = (moves.has('up') ? 1 : 0) - (moves.has('down') ? 1 : 0);
      if (rise) gaze.current.tilt = clampTilt(gaze.current.tilt + rise * KEY_TILT * elapsed);
      frame = requestAnimationFrame(step);
    };
    const down = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || keptByPage(event.target)) return;
      const move = KEYS[event.code];
      const factor = ZOOM_KEYS[event.code];
      if (!move && !factor && event.code !== 'Home') return;
      event.preventDefault();
      touched.current = performance.now();
      if (event.code === 'Home') return reset();
      if (factor) return void zoomAt(factor);
      pressed.current.add(move!);
      if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };
    const up = (event: KeyboardEvent) => {
      const move = KEYS[event.code];
      if (move) pressed.current.delete(move);
    };
    // Keys let go while the window was elsewhere are never heard: whatever was held is let go with it.
    const away = () => pressed.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', away);
      cancelAnimationFrame(frame);
    };
    // What the first render's handlers read, they read through refs.
  }, []);
  const press = (event: PointerEvent<HTMLDivElement>) => {
    touched.current = performance.now();
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      spread.current = apart();
      middle.current = centreOf();
      twist.current = angleOf();
      // A second finger makes it a pinch: the first one's drag ends, as letting go ends it.
      if (touches.current.size > 1) {
        drag.current = null;
        tapped.current = null;
        delete event.currentTarget.dataset['turning'];
        return;
      }
    }
    const right = event.pointerType === 'mouse' && event.button === 2;
    if (event.pointerType === 'mouse' && event.button !== 0 && !right) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, fromX: event.clientX, fromY: event.clientY, kept: false, turn: right || event.shiftKey };
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    spread.current = apart();
    middle.current = centreOf();
    twist.current = angleOf();
    const held = drag.current;
    if (held?.pointer !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset['turning'];
    // A press that stayed a press, on the picture itself: two of them close together on the water undo the viewer's moves.
    if (held.kept || held.turn || event.type !== 'pointerup' || !(event.target instanceof HTMLCanvasElement)) return;
    // Placing something: a press on the home's island puts it there.
    if (onPlace) {
      const element = box.current;
      const home = islands[0];
      const spot = element && groundAt(eye.current, element.getBoundingClientRect(), event.clientX, event.clientY, 0);
      if (spot && home && over(home, spot)) onPlace({ x: spot.x - home.x, z: spot.z - home.z });
      return;
    }
    const now = performance.now();
    const before = tapped.current;
    tapped.current = { at: now, x: event.clientX, y: event.clientY };
    const element = box.current;
    const camera = eye.current;
    if (before && now - before.at <= DOUBLE_MS && Math.hypot(event.clientX - before.x, event.clientY - before.y) <= DOUBLE_PIXELS) {
      tapped.current = null;
      const spot = element && groundAt(camera, element.getBoundingClientRect(), event.clientX, event.clientY, WATER_LEVEL);
      if (!spot || !islands.some((island) => over(island, spot))) return reset();
    }
    // Something standing on an island the press does not visit (a neighbour's is visited: see Plot): the camera goes to it.
    if (!element || !camera || !world.current) return;
    const area = element.getBoundingClientRect();
    if (area.width <= 0 || area.height <= 0) return;
    pointer.set(((event.clientX - area.left) / area.width) * 2 - 1, -((event.clientY - area.top) / area.height) * 2 + 1);
    const hit = standingAt(world.current, camera, pointer);
    if (!hit) {
      // The bare ground of the page's own island: the viewer's dog walks there.
      const ground = groundAt(camera, area, event.clientX, event.clientY, 0);
      const home = islands[0];
      if (onWalk && ground && home && over(home, ground)) onWalk(ground);
      return;
    }
    const visited = homes.findIndex((home, index) => !!onVisit && home.id !== focus && over(islands[index]!, { x: hit.x, z: hit.z }));
    if (visited >= 0) return;
    closeIn(hit);
  };
  // The box's own capture ending ends the drag. One that bubbles up from the canvas or a label only says the pointer
  // has come over to the box.
  const lost = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) release(event);
  };
  const pull = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current || touches.current.size > 0) touched.current = performance.now();
    const finger = touches.current.get(event.pointerId);
    if (finger) {
      finger.x = event.clientX;
      finger.y = event.clientY;
      if (touches.current.size > 1) {
        // Two fingers zoom by how far apart they move, toward their middle, move the picture as their middle moves, and
        // turn it as they turn about each other.
        const now = apart();
        const centre = centreOf();
        const was = middle.current;
        const angle = angleOf();
        if (angle !== null && twist.current !== null) {
          const turned = Math.atan2(Math.sin(angle - twist.current), Math.cos(angle - twist.current));
          gaze.current.turn += turned;
        }
        twist.current = angle;
        if (centre && was) {
          const { azimuth, tilt } = bearing();
          const zoom = eye.current && 'zoom' in eye.current ? (eye.current.zoom as number) : 0;
          const [right, down] = [centre.x - was.x, centre.y - was.y];
          // Moved up or down together, as far apart as they were: the camera is raised or lowered, as a drag with
          // shift does. Any other way, the picture moves with them.
          if (Math.abs(down) > Math.abs(right) * 1.5 && Math.abs(now - spread.current) < Math.abs(down) * 0.5) gaze.current.tilt = clampTilt(gaze.current.tilt + down * TILT_PER_PIXEL);
          else if (zoom > 0) moveBy(dragShift(right, down, zoom, azimuth, tilt));
        }
        if (spread.current > 0 && now > 0) zoomAt(now / spread.current, centre?.x, centre?.y);
        spread.current = now;
        middle.current = centre;
        return;
      }
    }
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    // The press ended where this box did not hear it (outside the picture, before the pointer was kept): a mouse or a
    // pen moving over the picture with nothing held down. A finger moves only while it touches.
    if (event.pointerType !== 'touch' && event.buttons === 0) return release(event);
    const right = event.clientX - held.x;
    const down = event.clientY - held.y;
    held.x = event.clientX;
    held.y = event.clientY;
    if (held.turn) {
      gaze.current.turn -= right * TURN_PER_PIXEL;
      gaze.current.tilt = clampTilt(gaze.current.tilt + down * TILT_PER_PIXEL);
    } else {
      const { azimuth, tilt } = bearing();
      const zoom = eye.current && 'zoom' in eye.current ? (eye.current.zoom as number) : 0;
      if (zoom > 0) moveBy(dragShift(right, down, zoom, azimuth, tilt));
    }
    // Past a drag's length the picture keeps the pointer: it goes on moving outside the canvas, and letting go is no
    // click on an island or a label.
    if (!held.kept && Math.hypot(event.clientX - held.fromX, event.clientY - held.fromY) > DRAG_PIXELS) {
      held.kept = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset['turning'] = '';
    }
  };
  const [inView, setInView] = useState(true);
  /** A lost device comes back with a fresh canvas. */
  const [generation, setGeneration] = useState(0);
  /** The canvas draws once its materials are ready, and stays out of sight until it has drawn. */
  const [warm, setWarm] = useState(false);
  // Whose village the canvas last showed: going to another 섬 keeps the canvas, out of sight until it shows that one.
  const [drawnFor, setDrawnFor] = useState<string | null>(null);
  const drawn = drawnFor === village;
  const [still] = useState(calm);
  // The gardens are planted once, for the device the page opened on.
  const [first] = useState(initialQuality);
  // Frames were taking too long: the costly parts of the look are given up and the canvas drawn at the screen's plain grain.
  const [slow, setSlow] = useState(false);
  const quality = slow ? 'low' : first;
  const lush = first === 'high';
  const mood = useMood();
  const warmed = useCallback(() => setWarm(true), []);
  const shown = useCallback((of: string) => setDrawnFor(of), []);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  /** The bar over the canvas while it makes the village ready (see Meter). */
  const meter = useRef<HTMLDivElement>(null);
  // The canvas's size on the page: a kept picture of the village lines up with it only at the size it was taken at.
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setArea((was) => (was && Math.round(was.width) === Math.round(width) && Math.round(was.height) === Math.round(height) ? was : { width, height }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const glimpse = area && glimpseKey(village, frame, inset, area, mood, quality);
  // The picture this browser kept of the village as it is framed now, shown while the canvas makes it ready.
  const [picture, setPicture] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!glimpse || drawn) return undefined;
    let live = true;
    void readGlimpse(glimpse).then((blob) => {
      if (!live || !blob) return;
      setPicture({ key: glimpse, url: URL.createObjectURL(blob) });
    });
    return () => {
      live = false;
    };
  }, [glimpse, drawn]);
  useEffect(() => (picture ? () => URL.revokeObjectURL(picture.url) : undefined), [picture]);
  return (
    <div className="mg-saju-canvas" ref={box} data-drawn={drawn ? village : undefined} data-placing={onPlace ? '' : undefined} onPointerDown={press} onPointerMove={pull} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={lost}>
      {picture && picture.key === glimpse && <img className="mg-saju-glimpse" src={picture.url} alt="" draggable={false} />}
      {/* What the canvas shows is said in words beside it; the labels over it are the page's own links. */}
      <Failsafe fallback={<p className="mg-saju-canvas-failed">이 브라우저에서는 마을을 그릴 수 없어요</p>}>
        <Canvas
          key={generation}
          aria-hidden="true"
          orthographic
          flat
          shadows={SHADOWS}
          dpr={slow ? 1 : [1, MOST_DPR]}
          frameloop="never"
          gl={createRenderer}
          camera={{ near: 1, far: 400, position: [60, 60, 60] }}
          onCreated={({ gl, camera, scene }) => {
            eye.current = camera;
            world.current = scene ?? null;
            (gl as unknown as WebGPURenderer).onDeviceLost = () => {
              setWarm(false);
              setDrawnFor(null);
              setGeneration((count) => count + 1);
            };
          }}
        >
          <Scene frame={frame} snap={still} gaze={gaze} inset={cover} islands={islands} mood={mood} quality={quality} still={still} onWarm={warmed} onReady={shown} village={village}>
            {homes.map((home, index) => (
              <Plot key={`${home.id}:${home.profile ? 'home' : 'lot'}`} home={home} kind={kindAt(index)} turn={index} focused={home.id === focus} lush={lush} onVisit={onVisit} {...(index === 0 ? { landings, ...(notes ? { notes } : {}), onBoard } : {})} />
            ))}
            {bridges.map((bridge) => (
              <Bridge key={`${bridge.to.id}:${bridge.colors.join()}`} from={[bridge.from.x, bridge.from.z]} to={[bridge.to.x, bridge.to.z]} colors={bridge.colors} tone={bridge.compat.tone} />
            ))}
            {flag && <FlagIsland flag={flag} lush={lush} turn={homes.length} />}
            {decor}
            <Cadence running={inView && warm} still={still} touched={touched} />
            {!slow && <Pace onSlow={() => setSlow(true)} />}
            <Meter bar={meter} village={village} />
            {glimpse && <Keepsake glimpse={glimpse} touched={touched} />}
          </Scene>
          <Pins homes={homes} layer={layer} />
        </Canvas>
      </Failsafe>
      {overlay}
      <div className="mg-saju-pins" ref={layer}>
        {pins}
      </div>
      {!drawn && (
        <div className="mg-saju-meter" ref={meter} role="progressbar" aria-label="섬 불러오는 중" aria-valuemin={0} aria-valuemax={100}>
          <div className="mg-loading-card mg-glass">
            <span className="mg-brand-mark" aria-hidden="true">
              <Icon name="island" />
            </span>
            <b>불러오는 중</b>
            <span className="mg-progress">
              <i />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

