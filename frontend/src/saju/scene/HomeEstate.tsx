import { Component, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { Terrain, TerrainCell } from '../../api/types';
import type { Profile } from '../profile';
import { mergeBuilds, type Build, type V3 } from './build';
import { keepEstate, keptEstate } from './kept';
import { fromShelf, nameOf, shelving, toShelf } from './shelf';
import { Built } from './Built';
import { loadDogModel, type DogModel } from './dogModel';
import { estateParts } from './estate/draw';
import { paintedGround } from './estate/painted';
import { EstateSite } from './estate/site';
import type { Estate as EstateLayout } from './estate/layout';
import { estateHomeOf, lawnOf, TERRAIN_GROUND } from './estateHome';
import { Guardian } from './Guardian';
import { GuestPlaques, type GuestNote } from './GuestPlaques';
import { buildHouse, buildLot } from './homes';
import { countWork, useBuild, WorksContext } from './works';

// The page's own island in the canvas: its estate (see estateHome) built a piece at a time, the ground first and the
// house second, each between frames, so the page answers while it comes up; and its guardian at the door. An estate
// that cannot be laid out or built leaves the island as it was found, and the rest of the village draws as ever.

/** The guardian stands a little smaller than it was drawn, beside a house whose door is a metre high (as Stage's Diorama). */
const GUARDIAN_SCALE = 0.8;
const NO_NOTES: readonly GuestNote[] = [];

/** One build of the island: an estate's part, mounted at `at` about the island's middle. */
type Piece = { key: string; at: V3; make: () => Build };

/**
 * The pieces built one a task (the page can answer between them) and laid down together as one build (see
 * mergeBuilds). The canvas waits for all of them before it draws (works); the island keeps what it had until they are
 * all built. A piece that fails to build is reported and left out: the canvas does not wait for it forever. An estate
 * built on an earlier visit, for the same reading, is laid down from what that visit kept (see shelf).
 */
function useParts(parts: readonly Piece[], turn: number, reading: object, key: string): Build | null {
  const works = useContext(WorksContext);
  const [built, setBuilt] = useState<Build | null>(null);
  const order = useRef(turn);
  order.current = turn;
  useEffect(() => {
    if (parts.length === 0) return undefined;
    // Built before for this reading (the page has come back to it, or the picture draws it again): no parts to build.
    const known = keptEstate(reading, key);
    if (known) {
      setBuilt(known);
      return undefined;
    }
    let left = parts.length;
    countWork(works, left);
    const shelf = shelving ? `estate|${nameOf(JSON.stringify(reading))}|${key}` : null;
    const builds: { build: Build; at: V3 }[] = [];
    let index = 0;
    const next = () => {
      const part = parts[index]!;
      try {
        builds.push({ build: part.make(), at: part.at });
      } catch (error) {
        reportError(error);
      }
      index += 1;
      if (index < parts.length) {
        left -= 1;
        if (works) works.pending -= 1;
        timer = setTimeout(next, 0);
        return;
      }
      // The last piece: the island is laid down as one, kept, and only then counted as built.
      try {
        const merged = mergeBuilds(builds);
        keepEstate(reading, key, merged);
        if (shelf) toShelf(shelf, merged);
        setBuilt(merged);
      } catch (error) {
        reportError(error);
      }
      builds.length = 0;
      left -= 1;
      if (works) works.pending -= 1;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const begin = () => {
      timer = setTimeout(next, works?.warm ? 0 : order.current);
    };
    if (shelf) {
      void fromShelf(shelf).then((kept) => {
        if (left === 0) return;
        if (!kept) return begin();
        keepEstate(reading, key, kept);
        setBuilt(kept);
        if (works) works.pending -= left;
        left = 0;
      });
    } else {
      begin();
    }
    return () => {
      clearTimeout(timer);
      if (works) works.pending -= left;
      left = 0;
    };
    // The parts are made from the reading and the key: a new list of parts comes with them.
  }, [parts, works]);
  return built;
}

/** The guardian's model once it has arrived; the canvas waits for it as for a part still to be built (as Stage's own). */
function useDog(id: string): DogModel | null {
  const works = useContext(WorksContext);
  const [loaded, setLoaded] = useState<{ id: string; model: DogModel } | null>(null);
  const settle = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true;
    let counted = true;
    countWork(works, 1);
    const done = () => {
      if (counted && works) works.pending -= 1;
      counted = false;
    };
    settle.current = done;
    loadDogModel(id).then((model) => {
      if (live) setLoaded({ id, model });
    }, done);
    return () => {
      live = false;
      done();
    };
  }, [id, works]);
  const model = loaded?.id === id ? loaded.model : null;
  useEffect(() => {
    if (model) settle.current();
  }, [model]);
  return model;
}

