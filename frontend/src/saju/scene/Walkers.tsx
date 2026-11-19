import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { AnimationMixer, CanvasTexture, DoubleSide, LoopOnce, LoopRepeat, MeshStandardMaterial, SRGBColorSpace, Vector3, type AnimationAction, type AnimationClip, type Group, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { balloonElement } from '../../minihome/balloons/dom';
import { DEFAULT_BALLOON, PERSON_COLORS, balloonOf, readableInk } from '../../minihome/balloons/designs';
import '../../minihome/balloons/balloons.css';
import { SELF, type Action, type VillageRoom } from '../live';
import { loadDogModel, type DogModel } from './dogModel';

/** A stable name-tag fill for someone who is not the viewer, from the same six colours the live room uses. */
function tagColor(id: string): string {
  return PERSON_COLORS[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PERSON_COLORS.length]!;
}

// The people in a home's room, each as their own guardian dog about its island: the viewer's own, which walks (or, a
// long way off, runs) where they press the ground, a flag showing where it is going, and jumps, waves, cheers and
// dances when asked; and everyone else's, eased toward where they last said they were, doing what they said. Over each
// head their name, and what they say in a cloud for a while (a layer of the page's own, placed every frame).

/** How tall a walker stands, in metres (a home's own dog is 1.44); how fast one walks and runs (metres a second). */
const HEIGHT = 1.3;
const WALK = 4.2;
const RUN = 8.5;
/** Farther than this, the viewer's dog runs to where they pressed. */
const RUN_FROM = 5;
/** A jump: how high, and how long it is in the air (seconds). */
const JUMP_HEIGHT = 0.9;
const JUMP_TIME = 0.62;
/** How long a move played once lasts when its dog has no clip for it (seconds). */
const MOVE_TIME = 1.6;
/** How quickly another walker is eased toward where they said they were, and turned. */
const FOLLOW = 10;
/** How high over the ground a walker's name and cloud are. */
const OVER = HEIGHT + 0.25;

/** What the page can ask of the viewer's own dog, and where it is (`at`, null while it is not on the island). */
export type WalkerControl = { goal: [number, number, number] | null; run: boolean; asked: { action: Action; at: number } | null; at?: readonly [number, number, number] | null };
const GOING = new Set<Action>(['walk', 'run']);
const ONCE = new Set<Action>(['jump', 'wave', 'cheer', 'dance']);

const dogs = new Map<string, DogModel>();

/** Dog `id`'s model once it has arrived; null until then (or if it cannot be had). */
function useDogModel(id: string): DogModel | null {
  const [model, setModel] = useState<DogModel | null>(() => dogs.get(id) ?? null);
  useEffect(() => {
    let live = true;
    const known = dogs.get(id);
    if (known) {
      setModel(known);
      return undefined;
    }
    loadDogModel(id).then(
      (loaded) => {
        dogs.set(id, loaded);
        if (live) setModel(loaded);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id]);
  return model;
}

/** A clip held to its place: its root's way across the ground taken out, so a dog moves only as the page moves it. */
function inPlace(clip: AnimationClip): AnimationClip {
  const held = clip.clone();
  const root = held.tracks.find((track) => track.name.endsWith('.position'));
  if (root) {
    const values = root.values;
    const [x, z] = [values[0]!, values[2]!];
    for (let at = 0; at < values.length; at += 3) {
      values[at] = x;
      values[at + 2] = z;
    }
  }
  return held;
}

/** One dog as a walker: its own copy of the model, playing what `action()` says (a move once, each time `moves()` counts one). */
function Figure({ dog, action, moves, holder }: { dog: string; action: () => Action; moves: () => number; holder: RefObject<Group | null> }) {
  const model = useDogModel(dog);
  const made = useMemo(() => {
    if (!model) return null;
    const figure: Object3D = model.clips ? cloneSkinned(model.scene) : model.scene.clone();
    figure.traverse((part) => {
      part.castShadow = true;
      part.frustumCulled = false;
    });
    const mixer = model.clips ? new AnimationMixer(figure) : null;
    const actions = new Map<Action, AnimationAction>();
    if (mixer && model.clips) {
      for (const [name, clip] of Object.entries(model.clips) as [Action, AnimationClip | undefined][]) {
        if (!clip) continue;
        const played = mixer.clipAction(inPlace(clip));
        if (ONCE.has(name)) {
          played.setLoop(LoopOnce, 1);
          played.clampWhenFinished = true;
        } else played.setLoop(LoopRepeat, Infinity);
        actions.set(name, played);
      }
      actions.get('idle')?.play();
    }
    return { figure, mixer, actions };
  }, [model]);
  const state = useRef({ action: 'idle' as Action, moves: -1, playing: null as AnimationAction | null, since: 0, hop: 0 });
  useFrame((_, elapsed) => {
    if (!made) return;
    const delta = Math.min(0.1, elapsed);
    const now = action();
    const count = moves();
    const was = state.current;
    if (was.moves < 0) was.moves = count;
    const fresh = ONCE.has(now) && count !== was.moves;
    if (now !== was.action || fresh) {
      const next = made.actions.get(now) ?? (now === 'run' ? made.actions.get('walk') : undefined) ?? made.actions.get('idle');
      if (next && next !== was.playing) {
        next.reset().play();
        if (was.playing) was.playing.crossFadeTo(next, now === 'jump' ? 0.08 : 0.2, false);
        else made.actions.get('idle')?.crossFadeTo(next, 0.2, false);
      } else if (next && fresh) next.reset().play();
      if (next) next.timeScale = now === 'run' && !made.actions.has('run') ? 1.8 : 1;
      was.playing = next ?? null;
      was.action = now;
      was.since = 0;
      if (now === 'jump') was.hop = 0;
    }
    was.moves = count;
    was.since += delta;
    made.mixer?.update(delta);
    // A move played once goes back to standing when it is over.
    const done = was.playing && ONCE.has(was.action) && !was.playing.isRunning();
    if (done || (ONCE.has(was.action) && !was.playing && was.since > MOVE_TIME)) {
      const idle = made.actions.get('idle');
      if (idle && was.playing) {
        idle.reset().play();
        was.playing.crossFadeTo(idle, 0.25, false);
      }
      was.playing = idle ?? null;
      was.action = 'idle';
    }
    // In the air while it jumps; a dog without clips hops as it goes.
    let lift = 0;
    if (was.action === 'jump' && was.since < JUMP_TIME) {
      const t = was.since / JUMP_TIME;
      lift = 4 * JUMP_HEIGHT * t * (1 - t);
    } else if (!made.mixer && GOING.has(was.action)) {
      was.hop += delta * (was.action === 'run' ? 18 : 11);
      lift = Math.abs(Math.sin(was.hop)) * 0.12;
    }
    made.figure.position.y = lift / HEIGHT;
  });
  useEffect(() => () => void made?.mixer?.stopAllAction(), [made]);
  if (!made) return null;
  return (
    <group ref={holder}>
      <group scale={HEIGHT}>
        <primitive object={made.figure} />
      </group>
    </group>
  );
}

const poleMaterial = new MeshStandardMaterial({ color: '#5c4636', roughness: 0.72 });
const finialMaterial = new MeshStandardMaterial({ color: '#e6c27a', roughness: 0.32, metalness: 0.55 });
const ringMaterial = new MeshStandardMaterial({ color: '#e6c27a', roughness: 0.45, transparent: true, opacity: 0.55, emissive: '#e6c27a', emissiveIntensity: 0.25 });

/** A swallowtail pennant, drawn once: cloth, a dark edge, a mark. */
function pennantMaterial(): MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  const material = new MeshStandardMaterial({ color: '#d85a48', roughness: 0.62, side: DoubleSide });
  if (!context) return material;
  context.fillStyle = '#f3e2c4';
  context.beginPath();
  context.moveTo(4, 8);
  context.lineTo(150, 48);
  context.lineTo(4, 88);
  context.closePath();
  context.fill();
  context.strokeStyle = '#8c3d32';
  context.lineWidth = 6;
  context.stroke();
  context.fillStyle = '#8c3d32';
  context.beginPath();
  context.arc(46, 48, 9, 0, Math.PI * 2);
  context.fill();
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  material.map = map;
  material.color.set('#ffffff');
  return material;
}

/** The flag where the viewer's dog is going, planted with a little bounce, the ring on the ground pulsing. */
function GoalFlag({ control }: { control: RefObject<WalkerControl> }) {
  const flag = useRef<Group>(null);
  const cloth = useRef<Group>(null);
  const ring = useRef<Group>(null);
  const clothMaterial = useMemo(() => pennantMaterial(), []);
  useEffect(() => () => {
    clothMaterial.map?.dispose();
    clothMaterial.dispose();
  }, [clothMaterial]);
  const placed = useRef<{ x: number; z: number; at: number } | null>(null);
  useFrame(() => {
    const group = flag.current;
    if (!group) return;
    const goal = control.current.goal;
    if (!goal) {
      group.visible = false;
      placed.current = null;
      return;
    }
    const now = performance.now() / 1000;
    if (!placed.current || placed.current.x !== goal[0] || placed.current.z !== goal[2]) placed.current = { x: goal[0], z: goal[2], at: now };
    const since = now - placed.current.at;
    group.visible = true;
    group.position.set(goal[0], 0, goal[2]);
    // Dropped in: down from a little above, settling with a bounce.
    const drop = Math.max(0, 1 - since / 0.25);
    const settle = since < 0.5 ? Math.sin(since * 25) * 0.08 * (1 - since / 0.5) : 0;
    group.scale.setScalar(1 + settle);
    group.position.y = drop * drop * 0.6;
    if (cloth.current) cloth.current.rotation.y = Math.sin(now * 5) * 0.25;
    if (ring.current) ring.current.scale.setScalar(0.85 + 0.25 * ((now * 1.5) % 1));
  });
  return (
    <group ref={flag} visible={false}>
      <mesh material={poleMaterial} position={[0, 0.52, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.02, 1.05, 8]} />
      </mesh>
      <mesh material={finialMaterial} position={[0, 1.08, 0]} castShadow>
        <sphereGeometry args={[0.038, 12, 8]} />
      </mesh>
      <group ref={cloth} position={[0.02, 0.9, 0]}>
        <mesh material={clothMaterial} position={[0.2, 0, 0]} castShadow>
          <planeGeometry args={[0.42, 0.26]} />
        </mesh>
      </group>
      <group ref={ring}>
        <mesh material={ringMaterial} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.28, 0.36, 32]} />
        </mesh>
      </group>
    </group>
  );
}

