import {
  createBuildingPlugin,
  createGaesupRuntime,
  type GameplayAreaConfig,
  type GameplayEventBlueprint,
  type GaesupRuntime,
  type SaveAdapter,
} from 'gaesup-world';

import { asset, modelUrl } from './figures';
import { at, CELL, createVillage, VILLAGE_VERSION } from './village';

export { asset, modelUrl };

type RuntimeErrorSink = NonNullable<NonNullable<Parameters<typeof createGaesupRuntime>[0]>['onError']>;

/** The server keeps saves per world id, so a new village version starts every island fresh. */
export const MINIHOME_WORLD_ID = `minihome-v${VILLAGE_VERSION}`;

const arrive = (areaId: string, text: string): GameplayEventBlueprint => ({
  id: `arrive-${areaId}`, name: `${areaId} 도착`, trigger: { type: 'enterArea', areaId }, actions: [{ type: 'toast', kind: 'info', text }],
});

/** Trigger boxes the rule engine hears through `enterArea`; each spans whole cells of the map. */
const area = (id: string, x: number, z: number, width: number, depth: number): GameplayAreaConfig =>
  ({ id, center: [at(x) + ((width - 1) * CELL) / 2, 1, at(z) + ((depth - 1) * CELL) / 2], size: [width * CELL, 4, depth * CELL] });
export const AREAS: GameplayAreaConfig[] = [
  area('miniroom', 3, 2, 2, 2),
  area('field', 10, 7, 2, 2),
  area('pond', 1, 7, 2, 3),
  area('beach', 0, 12, 14, 2),
];

const RULES: GameplayEventBlueprint[] = [
  arrive('miniroom', '🏠 나의 미니룸'),
  arrive('field', '🌱 텃밭'),
  arrive('pond', '🐟 연못가'),
  arrive('beach', '🌊 해변 산책 중'),
];

/**
 * One home's world: its own runtime and stores, loading and saving through `adapter`. The island has no residents:
 * the owner, visitors and their live room are the people on it.
 */
export function createMinihomeRuntime(adapter: SaveAdapter, onError?: RuntimeErrorSink): GaesupRuntime {
  const runtime = createGaesupRuntime({
    worldId: MINIHOME_WORLD_ID,
    plugins: [createBuildingPlugin()],
    saveOptions: { adapter },
    ...(onError ? { onError } : {}),
  });
  runtime.buildingStore.getState().hydrate(createVillage());
  runtime.gameplayEvents.setBlueprints(RULES);
  return runtime;
}
