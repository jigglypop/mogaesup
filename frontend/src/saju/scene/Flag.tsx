import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, ConeGeometry, DataTexture, DoubleSide, DynamicDrawUsage, LinearFilter, LinearMipmapLinearFilter, LineBasicMaterial, MeshStandardMaterial, RGBAFormat, SRGBColorSpace, type Group } from 'three';

import { ELEMENTS, type Element } from '../elements';
import { Built } from './Built';
import { buildFlagIsland, buntingColors, buntingShape, CLOTH, CLOTH_TEXELS, clothColors, clothShape, flagToken, flutter, fly, HULL, paintCloth, RISE_SECONDS, sunk, type Shape } from './flagIsland';
import { BOX } from './kit';
import { useAnimation, useStill } from './parts';
import { useBuild, useMood } from './works';

// 깃발 섬 in the canvas: the island as it was built, and over it the two things on it that move, the flag's cloth and
// the lines of pennants. Each is one small mesh whose corners are set down again every frame (see flagIsland). The
// pointer meets a plain hull about it all, and an island raised in a village already on screen comes up out of the lake.

/** The flag's island on the stage: where it lies, and the element of the home whose village raised it (null before the home is built). */
export type StageFlag = { x: number; z: number; element: Element | null };

/** A colour by the name the app's stylesheet gives it, as the bridges' light is read. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * How much of its own colours the cloth gives off for each step the hour turns the lamps up: none by day's last light.
 * After dark no lamp on the island reaches as high as the cloth, and lit by the sky alone a flag in the lake's own
 * blue is as dark as the lake behind it.
 */
const CLOTH_GLOW = 0.1;
/** A cone one metre high and one in radius, scaled into the hull. */
const CONE = new ConeGeometry(1, 1, HULL.cone.sides);

/**
 * A mesh's shape whose corners move: where they are and how they face are written over in place, every frame. No corner
 * ever strays more than `slack` metres from where the shape first has it, which is all that is measured of it.
 */
function moving({ positions, normals, indices }: Shape, slack: number) {
  const geometry = new BufferGeometry();
  const position = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const normal = new BufferAttribute(normals, 3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.boundingSphere!.radius += slack;
  return { geometry, position, normal };
}

/** The flag: cloth in `field` with the element's character on it, flying from the mast, giving off `glow` of its own colours. */
function Cloth({ element, field, glow }: { element: Element | null; field: string; glow: number }) {
  const shape = useMemo(() => {
    const cloth = clothShape();
    // However it folds, the cloth stays within its own length of its hoist.
    const made = moving(cloth, CLOTH.length);
    made.geometry.setAttribute('uv', new BufferAttribute(cloth.uvs, 2));
    return made;
  }, []);
  const look = useMemo(() => {
    const texture = new DataTexture(paintCloth(clothColors(field), element), CLOTH_TEXELS.width, CLOTH_TEXELS.height, RGBAFormat);
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return { texture, material: new MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: '#ffffff', emissiveIntensity: glow, side: DoubleSide, roughness: 0.86 }) };
  }, [field, element, glow]);
  useEffect(() => () => shape.geometry.dispose(), [shape]);
  useEffect(
    () => () => {
      look.material.dispose();
      look.texture.dispose();
    },
    [look],
  );
  useAnimation((time) => {
    fly(time, shape.position.array as Float32Array, shape.normal.array as Float32Array);
    shape.position.needsUpdate = true;
    shape.normal.needsUpdate = true;
  });
  return <mesh geometry={shape.geometry} material={look.material} castShadow receiveShadow />;
}

