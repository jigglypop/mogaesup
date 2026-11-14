import type { Resident } from '../residents';

/** Four births whose charts lean four ways (목·화·토·수, with 금 next in two of them): the people these tests build homes for. */
export const PEOPLE: readonly Resident[] = [
  { id: 'sol', name: '솔', birth: { calendar: 'solar', year: 1989, month: 2, day: 23, leapMonth: false, time: '22:10', gender: 'female' } },
  { id: 'noeul', name: '노을', birth: { calendar: 'solar', year: 1987, month: 6, day: 17, leapMonth: false, time: '08:30', gender: 'male' } },
  { id: 'bori', name: '보리', birth: { calendar: 'lunar', year: 1988, month: 8, day: 21, leapMonth: false, time: '06:15', gender: 'female' } },
  { id: 'garam', name: '가람', birth: { calendar: 'solar', year: 1992, month: 11, day: 12, leapMonth: false, time: '04:20', gender: 'male' } },
];

export const personOf = (id: string): Resident => {
  const person = PEOPLE.find((resident) => resident.id === id);
  if (!person) throw new Error(`no such person: ${id}`);
  return person;
};
