import { Component, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, HalfFloatType, MeshBasicMaterial, RingGeometry, Vector3, WebGLRenderTarget } from 'three';

import type { Compat } from '../compat';
import type { Profile } from '../profile';
import { Bridge } from './Bridge';
import type { Build } from './build';
import { Built, LampPool, Wind } from './Built';
import type { Frame } from './frames';
import { Guardian } from './Guardian';
import { buildHome, buildLot, GUARDIAN_AT } from './homes';
import { BOX } from './kit';
import { initialQuality, Look, type Quality } from './look';
import { DUSK, GOLDEN, WATER_LEVEL, type Mood } from './mood';
import { Stillness } from './parts';

// The village: every home on its own island in one lake at the day's last light, seen by one fixed isometric camera
// that moves between a single home, two homes with their bridge, and the whole village.

/** A home on the stage: where its island lies, and whose it is (nobody's yet when `profile` is null). */
export type StageHome = { id: string; x: number; z: number; profile: Profile | null };
/** A bridge the viewer built, from their own home to a neighbour's. */
export type StageBridge = { from: StageHome; to: StageHome; compat: Compat; colors: [string, string] };

/** The guardian stands a little smaller than it was drawn, beside a house whose door is a metre high. */
const GUARDIAN_SCALE = 0.8;
/** Milliseconds between one island's building and the next. */
const BUILD_EVERY_MS = 60;

