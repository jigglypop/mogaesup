import { createBuildingPlugin, createGaesupRuntime, type GaesupRuntime, type SaveAdapter } from 'gaesup-world';

import { templateOf } from './islands';
import { islandBinding, type IslandStore } from './islands/domain';
import { residentsBinding, type ResidentStore } from './residents';
import { VILLAGE_VERSION } from './village';

type RuntimeErrorSink = NonNullable<NonNullable<Parameters<typeof createGaesupRuntime>[0]>['onError']>;

/** The server keeps saves per world id, so a new village version starts every island fresh. */
export const MINIHOME_WORLD_ID = `minihome-v${VILLAGE_VERSION}`;

/**
 * One home's world: its own runtime and stores, loading and saving through `adapter`, its residents and its kind of
 * island with it. The arrival notes follow the kind.
 */
export function createMinihomeRuntime(adapter: SaveAdapter, residents: ResidentStore, island: IslandStore, onError?: RuntimeErrorSink): GaesupRuntime {
  const runtime = createGaesupRuntime({
    worldId: MINIHOME_WORLD_ID,
    plugins: [createBuildingPlugin()],
    saveOptions: { adapter },
    saveBindings: [residentsBinding(residents), islandBinding(island)],
    ...(onError ? { onError } : {}),
  });
  const template = templateOf(island.getState());
  runtime.buildingStore.getState().hydrate(template.build());
  runtime.gameplayEvents.setBlueprints(template.rules);
  island.subscribe(() => runtime.gameplayEvents.setBlueprints(templateOf(island.getState()).rules));
  return runtime;
}
