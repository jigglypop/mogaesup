import type { WardrobePart, WardrobeUnavailable } from '../factory/api';

const SHAPE_SLOTS = ['top', 'bottom'];
const FIT_REASONS = new Map([
  ['needs_anchors', '피팅 기준점 필요'],
  ['garment_fit_incomplete', '피팅 미완료'],
  ['fit_exception', '피팅 중 오류'],
]);

/** The parts on offer: a part that failed its fit check is worn only by operators, who look into it; members never
 * see it, so their character never wears a part known to clip through the body. */
export const wearableParts = (parts: WardrobePart[], operator: boolean): WardrobePart[] =>
  operator ? parts : parts.filter(part => part.fit_check?.status !== 'fail');

/** The parts that could not be fitted, for operators only. */
export const unfittedParts = (parts: WardrobeUnavailable[] | undefined, operator: boolean): WardrobeUnavailable[] => (operator ? (parts ?? []) : []);

export const fitReason = (code: string): string => FIT_REASONS.get(code) ?? '피팅 실패';

/**
 * The worn tops and bottoms whose shape can be rebuilt. A rebuild refits the part in its own job, which is paid studio
 * work and makes a new version of a part everyone shares, so only paid operators get the controls.
 */
export function reshapable(worn: Partial<Record<string, WardrobePart>>, paidOperator: boolean): [slot: string, part: WardrobePart][] {
  if (!paidOperator) return [];
  return SHAPE_SLOTS.flatMap((slot): [string, WardrobePart][] => {
    const part = worn[slot];
    return part?.fit_method === 'body-shell-v1' ? [[slot, part]] : [];
  });
}
