import { Link } from 'react-router-dom';

import { ELEMENTS } from '../elements';
import { HOUSE_NAME, type Profile } from '../profile';
import { MY_HOME, type Resident } from '../residents';
import { homePath, SAJU } from '../routes';
import { PixelIcon } from './PixelIcon';

export type Villager = { resident: Resident; profile: Profile; bridged: boolean };

/**
 * 마을 갤러리: everyone with a home in the village, each a way into their 미니홈피. The viewer's own comes first; while
 * they have none, the empty plot does.
 */
export function VillagePanel({ villagers, hasHome }: { villagers: readonly Villager[]; hasHome: boolean }) {
  return (
    <section aria-label="마을 주민">
      <h2 className="mg-heading">
        주민 <b>{villagers.length}</b>
      </h2>
      <ul className="mg-saju-villagers">
        {!hasHome && (
          <li>
            <Link className="mg-saju-villager mg-card is-lot" to={SAJU}>
              <span className="mg-saju-villager-mark">
                <PixelIcon name="house" size={26} />
              </span>
              <span className="mg-saju-villager-text">
                <b>빈 터</b>
                <small>내 집 짓기</small>
              </span>
            </Link>
          </li>
        )}
        {villagers.map(({ resident, profile, bridged }) => {
          const { balance } = profile;
          return (
            <li key={resident.id}>
              <Link className="mg-saju-villager mg-card" data-element={balance.dominant} to={homePath(resident.id)}>
                <span className="mg-saju-villager-mark">
                  <PixelIcon name={balance.dominant} size={26} />
                </span>
                <span className="mg-saju-villager-text">
                  <b>
                    {resident.name}
                    {resident.id === MY_HOME && <span className="mg-badge">내 집</span>}
                    {resident.sample && <span className="mg-badge">샘플</span>}
                    {bridged && <span className="mg-badge is-published">다리 놓음</span>}
                  </b>
                  <small>{profile.badge}</small>
                  <small>
                    {HOUSE_NAME[profile.house.style]} · {profile.guardian.name}
                  </small>
                  <span className="mg-saju-mix" aria-hidden="true">
                    {ELEMENTS.flatMap((element) => Array.from({ length: balance.counts[element] }, (_, index) => <i key={`${element}${index}`} data-element={element} />))}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
