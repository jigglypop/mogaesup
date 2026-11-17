import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RGBAFormat,
  RingGeometry,
  Sphere,
  SphereGeometry,
  Vector3,
  type Group,
  type OrthographicCamera,
  type PointLight,
  type Scene,
} from 'three';
import { abs, attribute, cameraProjectionMatrix, cos, dot, exp, float, Fn, fract, max, mix, modelViewMatrix, positionGeometry, sin, smoothstep, step, vec2, vec3, vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';

import type { Build, Lamp, Life } from './build';
import { WATER_LEVEL } from './mood';
import { hash } from './noise';
import { useAnimation } from './parts';
import { sprigGeometry, sprigMaterial, wind } from './sprigs';
import { MOVING } from './Static';

// A built home in the canvas: its piled meshes, its scatterings of leaves and stones, what moves about it (smoke, a
// fire, petals, fish) and the lamps it lends the village's pool of lights.

/** The layer flowers are drawn on: the camera sees it, the lake's mirror does not look for it. */
export const GRASS_LAYER = 1;

/** Turns the wind's clock; held still, every leaf and mote stops where a chosen moment left it. */
export function Wind() {
  useAnimation((time) => {
    wind.value = time;
  });
  return null;
}

type Motes = { at: number[]; look: number[]; way: number[] };

const MOTE = { halo: 0, firefly: 1, ember: 2, smoke: 3, petal: 4, mist: 5, flame: 6 } as const;
const QUAD = new PlaneGeometry(1, 1);

/**
 * The material of the motes: each copy of the quad is stood facing the camera at its own place and size, moves as its
 * kind does (a halo glows, a firefly wanders, an ember rises, smoke swells, a petal falls turning, mist drifts, a
 * flame flickers) and is cut to its shape. `glow` adds its light to what is behind it.
 */
function moteMaterial(glow: boolean): MeshBasicNodeMaterial {
  const at = attribute('aAt', 'vec3');
  const look = attribute('aLook', 'vec4');
  const way = attribute('aWay', 'vec4');
  const [mode, seed, reach, fall] = [way.x, way.y, way.z, way.w];
  // The wind's clock: the same seconds the leaves sway by.
  const t = wind;
  const wave = (speed: number, offset: number, of: Node<'float'> = t) => sin(of.mul(speed).add(seed.mul(offset)));
  const ember = fract(t.mul(0.35).add(seed));
  const smoke = fract(t.mul(0.1).add(seed));
  const petal = fract(t.mul(0.06).add(seed));
  /** One of seven values by the mote's kind: halo, firefly, ember, smoke, petal, mist, flame. */
  const byKind = <T extends 'float' | 'vec2' | 'vec3'>(values: readonly Node<T>[]): Node<T> =>
    values.slice(0, -1).reduceRight<Node<T>>((rest, value, index) => mode.lessThan(index + 0.5).select(value, rest), values[values.length - 1]!);
  const flicker = wave(13, 40).mul(0.14).add(0.84).add(wave(23, 11).mul(0.09));
  const size = look.w.mul(byKind<'float'>([float(1), float(1), float(1).sub(ember.mul(0.6)), smoke.mul(1.7).add(0.4), float(1), float(1), flicker]));
  const drift = byKind<'vec3'>([
    vec3(0),
    vec3(wave(0.37, 31), wave(0.53, 17).mul(0.45), cos(t.mul(0.29).add(seed.mul(23)))).mul(reach),
    vec3(wave(7, 20, ember).mul(0.22), ember.mul(reach), cos(ember.mul(5).add(seed.mul(9))).mul(0.22)),
    vec3(wave(3, 12, smoke).mul(0.14).add(smoke.mul(smoke).mul(0.85)), smoke.mul(reach), smoke.mul(smoke).mul(-0.5)),
    vec3(sin(seed.mul(91)), 0, cos(seed.mul(57)))
      .mul(reach)
      .mul(fract(seed.mul(7)).mul(0.75).add(0.25))
      .add(vec3(petal.mul(1.5).add(wave(9, 30, petal).mul(0.25)), petal.mul(fall).negate(), wave(7, 11, petal).mul(0.25))),
    vec3(wave(0.1, 20), 0, cos(t.mul(0.13).add(seed.mul(31)))).mul(reach),
    vec3(wave(9, 5).mul(size).mul(0.04), size.mul(0.5), 0),
  ]);
  const stretch = byKind<'vec2'>([vec2(1), vec2(1), vec2(1), vec2(1), vec2(1, wave(3, 70).mul(0.45).add(0.55)), vec2(1.9, 0.6), vec2(0.6, 1.3)]);
  const alpha = byKind<'float'>([
    wave(2.3, 40).mul(0.14).add(0.86),
    smoothstep(0.25, 0.9, wave(1.3, 50).mul(0.5).add(0.5)),
    float(1).sub(ember),
    smoothstep(0, 0.12, smoke).mul(float(1).sub(smoke).pow(2)).mul(0.62),
    smoothstep(0, 0.08, petal).mul(float(1).sub(smoothstep(0.9, 1, petal))),
    wave(0.3, 9).mul(0.2).add(0.35),
    float(1),
  ]);
  const seen = modelViewMatrix.mul(vec4(at.add(drift), 1)).add(vec4(positionGeometry.xy.mul(size).mul(stretch), 0, 0));
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, ...(glow ? { blending: AdditiveBlending } : {}) });
  material.vertexNode = cameraProjectionMatrix.mul(seen);
  // Cut to its shape: a flame's tongue, a petal's diamond, else a soft round glow.
  const spot = positionGeometry.xy.mul(2);
  const kind = mode.toVarying();
  const tongue = mix(float(0.8), float(0.04), smoothstep(-0.5, 1, spot.y));
  const flame = float(1)
    .sub(smoothstep(tongue.mul(0.25), tongue, abs(spot.x)))
    .mul(smoothstep(-1, -0.55, spot.y))
    .mul(float(1).sub(smoothstep(0.4, 1, spot.y)));
  const diamond = step(abs(spot.x).mul(1.3).add(abs(spot.y)), 0.9);
  const round = max(exp(dot(spot, spot).mul(-3.4)).sub(0.035), 0);
  const cover = kind.greaterThan(5.5).select(flame, kind.greaterThan(3.5).and(kind.lessThan(4.5)).select(diamond, round)).mul(alpha.toVarying());
  material.fragmentNode = Fn(() => {
    cover.lessThan(0.004).discard();
    return vec4(look.rgb.toVarying(), cover);
  })();
  return material;
}

