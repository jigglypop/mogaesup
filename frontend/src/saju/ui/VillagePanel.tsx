import { Link } from 'react-router-dom';

import { ELEMENTS } from '../elements';
import { HOUSE_NAME, type Profile } from '../profile';
import type { Resident } from '../residents';
import { homePath } from '../routes';
import { FLAG_NEIGHBOURS, flagRaised } from '../village';
import { PixelIcon } from './PixelIcon';

/** A home in the village; `bridged` when its owner is an 이웃 of the village's. */
export type Villager = { resident: Resident; profile: Profile; bridged: boolean };

/**
 * 마을 갤러리: the homes of a village, each a way into its 섬: the owner's first (an empty plot until they build
 * it), then their 이웃' and the other homes around it.
 */
export function VillagePanel({ owner, villagers, viewer }: {
  /** Whose village it is: their username and the name they go by. */
  owner: { username: string; name: string };
  villagers: readonly Villager[];
  /** The signed-in viewer's username. */
  viewer: string | null;
}) {
  const built = villagers.some(({ resident }) => resident.id === owner.username);
  return (
    <section aria-label="마을 주민">
      <h2 className="mg-heading">
        주민 <b>{villagers.length}</b>
      </h2>
      <ul className="mg-saju-villagers">
        {!built && (
          <li>
            <Link className="mg-saju-villager mg-card is-lot" to={homePath(owner.username)}>
              <span className="mg-saju-villager-mark">
                <PixelIcon name="house" size={26} />
              </span>
              <span className="mg-saju-villager-text">
                <b>빈 터</b>
                <small>{owner.username === viewer ? '내 집 짓기' : owner.name}</small>
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
                    {resident.id === viewer && <span className="mg-badge">내 집</span>}
                    {bridged && <span className="mg-badge is-published">이웃</span>}
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

/** 깃발 섬: how many of the ten 이웃 that raise a village's flag its owner has, and whether it is raised. */
export function FlagCard({ neighbours }: { neighbours: number }) {
  const raised = flagRaised(neighbours);
  return (
    <section className="mg-saju-card mg-saju-flag" aria-label="깃발 섬" data-raised={raised || undefined}>
      <h2 className="mg-heading">
        깃발 섬 <small>{raised ? `이웃 ${neighbours}명` : `이웃 ${neighbours}/${FLAG_NEIGHBOURS}`}</small>
      </h2>
      <div className="mg-saju-gauge-bar" aria-hidden="true">
        {Array.from({ length: FLAG_NEIGHBOURS }, (_, index) => (
          <i key={index} className={index < neighbours ? 'is-lit' : undefined} />
        ))}
      </div>
    </section>
  );
}
