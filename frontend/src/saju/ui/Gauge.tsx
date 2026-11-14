import { ELEMENT_NAME, ELEMENTS, type Balance } from '../elements';
import { PixelIcon } from './PixelIcon';

/**
 * 오행 밸런스: a bar for each element, one block for each character of the chart (eight, or six without a birth hour),
 * lit for the characters that element has.
 */
export function Gauge({ balance }: { balance: Balance }) {
  return (
    <ul className="mg-saju-gauge">
      {ELEMENTS.map((element) => {
        const { ko, hanja } = ELEMENT_NAME[element];
        const count = balance.counts[element];
        return (
          <li key={element} data-element={element} aria-label={`${ko}(${hanja}) ${balance.percent[element]}%, ${balance.total}글자 중 ${count}글자`}>
            <span className="mg-saju-gauge-name" aria-hidden="true">
              <PixelIcon name={element} size={16} />
              {ko}
              <small>{hanja}</small>
            </span>
            <span className="mg-saju-gauge-bar" aria-hidden="true">
              {Array.from({ length: balance.total }, (_, index) => (
                <i key={index} className={index < count ? 'is-lit' : undefined} />
              ))}
            </span>
            <b aria-hidden="true">{balance.percent[element]}%</b>
          </li>
        );
      })}
    </ul>
  );
}
