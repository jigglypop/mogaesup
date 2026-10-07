import './pets.css';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useFrame } from '@react-three/fiber';
import { Vector3, type Mesh } from 'three';

import type { GaesupRuntime, NPCAction, NPCInstanceData, NPCTemplate } from 'gaesup-world';

import type { PetSignal } from '../games/useGameSession';
import { useGameRoom } from '../games/room';
import { groundHeightAt } from '../minihome/edit/objects';
import { useLivePlayers } from '../minihome/live';
import { PET_POLICY, PET_SCALE, petNpcId, type BreedInfo, type PetController, type PetWorldView } from './controller';
import { BALL_RADIUS, type PetBody, type Vec3 } from './motor';
import { clearNpcLayer, setNpcLayer } from './npcLayer';
import type { PetHome, PetHomeState } from './persistence';
import { PetPuppet, PetRelaySender, petFrame } from './relay';

/** The pet's entries in the runtime's NPC store (`setNpcLayer`), beside the residents'. */
export const PET_LAYER = 'pet:';
/** How near the owner stands to pat the pet, and how high over its root the prompt sits. */
const PAT_RANGE = 2.2;
const PAT_HEIGHT = 0.6;
/** Without the island's navigation grid yet, open ground is taken to be the island's square. */
const ISLAND_REACH = 26;
const VOLUME = { height: 0.7, radius: 0.3, interactionRadius: 1.2 };
const REST_GESTURES = { clips: ['bark'], everySeconds: 40 };

export const petTemplateId = (breed: BreedInfo) => `pet-breed:${breed.id}`;

/** The engine's NPC template for a breed: its model as one body part, drawn matte, at the breed's height. */
export function petTemplate(breed: BreedInfo): NPCTemplate {
  return {
    id: petTemplateId(breed),
    name: breed.label,
    category: 'creature',
    baseParts: [{ id: 'body', type: 'body', url: breed.modelUrl }],
    clothingParts: [],
    height: breed.height,
    materialPolicy: 'figure',
  };
}

/**
 * The engine's NPC for a pet at `home`: island-sized, turning smoothly, its paws matched to its speed (`strideSpeed`).
 * The owner's page decides for it (`brain`); everyone else's has it lie at home, barking now and then, until frames come.
 */
export function petInstance(id: string, name: string, breed: BreedInfo, home: Vec3, driven: boolean): NPCInstanceData {
  const idle = driven ? 'idle' : breed.clips.includes('lie_hold') ? 'lie_hold' : 'idle';
  return {
    id: petNpcId(id),
    templateId: petTemplateId(breed),
    name,
    position: [...home],
    rotation: [0, 0, 0],
    scale: [PET_SCALE, PET_SCALE, PET_SCALE],
    currentAnimation: idle,
    volume: { ...VOLUME },
    brain: driven ? { mode: 'scripted', policyId: PET_POLICY } : { mode: 'none' },
    behavior: {
      mode: 'idle',
      speed: 0,
      turnSpeed: 8,
      waitSeconds: 0.5,
      home: [...home],
      idleAnimation: idle,
      strideSpeed: breed.strideSpeed,
      faceOnInteract: false,
      ...(driven ? {} : { gestures: REST_GESTURES }),
    },
  };
}

/** The pet's NPC in the runtime's store and simulation. */
/**
 * The walk and the run move the paws at different speeds, and the NPC has one `strideSpeed`: it follows the clip the
 * last move in `actions` goes with.
 */
function pace(runtime: GaesupRuntime, id: string, breed: BreedInfo, actions: readonly NPCAction[] | undefined): void {
  let clip: string | undefined;
  for (const action of actions ?? []) if (action.type === 'moveTo') clip = (action as { animationId?: string }).animationId;
  if (!clip) return;
  const stride = clip === 'run' ? (breed.runStrideSpeed ?? breed.strideSpeed) : breed.strideSpeed;
  const store = runtime.npcStore.getState();
  const instance = store.instances.get(id);
  if (!instance?.behavior || instance.behavior.strideSpeed === stride) return;
  store.updateInstance(id, { behavior: { ...instance.behavior, strideSpeed: stride } });
}

