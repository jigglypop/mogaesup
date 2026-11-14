import type { Birth } from './engine';

/** Someone with a home in the village. */
export type Resident = {
  id: string;
  name: string;
  birth: Birth;
  /** One of the village's sample residents, there before anyone moves in. */
  sample: boolean;
};

/** A line left in a home's guestbook. */
export type GuestEntry = {
  id: string;
  /** The home it was left at. */
  home: string;
  /** Who left it: a resident's id. */
  author: string;
  name: string;
  body: string;
  /** ISO time. */
  at: string;
};

/** The id of the home this browser's own resident lives in. */
export const MY_HOME = 'me';
export const NAME_MAX = 12;
export const ENTRY_MAX = 100;

/**
 * The village's sample residents: four births whose charts lean four ways (목·화·토·수, with 금 next in two of them).
 * Their homes are built from these births like anyone's, so the samples show what the calculation gives.
 */
export const SAMPLE_RESIDENTS: readonly Resident[] = [
  { id: 'sol', name: '솔', sample: true, birth: { calendar: 'solar', year: 1989, month: 2, day: 23, leapMonth: false, time: '22:10', gender: 'female' } },
  { id: 'noeul', name: '노을', sample: true, birth: { calendar: 'solar', year: 1987, month: 6, day: 17, leapMonth: false, time: '08:30', gender: 'male' } },
  { id: 'bori', name: '보리', sample: true, birth: { calendar: 'lunar', year: 1988, month: 8, day: 21, leapMonth: false, time: '06:15', gender: 'female' } },
  { id: 'garam', name: '가람', sample: true, birth: { calendar: 'solar', year: 1992, month: 11, day: 12, leapMonth: false, time: '04:20', gender: 'male' } },
];

const seed = (home: string, author: string, at: string, body: string): GuestEntry => ({
  id: `seed-${home}-${author}`,
  home,
  author,
  name: SAMPLE_RESIDENTS.find((resident) => resident.id === author)?.name ?? author,
  body,
  at,
});

/** What the sample residents left in each other's guestbooks. */
export const SEED_ENTRIES: readonly GuestEntry[] = [
  seed('sol', 'noeul', '2026-11-09T19:20:00+09:00', '숲 냄새 맡으러 또 왔어요. 장작 조금 얻어 갑니다 ㅎㅎ'),
  seed('sol', 'garam', '2026-11-04T08:05:00+09:00', '연못 물 길어다 나무에 주고 가요.'),
  seed('sol', 'bori', '2026-10-28T12:40:00+09:00', '감자 한 바구니 두고 갑니다. 호랑이랑 나눠 먹어요.'),
  seed('noeul', 'sol', '2026-11-11T21:10:00+09:00', '모닥불 앞이 제일 따뜻해요. 군고구마 예약!'),
  seed('noeul', 'garam', '2026-11-06T23:30:00+09:00', '불멍 하다 갑니다. 불씨는 안 건드렸어요.'),
  seed('noeul', 'bori', '2026-10-30T17:15:00+09:00', '아궁이에 넣을 불씨 조금 빌려 가요.'),
  seed('bori', 'noeul', '2026-11-10T11:00:00+09:00', '장독대에서 된장 익는 냄새가 나요.'),
  seed('bori', 'sol', '2026-11-02T15:45:00+09:00', '마당이 넓어서 뛰어놀기 딱이에요.'),
  seed('bori', 'garam', '2026-10-26T06:50:00+09:00', '항아리에 빗물 채워 두고 가요.'),
  seed('garam', 'sol', '2026-11-12T14:25:00+09:00', '연못에 발 담그고 갑니다. 잉어가 사람을 알아봐요.'),
  seed('garam', 'noeul', '2026-11-07T20:40:00+09:00', '밤에 오니까 물빛이 더 예뻐요.'),
  seed('garam', 'bori', '2026-10-31T09:30:00+09:00', '돌다리 건너 놀러 왔어요. 용이 꾸벅 인사하네요.'),
];

/** What two sample residents leave when someone new moves in. */
export const WELCOME_NOTES: readonly { author: string; body: string }[] = [
  { author: 'sol', body: '새 이웃이다! 집들이 선물로 묘목 하나 심어 두고 가요.' },
  { author: 'noeul', body: '이사 축하해요. 모닥불 피워 놨으니 놀러 와요.' },
];

export const sampleOf = (id: string): Resident | null => SAMPLE_RESIDENTS.find((resident) => resident.id === id) ?? null;
