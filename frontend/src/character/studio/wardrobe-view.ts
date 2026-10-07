import type { WardrobeBody, WardrobePart, WardrobeUnavailable } from '../factory/api';

const SHAPE_SLOTS = ['top', 'bottom'];
const FIT_REASONS = new Map([
  ['needs_anchors', '피팅 기준점 필요'],
  ['garment_fit_incomplete', '피팅 미완료'],
  ['fit_exception', '피팅 중 오류'],
  // The seal's quality gate (backend avatar_part_gate).
  ['shoes_incomplete', '신발 일부 없음'],
  ['shoes_toes_exposed', '발가락 드러남'],
  ['shoes_broken', '신발 조각남'],
  ['hat_covers_eyes', '모자가 눈을 가림'],
  ['hair_covers_eyes', '머리카락이 눈을 가림'],
  ['hair_backing_overhang', '뒷머리 판이 늘어짐'],
  ['torn_surface', '표면 찢김'],
  ['holes', '구멍'],
  ['stray_geometry', '튀어나온 조각'],
]);

/** A failed fit check, for operators only: they hide a bad part with the catalog's trash, and members wear every part
 * the server offers (a server that signs no member scope sends them the checks too). */
export const fitFailures = (part: WardrobePart, operator: boolean): string[] =>
  operator && part.fit_check?.status === 'fail' ? part.fit_check.failures : [];

/** The slots of `saved` (a look, an outfit) worn from `parts`: each slot's part as saved, or the same job's part as a
 * refit left it, and the slots whose part the wardrobe no longer offers. */
export function partsOf<T extends { job_id: string; version: string; sha256: string }>(
  saved: Record<string, T>, slots: readonly string[], parts: WardrobePart[],
): { worn: Record<string, WardrobePart>; missing: string[] } {
  const worn: Record<string, WardrobePart> = {}, missing: string[] = [];
  for (const [slot, ref] of Object.entries(saved)) {
    if (!slots.includes(slot)) continue;
    const part = parts.find(item => item.slot === slot && item.job_id === ref.job_id && item.version === ref.version && item.sha256 === ref.sha256)
      // A refit gives the job a new version; its current part in that slot is the same part refitted.
      || parts.find(item => item.slot === slot && item.job_id === ref.job_id);
    if (part) worn[slot] = part; else missing.push(slot);
  }
  return { worn, missing };
}

/** Whether something saved on `saved` (a look, an outfit) is on `body`: its version, or one of the earlier versions of
 * the same geometry the server lists as its aliases. */
export const onBody = (body: Pick<WardrobeBody, 'job_id' | 'version' | 'aliases'>, saved: { job_id: string; version: string }): boolean =>
  body.job_id === saved.job_id && (body.version === saved.version || !!body.aliases?.includes(saved.version));

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
