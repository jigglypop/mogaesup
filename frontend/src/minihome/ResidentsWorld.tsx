import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';

import type { GaesupRuntime, NPCInstanceData, NPCTemplate } from 'gaesup-world';

import type { CatalogItem } from '../api/types';
import { Icon } from '../ui/icons';
import {
  FACE_RADIUS,
  lookTarget,
  residentInstance,
  residentTemplate,
  shownResidents,
  TALK_RANGE,
  type GreetingStore,
  type Resident,
  type ResidentStore,
} from './residents';

/** How often residents look for someone to turn to, in seconds. */
const LOOK_EVERY = 0.2;
/** A greeting card closes by itself after this long, or once the player walks off. */
const GREETING_MS = 10_000;
const HEAD = 0.9;

type ResidentsWorldProps = {
  runtime: GaesupRuntime;
  residents: ResidentStore;
  /** Published 주민 catalog items; residents of any other item stay saved but are not drawn. */
  items: readonly CatalogItem[];
  greetings: GreetingStore;
};

/**
 * The island's residents inside its canvas. They become the runtime's NPCs, which the engine's NPC system (mounted by
 * the building controller) draws with their idle clip, a nameplate, culling and animation level of detail. Talking to
 * one runs through the world's interaction key, and a few times a second each turns toward the player when they come
 * near. Nothing here sets React state per frame.
 */
export function ResidentsWorld({ runtime, residents, items, greetings }: ResidentsWorldProps) {
  // The residents as the engine's NPCs; an unchanged resident keeps its instance, so its pose is not reset.
  useEffect(() => {
    const templates = new WeakMap<CatalogItem, NPCTemplate>();
    const instances = new WeakMap<Resident, NPCInstanceData>();
    const sync = () => {
      const shown = shownResidents(residents.getState(), items);
      const used = new Map<string, NPCTemplate>();
      for (const item of items) {
        if (!shown.some((resident) => resident.npc === item.id)) continue;
        let template = templates.get(item);
        if (!template) templates.set(item, (template = residentTemplate(item)));
        used.set(template.id, template);
      }
      const drawn = new Map<string, NPCInstanceData>();
      for (const resident of shown) {
        let instance = instances.get(resident);
        if (!instance) instances.set(resident, (instance = residentInstance(resident)));
        drawn.set(resident.id, instance);
      }
      runtime.npcStore.setState({ templates: used, instances: drawn });
    };
    sync();
    const unsubscribe = residents.subscribe(sync);
    return () => {
      unsubscribe();
      runtime.npcStore.setState({ templates: new Map(), instances: new Map() });
    };
  }, [runtime, residents, items]);

  // Each resident is something the player can talk to: the interaction key (or the button) shows its greeting.
  useEffect(() => {
    let releases: (() => void)[] = [];
    const sync = () => {
      for (const release of releases) release();
      releases = shownResidents(residents.getState(), items).map((resident) => {
        const at = new Vector3(resident.position[0], resident.position[1] + HEAD, resident.position[2]);
        const live = new Vector3();
        return runtime.interactablesStore.getState().register({
          id: `resident:${resident.id}`,
          kind: 'npc',
          label: `${resident.name}에게 말 걸기`,
          key: 'e',
          range: TALK_RANGE,
          position: at,
          getPosition: () => {
            const pose = runtime.npcSimulation.getPose(resident.id);
            return pose ? live.set(pose.position[0], pose.position[1] + HEAD, pose.position[2]) : at;
          },
          onActivate: () => {
            const { x, y, z } = runtime.stateManager.getActiveState().position;
            runtime.npcSimulation.greet(resident.id, [x, y, z]);
            greetings.show({ id: resident.id, name: resident.name, greeting: resident.greeting });
          },
        });
      });
    };
    sync();
    const unsubscribe = residents.subscribe(sync);
    return () => {
      unsubscribe();
      for (const release of releases) release();
    };
  }, [runtime, residents, items, greetings]);

  // Turning toward whoever comes near, and back once they leave; a greeting ends when the player walks away.
  const facing = useRef(new Map<string, boolean>());
  const since = useRef(0);
  useFrame((_, delta) => {
    since.current += delta;
    if (since.current < LOOK_EVERY) return;
    since.current = 0;
    if (runtime.buildingStore.getState().isInEditMode()) return;
    const { x, y, z } = runtime.stateManager.getActiveState().position;
    const player = [x, y, z];
    for (const resident of residents.getState()) {
      const pose = runtime.npcSimulation.getPose(resident.id);
      if (!pose) continue;
      const { near, target } = lookTarget(pose.position, resident.rotation, player);
      if (near || facing.current.get(resident.id)) runtime.npcSimulation.face(resident.id, target);
      facing.current.set(resident.id, near);
    }
    const talking = greetings.get();
    const pose = talking && runtime.npcSimulation.getPose(talking.id);
    if (talking && (!pose || Math.hypot(pose.position[0] - x, pose.position[2] - z) > FACE_RADIUS + 1)) greetings.hide();
  });

  return null;
}

/** What the resident the player talked to says, in the island's glass. */
export function ResidentGreeting({ greetings }: { greetings: GreetingStore }) {
  const greeting = useSyncExternalStore(greetings.subscribe, greetings.get);
  useEffect(() => {
    if (!greeting) return undefined;
    const timer = setTimeout(greetings.hide, GREETING_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') greetings.hide();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [greeting, greetings]);
  if (!greeting) return null;
  return (
    <section className="mg-greeting mg-glass" role="status" aria-live="polite" aria-label={`${greeting.name}의 인사`}>
      <div>
        <b>{greeting.name}</b>
        {greeting.greeting && <p>{greeting.greeting}</p>}
      </div>
      <button type="button" className="mg-icon-btn is-quiet" aria-label="인사 닫기" onClick={greetings.hide}>
        <Icon name="close" />
      </button>
    </section>
  );
}
