import { useState } from 'react';

import type { DecorItem, FlagDesign } from '../../api/types';
import { Icon } from '../../ui/icons';
import { MOST_ITEMS, PROPS, type Decor } from '../decor';

/** What is being placed: a kind of thing and which one. */
export type Placing = { kind: DecorItem['kind']; ref: string; label: string };

/** How far one press of the turn button turns a placed thing. */
const TURN_STEP = Math.PI / 4;

const labelOf = (item: DecorItem, decor: NonNullable<Decor['decor']>, own: FlagDesign | null): string => {
  if (item.kind === 'character') return '내 캐릭터';
  if (item.kind === 'prop') return PROPS.find((prop) => prop.ref === item.ref)?.label ?? item.ref;
  if (item.ref === 'mine') return `내 깃발${own ? ` · ${own.star}` : ''}`;
  const flag = decor.flags.find((one) => one.id === item.ref);
  return flag ? `${flag.giver.name}의 깃발 · ${flag.design.star}` : '깃발';
};

/**
 * 꾸미기, on the owner's own 섬: what can be placed (their flag, the flags given to them, small things, their
 * character), what is placed (each turned or taken away), and, while something is being placed, the press on the island
 * that places it (see Stage's onPlace).
 */
export function DecorCard({ state, own, placing, onPlacing }: { state: Decor; own: FlagDesign | null; placing: Placing | null; onPlacing: (placing: Placing | null) => void }) {
  const { decor, place, drop, problem } = state;
  if (!decor) return null;
  const full = decor.items.length >= MOST_ITEMS;
  const pick = (next: Placing) => onPlacing(placing && placing.kind === next.kind && placing.ref === next.ref ? null : next);
  const chosen = (kind: DecorItem['kind'], ref: string) => placing?.kind === kind && placing.ref === ref;
  const turn = (item: DecorItem) => place(decor.items.map((one) => (one.id === item.id ? { ...one, turn: ((one.turn + TURN_STEP + Math.PI) % (Math.PI * 2)) - Math.PI } : one)));
  const remove = (item: DecorItem) => place(decor.items.filter((one) => one.id !== item.id));
  const characterPlaced = decor.items.some((item) => item.kind === 'character');
  return (
    <section className="mg-saju-card mg-saju-decor" aria-label="꾸미기">
      <h2 className="mg-heading">꾸미기</h2>
      <div className="mg-saju-decor-pick" role="group" aria-label="놓을 것">
        {own && (
          <button className="mg-chip" aria-pressed={chosen('flag', 'mine')} disabled={full} onClick={() => pick({ kind: 'flag', ref: 'mine', label: `내 깃발 · ${own.star}` })}>
            내 깃발 · {own.star}
          </button>
        )}
        {decor.flags.map((flag) => (
          <span key={flag.id} className="mg-chip">
            <button className="mg-saju-decor-flag" aria-pressed={chosen('flag', flag.id)} disabled={full} onClick={() => pick({ kind: 'flag', ref: flag.id, label: `${flag.giver.name}의 깃발` })}>
              {flag.giver.name}의 깃발 · {flag.design.star}
            </button>
            <button className="mg-icon-btn is-quiet" aria-label={`${flag.giver.name}의 깃발 내리기`} onClick={() => drop(flag)}>
              <Icon name="close" />
            </button>
          </span>
        ))}
        {decor.character && !characterPlaced && (
          <button className="mg-chip" aria-pressed={chosen('character', 'me')} disabled={full} onClick={() => pick({ kind: 'character', ref: 'me', label: '내 캐릭터' })}>
            내 캐릭터
          </button>
        )}
        {PROPS.map((prop) => (
          <button key={prop.ref} className="mg-chip is-soft" aria-pressed={chosen('prop', prop.ref)} disabled={full} onClick={() => pick({ kind: 'prop', ref: prop.ref, label: prop.label })}>
            {prop.label}
          </button>
        ))}
      </div>
      {placing && (
        <p className="mg-muted" role="status">
          {placing.label}: 섬에서 놓을 자리를 누르세요
        </p>
      )}
      {decor.items.length > 0 && (
        <ul className="mg-saju-decor-placed" aria-label={`놓은 것 ${decor.items.length}/${MOST_ITEMS}`}>
          {decor.items.map((item) => (
            <li key={item.id}>
              <span>{labelOf(item, decor, own)}</span>
              <button className="mg-icon-btn is-quiet" aria-label="돌리기" onClick={() => turn(item)}>
                <Icon name="rotate" />
              </button>
              <button className="mg-icon-btn is-quiet" aria-label="치우기" onClick={() => remove(item)}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** On someone else's 섬: the visitor's own flag, to give it (once a day for each 섬). */
export function GiveFlagCard({ own, onGive }: { own: FlagDesign; onGive: (design: FlagDesign) => Promise<string | null> }) {
  const [said, setSaid] = useState<{ sent: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const give = () => {
    if (busy) return;
    setBusy(true);
    onGive(own)
      .then((problem) => setSaid(problem ? { sent: false, text: problem } : { sent: true, text: '깃발을 선물했어요' }))
      .finally(() => setBusy(false));
  };
  return (
    <section className="mg-saju-card mg-saju-decor" aria-label="깃발 선물하기">
      <button className="mg-btn is-primary" disabled={busy || said?.sent === true} onClick={give}>
        내 깃발 선물하기 · {own.star}
      </button>
      {said && (
        <p className={said.sent ? 'mg-muted' : 'mg-error'} role={said.sent ? 'status' : 'alert'}>
          {said.text}
        </p>
      )}
    </section>
  );
}