function npcBody(runtime: GaesupRuntime, id: string, breed: BreedInfo): PetBody {
  const store = runtime.npcStore;
  return {
    pose() {
      const pose = runtime.npcSimulation.getPose(id);
      return pose ? { position: [pose.position[0], pose.position[1], pose.position[2]], yaw: pose.rotation[1] } : null;
    },
    moving: () => store.getState().instances.get(id)?.navigation?.state === 'moving',
    act(actions) {
      if (!store.getState().instances.has(id)) return;
      pace(runtime, id, breed, actions);
      store.getState().executeInstanceActions(id, actions);
    },
    gesture: (clip) => runtime.npcSimulation.gesture(id, clip),
    face: (target) => runtime.npcSimulation.face(id, target),
    place(at, yaw) {
      const instance = store.getState().instances.get(id);
      if (!instance) return;
      store.getState().updateInstance(id, {
        position: [...at],
        rotation: [0, yaw, 0],
        navigation: undefined,
        currentAnimation: instance.behavior?.idleAnimation ?? 'idle',
      });
    },
  };
}

type PetWorldProps = {
  home: PetHome;
  runtime: GaesupRuntime;
  /** The owner is decorating: the pet stands at home. */
  decorating: boolean;
};

/** The island's pet inside its canvas; mount inside the world's physics, under the island's live and game rooms. */
export function PetWorld({ home, runtime, decorating }: PetWorldProps) {
  const state = useSyncExternalStore(home.subscribe, home.getState);
  const pet = state.pet;
  if (state.phase !== 'ready' || !pet) return null;
  return <IslandPet key={`${pet.id}:${pet.breedView.modelUrl}`} pet={pet} controller={state.controller} runtime={runtime} decorating={decorating} />;
}

type IslandPetProps = {
  pet: NonNullable<PetHomeState['pet']>;
  controller: PetController | null;
  runtime: GaesupRuntime;
  decorating: boolean;
};

