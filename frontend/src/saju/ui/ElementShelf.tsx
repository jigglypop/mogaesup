import { useState } from 'react';

import { dayOrnament, ELEMENT_PIECES, supplementElements, type ElementPiece } from '../elementalDecor';
import { ELEMENT_NAME, ELEMENTS, type Balance, type Element } from '../elements';
import type { DayMaster } from '../profile';
import type { Placing } from './DecorCard';
import './elementShelf.css';

type Props = { balance: Balance; dayMaster: DayMaster; full: boolean; placing: Placing | null; onPlacing: (next: Placing | null) => void };

export function ElementShelf({ balance, dayMaster, full, placing, onPlacing }: Props) {
  const recommended = supplementElements(balance);
  const [chosen, choose] = useState<Element | null>(null);
  const element = chosen ?? recommended[0]!;
  const { ko, hanja } = ELEMENT_NAME[element];
  const count = balance.counts[element];
  const recommendation = balance.lacking.length ? '내 사주에 없는 오행' : '내 사주에서 가장 적은 오행';
  const dayPiece = dayOrnament(dayMaster.stem);
  const active = (piece: ElementPiece) => placing?.kind === 'prop' && !placing.itemId && placing.ref === piece.ref;
  const pick = (piece: ElementPiece) => onPlacing(active(piece) ? null : { kind: 'prop', ref: piece.ref, label: piece.label });
  return (
    <section className="mg-element-shelf" aria-label="오행 장식">
      {dayPiece && <button type="button" className="mg-day-ornament" data-element={dayPiece.element}
        aria-label={`내 일간 장식 ${dayPiece.label} 놓기`} aria-pressed={active(dayPiece)} disabled={full} onClick={() => pick(dayPiece)}>
        <img src={dayPiece.image} width="80" height="80" alt="" />
        <span><small>{dayMaster.label} 일간 장식</small><strong>{dayPiece.label}</strong></span>
        <b aria-hidden="true">{active(dayPiece) ? '✓' : '+'}</b>
      </button>}
      <h3>오행 장식</h3>
      <p className="mg-element-supplement">{recommendation} <strong>{recommended.map((one) => ELEMENT_NAME[one].ko).join(' · ')}</strong></p>
      <div className="mg-element-filters" role="group" aria-label="장식의 오행">
        {ELEMENTS.map((one) => (
          <button key={one} type="button" data-element={one} aria-pressed={element === one} aria-label={`${ELEMENT_NAME[one].ko} 장식 보기`} onClick={() => choose(one)}>
            <i aria-hidden="true" />{ELEMENT_NAME[one].ko}
          </button>
        ))}
      </div>
      <div className="mg-element-heading" data-element={element}>
        <b>{ko}<span aria-hidden="true">{hanja}</span></b>
        <small>내 명식 {count} / {balance.total}자</small>
      </div>
      <div className="mg-element-choices" data-element={element}>
        {ELEMENT_PIECES.filter((piece) => piece.element === element).map((piece) => {
          return <button key={piece.ref} type="button" disabled={full} aria-pressed={active(piece)} onClick={() => pick(piece)}>
            <img src={piece.image} width="128" height="128" alt="" draggable={false} />
            <span>{piece.label}</span>
          </button>;
        })}
      </div>
    </section>
  );
}
