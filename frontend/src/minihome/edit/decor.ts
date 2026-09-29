import type { ModelPiece } from './catalog';

/**
 * Decor made for the island with the studio's prop pipeline (scripts/props: manifest ids under `decor/`), sized in metres,
 * served from public/gltf/decor with a picture each. Placed like studio models, at scale 1.
 */
const decor = (id: string, label: string): ModelPiece => ({
  kind: 'model',
  key: `decor-${id}`,
  id: `decor-${id}`,
  label,
  icon: 'studio',
  defaultColor: '#ffffff',
  modelUrl: `gltf/decor/${id}.glb`,
  thumbnailUrl: `/gltf/decor/thumbs/${id}.webp`,
});

/** Rock piles and flower beds, shown with the nature models. */
export const DECOR_NATURE: ModelPiece[] = [
  decor('rock-pile-small', '작은 돌무더기'),
  decor('rock-pile-large', '큰 돌무더기'),
  decor('rock-cairn', '돌탑'),
  decor('rock-boulder-moss', '이끼 바위'),
  decor('rock-ledge', '층진 바위'),
  decor('flower-tulip-bed', '튤립 화단'),
  decor('flower-sunflower', '해바라기'),
  decor('flower-rose-bush', '장미 덤불'),
  decor('flower-hydrangea', '수국'),
  decor('flower-lavender', '라벤더 화단'),
  decor('flower-daisy', '들꽃 무더기'),
];

/** Garden sculptures and village pieces. */
export const DECOR_GARDEN: ModelPiece[] = [
  decor('flower-pot', '화분'),
  decor('deco-fountain', '분수'),
  decor('deco-bird-bath', '새 물통'),
  decor('deco-stone-lantern', '석등'),
  decor('deco-statue-fox', '여우 석상'),
  decor('deco-statue-bear', '곰 목각상'),
  decor('deco-sundial', '해시계'),
  decor('deco-flower-arch', '꽃 아치'),
  decor('deco-bench', '정원 벤치'),
  decor('deco-well', '우물'),
  decor('deco-signpost', '이정표'),
  decor('deco-picnic-table', '피크닉 테이블'),
  decor('deco-parasol-table', '파라솔 테이블'),
  decor('deco-notice-board', '게시판'),
];

/** Farm tools and crop patches. */
export const DECOR_FARM: ModelPiece[] = [
  decor('farm-scarecrow', '허수아비'),
  decor('farm-hay-bale', '건초 더미'),
  decor('farm-veg-crate', '채소 상자'),
  decor('farm-wheelbarrow', '손수레'),
  decor('farm-watering-can', '물뿌리개'),
  decor('farm-beehive', '벌통'),
  decor('farm-barrel', '오크통'),
  decor('crop-pumpkin', '호박밭'),
  decor('crop-cabbage', '양배추 이랑'),
  decor('crop-corn', '옥수수'),
  decor('crop-wheat', '밀밭'),
  decor('crop-carrot', '당근 이랑'),
];
