import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { AnimationMixer, Vector3, type AnimationAction, type Group, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { SELF, type VillageRoom } from '../live';
import { loadDogModel, type DogModel } from './dogModel';

// The people in a home's room, each as their own guardian dog walking about its island: the viewer's own, which walks
// where they press the ground, and everyone else's, eased toward where they last said they were. Over each head their
// name, and what they say in a cloud for a while (a layer of the page's own, placed every frame).

/** How tall a walker stands, in metres (a home's own dog is 1.44), and how fast one walks. */
const HEIGHT = 1.3;
const SPEED = 2.4;
/** How quickly another walker is eased toward where they said they were, and turned. */
const FOLLOW = 8;
/** How high over the ground a walker's name and cloud are. */
const OVER = HEIGHT + 0.25;

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

/** One dog as a walker: its own copy of the model, walking or standing as `walking()` says. */
function Figure({ dog, walking, holder }: { dog: string; walking: () => boolean; holder: RefObject<Group | null> }) {
  const model = useDogModel(dog);
  const made = useMemo(() => {
    if (!model) return null;
    const figure: Object3D = model.clips ? cloneSkinned(model.scene) : model.scene.clone();
    figure.traverse((part) => {
      part.castShadow = true;
      part.frustumCulled = false;
    });
    const mixer = model.clips ? new AnimationMixer(figure) : null;
    const idle: AnimationAction | null = mixer && model.clips ? mixer.clipAction(model.clips.idle).play() : null;
    const walk: AnimationAction | null = mixer && model.clips?.walk ? mixer.clipAction(model.clips.walk) : null;
    return { figure, mixer, idle, walk };
  }, [model]);
  const was = useRef(false);
  const bob = useRef(0);
  useFrame((_, delta) => {
    if (!made) return;
    const now = walking();
    if (now !== was.current && made.walk && made.idle) {
      const [from, to] = now ? [made.idle, made.walk] : [made.walk, made.idle];
      to.reset().play();
      from.crossFadeTo(to, 0.25, false);
    }
    was.current = now;
    made.mixer?.update(Math.min(0.1, delta));
    // A dog without a walk of its own hops as it goes.
    if (!made.walk) {
      bob.current = now ? bob.current + delta * 11 : 0;
      made.figure.position.y = now ? Math.abs(Math.sin(bob.current)) * 0.12 : 0;
    }
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

const point = new Vector3();

/**
 * Everyone in `room` on the island, the viewer's own dog (`own`) walking toward `goal` (set by the page when the
 * ground is pressed) from `start`; names and what they say placed in `layer`.
 */
export function Walkers({ room, own, name, start, goal, layer }: { room: VillageRoom; own: string | null; name: string; start: [number, number, number]; goal: RefObject<[number, number, number] | null>; layer: RefObject<HTMLDivElement | null> }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const mine = useRef({ position: [...start] as [number, number, number], facing: 0, walking: false });
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
    mine.current = { position: [...start] as [number, number, number], facing: 0, walking: false };
    // `start` is where the viewer stands as they come to an island (its key stands for it).
  }, [start.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, elapsed) => {
    const delta = Math.min(0.1, elapsed);
    // The viewer's own: toward the ground pressed, turning to face the way.
    if (own) {
      const me = mine.current;
      const target = goal.current;
      let walking = false;
      if (target) {
        const dx = target[0] - me.position[0];
        const dz = target[2] - me.position[2];
        const away = Math.hypot(dx, dz);
        if (away < 0.05) goal.current = null;
        else {
          const step = Math.min(away, SPEED * delta);
          me.position = [me.position[0] + (dx / away) * step, 0, me.position[2] + (dz / away) * step];
          me.facing = Math.atan2(dx, dz);
          walking = true;
        }
      }
      me.walking = walking;
      room.move(me.position, me.facing, walking);
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
      const cloud = element.querySelector<HTMLElement>('.mg-saju-said');
      const said = room.said.get(id);
      if (cloud) {
        const showing = !!said && said.until > now;
        if (showing && cloud.textContent !== said.text) cloud.textContent = said.text;
        cloud.hidden = !showing;
      }
    }
  });

  return (
    <>
      {own && <Figure key={`self:${own}`} dog={own} walking={() => mine.current.walking} holder={holderOf(SELF)} />}
      {room.present.map((id) => {
        const walker = room.others.get(id);
        return walker ? <Figure key={`${id}:${walker.dog}`} dog={walker.dog} walking={() => room.others.get(id)?.walking ?? false} holder={holderOf(id)} /> : null;
      })}
      <Labels layer={layer} ids={[...(own ? [SELF] : []), ...room.present]} names={(id) => (id === SELF ? name : (room.others.get(id)?.name ?? ''))} />
    </>
  );
}

/** Keeps one label (a name and a cloud) in `layer` for each of `ids`. */
function Labels({ layer, ids, names }: { layer: RefObject<HTMLDivElement | null>; ids: string[]; names: (id: string) => string }) {
  const key = ids.join('|');
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
        const cloud = document.createElement('p');
        cloud.className = 'mg-saju-said';
        cloud.hidden = true;
        const tag = document.createElement('span');
        tag.className = 'mg-saju-walker-name';
        element.append(cloud, tag);
        host.append(element);
      }
      element.querySelector('.mg-saju-walker-name')!.textContent = names(id);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => layer.current?.replaceChildren(), [layer]);
  return null;
}
