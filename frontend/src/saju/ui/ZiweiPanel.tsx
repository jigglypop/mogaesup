import './ziwei.css';

import { memo, useState } from 'react';

import { Link } from 'react-router-dom';

import { Icon } from '../../ui/icons';
import { keyOf, type Birth } from '../engine';
import { STAR_KINDS, ziweiOf, type Ziwei, type ZiweiPalace, type ZiweiStar } from '../ziwei';

/** How a palace stands to the one that is picked: 삼방사정 is the picked palace, its two trines and the one across. */
type Relation = 'self' | 'trine' | 'opposite';

/**
 * Where a ring cell's row (or column) meets the square in the middle of the ring, in hundredths of the square's side:
 * a corner cell touches it at a corner, a side cell at the middle of its own half. The relation lines run between
 * these points.
 */
const EDGE = [0, 25, 75, 100] as const;
const pointOf = (palace: ZiweiPalace) => ({ x: EDGE[palace.col] ?? 50, y: EDGE[palace.row] ?? 50 });

/** A star as a 명반 writes it: its name, how bright it stands there, and the 사화 the birth year gave it. */
function StarMark({ star, hanja = false }: { star: ZiweiStar; hanja?: boolean }) {
  return (
    <span className="mg-ziwei-star" data-kind={star.kind}>
      {star.name}
      {hanja && star.hanja && <span lang="zh-Hant">{star.hanja}</span>}
      {star.brightness && <small>{star.brightness}</small>}
      {star.sahwa && (
        <b className="mg-ziwei-sahwa" data-sahwa={star.sahwa}>
          {star.sahwa}
        </b>
      )}
    </span>
  );
}

