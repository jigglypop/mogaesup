import { useState, type KeyboardEvent, type ReactNode } from 'react';

import type { DecorItem, FlagDesign } from '../../api/types';
import { Icon } from '../../ui/icons';
import { MOST_ITEMS, PROPS, type Decor } from '../decor';
import { elementPiece } from '../elementalDecor';
import { giftLabel } from '../gifts';
import './decorEditor.css';

/** An item picked from a shelf, or the particular copy being moved. */
export type Placing = { kind: DecorItem['kind']; ref: string; label: string; itemId?: string };

const TURN_STEP = Math.PI / 4;
const PALETTES = [
  { name: '붉은 계열', shades: [['로즈', '#ef899c'], ['코랄', '#eb715c'], ['크림슨', '#ba254c'], ['와인', '#72253e']] },
  { name: '녹색 계열', shades: [['새싹', '#bad88b'], ['비취', '#58ad8a'], ['이끼', '#738353'], ['숲', '#305b48']] },
  { name: '푸른 계열', shades: [['물빛', '#90d7dc'], ['하늘', '#83afd9'], ['쪽빛', '#52699e'], ['남색', '#303e69']] },
  { name: '흙빛 계열', shades: [['모래', '#e7cc99'], ['꿀빛', '#dba752'], ['황토', '#b97648'], ['밤색', '#715044']] },
  { name: '무채색 계열', shades: [['진주', '#eee9de'], ['은빛', '#b8bcc5'], ['돌빛', '#878491'], ['먹색', '#494354']] },
] as const;

function ItemPalette({ color, onChange }: { color?: string; onChange: (color: string | undefined) => void }) {
  const [family, setFamily] = useState(() => Math.max(0, PALETTES.findIndex((line) => line.shades.some(([, hex]) => hex === color))));
  const palette = PALETTES[family]!;
  return (
    <div className="mg-decor-colors">
      <div className="mg-decor-line">
        <label>색상 <select aria-label="색상 계열" value={family} onChange={(event) => setFamily(Number(event.target.value))}>
          {PALETTES.map((line, i) => <option value={i} key={line.name}>{line.name}</option>)}
        </select></label>
        <button className="mg-decor-reset" disabled={!color} onClick={() => onChange(undefined)}>원래 색</button>
      </div>
      <div className="mg-decor-swatches" role="group" aria-label={palette.name}>
        {palette.shades.map(([name, hex]) => <button key={hex} aria-pressed={color === hex} onClick={() => onChange(hex)}>
          <i style={{ backgroundColor: hex }} />{name}
        </button>)}
      </div>
    </div>
  );
}

const labelOf = (item: DecorItem, decor: NonNullable<Decor['decor']>, own: FlagDesign | null): string => {
  if (item.kind === 'character') return '내 캐릭터';
  if (item.kind === 'prop') return elementPiece(item.ref)?.label ?? PROPS.find((prop) => prop.ref === item.ref)?.label ?? item.ref;
  if (item.kind === 'gift') {
    const gift = decor.gifts?.find((one) => one.id === item.ref);
    return gift ? giftLabel(gift.design) : '궁합 선물';
  }
  if (item.ref === 'mine') return `내 깃발${own ? ` · ${own.star}` : ''}`;
  const flag = decor.flags.find((one) => one.id === item.ref);
  return flag ? `${flag.giver.name}의 깃발 · ${flag.design.star}` : '깃발';
};

type DecorCardProps = {
  state: Decor;
  own: FlagDesign | null;
  placing: Placing | null;
  onPlacing: (placing: Placing | null) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  children?: ReactNode;
};

const SECTIONS = [
  { id: 'items', label: '아이템' },
  { id: 'terrain', label: '바닥 타일' },
  { id: 'photo', label: '사진 전광판' },
] as const;
export type DecorSection = typeof SECTIONS[number]['id'];

type StudioProps = DecorCardProps & {
  id: string;
  section: DecorSection;
  onSection: (next: DecorSection) => void;
  terrainPick?: ReactNode;
  photoBoard?: ReactNode;
};