const point = new Vector3();

/**
 * Everyone in `room` on the island, the viewer's own dog (`own`) from `start`, as `control` asks (where to go, a move
 * to make); names and what they say placed in `layer`.
 */
export function Walkers({
  room,
  own,
  name,
  start,
  control,
  layer,
  balloon = DEFAULT_BALLOON,
}: {
  room: VillageRoom;
  own: string | null;
  name: string;
  start: [number, number, number];
  control: RefObject<WalkerControl>;
  layer: RefObject<HTMLDivElement | null>;
  /** The viewer's balloon design (`HomeProfile.balloon`); others talk in glass until the room carries theirs. */
  balloon?: string;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const mine = useRef({ position: [...start] as [number, number, number], facing: 0, action: 'idle' as Action, moves: 0, asked: 0, busy: 0 });
  const shown = useRef(new Map<string, { position: Vector3; facing: number }>());
  const holders = useRef(new Map<string, RefObject<Group | null>>());
  const holderOf = (id: string) => {
    let holder = holders.current.get(id);
    if (!holder) {
      holder = { current: null };
      holders.current.set(id, holder);
    }
    return holder;
  };
  useEffect(() => {
    mine.current = { position: [...start] as [number, number, number], facing: 0, action: 'idle', moves: 0, asked: 0, busy: 0 };
    // `start` is where the viewer stands as they come to an island (its key stands for it).
  }, [start.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Off the island, the viewer's dog is nowhere the camera could follow.
  useEffect(() => {
    const held = control.current;
    return () => {
      held.at = null;
    };
  }, [control]);

  useFrame((_, elapsed) => {
    const delta = Math.min(0.1, elapsed);
    // The viewer's own: a move asked for, else toward the ground pressed, turning to face the way.
    if (own) {
      const me = mine.current;
      const ask = control.current;
      if (ask.asked && ask.asked.at !== me.asked) {
        me.asked = ask.asked.at;
        me.action = ask.asked.action;
        me.moves += 1;
        me.busy = ask.asked.action === 'jump' ? JUMP_TIME : ask.asked.action === 'dance' ? 4 : MOVE_TIME;
        // Waving, cheering and dancing stand still; a jump goes on where it was going.
        if (ask.asked.action !== 'jump') ask.goal = null;
      }
      me.busy = Math.max(0, me.busy - delta);
      const target = ask.goal;
      let going: Action | null = null;
      if (target && (me.busy === 0 || me.action === 'jump')) {
        const dx = target[0] - me.position[0];
        const dz = target[2] - me.position[2];
        const away = Math.hypot(dx, dz);
        if (away < 0.08) ask.goal = null;
        else {
          const running = ask.run || away > RUN_FROM || (me.action === 'run' && away > 1);
          const step = Math.min(away, (running ? RUN : WALK) * delta);
          me.position = [me.position[0] + (dx / away) * step, 0, me.position[2] + (dz / away) * step];
          me.facing = Math.atan2(dx, dz);
          going = running ? 'run' : 'walk';
        }
      }
      if (me.busy === 0 || (going && me.action !== 'jump')) me.action = going ?? (ONCE.has(me.action) && me.busy > 0 ? me.action : 'idle');
      room.move(me.position, me.facing, me.action, me.moves);
      ask.at = me.position;
      const holder = holders.current.get(SELF)?.current;
      if (holder) {
        holder.position.set(me.position[0], me.position[1], me.position[2]);
        holder.rotation.y = me.facing;
      }
    }
    // Everyone else, eased toward where they last were.
    const ease = 1 - Math.exp(-delta * FOLLOW);
    for (const [id, walker] of room.others) {
      let at = shown.current.get(id);
      if (!at) {
        at = { position: new Vector3(...walker.position), facing: walker.facing };
        shown.current.set(id, at);
      }
      at.position.lerp(point.set(...walker.position), ease);
      const turn = Math.atan2(Math.sin(walker.facing - at.facing), Math.cos(walker.facing - at.facing));
      at.facing += turn * ease;
      const holder = holders.current.get(id)?.current;
      if (holder) {
        holder.position.copy(at.position);
        holder.rotation.y = at.facing;
      }
    }
    for (const id of shown.current.keys()) if (!room.others.has(id)) shown.current.delete(id);
    // Names and clouds over their heads.
    const host = layer.current;
    if (!host) return;
    const now = Date.now();
    for (const element of host.querySelectorAll<HTMLElement>('[data-walker]')) {
      const id = element.dataset['walker']!;
      const at = id === SELF ? mine.current.position : shown.current.get(id)?.position.toArray();
      if (!at) {
        element.style.visibility = 'hidden';
        continue;
      }
      point.set(at[0]!, (at[1] ?? 0) + OVER, at[2]!).project(camera);
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      element.style.visibility = point.z > 1 ? 'hidden' : '';
      const cloud = element.querySelector<HTMLElement>('.mg-balloon');
      const words = cloud?.querySelector('b');
      const said = room.said.get(id);
      if (cloud && words) {
        const showing = !!said && said.until > now;
        if (showing && words.textContent !== said.text) words.textContent = said.text;
        cloud.hidden = !showing;
      }
    }
  });

  const design = balloonOf(balloon);
  return (
    <>
      {own && <Figure key={`self:${own}`} dog={own} action={() => mine.current.action} moves={() => mine.current.moves} holder={holderOf(SELF)} />}
      {own && <GoalFlag control={control} />}
      {room.present.map((id) => {
        const walker = room.others.get(id);
        return walker ? (
          <Figure key={`${id}:${walker.dog}`} dog={walker.dog} action={() => room.others.get(id)?.action ?? 'idle'} moves={() => room.others.get(id)?.moves ?? 0} holder={holderOf(id)} />
        ) : null;
      })}
      <Labels
        layer={layer}
        ids={[...(own ? [SELF] : []), ...room.present]}
        names={(id) => (id === SELF ? name : (room.others.get(id)?.name ?? ''))}
        design={design}
      />
    </>
  );
}

/** Keeps one label (a name and a balloon) in `layer` for each of `ids`. */
function Labels({
  layer,
  ids,
  names,
  design,
}: {
  layer: RefObject<HTMLDivElement | null>;
  ids: string[];
  names: (id: string) => string;
  design: string;
}) {
  const key = `${ids.join('|')}|${design}`;
  useEffect(() => {
    const host = layer.current;
    if (!host) return;
    const wanted = new Set(ids);
    for (const element of [...host.querySelectorAll<HTMLElement>('[data-walker]')]) if (!wanted.has(element.dataset['walker']!)) element.remove();
    for (const id of ids) {
      let element = host.querySelector<HTMLElement>(`[data-walker="${CSS.escape(id)}"]`);
      if (!element) {
        element = document.createElement('div');
        element.className = 'mg-saju-walker';
        element.dataset['walker'] = id;
        element.style.visibility = 'hidden';
        const cloud = balloonElement('', id === SELF ? design : DEFAULT_BALLOON);
        cloud.hidden = true;
        const tag = document.createElement('span');
        tag.className = 'mg-saju-walker-name';
        element.append(cloud, tag);
        host.append(element);
      }
      const tag = element.querySelector<HTMLElement>('.mg-saju-walker-name')!;
      tag.textContent = names(id);
      if (id === SELF) {
        element.dataset['own'] = '';
        tag.style.removeProperty('--tag');
        tag.style.removeProperty('--tag-ink');
      } else {
        delete element.dataset['own'];
        const fill = tagColor(id);
        tag.style.setProperty('--tag', fill);
        tag.style.setProperty('--tag-ink', readableInk(fill));
      }
      const cloud = element.querySelector<HTMLElement>('.mg-balloon');
      if (cloud) cloud.dataset['design'] = id === SELF ? design : DEFAULT_BALLOON;
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => layer.current?.replaceChildren(), [layer]);
  return null;
}