/** What a palace's button is called: the palace and its 간지, what it is besides, and its major stars. */
function nameOf(palace: ZiweiPalace): string {
  return [
    `${palace.name} ${palace.ganji.ko}`,
    palace.isBody && '신궁',
    palace.isOrigin && '래인궁',
    palace.isCurrent && '현재 대한',
    palace.stars.major.map((star) => star.name).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
}

function Cell({ palace, relation, onPick }: { palace: ZiweiPalace; relation: Relation | null; onPick: () => void }) {
  const { stars, decade } = palace;
  const minor = [...stars.lucky, ...stars.tough, ...stars.special];
  // What else the palace is. A narrow cell has room for the first syllable alone, and only at its foot; a wide one
  // says it beside the name. The cell holds both and its width shows one.
  const flags = (palace.isBody || palace.isOrigin) && (
    <span className="mg-ziwei-flags">
      {palace.isBody && (
        <i>
          신<span>궁</span>
        </i>
      )}
      {palace.isOrigin && (
        <i>
          래<span>인궁</span>
        </i>
      )}
    </span>
  );
  return (
    <button
      type="button"
      className="mg-ziwei-palace"
      style={{ gridArea: `${palace.row + 1} / ${palace.col + 1}` }}
      aria-pressed={relation === 'self'}
      aria-label={nameOf(palace)}
      data-relation={relation ?? undefined}
      data-soul={palace.isSoul || undefined}
      onClick={onPick}
    >
      <span className="mg-ziwei-head">
        <b className="mg-ziwei-name">{palace.name}</b>
        {flags}
        <span className="mg-ziwei-ganji">
          {palace.ganji.ko}
          <span lang="zh-Hant">{palace.ganji.hanja}</span>
        </span>
      </span>
      <span className="mg-ziwei-major">
        {stars.major.map((star) => (
          <StarMark key={star.id} star={star} />
        ))}
      </span>
      <span className="mg-ziwei-minor">
        {minor.map((star) => (
          <StarMark key={star.id} star={star} />
        ))}
        {/* A narrow cell counts the stars it has no room to name. */}
        {stars.misc.length > 0 && <span className="mg-ziwei-more">+{stars.misc.length}</span>}
      </span>
      <span className="mg-ziwei-misc">
        {stars.misc.map((star) => (
          <StarMark key={star.id} star={star} />
        ))}
      </span>
      {/* Two and two, so that a line too long for the cell breaks in the middle. */}
      <span className="mg-ziwei-cycles">
        {[palace.cycles.slice(0, 2), palace.cycles.slice(2)].map((pair, half) => (
          <span key={half}>{pair.map((cycle) => cycle.name).join(' ')}</span>
        ))}
      </span>
      <span className="mg-ziwei-foot">
        {decade && (
          <span className="mg-ziwei-decade" data-current={palace.isCurrent || undefined}>
            {decade.from}–{decade.to}
          </span>
        )}
        {flags}
      </span>
    </button>
  );
}

/** 삼방사정 over the middle of the ring: the picked palace and its trines as a triangle, and a broken line across. */
function Lines({ ziwei, picked }: { ziwei: Ziwei; picked: ZiweiPalace }) {
  if (!picked.surround) return null;
  const from = pointOf(picked);
  const trines = picked.surround.trines.flatMap((index) => ziwei.palaces[index] ?? []).map(pointOf);
  const across = ziwei.palaces[picked.surround.opposite];
  const to = across ? pointOf(across) : null;
  return (
    <span className="mg-ziwei-lines" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        <polygon points={[from, ...trines].map(({ x, y }) => `${x},${y}`).join(' ')} />
        {to && <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />}
      </svg>
      {/* The ends are not part of the drawing: stretched with it, a dot would be an oval. */}
      {[from, ...trines, ...(to ? [to] : [])].map(({ x, y }) => (
        <i key={`${x},${y}`} style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
    </span>
  );
}

/**
 * A palace in full: the palaces it is read with, every star by kind, its cycles and years, and its 비성사화. `onPick`
 * goes on to one of the palaces it is read with; without it the card is a copy that only takes up room, with no name
 * of its own and nothing in it that can be pressed.
 */
function Detail({ ziwei, palace, onPick }: { ziwei: Ziwei; palace: ZiweiPalace; onPick?: (index: number) => void }) {
  // The palaces it is read with wear the edge their cells wear on the ring, and pick as those cells do. Each keeps its
  // place whichever palace it names, so the focus stays on the button that was pressed.
  const related = (relation: Relation, indexes: readonly number[]) =>
    indexes.map((index, place) => (
      <button key={place} type="button" data-relation={relation} disabled={!onPick} onClick={() => onPick?.(index)}>
        {ziwei.palaces[index]?.name}
      </button>
    ));
  const kinds = STAR_KINDS.filter(({ kind }) => palace.stars[kind].length > 0);
  return (
    <section
      className={onPick ? 'mg-saju-card mg-ziwei-detail' : 'mg-saju-card'}
      aria-label={onPick ? `${palace.name} ${palace.ganji.ko}` : undefined}
      aria-hidden={onPick ? undefined : true}
    >
      <h2 className="mg-heading">
        {palace.name}
        <small>
          {palace.ganji.ko} <span lang="zh-Hant">{palace.ganji.hanja}</span>
        </small>
        {palace.isBody && <span className="mg-badge">신궁</span>}
        {palace.isOrigin && <span className="mg-badge">래인궁</span>}
        {palace.isCurrent && <span className="mg-badge mg-ziwei-now">현재 대한</span>}
      </h2>
      <div className="mg-ziwei-halves">
        {/* These come first: under the stars, whose rows differ from palace to palace, a button that was pressed would
            be drawn somewhere else, away from the pointer that goes on round the 삼합. */}
        {palace.surround && (
          <dl className="mg-ziwei-rows">
            <div>
              <dt>삼합</dt>
              <dd className="mg-ziwei-related">{related('trine', palace.surround.trines)}</dd>
            </div>
            <div>
              <dt>대궁</dt>
              <dd className="mg-ziwei-related">{related('opposite', [palace.surround.opposite])}</dd>
            </div>
          </dl>
        )}
        {kinds.length > 0 && (
          <dl className="mg-ziwei-rows mg-ziwei-kinds">
            {kinds.map(({ kind, label }) => (
              <div key={kind}>
                <dt>{label}</dt>
                <dd className="mg-ziwei-stars">
                  {palace.stars[kind].map((star) => (
                    <StarMark key={star.id} star={star} hanja />
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <dl className="mg-ziwei-rows">
          {palace.cycles.length > 0 && (
            <div>
              <dt>12신</dt>
              <dd className="mg-ziwei-pairs">
                {palace.cycles.map((cycle) => (
                  <span key={cycle.label}>
                    <small>{cycle.label}</small> {cycle.name}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {palace.decade && (
            <div>
              <dt>대한</dt>
              <dd className="mg-ziwei-years">
                <span>
                  {palace.decade.from}–{palace.decade.to}세
                </span>
              </dd>
            </div>
          )}
          {palace.ages.length > 0 && (
            <div>
              <dt>소한</dt>
              <dd className="mg-ziwei-years">
                {palace.ages.map((age, index) => (
                  <span key={age}>
                    {age}
                    {index === palace.ages.length - 1 && '세'}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {palace.flies.length > 0 && (
            <div>
              <dt>비성사화</dt>
              <dd className="mg-ziwei-pairs">
                {palace.flies.map((fly) => (
                  <span key={fly.sahwa}>
                    <b className="mg-ziwei-sahwa" data-sahwa={fly.sahwa}>
                      {fly.sahwa}
                    </b>{' '}
                    {ziwei.palaces[fly.to]?.name}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}

/** Every palace's card, to lie unseen where the picked one's is. A chart's twelve do not change with the pick. */
const Unseen = memo(function Unseen({ ziwei }: { ziwei: Ziwei }) {
  return ziwei.palaces.map((palace) => <Detail key={palace.index} ziwei={ziwei} palace={palace} />);
});

/**
 * 자미두수: the 명반 of a home's birth, as jamiblossom draws it. The twelve palaces stand round a ring by earthly branch
 * with the chart's summary in the middle; picking one marks its 삼방사정 and shows it in full below. `editTo` is where
 * the owner enters the birth again (null for a visitor): a birth without an hour has no 명반.
 */
export function ZiweiPanel({ birth, editTo }: { birth: Birth; editTo: string | null }) {
  const ziwei = ziweiOf(birth);
  // The palace picked on this birth's chart: another birth's starts again from its own 명궁. It is held against the
  // birth and not the chart, which is drawn again each day.
  const of = keyOf(birth);
  const [pick, setPick] = useState<{ of: string; index: number } | null>(null);
  if (!ziwei) {
    return (
      <section className="mg-saju-card mg-ziwei-none" aria-label="자미두수 명반">
        <p>태어난 시간을 알아야 명반을 세울 수 있어요</p>
        {editTo && (
          <Link className="mg-btn is-small" to={editTo}>
            <Icon name="edit" /> 사주 다시 입력
          </Link>
        )}
      </section>
    );
  }
  const picked = ziwei.palaces[pick?.of === of ? pick.index : ziwei.soul];
  if (!picked) return null;
  const pickAt = (index: number) => setPick({ of, index });
  const relationOf = (index: number): Relation | null => {
    if (index === picked.index) return 'self';
    if (picked.surround?.trines.includes(index)) return 'trine';
    return picked.surround?.opposite === index ? 'opposite' : null;
  };
  const soul = ziwei.palaces[ziwei.soul];
  const body = ziwei.body === null ? null : ziwei.palaces[ziwei.body];
  // Round the ring from the 명궁, the way a 명반 is read: the order the cells take the keyboard's focus in.
  const inTurn = [...ziwei.palaces.slice(ziwei.soul), ...ziwei.palaces.slice(0, ziwei.soul)];
  return (
    <div className="mg-ziwei">
      <section className="mg-saju-card mg-ziwei-board" aria-label="자미두수 명반">
        <h2 className="mg-heading">자미두수 명반</h2>
        <div className="mg-ziwei-grid">
          <div className="mg-ziwei-centre">
            <Lines ziwei={ziwei} picked={picked} />
            <div className="mg-ziwei-summary">
              <b className="mg-ziwei-bureau" data-element={ziwei.bureau.element ?? undefined}>
                {ziwei.bureau.name}
              </b>
              <dl>
                {soul && (
                  <div>
                    <dt>명궁</dt>
                    <dd>{soul.ganji.ko}</dd>
                  </div>
                )}
                {body && (
                  <div>
                    <dt>신궁</dt>
                    <dd>{body.ganji.ko}</dd>
                  </div>
                )}
                <div>
                  <dt>명주</dt>
                  <dd>{ziwei.soulStar}</dd>
                </div>
                <div>
                  <dt>신주</dt>
                  <dd>{ziwei.bodyStar}</dd>
                </div>
                <div className="is-long">
                  <dt>음력</dt>
                  <dd>{ziwei.lunarDate}</dd>
                </div>
                <div className="is-long">
                  <dt>시진</dt>
                  <dd>
                    {ziwei.hour.name} {ziwei.hour.range && <small>{ziwei.hour.range}</small>}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          {inTurn.map((palace) => (
            <Cell key={palace.index} palace={palace} relation={relationOf(palace.index)} onPick={() => pickAt(palace.index)} />
          ))}
        </div>
      </section>
      {/* The place of the picked palace's card is as tall as the fullest of the twelve, whichever is picked: under a
          card that got shorter, a column scrolled to its end would slide, and the ring and the card's buttons with
          it, from under the pointer. */}
      <div className="mg-ziwei-fit">
        <Detail ziwei={ziwei} palace={picked} onPick={pickAt} />
        <Unseen ziwei={ziwei} />
      </div>
    </div>
  );
}