let glowMaterial: MeshBasicNodeMaterial | null = null;
let softMaterial: MeshBasicNodeMaterial | null = null;
const moteMaterialOf = (glow: boolean): MeshBasicNodeMaterial => {
  const known = glow ? glowMaterial : softMaterial;
  if (known) return known;
  const material = moteMaterial(glow);
  if (glow) glowMaterial = material;
  else softMaterial = material;
  return material;
};

const tint = new Color();
function mote(into: Motes, at: readonly number[], color: string, gain: number, size: number, mode: number, seed: number, reach = 0, extra = 0): void {
  tint.set(color).multiplyScalar(gain);
  into.at.push(at[0]!, at[1]!, at[2]!);
  into.look.push(tint.r, tint.g, tint.b, size);
  into.way.push(mode, seed, reach, extra);
}

/** The glows and drifting things a build's lamps and lives call for. */
function motesOf(build: Build): { glow: Motes; soft: Motes } {
  const glow: Motes = { at: [], look: [], way: [] };
  const soft: Motes = { at: [], look: [], way: [] };
  build.lamps.forEach((lamp, index) => mote(glow, lamp.at, lamp.color, 0.5 + lamp.power * 0.28, 0.5 + lamp.power * 0.22, MOTE.halo, hash(index, 3)));
  build.lives.forEach((life, index) => {
    const seed = (step: number) => hash(index * 31 + step, 7);
    if (life.kind === 'fire') {
      const scale = life.scale ?? 1;
      mote(glow, life.at, '#ff6a1e', 2.6, 0.62 * scale, MOTE.flame, seed(0));
      mote(glow, life.at, '#ff9a2e', 3.2, 0.46 * scale, MOTE.flame, seed(1));
      mote(glow, life.at, '#ffd76a', 4, 0.3 * scale, MOTE.flame, seed(2));
      for (let ember = 0; ember < 7; ember++) mote(glow, [life.at[0], life.at[1] + 0.2 * scale, life.at[2]], '#ffb347', 5, 0.05 * scale, MOTE.ember, seed(3 + ember), 1.8 * scale);
    } else if (life.kind === 'fireflies') {
      for (let fly = 0; fly < life.count; fly++) {
        mote(glow, [life.at[0] + (seed(fly) - 0.5) * life.reach * 2, life.at[1] + seed(fly + 50) * 0.8, life.at[2] + (seed(fly + 100) - 0.5) * life.reach * 2], '#f6ff9a', 3.4, 0.075, MOTE.firefly, seed(fly + 150), 0.45);
      }
    } else if (life.kind === 'smoke') {
      for (let puff = 0; puff < 9; puff++) mote(soft, life.at, '#eadfd8', 0.9, 0.42 * (life.scale ?? 1), MOTE.smoke, puff / 9 + seed(puff) * 0.05, 2.6 * (life.scale ?? 1));
    } else if (life.kind === 'petals') {
      for (let petal = 0; petal < 26; petal++) mote(soft, life.at, life.color, 1.1, 0.055, MOTE.petal, seed(petal), life.reach, life.at[1]);
    } else if (life.kind === 'mist') {
      for (let wisp = 0; wisp < 7; wisp++) mote(soft, [life.at[0] + (seed(wisp) - 0.5) * life.reach, life.at[1] + seed(wisp + 9) * 0.3, life.at[2] + (seed(wisp + 20) - 0.5) * life.reach], '#f3f6fb', 1, 0.8, MOTE.mist, seed(wisp + 30), 0.25);
    }
  });
  return { glow, soft };
}

