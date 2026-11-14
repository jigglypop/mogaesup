import type { ReactNode } from 'react';

import { branchElement, stemElement } from '../elements';
import type { Pillar, PillarKey } from '../engine';
import { nayinKo, stageKo } from '../labels';
import type { Profile } from '../profile';

const PILLAR_LABEL: Record<PillarKey, string> = { year: '년주', month: '월주', day: '일주', hour: '시주' };
/** 시·일·월·년, the order a chart is written in. */
const ORDER: readonly PillarKey[] = ['hour', 'day', 'month', 'year'];
const BLANK = '-';

/**
 * 사주보기: the chart as jamiblossom calculates it. The four pillars with their 십성, 지장간, 12운성 and 납음; the 신살
 * the chart has; and the 대운, the one running now marked. A chart without a birth hour shows its hour pillar empty.
 */
export function ChartPanel({ profile }: { profile: Profile }) {
  const { reading } = profile;
  const pillars = ORDER.map((key) => ({ key, pillar: reading[key] }));
  const row = (label: string, cell: (pillar: Pillar) => ReactNode) => (
    <tr>
      <th scope="row">{label}</th>
      {pillars.map(({ key, pillar }) => (
        <td key={key}>{pillar ? cell(pillar) : BLANK}</td>
      ))}
    </tr>
  );
  const matched = reading.sinsal.checks.filter((check) => check.matched);
  const daYun = reading.daYun.map((item, index) => ({ item, index })).filter(({ item }) => item.ganZhi);
  return (
    <div className="mg-saju-chart">
      <section className="mg-saju-card" aria-label="사주 원국">
        <h2 className="mg-heading">사주 원국</h2>
        <table className="mg-saju-pillars">
          <thead>
            <tr>
              <td />
              {pillars.map(({ key }) => (
                <th key={key} scope="col">
                  {PILLAR_LABEL[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('십성', (pillar) => pillar.shiShenGan)}
            {row('천간', (pillar) => (
              <span className="mg-saju-glyph" data-element={stemElement(pillar.stem) ?? undefined}>
                <b lang="zh-Hant">{pillar.stem}</b>
                <small>{pillar.stemKo}</small>
              </span>
            ))}
            {row('지지', (pillar) => (
              <span className="mg-saju-glyph" data-element={branchElement(pillar.branch) ?? undefined}>
                <b lang="zh-Hant">{pillar.branch}</b>
                <small>{pillar.branchKo}</small>
              </span>
            ))}
            {row('십성', (pillar) => pillar.shiShenBranch)}
            {row('지장간', (pillar) => pillar.hideGanKo)}
            {row('12운성', (pillar) => stageKo(pillar.diShi))}
            {row('납음', (pillar) => nayinKo(pillar.nayin))}
          </tbody>
        </table>
      </section>

      <section className="mg-saju-card" aria-label="신살">
        <h2 className="mg-heading">
          신살 <b>{matched.length}</b>
        </h2>
        {matched.length === 0 && <p className="mg-empty">해당하는 신살이 없어요</p>}
        <ul className="mg-saju-sinsal">
          {matched.map((check) => (
            <li key={check.id} className="mg-chip is-soft" data-kind={check.category}>
              {check.name}
              <small>{check.matchedPillars.map((key) => PILLAR_LABEL[key][0]).join('·')}</small>
            </li>
          ))}
        </ul>
        <table className="mg-saju-twelve">
          <thead>
            <tr>
              <th scope="col">12신살</th>
              {pillars.map(({ key }) => (
                <th key={key} scope="col">
                  {PILLAR_LABEL[key][0]}지
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['yearBasis', 'dayBasis'] as const).map((basis) => (
              <tr key={basis}>
                <th scope="row">{basis === 'yearBasis' ? '년지 기준' : '일지 기준'}</th>
                {pillars.map(({ key }) => (
                  <td key={key}>{reading.sinsal.twelve.find((cell) => cell.pillar === key)?.[basis] ?? BLANK}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mg-saju-card" aria-label="대운">
        <h2 className="mg-heading">
          대운 <small>{reading.daYunStart} · {reading.forward ? '순행' : '역행'}</small>
        </h2>
        <ol className="mg-saju-dayun">
          {daYun.map(({ item, index }) => (
            <li key={index} aria-current={index === reading.currentDaYun ? 'true' : undefined}>
              <b>{item.ganZhiKo}</b>
              <span lang="zh-Hant">{item.ganZhi}</span>
              <small>
                {item.startAge}–{item.endAge}세
              </small>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
