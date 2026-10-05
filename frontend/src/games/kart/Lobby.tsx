import type { LobbyProps } from '../game';
import type { KartOptions } from './index';
import { botRoom, optionsFor } from './layout';
import { MAX_LAPS, MAX_RACERS } from './track';

/** A − value + row for one number. */
function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="mg-kart-step" role="group" aria-label={label}>
      <span>{label}</span>
      <button type="button" className="mg-icon-btn is-small" aria-label={`${label} 빼기`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <b aria-live="polite">{value}</b>
      <button type="button" className="mg-icon-btn is-small" aria-label={`${label} 더하기`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** The host's settings: how many bots race, and how many laps. */
export function KartLobby({ session, options, setOptions }: LobbyProps) {
  const people = session.players.length;
  const chosen = optionsFor(options, people);
  const change = (changes: Partial<KartOptions>) => setOptions({ ...chosen, ...changes });
  return (
    <div className="mg-kart-lobby">
      <div className="mg-kart-row">
        <Stepper label="봇" value={chosen.bots} min={0} max={botRoom(people)} onChange={(bots) => change({ bots })} />
        <span className="mg-kart-count">
          {people + chosen.bots}/{MAX_RACERS}
        </span>
      </div>
      <Stepper label="바퀴" value={chosen.laps} min={1} max={MAX_LAPS} onChange={(laps) => change({ laps })} />
    </div>
  );
}
