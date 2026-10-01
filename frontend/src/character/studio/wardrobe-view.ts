import type { WardrobePart } from '../factory/api';

const SHAPE_SLOTS = ['top', 'bottom'];

/** The parts a person is offered: operators see every fit, everyone else only the parts that passed the fit check. */
export const wearableParts = (parts: WardrobePart[], operator: boolean): WardrobePart[] =>
  operator ? parts : parts.filter((part) => part.fit_check?.status !== 'fail');

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
