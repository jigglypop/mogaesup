import type { HouseChoice, SajuHome } from '../api/types';
import type { Birth } from './engine';

/** A member with a 사주 home. */
export type Resident = {
  /** Their username: `/@id` is their 섬. */
  id: string;
  /** The name on the home's gate. */
  name: string;
  birth: Birth;
  /** Their profile picture, when the page knows it. */
  avatarUrl?: string | null;
  /** The house they chose in place of their chart's, if they did. */
  house?: HouseChoice | null;
};

export const NAME_MAX = 12;

/** A member's stored home as a resident of the village. */
export const residentOf = (username: string, home: SajuHome): Resident => ({ id: username, name: home.name, birth: home.birth, ...(home.house ? { house: home.house } : {}) });
