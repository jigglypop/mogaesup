import { useId, useState, type FormEvent } from 'react';

import { Link, useNavigate } from 'react-router-dom';

import { BirthError, hasLeapMonth, isValidBirthDate, solarDateOf, timeBranchOf, timeBranches, type Birth, type Calendar, type Gender } from '../engine';
import { profileOf } from '../profile';
import { NAME_MAX, type Resident } from '../residents';
import { SAJU } from '../routes';
import { sajuStore } from '../store';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CALENDARS: { value: Calendar; label: string }[] = [
  { value: 'solar', label: '양력' },
  { value: 'lunar', label: '음력' },
];
const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: '여성' },
  { value: 'male', label: '남성' },
];

/** The form as it is typed: every field text until it is checked. */
export type Draft = {
  name: string;
  calendar: Calendar;
  year: string;
  month: string;
  day: string;
  leapMonth: boolean;
  time: string;
  /** The hour is not known. */
  noTime: boolean;
  gender: Gender | null;
};

const draftOf = (resident: Resident | null, name: string): Draft =>
  resident
    ? {
        name: resident.name,
        calendar: resident.birth.calendar,
        year: String(resident.birth.year),
        month: String(resident.birth.month),
        day: String(resident.birth.day),
        leapMonth: resident.birth.leapMonth,
        time: resident.birth.time ?? '',
        noTime: resident.birth.time === null,
        gender: resident.birth.gender,
      }
    : { name, calendar: 'solar', year: '', month: '', day: '', leapMonth: false, time: '', noTime: false, gender: null };

const digits = (text: string, max: number) => text.replace(/\D/g, '').slice(0, max);

/**
 * What a draft amounts to: a birth to build a home from, or what is still wrong with it, in words for the person
 * filling it in.
 */
export function birthOfDraft(draft: Draft): { birth: Birth } | { problem: string } {
  if (!draft.name.trim()) return { problem: '이름을 적어 주세요.' };
  if (!draft.year || !draft.month || !draft.day) return { problem: '생년월일을 적어 주세요.' };
  if (!draft.gender) return { problem: '성별을 골라 주세요.' };
  if (!draft.noTime && !TIME.test(draft.time)) return { problem: '태어난 시간을 적거나 모름을 골라 주세요.' };
  const birth: Birth = {
    calendar: draft.calendar,
    year: Number(draft.year),
    month: Number(draft.month),
    day: Number(draft.day),
    leapMonth: draft.calendar === 'lunar' && draft.leapMonth,
    time: draft.noTime ? null : draft.time,
    gender: draft.gender,
  };
  if (!solarDateOf(birth)) return { problem: '달력에 없는 날짜예요.' };
  if (!isValidBirthDate(birth)) return { problem: '아직 오지 않은 날이에요.' };
  return { birth };
}

/**
 * The card a home is built from: a name, a birth date in either calendar, the hour (or that it is not known) and
 * gender. With `resident` it corrects the viewer's own; the home is then rebuilt, or taken down.
 */
