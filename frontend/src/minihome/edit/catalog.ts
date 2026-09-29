import {
  BUILDING_TREE_COLOR_PRESETS,
  BUILDING_TREE_OPTIONS,
  DEFAULT_BUILDING_OBJECT_CATALOG,
  type BuildingObjectCatalogItem,
  type BuildingTreeKind,
} from 'gaesup-world/building';

import { DECOR_FARM, DECOR_GARDEN, DECOR_NATURE } from './decor';
import type { EditPart } from './session';

export type Shelf = 'furniture' | 'living' | 'nature' | 'garden' | 'farm' | 'floor' | 'wall' | 'studio' | 'residents';

export const SHELVES: { id: Shelf; label: string; part: EditPart }[] = [
  { id: 'furniture', label: '가구', part: 'object' },
  { id: 'living', label: '생활', part: 'object' },
  { id: 'nature', label: '자연', part: 'object' },
  { id: 'garden', label: '정원', part: 'object' },
  { id: 'farm', label: '농장', part: 'object' },
  { id: 'floor', label: '바닥', part: 'tile' },
  { id: 'wall', label: '벽', part: 'wall' },
  { id: 'studio', label: '스튜디오에서 만든 것', part: 'object' },
  { id: 'residents', label: '주민', part: 'object' },
];

/** A catalog GLB (or a studio model): placed at its catalog size. */
export type ModelPiece = {
  kind: 'model';
  key: string;
  id: string;
  label: string;
  icon: string;
  tint?: string;
  defaultColor: string;
  modelUrl?: string;
  thumbnailUrl?: string;
};
/** One of the engine's drawn trees, whose kind sets its shape and colours. */
export type TreePiece = { kind: 'tree'; key: string; treeKind: BuildingTreeKind; label: string; icon: string; tint: string };
/** A flag or a campfire: animated pieces the engine draws itself. */
export type LivelyPiece = { kind: 'lively'; key: string; type: 'flag' | 'fire'; label: string; icon: string };
export type Piece = ModelPiece | TreePiece | LivelyPiece;

const modelPiece = (item: BuildingObjectCatalogItem, icon: string = item.fallbackKind, tint?: string): ModelPiece => ({
  kind: 'model',
  key: item.id,
  id: item.id,
  label: item.label,
  icon,
  ...(tint ? { tint } : {}),
  defaultColor: item.defaultColor,
  ...(item.modelUrl ? { modelUrl: item.modelUrl } : {}),
});

const byCategory = (...categories: BuildingObjectCatalogItem['category'][]) =>
  DEFAULT_BUILDING_OBJECT_CATALOG.filter((item) => categories.includes(item.category));

export const FURNITURE: Piece[] = byCategory('furniture', 'decor').map((item) => modelPiece(item));
export const LIVING: Piece[] = [
  ...byCategory('utility', 'structure', 'shop').map((item) => modelPiece(item)),
  { kind: 'lively', key: 'flag', type: 'flag', label: '깃발', icon: 'flag' },
  { kind: 'lively', key: 'fire', type: 'fire', label: '모닥불', icon: 'fire' },
];

/** Drawings and colours for the nature models the village itself is made of, in the order the drawer shows them. */
const NATURE_LOOKS: [id: string, icon: string, tint?: string][] = [
  ['nature-tree-round', 'tree', '#7cbf5f'],
  ['nature-tree-oak', 'fruitTree', '#6fae5b'],
  ['nature-tree-pine', 'pine', '#4f8f5a'],
  ['nature-tree-fat', 'tree', '#5f9e4b'],
  ['nature-tree-thin', 'thinTree', '#8cc76a'],
  ['nature-bush', 'bush', '#6fae5b'],
  ['nature-fern', 'fern'],
  ['nature-flower-red', 'flower', '#ff6b6b'],
  ['nature-flower-yellow', 'flower', '#ffd24d'],
  ['nature-flower-purple', 'flower', '#b48cff'],
  ['nature-mushroom-cluster', 'mushroom', '#ff8a6b'],
  ['nature-lily', 'lily', '#ffb3c9'],
  ['nature-stump', 'stump', '#c29462'],
  ['nature-fallen-log', 'log', '#c29462'],
  ['nature-rock-round', 'rock', '#bdb7ac'],
  ['nature-rock-wide', 'rock', '#bdb7ac'],
  ['nature-rock-tall', 'rock', '#bdb7ac'],
  ['nature-rock-large', 'rock', '#aaa498'],
  ['nature-rock-small', 'rock', '#cdc7bc'],
  ['nature-rock-flat', 'rock', '#cdc7bc'],
  ['nature-rock-moss', 'rock', '#94b273'],
];

const TREE_ICONS: Partial<Record<BuildingTreeKind, string>> = { sakura: 'sakura', pine: 'pine', cypress: 'thinTree', dead: 'deadTree' };
/** The drawn pine shares its name with the nature model's; the drawn trees are the big ones. */
const TREE_LABELS: Partial<Record<BuildingTreeKind, string>> = { pine: '큰 소나무' };

const NATURE_MODELS = DEFAULT_BUILDING_OBJECT_CATALOG.filter((item) => item.category === 'nature');
const natureModel = (id: string) => NATURE_MODELS.find((item) => item.id === id);

export const NATURE: Piece[] = [
  ...NATURE_LOOKS.slice(0, 5).flatMap(([id, icon, tint]) => {
    const item = natureModel(id);
    return item ? [modelPiece(item, icon, tint)] : [];
  }),
  ...BUILDING_TREE_OPTIONS.map(
    (option): TreePiece => ({
      kind: 'tree',
      key: `tree-${option.type}`,
      treeKind: option.type,
      label: TREE_LABELS[option.type] ?? option.labelKo,
      icon: TREE_ICONS[option.type] ?? 'tree',
      tint: BUILDING_TREE_COLOR_PRESETS[option.type].primaryColor,
    }),
  ),
  ...NATURE_LOOKS.slice(5).flatMap(([id, icon, tint]) => {
    const item = natureModel(id);
    return item ? [modelPiece(item, icon, tint)] : [];
  }),
  // Nature models a later engine adds still show up, with a plain drawing.
  ...NATURE_MODELS.filter((item) => !NATURE_LOOKS.some(([id]) => id === item.id)).map((item) => modelPiece(item, 'bush')),
  ...DECOR_NATURE,
];

export const GARDEN: Piece[] = DECOR_GARDEN;
export const FARM: Piece[] = DECOR_FARM;

/** The island's own floors first, so painted ground can go back to lawn. */
export const ISLAND_FLOORS = [
  { id: 'lawn', label: '잔디밭', color: '#8ccd65' },
  { id: 'flowers', label: '꽃밭', color: '#6fbf53' },
  { id: 'field', label: '밭', color: '#8a5f3a' },
  { id: 'floor', label: '마루', color: '#d3a36a' },
];
