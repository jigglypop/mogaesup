import type { LobbyProps } from '../game';
import type { ImpostorOptions } from './index';
import { MAX_BOTS, MAX_PLAYERS, MIN_PLAYERS, optionsFor } from './layout';

const ROLES: [ImpostorOptions['role'], string][] = [
  ['random', '무작위'],
  ['crew', '크루'],
  ['impostor', '임포스터'],
];

/** The host's settings: how many bots fill the table, and (playing alone) which side they play. */
export function ImpostorLobby({ session, options, setOptions }: LobbyProps) {
  const people = session.players.length;
  const chosen = optionsFor(options, people);
  const most = Math.max(0, Math.min(MAX_BOTS, MAX_PLAYERS - people));
  const total = people + chosen.bots;
  const change = (changes: Partial<ImpostorOptions>) => setOptions({ ...chosen, ...changes });
  return (
    <div className="mg-impostor-lobby">
      <div className="mg-impostor-bots" role="group" aria-label="봇">
        <span>봇</span>
        <button type="button" className="mg-icon-btn is-small" aria-label="봇 빼기" disabled={chosen.bots <= 0} onClick={() => change({ bots: chosen.bots - 1 })}>
          −
        </button>
        <b aria-live="polite">{chosen.bots}</b>
        <button type="button" className="mg-icon-btn is-small" aria-label="봇 더하기" disabled={chosen.bots >= most} onClick={() => change({ bots: chosen.bots + 1 })}>
          +
        </button>
        <span className={total < MIN_PLAYERS ? 'mg-impostor-count is-short' : 'mg-impostor-count'}>
          {total}/{MIN_PLAYERS}+
        </span>
      </div>
      {people === 1 && (
        <label className="mg-impostor-side">
          <span>내 역할</span>
          <select className="mg-field" value={chosen.role} onChange={(event) => change({ role: event.target.value as ImpostorOptions['role'] })}>
            {ROLES.map(([role, name]) => (
              <option key={role} value={role}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
