import './balloons.css';

import { BALLOON_DESIGNS, balloonOf } from './designs';

/** A balloon as the island draws it (dom.ts `balloonElement`), standing still. */
export function BalloonShape({ design, text }: { design: string; text: string }) {
  return (
    <span className="mg-balloon is-still" data-design={design}>
      <span className="mg-balloon-pop">
        <span className="mg-balloon-body">
          <b>{text}</b>
        </span>
        <i className="mg-balloon-tail" />
      </span>
    </span>
  );
}

/** The balloon the owner talks in, on any island: each design drawn as it shows over the island. */
export function BalloonPicker({ value, onPick }: { value: string | undefined; onPick: (id: string) => void }) {
  const current = balloonOf(value);
  return (
    <div className="mg-balloons" role="radiogroup" aria-label="말풍선">
      {BALLOON_DESIGNS.map((design) => (
        <button
          key={design.id}
          type="button"
          role="radio"
          aria-checked={design.id === current}
          onClick={() => design.id !== current && onPick(design.id)}
        >
          <span className="mg-balloon-sky" aria-hidden="true">
            <BalloonShape design={design.id} text="안녕" />
          </span>
          <small>{design.label}</small>
        </button>
      ))}
    </div>
  );
}
