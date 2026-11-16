import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiRequestError } from '../api/client';
import { sajuApi } from '../api/endpoints';
import type { DecorFlag, DecorItem, FlagDesign, SajuDecor } from '../api/types';
import type { Birth } from './engine';
import { ziweiOf } from './ziwei';

// What a 섬's owner has placed on it: their own flag (the main star of their 자미두수 명궁, in the colour of their 오행국),
// the flags other members gave it, small things for the garden, and their own character from the studio. Read for
// whoever looks at the 섬; placed by its owner.

/** The small things a 섬 can be decorated with, by the name the server knows each by. */
export const PROPS = [
  { ref: 'lantern', label: '석등' },
  { ref: 'bench', label: '벤치' },
  { ref: 'jar', label: '장독' },
  { ref: 'pot', label: '화분' },
  { ref: 'barrel', label: '나무통' },
  { ref: 'woodpile', label: '장작더미' },
  { ref: 'table', label: '탁자' },
  { ref: 'parasol', label: '파라솔' },
  { ref: 'well', label: '우물' },
  { ref: 'bush', label: '덤불' },
  { ref: 'rock', label: '바위' },
  { ref: 'tree', label: '나무' },
] as const;
export type PropRef = (typeof PROPS)[number]['ref'];

/** As many things as a 섬 holds (the server's limit). */
export const MOST_ITEMS = 24;

/** The fourteen main stars of 자미두수, as the server takes them; a 명궁 with none of them flies 공궁. */
const STARS = ['자미', '천기', '태양', '무곡', '천동', '염정', '천부', '태음', '탐랑', '거문', '천상', '천량', '칠살', '파군'];

/** The flag `birth` flies: the first main star of its 명궁 (공궁 for none) and the element of its 오행국. */
export function flagDesignOf(birth: Birth): FlagDesign | null {
  const chart = ziweiOf(birth);
  if (!chart) return null;
  const star = chart.palaces[chart.soul]?.stars.major.map((one) => one.name).find((name) => STARS.includes(name)) ?? '공궁';
  return { star, element: chart.bureau.element ?? 'earth' };
}

/** A new item's id, unique within a 섬's few dozen. */
export const itemId = () => Math.random().toString(36).slice(2, 10);

export type Decor = {
  /** What the 섬 shows, once read (null until then, or when it could not be read). */
  decor: SajuDecor | null;
  /** The owner places what the 섬 shows; a refusal is said in `problem` and the 섬 keeps what it had. */
  place: (items: DecorItem[]) => void;
  /** The owner takes down a flag given to the 섬. */
  drop: (flag: DecorFlag) => void;
  /** A visitor gives the 섬 their flag; resolves to what to say (null when it went up). */
  give: (design: FlagDesign) => Promise<string | null>;
  problem: string;
};

const problemText = (error: unknown) => (error instanceof ApiRequestError ? error.message : '저장하지 못했어요');

/** The decoration of `username`'s 섬, read again when the 섬 changes; `ownerId` is the viewer's own id on their own 섬. */
export function useDecor(username: string, ownerId: string | null): Decor {
  const [read, setRead] = useState<{ of: string; decor: SajuDecor } | null>(null);
  const [problem, setProblem] = useState('');
  const latest = useRef(0);
  useEffect(() => {
    let live = true;
    setProblem('');
    sajuApi.decor(username).then(
      (decor) => {
        if (live) setRead({ of: username, decor });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [username]);
  const decor = read?.of === username ? read.decor : null;
  const place = useCallback(
    (items: DecorItem[]) => {
      if (!ownerId || !decor) return;
      const mine = ++latest.current;
      const before = decor;
      setRead({ of: username, decor: { ...decor, items } });
      setProblem('');
      sajuApi.placeDecor({ expectedOwnerId: ownerId, items }).then(
        (saved) => {
          if (mine === latest.current) setRead({ of: username, decor: saved });
        },
        (error: unknown) => {
          if (mine !== latest.current) return;
          setRead({ of: username, decor: before });
          setProblem(problemText(error));
        },
      );
    },
    [ownerId, decor, username],
  );
  const drop = useCallback(
    (flag: DecorFlag) => {
      if (!ownerId || !decor) return;
      const before = decor;
      setRead({ of: username, decor: { ...decor, flags: decor.flags.filter((one) => one.id !== flag.id), items: decor.items.filter((item) => !(item.kind === 'flag' && item.ref === flag.id)) } });
      sajuApi.dropFlag(flag.id).catch((error: unknown) => {
        setRead({ of: username, decor: before });
        setProblem(problemText(error));
      });
    },
    [ownerId, decor, username],
  );
  const give = useCallback(async (design: FlagDesign) => {
    try {
      await sajuApi.giveFlag(username, design);
      return null;
    } catch (error) {
      return problemText(error);
    }
  }, [username]);
  return { decor, place, drop, give, problem };
}
