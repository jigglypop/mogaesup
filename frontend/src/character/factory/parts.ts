export const partLabels: Record<string, string> = {
  body: '기본 몸', hair: '헤어', head: '기존 머리 파츠', hairBack: '뒷머리', hairFront: '앞머리',
  hat: '모자·머리 장식', top: '상의', bottom: '하의', shoes: '신발', weapon: '무기', tool: '도구', glasses: '안경',
};

export const garmentSlots = ['top', 'bottom', 'shoes'] as const;
/** Slots a character is generated with besides its body. */
export const characterSlots = ['hair', 'hat', ...garmentSlots] as const;
export const variantSlots = [...characterSlots, 'weapon', 'tool', 'glasses'] as const;

/** The same replacements as production's is_native_part_set: split front/back may be worn together. */
const replacements: Record<string, readonly string[]> = {
  head: ['hair', 'hairFront', 'hairBack', 'hat'],
  hair: ['head', 'hairFront', 'hairBack'],
  hairFront: ['head', 'hair'],
  hairBack: ['head', 'hair'],
  hat: ['head'],
};

export function selectPartSlot(current: readonly string[], slot: string): string[] {
  return [...current.filter(value => value !== slot && !replacements[slot]?.includes(value)), slot];
}

/** Repair older saved combinations: a full hairstyle wins over split/legacy hair; modern parts replace legacy head. */
export function compatiblePartSlots(slots: readonly string[]): string[] {
  const unique = [...new Set(slots)];
  if (unique.includes('hair')) return unique.filter(slot => !['head', 'hairFront', 'hairBack'].includes(slot));
  if (unique.some(slot => ['hairFront', 'hairBack', 'hat'].includes(slot))) return unique.filter(slot => slot !== 'head');
  return unique;
}

export function hasConflictingPartSlots(slots: readonly string[]): boolean {
  return slots.length !== compatiblePartSlots(slots).length;
}
