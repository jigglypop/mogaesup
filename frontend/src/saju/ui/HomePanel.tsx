import { Link } from 'react-router-dom';

import { Icon } from '../../ui/icons';
import type { Compat } from '../compat';
import type { Element } from '../elements';
import { HOUSE_NAME, type Profile } from '../profile';
import type { GuestEntry, Resident } from '../residents';
import { EDIT, SAJU } from '../routes';
import { sajuStore } from '../store';
import { Gauge } from './Gauge';
import { Guestbook } from './Guestbook';
import { PixelIcon } from './PixelIcon';

/** What stands between the viewer's home and this one. */
export type BridgeState =
  /** The viewer has no home to build a bridge from. */
  | { kind: 'homeless' }
  | { kind: 'open'; compat: Compat }
  /** Built; `shown` while the stage is showing the two homes and the bridge between them. */
  | { kind: 'built'; compat: Compat; shown: boolean };

/** 궁합 다리: the way to build the bridge to a neighbour, and once it is built, what the two charts found in each other. */
function BridgeCard({ resident, bridge, onShow }: { resident: Resident; bridge: BridgeState; onShow: (shown: boolean) => void }) {
  if (bridge.kind === 'homeless') {
    return (
      <section className="mg-saju-card mg-saju-bridge" aria-label="궁합 다리">
        <h2 className="mg-heading">궁합 다리</h2>
        <Link className="mg-btn is-wide" to={SAJU}>
          내 집 짓기
        </Link>
      </section>
    );
  }
  if (bridge.kind === 'open') {
    return (
      <section className="mg-saju-card mg-saju-bridge" aria-label="궁합 다리">
        <h2 className="mg-heading">궁합 다리</h2>
        <button
          className="mg-btn is-primary is-wide"
          onClick={() => {
            sajuStore.connect(resident.id);
            onShow(true);
          }}
        >
          <Icon name="sparkle" /> 궁합 다리 연결
        </button>
      </section>
    );
  }
  return (
    <section className="mg-saju-card mg-saju-bridge is-built" aria-label="궁합 다리">
      <h2 className="mg-heading">궁합 다리</h2>
      <p className="mg-saju-bridge-line">{bridge.compat.headline}</p>
      <ul className="mg-saju-notes">
        {bridge.compat.notes.map((note) => (
          <li key={note} className="mg-chip is-soft">
            {note}
          </li>
        ))}
      </ul>
      <button className="mg-btn is-small" aria-pressed={bridge.shown} onClick={() => onShow(!bridge.shown)}>
        <Icon name={bridge.shown ? 'island' : 'link'} /> {bridge.shown ? '집 보기' : '다리 보기'}
      </button>
    </section>
  );
}

/**
 * A home's story beside its canvas: the day master in a line, the house and guardian the chart gave, the balance of
 * elements, the bridge to it (a neighbour's home) and its guestbook.
 */
export function HomePanel({ resident, profile, mine, bridge, onShowBridge, entries, canWrite, elementOf }: {
  resident: Resident;
  profile: Profile;
  /** The viewer's own home. */
  mine: boolean;
  bridge: BridgeState | null;
  onShowBridge: (shown: boolean) => void;
  entries: readonly GuestEntry[];
  canWrite: boolean;
  elementOf: (author: string) => Element | null;
}) {
  const { balance, guardian, house } = profile;
  return (
    <>
      <section className="mg-saju-card mg-saju-who" aria-label="사주 요약">
        <span className="mg-saju-who-mark">
          <PixelIcon name={balance.dominant} size={30} />
        </span>
        <div className="mg-saju-who-text">
          <p className="mg-saju-badge">{profile.badge}</p>
          <ul className="mg-saju-notes">
            <li className="mg-chip is-soft">{HOUSE_NAME[house.style]}</li>
            <li className="mg-chip is-soft">
              {guardian.name} · {guardian.pillar}
            </li>
            {guardian.charms.map((item) => (
              <li key={item.charm} className="mg-chip is-soft">
                {item.label}
              </li>
            ))}
          </ul>
        </div>
        {mine && (
          <Link className="mg-icon-btn is-quiet mg-saju-who-edit" to={EDIT} aria-label="내 정보 고치기">
            <Icon name="edit" />
          </Link>
        )}
      </section>
      <section className="mg-saju-card" aria-label="오행 밸런스">
        <h2 className="mg-heading">오행 밸런스</h2>
        <Gauge balance={balance} />
      </section>
      {bridge && <BridgeCard resident={resident} bridge={bridge} onShow={onShowBridge} />}
      <Guestbook home={resident.id} entries={entries} canWrite={canWrite} elementOf={elementOf} />
    </>
  );
}
