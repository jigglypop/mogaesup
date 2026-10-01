import type { FitProfile, PartMethod } from '../factory/api';

export type FitChoices = {
  sleeve: NonNullable<FitProfile['sleeve']>;
  kind: NonNullable<FitProfile['kind']>;
  ease: NonNullable<FitProfile['ease']>;
};

/**
 * Sleeve length and ease reach only the single-view method's prompt; the worn and body-shell methods build the garment on
 * the body and ignore them. So they are asked, and sent, only for that method. The lower garment's kind (pants or skirt)
 * is read by every method.
 */
export const fitsByPrompt = (method: PartMethod) => method === 'isolated';

/** The fit a top or bottom request carries; what the method ignores is always the default, so equal requests look equal. */
export function fitProfileFor(slot: string, method: PartMethod, { sleeve, kind, ease }: FitChoices): FitProfile | undefined {
  const asked = fitsByPrompt(method);
  const sleeveSent = asked ? sleeve : 'source';
  const easeSent = asked ? ease : 'source';
  if (slot === 'top') return { revision: 'garment-fit-v1', sleeve: sleeveSent, ease: easeSent };
  if (slot === 'bottom') return { revision: 'garment-fit-v1', kind, ease: easeSent };
  return undefined;
}
