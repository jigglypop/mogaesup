import { AnimationMixer, Box3, LoopOnce, type AnimationAction, type AnimationClip, type Mesh, type Object3D, type SkinnedMesh } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// A guardian dog's model as frontend/scripts/guardians-normalize.mjs leaves it: one unit tall, standing on the origin
// and facing +z. Each is fetched once, and its mesh and picture are shared by every home that dog keeps. A dog whose rig
// held (scripts/guardians/models.json) comes with its skeleton and clips, each named for what the village plays it for;
// the others stand as they were modelled.

/** What a rigged dog does, by the names the normalizer gives its clips. */
export type Move = 'idle' | 'cheer' | 'wave' | 'walk';
/** A rigged dog's clips: the idle it stands in, and the others it has. */
export type DogClips = { idle: AnimationClip } & Partial<Record<Exclude<Move, 'idle'>, AnimationClip>>;
/** What a tap plays, in turn. The walk is kept for a dog that will one day go somewhere. */
const TAP_MOVES = ['wave', 'cheer'] as const;
export type TapMove = (typeof TAP_MOVES)[number];

export type DogModel = {
  /** The model's scene, cloned for each place the dog stands (a rigged one in its T-pose: see {@link DogRig}). */
  scene: Object3D;
  /** How far it reaches to either side of its middle, and behind it (a negative z), of its height. */
  halfWidth: number;
  back: number;
  /** A rigged dog's clips; null for one that stands as it was modelled. */
  clips: DogClips | null;
};

/** The clips a rigged dog plays, by name; null when there is no idle to stand in, as for a model that was never rigged. */
export function clipsOf(animations: readonly AnimationClip[]): DogClips | null {
  const named = new Map(animations.map((clip) => [clip.name, clip]));
  const idle = named.get('idle');
  if (!idle) return null;
  const clips: DogClips = { idle };
  for (const move of ['cheer', 'wave', 'walk'] as const) {
    const clip = named.get(move);
    if (clip) clips[move] = clip;
  }
  return clips;
}

/** The moves a tap plays, in turn: those of {@link TAP_MOVES} the dog has. */
export const tapMovesOf = (clips: DogClips): TapMove[] => TAP_MOVES.filter((move) => clips[move]);

/** A rigged dog's skinned meshes reach this much further, waving, than they do idling. */
const REACH = 1.3;

/**
 * Where a rigged model's parts lie as it idles: at the idle's first frame, not in the T-pose it was rigged in. The
 * skinned meshes keep a bounding sphere about that pose, wide enough for a wave, which every copy inherits; the bones
 * are put back afterwards.
 */
function measureIdling(scene: Object3D, idle: AnimationClip): Box3 {
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(idle).play();
  mixer.update(0);
  scene.updateMatrixWorld(true);
  // Precise: through the skin, vertex by vertex.
  const box = new Box3().setFromObject(scene, true);
  scene.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius *= REACH;
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  return box;
}

/** A loaded model as the village keeps it: casting and taking shadows, measured, and with its clips told apart. */
export function dogModelOf({ scene, animations }: { scene: Object3D; animations: readonly AnimationClip[] }): DogModel {
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  const clips = clipsOf(animations);
  // Measured through the scene: the file keeps its vertices packed, behind a transform that unpacks them.
  const box = clips ? measureIdling(scene, clips.idle) : new Box3().setFromObject(scene);
  return { scene, halfWidth: Math.max(-box.min.x, box.max.x), back: box.min.z, clips };
}

const models = new Map<string, Promise<DogModel>>();

export const dogModelUrl = (id: string) => `/gltf/guardians/${id}.glb`;

/** The model of dog `id`. A load that failed is tried again the next time it is asked for. */
export function loadDogModel(id: string): Promise<DogModel> {
  let model = models.get(id);
  if (!model) {
    model = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(dogModelUrl(id)).then(dogModelOf);
    models.set(id, model);
    model.catch(() => models.delete(id));
  }
  return model;
}

/** How far into its idle, in seconds, a dog standing at `x`, `z` starts: the dogs of a village idle out of step. */
export function idlePhase(x: number, z: number, length: number): number {
  const hash = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (hash - Math.floor(hash)) * length;
}

/** How long a tap's move and the idle take to blend into each other, in seconds. */
const BLEND = 0.3;

/**
 * A rigged dog's own copy of its model and the mixer that moves it. It idles from the first frame it is drawn in, never
 * showing the T-pose it was rigged in; asked to, it plays a move once and goes back to its idle. Its mesh and picture are
 * the model's; its skeleton is its own, to be let go of with {@link DogRig.dispose}.
 */
export class DogRig {
  /** What is drawn: a copy of the model with its own skeleton. */
  readonly figure: Object3D;
  /** The idle's length in seconds. */
  readonly idleLength: number;
  private readonly mixer: AnimationMixer;
  private readonly idle: AnimationAction;
  private readonly moves: { move: TapMove; action: AnimationAction }[];
  /** The move under way, until it has ended. */
  private playing: AnimationAction | null = null;
  private turn = 0;

  constructor(scene: Object3D, clips: DogClips) {
    this.figure = cloneSkinned(scene);
    this.mixer = new AnimationMixer(this.figure);
    this.idle = this.mixer.clipAction(clips.idle);
    this.idleLength = clips.idle.duration;
    this.moves = tapMovesOf(clips).map((move) => {
      const action = this.mixer.clipAction(clips[move]!).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      return { move, action };
    });
  }

  /** Idles from `at` seconds into the idle (0 is its first frame), posed at once: what a still scene shows. */
  rest(at: number): void {
    this.mixer.addEventListener('finished', this.ended);
    for (const { action } of this.moves) action.stop();
    this.playing = null;
    this.idle.reset().play();
    this.idle.time = this.idleLength > 0 ? ((at % this.idleLength) + this.idleLength) % this.idleLength : 0;
    this.mixer.update(0);
  }

  /** Moves the dog on by `delta` seconds. */
  advance(delta: number): void {
    this.mixer.update(delta);
  }

  /** Plays the next of its tap moves once, blending out of the idle: none while one is under way, or for a dog without any. */
  perform(): TapMove | null {
    if (this.playing || this.moves.length === 0) return null;
    const { move, action } = this.moves[this.turn % this.moves.length]!;
    this.turn += 1;
    action.reset().play();
    action.crossFadeFrom(this.idle, BLEND, false);
    this.playing = action;
    return move;
  }

  /** The move under way, if any. */
  get performing(): TapMove | null {
    return this.moves.find(({ action }) => action === this.playing)?.move ?? null;
  }

  /** A move has ended (held on its last frame): the idle comes back in from its start. */
  private readonly ended = ({ action }: { action: AnimationAction }) => {
    if (!this.playing || action !== this.playing) return;
    this.idle.reset().play();
    this.idle.crossFadeFrom(this.playing, BLEND, false);
    this.playing = null;
  };

  /**
   * Stops it and lets go of what the copy made for itself (the skeleton's bone texture, where a renderer made one). It
   * can still be rested again afterwards, as React does with an effect it tries twice. The mixer's caches are left: the
   * mixer is this copy's alone and goes with it, and an action it has forgotten cannot be played again.
   */
  dispose(): void {
    this.mixer.removeEventListener('finished', this.ended);
    this.mixer.stopAllAction();
    this.playing = null;
    this.figure.traverse((object) => {
      const mesh = object as SkinnedMesh;
      if (mesh.isSkinnedMesh) mesh.skeleton.dispose();
    });
  }
}
