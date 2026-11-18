import { ELEMENTS, type Balance, type Element } from './elements';

const pieces = [
  ['wood', 'pine-bonsai', '청자 솔분재'],
  ['wood', 'bamboo-wheel', '대나무 바람개비'],
  ['wood', 'plum-planter', '매화 화분'],
  ['fire', 'lotus-lamp', '홍련 석등'],
  ['fire', 'copper-brazier', '구리 화로'],
  ['fire', 'vermilion-lamp', '주홍 정자등'],
  ['earth', 'ochre-cairn', '황토 돌탑'],
  ['earth', 'harvest-jar', '이삭 옹기'],
  ['earth', 'clay-peaks', '삼봉 산수석'],
  ['metal', 'silver-bell', '물고기 풍경'],
  ['metal', 'silver-crane', '은빛 학'],
  ['metal', 'gold-sphere', '황금 혼천의'],
  ['water', 'lotus-basin', '백련 수반'],
  ['water', 'rain-spout', '청자 물받이'],
  ['water', 'koi-fountain', '비단잉어 분수'],
] as const satisfies readonly (readonly [Element, string, string])[];

export type ElementPiece = { element: Element; ref: typeof pieces[number][1]; label: string; image: string };
export const ELEMENT_PIECES: readonly ElementPiece[] = pieces.map(([element, ref, label]) => ({
  element, ref, label, image: `/saju/ornaments/${ref}.webp`,
}));

export const elementPiece = (ref: string) => ELEMENT_PIECES.find((piece) => piece.ref === ref);

const dayPieces: Record<string, ElementPiece['ref']> = {
  甲: 'pine-bonsai', 乙: 'plum-planter', 丙: 'lotus-lamp', 丁: 'vermilion-lamp', 戊: 'clay-peaks',
  己: 'harvest-jar', 庚: 'silver-crane', 辛: 'gold-sphere', 壬: 'koi-fountain', 癸: 'rain-spout',
};

export function dayOrnament(stem: string) {
  const ref = dayPieces[stem];
  return ref && elementPiece(ref);
}

/** All tied minima are kept, including every absent element on a six-character chart. */
export function supplementElements(balance: Balance): Element[] {
  const least = Math.min(...Object.values(balance.counts));
  return ELEMENTS.filter((element) => balance.counts[element] === least);
}
