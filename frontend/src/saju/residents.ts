import type { SajuHome } from '../api/types';
import type { Birth } from './engine';

/** A member with a 사주 home. */
export type Resident = {
  /** Their username: `/@id` is their 미니홈피. */
  id: string;
  /** The name on the home's gate. */
  name: string;
  birth: Birth;
};

export const NAME_MAX = 12;

/** A member's stored home as a resident of the village. */
export const residentOf = (username: string, home: SajuHome): Resident => ({ id: username, name: home.name, birth: home.birth });