/** The hour the village is seen at: sunset under the light theme, dusk under the dark one. */
export function useMood(): Mood {
  const read = () => (typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark' ? DUSK : GOLDEN);
  const [mood, setMood] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMood(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return mood;
}

/** How many islands are still to be built: the canvas waits for them before it draws its first frame. */
type Works = { pending: number };
const WorksContext = createContext<Works | null>(null);

/**
 * What `make` builds, a little after mounting and `turn` builds after the first: a village is built an island at a
 * time, between which the page can answer, instead of all at once.
 */
function useBuild(make: () => Build, turn: number): Build | null {
  const works = useContext(WorksContext);
  const [build, setBuild] = useState<Build | null>(null);
  useEffect(() => {
    let counted = true;
    if (works) works.pending += 1;
    const settle = () => {
      if (counted && works) works.pending -= 1;
      counted = false;
    };
    const timer = setTimeout(() => {
      setBuild(make());
      settle();
    }, turn * BUILD_EVERY_MS);
    return () => {
      clearTimeout(timer);
      settle();
    };
  }, [make, turn, works]);
  return build;
}

/**
 * One home's island, house, garden and guardian, about the middle of its island; `origin` is where that is in the
 * village. Everything that stands still is built once for the chart's house (see homes), `turn` builds after the first.
 */
export function Diorama({ profile, origin, playful = false, lush = true, turn = 0 }: { profile: Pick<Profile, 'house' | 'guardian'>; origin: readonly [number, number, number]; playful?: boolean; lush?: boolean; turn?: number }) {
  const { house, guardian } = profile;
  const make = useCallback(() => buildHome({ style: house.style, accent: house.accent, symbol: house.symbol }, lush), [house.style, house.accent, house.symbol, lush]);
  const build = useBuild(make, turn);
  const charms = guardian.charms.map((item) => item.charm).join('+');
  if (!build) return null;
  return (
    <>
      <Built build={build} origin={origin} />
      <group key={`${guardian.animal}:${guardian.color}:${charms}`} position={GUARDIAN_AT} scale={GUARDIAN_SCALE}>
        <Guardian guardian={guardian} position={[0, 0, 0]} playful={playful} />
      </group>
    </>
  );
}

function EmptyLot({ origin, lush, turn }: { origin: readonly [number, number, number]; lush: boolean; turn: number }) {
  const make = useCallback(() => buildLot(lush), [lush]);
  const build = useBuild(make, turn);
  return build && <Built build={build} origin={origin} />;
}

const HALO = new RingGeometry(6.3, 8.2, 72);

/**
 * A home's island in its place. The water about it lights up under the pointer when it can be visited. Memoized: the
 * page around the canvas renders again for every line in a guestbook, and a home is a great deal to go over.
 */
const Plot = memo(function Plot({ home, turn, focused, lush, onVisit }: { home: StageHome; turn: number; focused: boolean; lush: boolean; onVisit: ((id: string) => void) | undefined }) {
  const [hovered, setHovered] = useState(false);
  const glow = useMemo(() => new MeshBasicMaterial({ color: '#ffe2b0', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }), []);
  const origin = useMemo(() => [home.x, 0, home.z] as const, [home.x, home.z]);
  const visitable = !!onVisit && !focused;
  useEffect(() => () => glow.dispose(), [glow]);
  useEffect(() => {
    if (!hovered) return undefined;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);
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
          geometry={BOX}
          position={[0, 1.8, 0]}
          scale={[10.6, 5.4, 10.6]}
          visible={false}
          onClick={(event) => {
            // A drag across the island is not a visit.
            if (event.delta > 6) return;
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
      <mesh geometry={HALO} material={glow} position={[0, WATER_LEVEL + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1} />
      {home.profile ? <Diorama profile={home.profile} origin={origin} playful={focused} lush={lush} turn={turn} /> : <EmptyLot origin={origin} lush={lush} turn={turn} />}
    </group>
  );
});

/** Keeps the page's labels over the islands they name: each `[data-pin]` in `layer` follows the home of that id. */
function Pins({ homes, layer }: { homes: readonly StageHome[]; layer: RefObject<HTMLDivElement | null> }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const point = useRef(new Vector3());
  useFrame(() => {
    const host = layer.current;
    if (!host) return;
    for (const element of host.querySelectorAll<HTMLElement>('[data-pin]')) {
      const home = homes.find((item) => item.id === element.dataset['pin']);
      if (!home) continue;
      point.current.set(home.x, home.profile ? 5.9 : 2.6, home.z).project(camera);
      const x = (point.current.x * 0.5 + 0.5) * size.width;
      const y = (-point.current.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      // A label stays out of sight until it has been put over its island.
      element.dataset['placed'] = '';
    }
  });
  return null;
}

/**
 * Has the graphics card make ready everything the scene is drawn with, once its islands are built, and says when it
 * has: the first frame then draws at once instead of holding the page while every material is made ready.
 */
function Warm({ onWarm }: { onWarm: () => void }) {
  const works = useContext(WorksContext);
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    let live = true;
    let frame = 0;
    const wait = () => {
      if (!live) return;
      if (works && works.pending > 0) {
        frame = requestAnimationFrame(wait);
        return;
      }
      // Made ready as the frame will use them: drawn into a picture of light's own values, not onto the screen.
      const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
      const before = gl.getRenderTarget();
      gl.setRenderTarget(target);
      const ready = gl.compileAsync(scene, camera).catch(() => undefined);
      gl.setRenderTarget(before);
      void ready.then(() => {
        target.dispose();
        if (live) onWarm();
      });
    };
    // A frame on, when every island has said it is still to be built.
    frame = requestAnimationFrame(wait);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [gl, scene, camera, works, onWarm]);
  return null;
}

type SceneProps = {
  frame: Frame;
  snap: boolean;
  mood: Mood;
  quality: Quality;
  still: boolean;
  /** Told once the scene can be drawn without a wait. */
  onWarm: () => void;
  children: ReactNode;
};

/** Everything the village's canvas and a saved picture's share: the hour, the camera's look, the lights, the wind. */
export function Scene({ frame, snap, mood, quality, still, onWarm, children }: SceneProps) {
  const works = useMemo<Works>(() => ({ pending: 0 }), []);
  return (
    <WorksContext.Provider value={works}>
      <Stillness value={still}>
        <Look frame={frame} snap={snap} mood={mood} quality={quality} />
        <Wind />
        <LampPool count={quality === 'high' ? 8 : 4} gain={mood.lamps}>
          <group dispose={null}>{children}</group>
        </LampPool>
        <Warm onWarm={onWarm} />
      </Stillness>
    </WorksContext.Provider>
  );
}

/** How long a frame may take, on average, before the costly parts of the look are given up: under 33 frames a second. */
const SLOW_FRAME_MS = 30;
const SETTLE_FRAMES = 90;
const MEASURED_FRAMES = 120;

/** Watches how long frames take once the scene has been built, and says so once if they take too long. */
function Pace({ onSlow }: { onSlow: () => void }) {
  const seen = useRef({ frames: 0, total: 0, last: 0, done: false });
  useFrame(() => {
    const pace = seen.current;
    const now = performance.now();
    const took = now - pace.last;
    pace.last = now;
    // A stall (the tab was hidden, a home was being built) is not the scene's own pace.
    if (pace.done || took > 250) return;
    pace.frames += 1;
    if (pace.frames <= SETTLE_FRAMES) return;
    pace.total += took;
    if (pace.frames < SETTLE_FRAMES + MEASURED_FRAMES) return;
    pace.done = true;
    if (pace.total / MEASURED_FRAMES > SLOW_FRAME_MS) onSlow();
  });
  return null;
}

/** Says when the canvas has drawn its first few frames: the homes are lit and mirrored, and it can be shown. */
function Drawn({ onDrawn }: { onDrawn: () => void }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current === 4) onDrawn();
  }, 2);
  return null;
}

/** Shows `fallback` in place of a canvas that could not be made (a browser without WebGL). */
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

type StageProps = {
  homes: readonly StageHome[];
  bridges: readonly StageBridge[];
  frame: Frame;
  /** The home in view, whose guardian plays; the others can be visited. */
  focus: string | null;
  onVisit?: (id: string) => void;
  /** Labels over the islands: elements carrying `data-pin` with a home's id. */
  pins?: ReactNode;
};

/** The village's canvas. It draws while it is on screen, and holds still for a viewer who asked for less motion. */
export function Stage({ homes, bridges, frame, focus, onVisit, pins }: StageProps) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);
  /** A lost WebGL context comes back with a fresh canvas. */
  const [generation, setGeneration] = useState(0);
  /** The canvas draws once its materials are ready, and stays out of sight until it has drawn. */
  const [warm, setWarm] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [still] = useState(calm);
  // The gardens are planted once, for the device the page opened on.
  const [first] = useState(initialQuality);
  // Frames were taking too long: the costly parts of the look are given up and the canvas drawn at the screen's plain grain.
  const [slow, setSlow] = useState(false);
  const quality = slow ? 'low' : first;
  const lush = first === 'high';
  const mood = useMood();
  const warmed = useCallback(() => setWarm(true), []);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="mg-saju-canvas" ref={box} data-drawn={drawn || undefined}>
      {/* What the canvas shows is said in words beside it; the labels over it are the page's own links. */}
      <Failsafe fallback={<p className="mg-saju-canvas-failed">이 브라우저에서는 마을을 그릴 수 없어요</p>}>
        <Canvas
          key={generation}
          aria-hidden="true"
          orthographic
          flat
          shadows="percentage"
          dpr={slow ? 1 : [1, 2]}
          frameloop={inView && warm ? 'always' : 'never'}
          gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
          camera={{ near: 1, far: 400, position: [60, 60, 60] }}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener('webglcontextlost', (event) => {
              event.preventDefault();
              setWarm(false);
              setDrawn(false);
              setGeneration((count) => count + 1);
            });
          }}
        >
          <Scene frame={frame} snap={still} mood={mood} quality={quality} still={still} onWarm={warmed}>
            {homes.map((home, index) => (
              <Plot key={`${home.id}:${home.profile ? 'home' : 'lot'}`} home={home} turn={index} focused={home.id === focus} lush={lush} onVisit={onVisit} />
            ))}
            {bridges.map((bridge) => (
              <Bridge key={`${bridge.to.id}:${bridge.colors.join()}`} from={[bridge.from.x, bridge.from.z]} to={[bridge.to.x, bridge.to.z]} colors={bridge.colors} tone={bridge.compat.tone} />
            ))}
          </Scene>
          <Pins homes={homes} layer={layer} />
          {!slow && <Pace onSlow={() => setSlow(true)} />}
          <Drawn onDrawn={() => setDrawn(true)} />
        </Canvas>
      </Failsafe>
      <div className="mg-saju-pins" ref={layer}>
        {pins}
      </div>
    </div>
  );
}