function moteMesh(motes: Motes, glow: boolean): Mesh | null {
  const count = motes.at.length / 3;
  if (count === 0) return null;
  const geometry = new InstancedBufferGeometry();
  // Its own copy of the quad: a geometry let go takes its buffers with it, and another island's motes still draw.
  geometry.index = QUAD.index!.clone();
  geometry.setAttribute('position', QUAD.getAttribute('position').clone());
  geometry.setAttribute('aAt', new InstancedBufferAttribute(new Float32Array(motes.at), 3));
  geometry.setAttribute('aLook', new InstancedBufferAttribute(new Float32Array(motes.look), 4));
  geometry.setAttribute('aWay', new InstancedBufferAttribute(new Float32Array(motes.way), 4));
  geometry.instanceCount = count;
  const mesh = new Mesh(geometry, moteMaterialOf(glow));
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

type LampSource = { lamps: readonly Lamp[]; origin: Vector3 };
type LampRegistry = { sources: Set<LampSource> };
const LampContext = createContext<LampRegistry | null>(null);

/** How bright a lamp of power 1 is, as the renderer counts light. */
const LAMP_CANDELA = 2.6;
const lampAt = new Vector3();

/**
 * The village's lights: every built home lends its lamps, and the `count` that matter most to what the camera looks at
 * (`focus`) are lit for real; the rest only glow. `gain` turns them all up after dark.
 */
export function LampPool({ count, gain, children }: { count: number; gain: number; children: ReactNode }) {
  const registry = useMemo<LampRegistry>(() => ({ sources: new Set() }), []);
  const lights = useRef<(PointLight | null)[]>([]);
  const chosen = useRef<{ lamp: Lamp; origin: Vector3 }[]>([]);
  const tick = useRef(0);
  const focus = useMemo(() => new Vector3(), []);
  useFrame(({ camera, clock }) => {
    // Choosing again a few times a second is often enough for a camera that eases.
    if (tick.current++ % 12 === 0) {
      camera.getWorldDirection(focus);
      const reach = (camera.position.y - 1) / -focus.y;
      focus.multiplyScalar(reach).add(camera.position);
      const all: { lamp: Lamp; origin: Vector3; score: number }[] = [];
      for (const source of registry.sources) {
        for (const lamp of source.lamps) {
          lampAt.set(lamp.at[0], lamp.at[1], lamp.at[2]).add(source.origin);
          all.push({ lamp, origin: source.origin, score: lamp.power / (1 + lampAt.distanceToSquared(focus) * 0.03) });
        }
      }
      all.sort((a, b) => b.score - a.score);
      chosen.current = all.slice(0, count);
    }
    for (let index = 0; index < count; index++) {
      const light = lights.current[index];
      if (!light) continue;
      const pick = chosen.current[index];
      if (!pick) {
        light.intensity = 0;
        continue;
      }
      const { lamp, origin } = pick;
      light.position.set(lamp.at[0] + origin.x, lamp.at[1] + origin.y, lamp.at[2] + origin.z);
      light.color.set(lamp.color);
      light.distance = lamp.reach;
      const flicker = lamp.flicker ? 0.86 + Math.sin(clock.elapsedTime * 11 + index) * 0.08 + Math.sin(clock.elapsedTime * 17.3) * 0.06 : 1;
      light.intensity = lamp.power * LAMP_CANDELA * gain * flicker;
    }
  });
  return (
    <LampContext.Provider value={registry}>
      {Array.from({ length: count }, (_, index) => (
        <pointLight key={index} ref={(light) => void (lights.current[index] = light)} intensity={0} decay={2} />
      ))}
      {children}
    </LampContext.Provider>
  );
}

/** Lends `lamps` (placed about `origin` in the village) to the village's lights for as long as the caller is mounted. */
export function useLamps(lamps: readonly Lamp[], origin: readonly [number, number, number]): void {
  const registry = useContext(LampContext);
  useEffect(() => {
    if (!registry) return undefined;
    const source: LampSource = { lamps, origin: new Vector3(origin[0], origin[1], origin[2]) };
    registry.sources.add(source);
    return () => void registry.sources.delete(source);
  }, [registry, lamps, origin]);
}

const FISH = new SphereGeometry(1, 14, 8);
const RING = new RingGeometry(0.88, 1, 28);

/** A carp just under the surface, going round. */
function Koi({ life }: { life: Extract<Life, { kind: 'koi' }> }) {
  const fish = useRef<Group>(null);
  const tail = useRef<Group>(null);
  const material = useMemo(() => new MeshBasicMaterial({ color: new Color(life.color).multiplyScalar(0.8), transparent: true, opacity: 0.7, depthWrite: false }), [life.color]);
  useEffect(() => () => material.dispose(), [material]);
  useAnimation((time) => {
    const t = time * 0.42 + life.phase;
    fish.current?.position.set(life.at[0] + Math.cos(t) * life.reach, WATER_LEVEL + 0.004, life.at[2] + Math.sin(t) * life.reach * 0.7);
    if (fish.current) fish.current.rotation.y = -t - Math.PI / 2 + Math.sin(time * 5 + life.phase) * 0.12;
    if (tail.current) tail.current.rotation.y = Math.sin(time * 6 + life.phase) * 0.5;
  });
  return (
    <group ref={fish} userData={MOVING}>
      <mesh geometry={FISH} material={material} scale={[0.17, 0.012, 0.055]} renderOrder={1} />
      <group ref={tail} position={[-0.16, 0, 0]}>
        <mesh geometry={FISH} material={material} scale={[0.08, 0.01, 0.05]} position={[-0.05, 0, 0]} renderOrder={1} />
      </group>
    </group>
  );
}

/** A butterfly about its flowers. */
function Butterfly({ life }: { life: Extract<Life, { kind: 'butterfly' }> }) {
  const body = useRef<Group>(null);
  const left = useRef<Mesh>(null);
  const right = useRef<Mesh>(null);
  const material = useMemo(() => new MeshBasicMaterial({ color: life.color, side: DoubleSide }), [life.color]);
  useEffect(() => () => material.dispose(), [material]);
  useAnimation((time) => {
    const t = time * 0.7 + life.phase;
    body.current?.position.set(life.at[0] + Math.sin(t) * 0.8, life.at[1] + Math.sin(t * 2.3) * 0.2, life.at[2] + Math.cos(t * 1.3) * 0.6);
    if (body.current) body.current.rotation.y = Math.atan2(Math.cos(t) * 0.8, -Math.sin(t * 1.3) * 0.78);
    const flap = Math.sin(time * 14 + life.phase) * 0.9;
    if (left.current) left.current.rotation.z = flap;
    if (right.current) right.current.rotation.z = -flap;
  });
  return (
    <group ref={body} userData={MOVING}>
      <mesh ref={left} geometry={QUAD} material={material} scale={[0.09, 0.07, 1]} position={[-0.045, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} />
      <mesh ref={right} geometry={QUAD} material={material} scale={[0.09, 0.07, 1]} position={[0.045, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  );
}

/** Rings spreading on the water and fading. */
function Ripples({ life }: { life: Extract<Life, { kind: 'ripples' }> }) {
  const rings = useRef<(Mesh | null)[]>([]);
  const materials = useMemo(() => [0, 1].map(() => new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false })), []);
  useEffect(() => () => materials.forEach((material) => material.dispose()), [materials]);
  useAnimation((time) => {
    rings.current.forEach((ring, index) => {
      if (!ring) return;
      // A place west of its island's middle has a negative x, and a remainder keeps its sign: left as it was, the
      // ring's scale went negative, it turned face down and only the lake's mirror drew it.
      const age = (((time * 0.3 + index / 2 + life.at[0]) % 1) + 1) % 1;
      ring.scale.setScalar(0.1 + age * life.reach);
      materials[index]!.opacity = 0.5 * (1 - age);
    });
  });
  return (
    <group position={[life.at[0], life.at[1] + 0.006, life.at[2]]} rotation={[-Math.PI / 2, 0, 0]} userData={MOVING}>
      {materials.map((material, index) => (
        <mesh key={index} ref={(mesh) => void (rings.current[index] = mesh)} geometry={RING} material={material} renderOrder={1} />
      ))}
    </group>
  );
}

/** A beam of light one metre long: narrow where it leaves the lamp, wide and gone where it ends, soft at its edges. */
function beamShape(): { geometry: BufferGeometry; fade: DataTexture } {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, -0.03, 0, 1, -0.16, 0, 1, 0.16, 0, 0, 0.03, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const [wide, tall] = [32, 16];
  const data = new Uint8Array(wide * tall * 4);
  for (let y = 0; y < tall; y++) {
    for (let x = 0; x < wide; x++) {
      const along = x / (wide - 1);
      data.set([255, 255, 255, Math.round(255 * (1 - along) ** 1.6 * Math.sin((Math.PI * (y + 0.5)) / tall) ** 2)], (y * wide + x) * 4);
    }
  }
  const fade = new DataTexture(data, wide, tall, RGBAFormat);
  fade.magFilter = fade.minFilter = LinearFilter;
  fade.needsUpdate = true;
  return { geometry, fade };
}
let beam: ReturnType<typeof beamShape> | null = null;

/** A lighthouse's beam sweeping round. */
function Beam({ life }: { life: Extract<Life, { kind: 'beam' }> }) {
  const arm = useRef<Group>(null);
  const shape = (beam ??= beamShape());
  const material = useMemo(() => new MeshBasicMaterial({ color: new Color('#ffe9a8').multiplyScalar(1.5), map: shape.fade, transparent: true, opacity: 0.5, depthWrite: false, blending: AdditiveBlending, side: DoubleSide }), [shape]);
  useEffect(() => () => material.dispose(), [material]);
  useAnimation((time) => {
    if (arm.current) arm.current.rotation.y = time * 0.5;
  });
  return (
    <group ref={arm} position={life.at} userData={MOVING}>
      {[0, Math.PI / 2].map((roll) => (
        <mesh key={roll} geometry={shape.geometry} material={material} scale={[4.2, 3, 1]} rotation={[roll, 0, 0]} renderOrder={2} />
      ))}
    </group>
  );
}

const corner = new Vector3();
const span = new Box3();

/** Leaves drawn into the sun's shadows, against those drawn in the picture: a crown's shadow is as soft with fewer. */
const SHADOW_LEAVES = 0.45;
/**
 * The share of a crown's leaves drawn for a camera that shows `perMetre` pixels to a metre: all of them close up, a few
 * less far off, where a leaf is a pixel or two and the crown reads as one mass.
 */
const leavesFor = (perMetre: number) => Math.min(1, Math.max(0.8, 0.8 + ((perMetre - 25) / 30) * 0.2));

/** Scatterings whose copies are already in no order (see inNoOrder): the same numbers are handed to every island using them. */
const shuffled = new WeakSet<Float32Array>();

/**
 * Puts a scattering's copies (`count` of them, their matrices, colours and ways out) in no order, the same way each
 * time, so that the first of them, however many, are spread over every crown: a share of them can be drawn.
 */
function inNoOrder(count: number, matrices: Float32Array, colors: Float32Array, outs: Float32Array): void {
  if (shuffled.has(matrices)) return;
  shuffled.add(matrices);
  let state = count * 2654435761;
  const random = () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    return state / 4294967296;
  };
  const swap = (array: Float32Array, size: number, a: number, b: number) => {
    for (let k = 0; k < size; k++) {
      const kept = array[a * size + k]!;
      array[a * size + k] = array[b * size + k]!;
      array[b * size + k] = kept;
    }
  };
  for (let at = count - 1; at > 0; at--) {
    const other = Math.floor(random() * (at + 1));
    swap(matrices, 16, at, other);
    swap(colors, 3, at, other);
    swap(outs, 3, at, other);
  }
}

/** A sphere about every copy of `shape` that `matrices` place (`count` of them): what the camera's view is tested against. */
function copiesSphere(shape: BufferGeometry, matrices: Float32Array, count: number): Sphere {
  if (!shape.boundingSphere) shape.computeBoundingSphere();
  const { center, radius } = shape.boundingSphere!;
  const reach = center.length() + radius;
  span.makeEmpty();
  for (let index = 0; index < count; index++) {
    const m = index * 16;
    const size = Math.sqrt(Math.max(
      matrices[m]! ** 2 + matrices[m + 1]! ** 2 + matrices[m + 2]! ** 2,
      matrices[m + 4]! ** 2 + matrices[m + 5]! ** 2 + matrices[m + 6]! ** 2,
      matrices[m + 8]! ** 2 + matrices[m + 9]! ** 2 + matrices[m + 10]! ** 2,
    ));
    const [x, y, z, out] = [matrices[m + 12]!, matrices[m + 13]!, matrices[m + 14]!, reach * size];
    span.expandByPoint(corner.set(x + out, y + out, z + out));
    span.expandByPoint(corner.set(x - out, y - out, z - out));
  }
  return span.getBoundingSphere(new Sphere());
}

/**
 * Mounts `build` where its parent stands. The build's meshes are let go with it; `origin` is where the parent stands
 * in the village, for the lamps it lends.
 */
export function Built({ build, origin }: { build: Build; origin: readonly [number, number, number] }) {
  useLamps(build.lamps, origin);
  const made = useMemo(() => {
    const scattered = build.sprigs.flatMap((sprigs): Mesh[] => {
      const { kind, count, matrices, colors, outs } = sprigs;
      const base = sprigGeometry(kind);
      const leafy = kind === 'leaf' || kind === 'needle';
      if (leafy) inNoOrder(count, matrices, colors, outs);
      const geometry = new InstancedBufferGeometry();
      // Its own copy of the shape: a geometry let go takes its buffers with it, while the village's other copies draw on.
      geometry.index = base.index && base.index.clone();
      for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.getAttribute(name).clone());
      // Each copy's matrix (as four columns), colour and way out, read by the kind's material (see sprigMaterial).
      const columns = new InstancedInterleavedBuffer(matrices, 16);
      for (let column = 0; column < 4; column++) geometry.setAttribute(`aM${column}`, new InterleavedBufferAttribute(columns, 4, column * 4));
      geometry.setAttribute('aColor', new InstancedBufferAttribute(colors, 3));
      geometry.setAttribute('aOut', new InstancedBufferAttribute(outs, 3));
      geometry.instanceCount = count;
      geometry.boundingSphere = copiesSphere(base, matrices, count);
      const mesh = new Mesh(geometry, sprigMaterial(kind));
      // Only what is big enough to shade something throws a shadow, and the lake does not mirror what lies low.
      mesh.castShadow = leafy || kind === 'puff';
      mesh.receiveShadow = true;
      if (kind === 'bloom') mesh.layers.set(GRASS_LAYER);
      // A crown's leaves: fewer of them in the sun's shadows, and a few less in a picture seen from far off.
      if (leafy) {
        mesh.onBeforeRender = (_renderer, scene, camera) => {
          const shadow = ((scene as Scene).overrideMaterial as { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial === true;
          const zoom = (camera as OrthographicCamera).isOrthographicCamera ? (camera as OrthographicCamera).zoom : 60;
          geometry.instanceCount = Math.max(1, Math.round(count * (shadow ? SHADOW_LEAVES : leavesFor(zoom))));
        };
      }
      return [mesh];
    });
    const { glow, soft } = motesOf(build);
    return { scattered, motes: [moteMesh(glow, true), moteMesh(soft, false)].filter((mesh): mesh is Mesh => !!mesh) };
  }, [build]);
  useEffect(
    () => () => {
      for (const { geometry } of build.meshes) geometry.dispose();
      for (const mesh of made.scattered) {
        mesh.geometry.dispose();
        (mesh.userData['letGo'] as (() => void) | undefined)?.();
      }
      for (const mesh of made.motes) mesh.geometry.dispose();
    },
    [build, made],
  );
  return (
    <>
      {build.meshes.map((mesh, index) => (
        <mesh key={index} geometry={mesh.geometry} material={mesh.material} castShadow={mesh.cast} receiveShadow />
      ))}
      {made.scattered.map((mesh, index) => (
        <primitive key={index} object={mesh} />
      ))}
      {made.motes.map((mesh, index) => (
        <primitive key={index} object={mesh} />
      ))}
      {build.lives.map((life, index) =>
        life.kind === 'koi' ? (
          <Koi key={index} life={life} />
        ) : life.kind === 'butterfly' ? (
          <Butterfly key={index} life={life} />
        ) : life.kind === 'ripples' ? (
          <Ripples key={index} life={life} />
        ) : life.kind === 'beam' ? (
          <Beam key={index} life={life} />
        ) : null,
      )}
    </>
  );
}
