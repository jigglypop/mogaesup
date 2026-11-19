import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiRequestError } from '../api/client';
import { sajuApi } from '../api/endpoints';
import type { DecorFlag, DecorItem, FlagDesign, SajuDecor, Terrain, TerrainCell } from '../api/types';
import { paintCells } from './tiles';
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
export const itemId = () => Array.from(crypto.getRandomValues(new Uint32Array(3)), (part) => part.toString(36)).join('-');

export type Decor = {
  /** What the 섬 shows, once read (null until then, or when it could not be read). */
  decor: SajuDecor | null;
  /** The owner places what the 섬 shows; a refusal is said in `problem` and the 섬 keeps what it had. */
  place: (items: DecorItem[]) => void;
  setTerrain: (terrain: Terrain) => void;
  /** Paints one metre. `default` clears that cell back to the island's terrain. */
  paintCell: (x: number, z: number, terrain: Terrain) => void;
  reload: () => void;
  /** The owner takes down a flag given to the 섬. */
  drop: (flag: DecorFlag) => void;
  /** A visitor gives the 섬 their flag; resolves to what to say (null when it went up). */
  give: (design: FlagDesign) => Promise<string | null>;
  changePhoto: (image: string | null) => Promise<string>;
  problem: string;
};

const problemText = (error: unknown) => (error instanceof ApiRequestError ? error.message : '저장하지 못했어요');
// A return visit waits for any edits sent just before leaving this home.
const pending = new Map<string, Promise<string>>();

/** The decoration of `username`'s 섬, read again when the 섬 changes; `ownerId` is the viewer's own id on their own 섬. */
export function useDecor(username: string, ownerId: string | null): Decor {
  const session = useMemo(() => ({ saved: null as SajuDecor | null, version: 0, live: true }), [username, ownerId]);
  const [read, setRead] = useState<{ of: typeof session; decor: SajuDecor } | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    session.live = true;
    setProblem('');
    const writes = pending.get(username);
    const read = writes ? writes.then(() => sajuApi.decor(username)) : sajuApi.decor(username);
    read.then(
      (decor) => {
        if (!live) return;
        session.saved = decor;
        setRead({ of: session, decor });
      },
      () => { if (live) setProblem('꾸미기 아이템을 불러오지 못했어요.'); },
    );
    return () => {
      live = false;
      session.live = false;
    };
  }, [username, session]);
  const decor = read?.of === session ? read.decor : null;
  // Each PUT replaces the full layout. Keep writes in input order, and roll back to the last *accepted* layout.
  const write = useCallback((preview: SajuDecor, save: (before: SajuDecor) => Promise<SajuDecor>) => {
    const version = ++session.version;
    setProblem('');
    setRead({ of: session, decor: preview });
    const saving = (pending.get(username) ?? Promise.resolve()).then(async () => {
      let problem = '';
      try {
        session.saved = await save(session.saved!);
      } catch (error) {
        problem = problemText(error);
      }
      if (session.live && version === session.version && session.saved) {
        setRead({ of: session, decor: session.saved });
        setProblem(problem);
      }
      return problem;
    });
    pending.set(username, saving);
    void saving.finally(() => { if (pending.get(username) === saving) pending.delete(username); });
    return saving;
  }, [session, username]);
  const place = useCallback(
    (items: DecorItem[]) => {
      if (!ownerId || !decor) return;
      write({ ...decor, items }, () => sajuApi.placeDecor({ expectedOwnerId: ownerId, items }));
    },
    [ownerId, decor, write],
  );
  const drop = useCallback(
    (flag: DecorFlag) => {
      if (!ownerId || !decor) return;
      const withoutFlag = (before: SajuDecor) => ({
        ...before,
        flags: before.flags.filter((one) => one.id !== flag.id),
        items: before.items.filter((item) => !(item.kind === 'flag' && item.ref === flag.id)),
      });
      write(withoutFlag(decor), async (before) => {
        await sajuApi.dropFlag(flag.id);
        return withoutFlag(before);
      });
    },
    [ownerId, decor, write],
  );
  const setTerrain = useCallback((terrain: Terrain) => {
    if (!ownerId || !decor || terrain === (decor.terrain ?? 'default')) return;
    write({ ...decor, terrain }, () => sajuApi.setTerrain({ expectedOwnerId: ownerId, terrain }));
  }, [ownerId, decor, write]);
  const paintCell = useCallback((x: number, z: number, terrain: Terrain) => {
    if (!ownerId || !decor) return;
    const tiles: TerrainCell[] = paintCells(decor.tiles ?? [], x, z, terrain);
    write({ ...decor, tiles }, () => sajuApi.setTerrain({ expectedOwnerId: ownerId, tiles }));
  }, [ownerId, decor, write]);
  const reload = useCallback(() => {
    sajuApi.decor(username).then(
      (next) => {
        session.saved = next;
        if (session.live) setRead({ of: session, decor: next });
      },
      () => undefined,
    );
  }, [session, username]);
  const give = useCallback(async (design: FlagDesign) => {
    try {
      await sajuApi.giveFlag(username, design);
      return null;
    } catch (error) {
      return problemText(error);
    }
  }, [username]);
  const changePhoto = useCallback(async (image: string | null) => {
    if (!ownerId || !decor) return '집을 다시 불러와 주세요.';
    return write(decor, async (before) => {
      if (image === null) {
        await sajuApi.removePhotoBoard(ownerId);
        return { ...before, photoBoard: null };
      }
      return { ...before, photoBoard: await sajuApi.uploadPhotoBoard(ownerId, image) };
    });
  }, [ownerId, decor, write]);
  return { decor, place, setTerrain, paintCell, drop, give, changePhoto, reload, problem };
}