export function DecorCard({ id, section, onSection, terrainPick, photoBoard, ...items }: StudioProps) {
  const { decor, problem } = items.state;
  if (!decor) return problem ? <p className="mg-error" role="alert">{problem}</p> : null;
  const chooseByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = SECTIONS.findIndex((tab) => tab.id === section);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = (current + SECTIONS.length - 1) % SECTIONS.length; break;
      case 'ArrowRight': next = (current + 1) % SECTIONS.length; break;
      case 'Home': next = 0; break;
      case 'End': next = SECTIONS.length - 1; break;
      default: return;
    }
    event.preventDefault();
    onSection(SECTIONS[next]!.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
  };
  const content = { items: <DecorItems {...items} decor={decor} />, terrain: terrainPick, photo: photoBoard };
  return (
    <section id={id} className="mg-saju-card mg-saju-decor" aria-labelledby={`${id}-heading`}>
      <header className="mg-decor-header">
        <h2 id={`${id}-heading`} className="mg-heading"><Icon name="brush" />꾸미기</h2>
        {section === 'items' && <span>{decor.items.length} / {MOST_ITEMS} 배치</span>}
      </header>
      <div className="mg-decor-tabs" role="tablist" aria-label="꾸미기 메뉴" onKeyDown={chooseByKey}>
        {SECTIONS.map(({ id: tab, label }) => <button key={tab} id={`${id}-tab-${tab}`} type="button"
          role="tab" aria-selected={section === tab} aria-controls={`${id}-panel-${tab}`}
          tabIndex={section === tab ? 0 : -1} onClick={() => onSection(tab)}>{label}</button>)}
      </div>
      {SECTIONS.map(({ id: tab }) => <div key={tab} id={`${id}-panel-${tab}`} className="mg-decor-content"
        role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} hidden={section !== tab}>{content[tab]}</div>)}
      {problem && <p className="mg-error" role="alert">{problem}</p>}
    </section>
  );
}