export function Onboarding({ resident, suggestedName = '' }: { resident: Resident | null; suggestedName?: string }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => draftOf(resident, suggestedName.slice(0, NAME_MAX)));
  const [problem, setProblem] = useState('');
  const ids = useId();
  const change = (changes: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setProblem('');
  };

  const year = Number(draft.year);
  const month = Number(draft.month);
  const leapAllowed = draft.calendar === 'lunar' && draft.year.length === 4 && month >= 1 && month <= 12 && hasLeapMonth(year, month);
  const leapMonth = leapAllowed && draft.leapMonth;
  // The 시진 follow the clock of the birth date: summer time and the old offsets move their hours.
  const solarDate = draft.year.length === 4 && draft.month && draft.day ? solarDateOf({ calendar: draft.calendar, year, month, day: Number(draft.day), leapMonth }) : null;
  const branches = solarDate ? timeBranches(solarDate) : [];
  const branch = solarDate && TIME.test(draft.time) ? timeBranchOf(solarDate, draft.time) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = birthOfDraft({ ...draft, leapMonth });
    if ('problem' in result) return setProblem(result.problem);
    try {
      profileOf(result.birth);
    } catch (error) {
      return setProblem(error instanceof BirthError ? error.message : '계산하지 못했어요.');
    }
    sajuStore.moveIn(draft.name, result.birth);
    navigate(SAJU);
  };
  const moveOut = () => {
    if (!window.confirm('집과 방명록, 놓은 다리가 이 브라우저에서 지워져요. 허물까요?')) return;
    sajuStore.moveOut();
    navigate(SAJU);
  };

  return (
    <form className="mg-saju-card mg-saju-form" onSubmit={submit} noValidate>
      <h2 className="mg-heading">{resident ? '내 정보 고치기' : '내 집 짓기'}</h2>
      <label className="mg-label">
        이름
        <input className="mg-field" name="name" value={draft.name} maxLength={NAME_MAX} autoComplete="nickname" onChange={(event) => change({ name: event.target.value })} />
      </label>

      <div className="mg-label" role="group" aria-labelledby={`${ids}date`}>
        <span id={`${ids}date`}>생년월일</span>
        <div className="mg-tabs" role="radiogroup" aria-label="달력">
          {CALENDARS.map((item) => (
            <button key={item.value} type="button" role="radio" aria-checked={draft.calendar === item.value} onClick={() => change({ calendar: item.value })}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="mg-saju-date">
          <input className="mg-field" name="year" inputMode="numeric" aria-label="년" value={draft.year} onChange={(event) => change({ year: digits(event.target.value, 4) })} />
          <span aria-hidden="true">년</span>
          <input className="mg-field" name="month" inputMode="numeric" aria-label="월" value={draft.month} onChange={(event) => change({ month: digits(event.target.value, 2) })} />
          <span aria-hidden="true">월</span>
          <input className="mg-field" name="day" inputMode="numeric" aria-label="일" value={draft.day} onChange={(event) => change({ day: digits(event.target.value, 2) })} />
          <span aria-hidden="true">일</span>
        </div>
        {leapAllowed && (
          <label className="mg-check">
            <input type="checkbox" name="leapMonth" checked={draft.leapMonth} onChange={(event) => change({ leapMonth: event.target.checked })} />
            윤달
          </label>
        )}
      </div>

      <div className="mg-label" role="group" aria-labelledby={`${ids}time`}>
        <span id={`${ids}time`}>태어난 시간</span>
        <div className="mg-saju-time">
          <input
            className="mg-field"
            type="time"
            name="time"
            aria-label="태어난 시각"
            value={draft.time}
            disabled={draft.noTime}
            onChange={(event) => change({ time: event.target.value })}
          />
          <select
            className="mg-field"
            name="branch"
            aria-label="시진"
            value={branch === null ? '' : String(branch)}
            disabled={draft.noTime || branches.length === 0}
            onChange={(event) => {
              const chosen = branches.find((option) => String(option.index) === event.target.value);
              if (chosen) change({ time: chosen.time });
            }}
          >
            <option value="" disabled>
              시진
            </option>
            {branches.map((option) => (
              <option key={option.index} value={option.index}>
                {option.label}
                {option.note ? `(${option.note})` : ''} {option.range}
              </option>
            ))}
          </select>
        </div>
        <label className="mg-check">
          <input type="checkbox" name="noTime" checked={draft.noTime} onChange={(event) => change({ noTime: event.target.checked })} />
          모름
        </label>
      </div>

      <div className="mg-label" role="group" aria-labelledby={`${ids}gender`}>
        <span id={`${ids}gender`}>성별</span>
        <div className="mg-tabs" role="radiogroup" aria-labelledby={`${ids}gender`}>
          {GENDERS.map((item) => (
            <button key={item.value} type="button" role="radio" aria-checked={draft.gender === item.value} onClick={() => change({ gender: item.value })}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
      <button className="mg-btn is-primary is-wide" type="submit">
        {resident ? '고쳐 짓기' : '내 집 짓기'}
      </button>
      {resident && (
        <div className="mg-saju-form-foot">
          <Link className="mg-btn is-quiet is-small" to={SAJU}>
            취소
          </Link>
          <button className="mg-btn is-danger is-small" type="button" onClick={moveOut}>
            집 허물기
          </button>
        </div>
      )}
    </form>
  );
}
