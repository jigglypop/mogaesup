export const partLabels: Record<string, string> = {
  body: '기본 몸', hair: '헤어', head: '기존 머리 파츠', hairBack: '뒷머리', hairFront: '앞머리',
  hat: '모자·머리 장식', top: '상의', bottom: '하의', shoes: '신발', weapon: '무기', tool: '도구', glasses: '안경',
};

export const garmentSlots = ['top', 'bottom', 'shoes'] as const;
/** Slots a character is generated with besides its body. */
export const characterSlots = ['hair', 'hat', ...garmentSlots] as const;
export const variantSlots = [...characterSlots, 'weapon', 'tool', 'glasses'] as const;