function DecorItems({ state, decor, own, placing, onPlacing, selectedId, onSelect, children }: DecorCardProps & { decor: NonNullable<Decor['decor']> }) {
  const { place, drop } = state;
  const full = decor.items.length >= MOST_ITEMS;
  const pick = (next: Placing) => onPlacing(placing && placing.kind === next.kind && placing.ref === next.ref && placing.itemId === next.itemId ? null : next);
  const chosen = (kind: DecorItem['kind'], ref: string) => !placing?.itemId && placing?.kind === kind && placing.ref === ref;
  const selected = decor.items.find((item) => item.id === selectedId);
  const update = (patch: Partial<DecorItem>) => place(decor.items.map((item) => item.id === selectedId ? { ...item, ...patch } : item));
  const scale = selected?.scale ?? 1;
  const characterPlaced = decor.items.some((item) => item.kind === 'character');
  const labels = decor.items.map((item) => labelOf(item, decor, own));
  const names = new Map(decor.items.map((item, index) => {
    const label = labels[index]!;
    const repeated = labels.indexOf(label) !== labels.lastIndexOf(label);
    const number = labels.slice(0, index + 1).filter((other) => other === label).length;
    return [item.id, repeated ? `${label} ${number}번` : label];
  }));
  const nameOf = (item: DecorItem) => names.get(item.id)!;
  return (
    <>
      {placing && <div className="mg-decor-instruction" role="status">
        <span><b>{placing.label}</b> 놓을 자리를 섬에서 눌러 주세요.</span>
        <button className="mg-decor-reset" onClick={() => onPlacing(null)}>취소</button>
      </div>}
      {selected && (!placing || placing.itemId) && (
        <section className="mg-decor-inspector" aria-label="선택한 아이템" key={selected.id}>
          <div className="mg-decor-line"><h3>{nameOf(selected)}</h3><button className="mg-icon-btn is-quiet" aria-label="선택 해제" onClick={() => onSelect(null)}><Icon name="close" /></button></div>
          <ItemPalette color={selected.color} onChange={(color) => update({ color })} />
          <div className="mg-decor-line mg-decor-size">
            <span>크기</span>
            <div className="mg-decor-stepper" role="group" aria-label="아이템 크기">
              <button className="mg-icon-btn is-quiet" aria-label="크기 줄이기" disabled={scale <= 0.5} onClick={() => update({ scale: Math.max(0.5, scale - 0.25) })}><Icon name="minus" /></button>
              <output aria-label="현재 크기">{Math.round(scale * 100)}%</output>
              <button className="mg-icon-btn is-quiet" aria-label="크기 키우기" disabled={scale >= 2} onClick={() => update({ scale: Math.min(2, scale + 0.25) })}><Icon name="plus" /></button>
            </div>
          </div>
          <div className="mg-decor-actions">
            <button className="mg-btn is-small" aria-pressed={placing?.itemId === selected.id} onClick={() => pick({ kind: selected.kind, ref: selected.ref, label: nameOf(selected), itemId: selected.id })}><Icon name="place" />옮기기</button>
            <button className="mg-btn is-small" onClick={() => update({ turn: ((selected.turn + TURN_STEP + Math.PI) % (Math.PI * 2)) - Math.PI })}><Icon name="rotate" />돌리기</button>
            <button className="mg-btn is-small mg-decor-remove" aria-label={`${nameOf(selected)} 삭제`} onClick={() => {
              onPlacing(null);
              place(decor.items.filter((item) => item.id !== selected.id));
            }}><Icon name="trash" />삭제</button>
          </div>
        </section>
      )}
      {decor.items.length > 0 && <div className="mg-decor-section">
        <h3>배치한 아이템</h3>
        <ul className="mg-decor-items" aria-label="배치한 아이템">
          {decor.items.map((item) => <li key={item.id}><button className="mg-chip" aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
            {item.color && <i style={{ backgroundColor: item.color }} />}{nameOf(item)}
          </button></li>)}
        </ul>
      </div>}
      {children}
      <details className="mg-decor-base" open>
        <summary>기본 소품</summary>
        <div className="mg-saju-decor-pick" role="group" aria-label="놓을 것">
          {PROPS.map((prop) => (
            <button key={prop.ref} className="mg-chip is-soft" aria-pressed={chosen('prop', prop.ref)} disabled={full} onClick={() => pick({ kind: 'prop', ref: prop.ref, label: prop.label })}>{prop.label}</button>
          ))}
          {own && <button className="mg-chip" aria-pressed={chosen('flag', 'mine')} disabled={full} onClick={() => pick({ kind: 'flag', ref: 'mine', label: `내 깃발 · ${own.star}` })}>내 깃발 · {own.star}</button>}
          {decor.character && !characterPlaced && <button className="mg-chip" aria-pressed={chosen('character', 'me')} disabled={full} onClick={() => pick({ kind: 'character', ref: 'me', label: '내 캐릭터' })}>내 캐릭터</button>}
        </div>
      </details>
      {(!!decor.gifts?.length || decor.flags.length > 0) && <div className="mg-decor-section">
        <h3>받은 선물</h3>
        <div className="mg-saju-decor-pick">
          {decor.gifts?.map((gift) => (
            <button className="mg-chip" key={gift.id} aria-pressed={chosen('gift', gift.id)} disabled={full} onClick={() => pick({ kind: 'gift', ref: gift.id, label: giftLabel(gift.design) })}>{giftLabel(gift.design)} · {gift.giver.name}</button>
          ))}
          {decor.flags.map((flag) => {
            const placed = decor.items.filter((item) => item.kind === 'flag' && item.ref === flag.id).length;
            const remove = placed ? `배치 ${placed}개와 선물 삭제` : '선물 삭제';
            return (
            <span key={flag.id} className="mg-chip">
              <button className="mg-saju-decor-flag" aria-pressed={chosen('flag', flag.id)} disabled={full} onClick={() => pick({ kind: 'flag', ref: flag.id, label: `${flag.giver.name}의 깃발` })}>{flag.giver.name}의 깃발 · {flag.design.star}</button>
              <button className="mg-decor-reset" aria-label={`${flag.giver.name}의 깃발 ${remove}`} onClick={() => drop(flag)}>{remove}</button>
            </span>
            );
          })}
        </div>
      </div>}
    </>
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