/** Shows `fallback` in place of what failed to render. */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The page's own island as it was found, for an estate that could not be laid out. */
function Found({ origin, lush, turn }: { origin: readonly [number, number, number]; lush: boolean; turn: number }) {
  const make = useCallback(() => buildLot(lush, 'home'), [lush]);
  const build = useBuild(make, turn);
  return build && <Built build={build} origin={origin} />;
}

const NO_TILES: readonly TerrainCell[] = [];

/** The cells the owner painted, laid on the estate's own ground (see estate/painted), once the estate is built. */
function PaintedGround({ estate, tiles, origin }: { estate: EstateLayout; tiles: readonly TerrainCell[]; origin: readonly [number, number, number] }) {
  const site = useMemo(() => (tiles.length > 0 ? new EstateSite(estate) : null), [estate, tiles.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const build = useMemo(() => (site && tiles.length > 0 ? paintedGround(site, tiles, TERRAIN_GROUND) : null), [site, tiles]);
  return build && <Built build={build} origin={origin} />;
}

type EstateProps = {
  terrain?: Terrain;
  /** The cells painted another terrain, on the island's own ground. */
  tiles?: readonly TerrainCell[];
  profile: Pick<Profile, 'reading' | 'house' | 'guardian'>;
  origin: readonly [number, number, number];
  playful?: boolean;
  lush?: boolean;
  turn?: number;
  bridges?: readonly number[];
  /** The guestbook's lines, hung on the 기념 방명록 as plaques; pressing it is told to `onBoard`. */
  notes?: readonly GuestNote[];
  onBoard?: (() => void) | undefined;
  /** The guardian is away from its place: its owner walks the island as it (see Walkers). */
  guardianAway?: boolean;
};

/**
 * The page's own island as an estate, about its middle; `origin` is where that is in the village (for the lamps the
 * pieces lend the village's lights). `bridges` are the landings bridges come to (see estateHome's landingsOf).
 */
export function HomeEstate(props: EstateProps) {
  return (
    <Fallback fallback={<Found origin={props.origin} lush={props.lush ?? true} turn={props.turn ?? 0} />}>
      <Estate {...props} />
    </Fallback>
  );
}

function Estate({
  profile,
  origin,
  terrain = 'default',
  tiles = NO_TILES,
  playful = false,
  lush = true,
  turn = 0,
  bridges,
  notes = NO_NOTES,
  onBoard,
  guardianAway = false,
}: EstateProps) {
  const { reading, house, guardian } = profile;
  // The landings as a key: a new list of the same landings lays the estate out no differently.
  const landings = bridges ? bridges.join() : null;
  const estate = useMemo(() => estateHomeOf(reading, landings === null ? undefined : landings.split(',').filter(Boolean).map(Number)), [reading, landings]);
  const parts = useMemo<Piece[]>(() => {
    return estateParts(estate, { lush, paint: lawnOf(estate, house.style, terrain), house: () => buildHouse(house, lush) });
  }, [estate, lush, house, terrain]);
  const build = useParts(parts, turn, reading, `${landings ?? ''}|${lush}|${house.style}|${house.accent}|${house.symbol}|${terrain}`);
  const dog = useDog(guardian.dog);
  const charms = guardian.charms.map((item) => item.charm).join('+');
  const board = estate.placements.find((placement) => placement.kind === 'guestbook');
  return (
    <>
      {build && <Built build={build} origin={origin} />}
      {build && <PaintedGround estate={estate} tiles={tiles} origin={origin} />}
      {build && board && <GuestPlaques at={board.at} facing={board.facing} notes={notes} onPress={onBoard} />}
      {dog && !guardianAway && (
        <group key={`${guardian.dog}:${charms}`} position={[estate.guardian.at[0], 0, estate.guardian.at[1]]} scale={GUARDIAN_SCALE}>
          <Guardian guardian={guardian} model={dog} position={[0, 0, 0]} facing={estate.guardian.facing} playful={playful} />
        </group>
      )}
    </>
  );
}
