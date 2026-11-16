import { Component, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { Profile } from '../profile';
import { mergeBuilds, type Build, type V3 } from './build';
import { Built } from './Built';
import { loadDogModel, type DogModel } from './dogModel';
import { estateParts } from './estate/draw';
import { estateHomeOf, lawnOf, lawnStrips } from './estateHome';
import { Guardian } from './Guardian';
import { buildHouse, buildLot } from './homes';
import { useBuild, WorksContext } from './works';

// The page's own island in the canvas: its estate (see estateHome) built a piece at a time, the ground first and the
// house second, each between frames, so the page answers while it comes up; and its guardian at the door. An estate
// that cannot be laid out or built leaves the island as it was found, and the rest of the village draws as ever.

/** The guardian stands a little smaller than it was drawn, beside a house whose door is a metre high (as Stage's Diorama). */
const GUARDIAN_SCALE = 0.8;
/** Milliseconds between one island's building and the next (works), and between one part of the estate and the next. */
const BUILD_EVERY_MS = 60;
const PART_EVERY_MS = 16;

/** One build of the island: an estate's part, or a strip of its lawn, mounted at `at` about the island's middle. */
type Piece = { key: string; at: V3; make: () => Build };
const MIDDLE: V3 = [0, 0, 0];

/**
 * The pieces built one a turn (the first `turn` builds after the canvas's first island, each next one a frame after the
 * last) and laid down together as one build (see mergeBuilds). The canvas waits for all of them before it draws (works);
 * pieces for a canvas already drawing build at once, and the island keeps what it had until they are all built. A piece
 * that fails to build is reported and left out: the canvas does not wait for it forever.
 */
function useParts(parts: readonly Piece[], turn: number): Build | null {
  const works = useContext(WorksContext);
  const [built, setBuilt] = useState<Build | null>(null);
  useEffect(() => {
    if (parts.length === 0) return undefined;
    let left = parts.length;
    if (works) works.pending += left;
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
        timer = setTimeout(next, PART_EVERY_MS);
        return;
      }
      // The last piece: the island is laid down as one, and only then counted as built.
      try {
        setBuilt(mergeBuilds(builds));
      } catch (error) {
        reportError(error);
      }
      builds.length = 0;
      left -= 1;
      if (works) works.pending -= 1;
    };
    let timer = setTimeout(next, works?.warm ? 0 : turn * BUILD_EVERY_MS);
    return () => {
      clearTimeout(timer);
      if (works) works.pending -= left;
      left = 0;
    };
  }, [parts, turn, works]);
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
    if (works) works.pending += 1;
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

type EstateProps = {
  profile: Pick<Profile, 'reading' | 'house' | 'guardian'>;
  origin: readonly [number, number, number];
  playful?: boolean;
  lush?: boolean;
  turn?: number;
  bridges?: readonly number[];
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
  playful = false,
  lush = true,
  turn = 0,
  bridges,
}: EstateProps) {
  const { reading, house, guardian } = profile;
  // The landings as a key: a new list of the same landings lays the estate out no differently.
  const landings = bridges ? bridges.join() : null;
  const estate = useMemo(() => estateHomeOf(reading, landings === null ? undefined : landings.split(',').filter(Boolean).map(Number)), [reading, landings]);
  const style = house.style;
  const parts = useMemo<Piece[]>(() => {
    const { paint, blades } = lawnOf(estate, style);
    const lawn = lawnStrips(estate, blades, lush).map((strip) => ({ ...strip, at: MIDDLE }));
    return [...estateParts(estate, { lush, paint, house: () => buildHouse({ style }, lush) }), ...lawn];
  }, [estate, lush, style]);
  const build = useParts(parts, turn);
  const dog = useDog(guardian.dog);
  const charms = guardian.charms.map((item) => item.charm).join('+');
  return (
    <>
      {build && <Built build={build} origin={origin} />}
      {dog && (
        <group key={`${guardian.dog}:${charms}`} position={[estate.guardian.at[0], 0, estate.guardian.at[1]]} scale={GUARDIAN_SCALE}>
          <Guardian guardian={guardian} model={dog} position={[0, 0, 0]} facing={estate.guardian.facing} playful={playful} />
        </group>
      )}
    </>
  );
}
