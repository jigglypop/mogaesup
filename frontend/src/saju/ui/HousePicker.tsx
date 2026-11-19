import type { HouseChoice } from '../../api/types';
import { ELEMENT_NAME, ELEMENTS, type Element } from '../elements';
import { choiceOf, HOUSE_NAME, ROOF_NAME, ROOFS, type House } from '../profile';
import './housePicker.css';

/**
 * The owner's house as they would have it: its kind (and with it its walls, logs, bricks, 황토 or stone), its roof and
 * the colour of its trim, each chosen in place of what the chart gives. `chart` is the chart's house, `chosen` what the
 * owner chose (null for the chart's).
 */
export function HousePicker({ chart, chosen, onChoose }: { chart: House; chosen: HouseChoice | null; onChoose: (next: HouseChoice | null) => void }) {
  const now = chosen ?? choiceOf(chart);
  const pick = (patch: Partial<HouseChoice>) => {
    const next = { ...now, ...patch };
    const same = (a: HouseChoice) => a.style === next.style && a.roof === next.roof && a.accent === next.accent;
    onChoose(same(choiceOf(chart)) ? null : next);
  };
  const swatch = (element: Element) => <i style={{ backgroundColor: `var(--mg-${element})` }} />;
  return (
    <div className="mg-house-pick">
      <div className="mg-house-row" role="group" aria-label="집 모양">
        <h3>집</h3>
        <div className="mg-saju-decor-pick">
          {ELEMENTS.map((style) => (
            <button key={style} type="button" className="mg-chip is-soft" aria-pressed={now.style === style} onClick={() => pick({ style })}>
              {swatch(style)}{HOUSE_NAME[style]}
            </button>
          ))}
        </div>
      </div>
      <div className="mg-house-row" role="group" aria-label="지붕">
        <h3>지붕</h3>
        <div className="mg-saju-decor-pick">
          {ROOFS.map((roof) => (
            <button key={roof} type="button" className="mg-chip is-soft" aria-pressed={now.roof === roof} onClick={() => pick({ roof })}>
              {ROOF_NAME[roof]}
            </button>
          ))}
        </div>
      </div>
      <div className="mg-house-row" role="group" aria-label="장식 색">
        <h3>장식 색</h3>
        <div className="mg-saju-decor-pick">
          {ELEMENTS.map((accent) => (
            <button key={accent} type="button" className="mg-chip is-soft" aria-pressed={now.accent === accent} onClick={() => pick({ accent })}>
              {swatch(accent)}{ELEMENT_NAME[accent].ko}
            </button>
          ))}
          <button type="button" className="mg-chip is-soft" aria-pressed={now.accent === null} onClick={() => pick({ accent: null })}>
            집과 같은 색
          </button>
        </div>
      </div>
      <button type="button" className="mg-btn is-small" disabled={!chosen} onClick={() => onChoose(null)}>
        사주대로 짓기
      </button>
    </div>
  );
}
