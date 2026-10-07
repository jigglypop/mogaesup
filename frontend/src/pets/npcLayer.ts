import type { NPCInstanceData, NPCTemplate } from 'gaesup-world';

/** The part of a runtime's NPC store the layers write: its templates and instances. */
type NpcStore = {
  getState: () => { templates: Map<string, NPCTemplate>; instances: Map<string, NPCInstanceData> };
  setState: (partial: { templates: Map<string, NPCTemplate>; instances: Map<string, NPCInstanceData> }) => void;
};
type Owned = { templates: Set<string>; instances: Set<string> };

/** What each layer last put in each store, by layer name. */
const layers = new WeakMap<object, Map<string, Owned>>();

function ownedBy(store: object): Map<string, Owned> {
  let owned = layers.get(store);
  if (!owned) layers.set(store, (owned = new Map()));
  return owned;
}

/**
 * The island's NPCs come from more than one place: its residents and its pet. Each sets its own layer (`layer`, such as
 * 'resident:' or 'pet:') with what it draws now; the entries it set before and no longer lists go, and every other
 * layer's entries stay as they are, the same objects, so the engine keeps their poses. One store update a call.
 */
export function setNpcLayer(
  runtime: { npcStore: NpcStore },
  layer: string,
  templates: Iterable<NPCTemplate>,
  instances: Iterable<NPCInstanceData>,
): void {
  const store = runtime.npcStore;
  const owned = ownedBy(store);
  const before = owned.get(layer) ?? { templates: new Set<string>(), instances: new Set<string>() };
  const state = store.getState();
  const nextTemplates = new Map(state.templates);
  const nextInstances = new Map(state.instances);
  for (const id of before.templates) nextTemplates.delete(id);
  for (const id of before.instances) nextInstances.delete(id);
  const now: Owned = { templates: new Set(), instances: new Set() };
  for (const template of templates) {
    nextTemplates.set(template.id, template);
    now.templates.add(template.id);
  }
  for (const instance of instances) {
    nextInstances.set(instance.id, instance);
    now.instances.add(instance.id);
  }
  // Another layer that listed the same id gave it up to this one.
  for (const [name, other] of owned) {
    if (name === layer) continue;
    for (const id of now.templates) other.templates.delete(id);
    for (const id of now.instances) other.instances.delete(id);
  }
  owned.set(layer, now);
  store.setState({ templates: nextTemplates, instances: nextInstances });
}

/** Takes `layer`'s entries out of the store, leaving the other layers'. */
export function clearNpcLayer(runtime: { npcStore: NpcStore }, layer: string): void {
  const owned = layers.get(runtime.npcStore)?.get(layer);
  if (!owned || (!owned.templates.size && !owned.instances.size)) {
    layers.get(runtime.npcStore)?.delete(layer);
    return;
  }
  setNpcLayer(runtime, layer, [], []);
  layers.get(runtime.npcStore)?.delete(layer);
}