function IslandPet({ pet, controller, runtime, decorating }: IslandPetProps) {
  const room = useGameRoom();
  const client = room?.client ?? null;
  const players = useLivePlayers();
  const playersRef = useRef(players);
  playersRef.current = players;
  // Another of the owner's pages relays the pet: this one shows it as visitors do.
  const [busy, setBusy] = useState(false);
  const driving = !!controller && !busy;
  const id = petNpcId(pet.id);
  // A rename brings a new record of the same breed; the NPC and its puppet stay as they are.
  const breedView = pet.breedView;
  const breed = useMemo(() => breedView, [breedView.id, breedView.modelUrl]);
  const ground = useCallback(
    (x: number, z: number) => groundHeightAt(runtime.buildingStore.getState().tileGroups.values(), x, z),
    [runtime],
  );
  const homeAt = useMemo<Vec3>(() => [pet.home.x, ground(pet.home.x, pet.home.z), pet.home.z], [pet.home.x, pet.home.z, ground]);
  const body = useMemo(() => npcBody(runtime, id, breed), [runtime, id, breed]);
  const ball = useRef<Mesh>(null);
  const ballColor = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue('--mg-pet-ball').trim() || '#f2d43d', []);

  // The NPC itself, put in once per pet and breed; the residents' changes leave it as it is.
  const firstDriving = useRef(driving);
  useEffect(() => {
    setNpcLayer(runtime, PET_LAYER, [petTemplate(breed)], [petInstance(pet.id, pet.name, breed, homeAt, firstDriving.current)]);
    return () => clearNpcLayer(runtime, PET_LAYER);
    // The name, home and who drives it change in place below; the NPC is made anew only for another pet or breed.
  }, [runtime, pet.id, breed]);
  useEffect(() => {
    const instance = runtime.npcStore.getState().instances.get(id);
    if (instance && instance.name !== pet.name) runtime.npcStore.getState().updateInstance(id, { name: pet.name });
  }, [runtime, id, pet.name]);
  useEffect(() => {
    const store = runtime.npcStore.getState();
    const instance = store.instances.get(id);
    if (!instance) return;
    store.updateInstanceBrain(id, driving ? { mode: 'scripted', policyId: PET_POLICY } : { mode: 'none' });
    store.updateInstance(id, { behavior: { ...(instance.behavior ?? { mode: 'idle', speed: 0 }), home: [...homeAt] } });
  }, [runtime, id, driving, homeAt]);

  const world = useMemo<PetWorldView>(
    () => ({
      owner() {
        const state = runtime.stateManager.getActiveState();
        const at = state.position;
        if (!at) return null;
        return { position: [at.x, at.y, at.z], yaw: state.euler?.y ?? 0, speed: Math.hypot(state.velocity?.x ?? 0, state.velocity?.z ?? 0) };
      },
      visitors() {
        const map = playersRef.current;
        return map ? [...map].map(([peer, player]) => ({ id: peer, position: player.position })) : [];
      },
      hour: () => runtime.timeStore.getState().time.hour,
      ground,
      walkable(x, z) {
        const navigation = runtime.navigation;
        if (navigation.isReady) return navigation.isWalkable(x, z, { agentRadius: VOLUME.radius * PET_SCALE });
        return Math.abs(x) <= ISLAND_REACH && Math.abs(z) <= ISLAND_REACH;
      },
    }),
    [runtime, ground],
  );

  // The owner's page: the brain decides, the body follows, frames go out.
  const sender = useMemo(() => (client?.sendPet ? new PetRelaySender((frame) => client.sendPet?.(frame) ?? false) : null), [client]);
  useEffect(() => {
    if (!driving || !controller) return undefined;
    const release = controller.attach(body, world);
    const unregister = runtime.npcBrainAdapters.register('scripted', PET_POLICY, () => {
      const decision = controller.decide();
      pace(runtime, id, breed, decision?.actions);
      return decision;
    });
    return () => {
      unregister();
      release();
      sender?.letGo();
    };
  }, [driving, controller, body, world, runtime, sender, id, breed]);
  useEffect(() => controller?.setConditions({ decorating }), [controller, decorating]);

  // Everyone else's page (and the owner's while another page relays the pet): the frames move the NPC.
  const puppet = useMemo(
    () =>
      driving
        ? null
        : new PetPuppet(body, breed.motion, homeAt, (on) => {
            const instance = runtime.npcStore.getState().instances.get(id);
            if (!instance || !!instance.behavior?.gestures === on) return;
            const behavior = { ...(instance.behavior ?? { mode: 'idle' as const, speed: 0 }) };
            if (on) behavior.gestures = REST_GESTURES;
            else delete behavior.gestures;
            runtime.npcStore.getState().updateInstance(id, { behavior });
          }),
    [driving, body, breed.motion, homeAt, runtime, id],
  );
  useEffect(() => puppet?.rest(), [puppet]);
  useEffect(() => {
    if (!client?.onPet) return undefined;
    return client.onPet((signal: PetSignal) => {
      if (signal.type === 'refused') {
        if (signal.code === 'pet_busy' && controller) {
          setBusy(true);
          controller.setConditions({ busy: true });
        }
        return;
      }
      if (signal.pet && signal.pet.id !== pet.id) return;
      if (busy && signal.pet === null && controller) {
        // The page that relayed it let go: this one takes the pet back.
        setBusy(false);
        controller.setConditions({ busy: false });
        return;
      }
      puppet?.apply(signal.pet);
    });
  }, [client, controller, puppet, busy, pet.id]);

  // Patting: the interaction key (or the button) near the pet, on the owner's page.
  useEffect(() => {
    if (!driving || !controller) return undefined;
    const at = new Vector3(homeAt[0], homeAt[1] + PAT_HEIGHT, homeAt[2]);
    const live = new Vector3();
    return runtime.interactablesStore.getState().register({
      id: `${id}:pat`,
      kind: 'npc',
      label: `${pet.name} 쓰다듬기`,
      key: 'e',
      range: PAT_RANGE,
      position: at,
      getPosition: () => {
        const pose = runtime.npcSimulation.getPose(id);
        return pose ? live.set(pose.position[0], pose.position[1] + PAT_HEIGHT, pose.position[2]) : at;
      },
      onActivate: () => {
        controller.feedback('pat');
        const { x, y, z } = runtime.stateManager.getActiveState().position;
        runtime.npcSimulation.face(id, [x, y, z]);
      },
    });
  }, [driving, controller, runtime, id, pet.name, homeAt]);

  useFrame((_, delta) => {
    let shown: { at: Vec3 } | null = null;
    if (driving && controller) {
      controller.setConditions({ away: !!client?.trip(), hidden: document.visibilityState === 'hidden' });
      controller.tick(delta);
      const motor = controller.bodyMotor;
      if (motor) {
        shown = motor.ball;
        const now = performance.now() / 1000;
        const frame = sender && room?.live ? petFrame(pet.id, now, body, motor) : null;
        if (frame) sender?.offer(now, frame, !!motor.ball?.flight);
      }
    } else if (puppet) {
      puppet.tick(delta);
      shown = puppet.ball;
    }
    const mesh = ball.current;
    if (!mesh) return;
    mesh.visible = !!shown;
    if (shown) mesh.position.set(shown.at[0], shown.at[1], shown.at[2]);
  });

  return (
    <mesh ref={ball} visible={false} castShadow>
      <sphereGeometry args={[BALL_RADIUS, 16, 12]} />
      <meshStandardMaterial color={ballColor} roughness={0.55} />
    </mesh>
  );
}