/** The lines of pennants from the mast's head to the posts, in `colors` by turns. */
function Bunting({ colors }: { colors: readonly string[] }) {
  const shape = useMemo(() => {
    const hung = buntingShape();
    // A line gives a hand's width to the wind, and a pennant swings within its own fall.
    const made = moving(hung, 1);
    const color = new BufferAttribute(new Float32Array(made.position.count * 3), 3);
    made.geometry.setAttribute('color', color);
    // The ropes once more, as bare lines through the same corners. Across the village a rope is a third of a pixel
    // thick and is drawn as scattered dots; a line is a pixel wide however far off, and lies hidden in the rope close up.
    const thread = new BufferGeometry();
    thread.setAttribute('position', made.position);
    thread.setAttribute('color', color);
    thread.setIndex(new BufferAttribute(hung.threads, 1));
    // Measured as the mesh is, with the same room to move.
    thread.boundingSphere = made.geometry.boundingSphere;
    return { ...made, color, thread };
  }, []);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.84 }), []);
  const line = useMemo(() => new LineBasicMaterial({ vertexColors: true }), []);
  // Before the first frame that shows them, and again when the colours change.
  useLayoutEffect(() => {
    (shape.color.array as Float32Array).set(buntingColors(colors));
    shape.color.needsUpdate = true;
  }, [shape, colors]);
  useEffect(
    () => () => {
      shape.geometry.dispose();
      shape.thread.dispose();
    },
    [shape],
  );
  useEffect(
    () => () => {
      material.dispose();
      line.dispose();
    },
    [material, line],
  );
  useAnimation((time) => {
    flutter(time, shape.position.array as Float32Array, shape.normal.array as Float32Array);
    shape.position.needsUpdate = true;
    shape.normal.needsUpdate = true;
  });
  return (
    <>
      <mesh geometry={shape.geometry} material={material} castShadow receiveShadow />
      <lineSegments geometry={shape.thread} material={line} />
    </>
  );
}

/** Keeps what the pointer does on the island from going on to a home drawn behind it. */
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * What the pointer meets of the island (see HULL): two plain shapes that are never drawn. Homes are visited through
 * boxes of their own and the nearest thing under the pointer takes it, so a home behind the flag is neither lit nor
 * visited through the flag, as it is not through a home in front of it.
 */
function Hull() {
  const { cone, cloth } = HULL;
  return (
    <group onClick={stop} onPointerOver={stop}>
      <mesh geometry={CONE} position={[0, (cone.foot + cone.tip) / 2, 0]} scale={[cone.radius, cone.tip - cone.foot, cone.radius]} visible={false} />
      <group rotation={[0, cloth.turn, 0]}>
        <mesh geometry={BOX} position={[cloth.length / 2, (cloth.foot + cloth.head) / 2, 0]} scale={[cloth.length, cloth.head - cloth.foot, cloth.half * 2]} visible={false} />
      </group>
    </group>
  );
}

/**
 * The island with the flag, built after the homes (`turn` is its place in that order) and counted with them, so the
 * canvas waits for it too. One raised later, in a village already on screen (the 이웃 were counted after the canvas had
 * drawn, or the tenth has just come), is not there in one frame: it comes up out of the lake. Where the scene is held
 * still it stands finished at once. Memoized as the homes' plots are: the page around the canvas renders again far more
 * often than a flag changes.
 */
export const FlagIsland = memo(function FlagIsland({ flag, lush, turn }: { flag: StageFlag; lush: boolean; turn: number }) {
  const make = useCallback(() => buildFlagIsland(lush), [lush]);
  const build = useBuild(make, turn);
  const origin = useMemo(() => [flag.x, 0, flag.z] as const, [flag.x, flag.z]);
  // The app's colours are its theme's, and the hour follows the theme: a new hour reads them again.
  const mood = useMood();
  const colors = useMemo(() => ({ field: token(flagToken(flag.element)), pennants: ELEMENTS.map((element) => token(flagToken(element))) }), [flag.element, mood]);
  const clock = useThree((state) => state.clock);
  const still = useStill();
  const island = useRef<Group>(null);
  // Whether the canvas was drawing before the island stood in it (its clock starts with its first frame), and for
  // how many seconds the island has been coming up.
  const arrival = useRef({ late: clock.elapsedTime > 0, seconds: 0 });
  useFrame((_, delta) => {
    const group = island.current;
    const state = arrival.current;
    // A frame drawn while the island is still to be built: the village is on screen without it.
    if (!group) return void (state.late = true);
    if (state.seconds >= RISE_SECONDS) return;
    // A stall (the island's own building, a hidden tab) is not time it has been seen rising.
    state.seconds = state.late && !still ? state.seconds + Math.min(0.1, delta) : RISE_SECONDS;
    group.position.y = -sunk(state.seconds);
  });
  if (!build) return null;
  return (
    <group position={[flag.x, 0, flag.z]}>
      <group ref={island}>
        <Built build={build} origin={origin} />
        <Cloth element={flag.element} field={colors.field} glow={CLOTH_GLOW * (mood.lamps - 1)} />
        <Bunting colors={colors.pennants} />
        <Hull />
      </group>
    </group>
  );
});
