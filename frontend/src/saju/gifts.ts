import type { GiftDesign, ReadingElement } from '../api/types';

export const GIFT_FORMS = {
  union: { name: '인연 꽃문', model: 'deco-flower-arch' },
  flow: { name: '상생의 샘', model: 'deco-fountain' },
  same: { name: '쌍둥이 석등', model: 'deco-stone-lantern' },
  spark: { name: '균형의 해시계', model: 'deco-sundial' },
} as const;

export const GIFT_STONES: Record<ReadingElement, { name: string; color: string }> = {
  wood: { name: '비취', color: '#64ab88' },
  fire: { name: '홍옥', color: '#d05a55' },
  earth: { name: '호박', color: '#d9a14e' },
  metal: { name: '백금', color: '#c3c5ce' },
  water: { name: '청금석', color: '#4d7db5' },
};

export function giftLabel(design: GiftDesign) {
  return `${GIFT_STONES[design.from].name}·${GIFT_STONES[design.to].name} ${GIFT_FORMS[design.tone].name}`;
}
