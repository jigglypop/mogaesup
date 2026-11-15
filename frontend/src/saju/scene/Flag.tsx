import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';

import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, DynamicDrawUsage, LinearFilter, LinearMipmapLinearFilter, MeshStandardMaterial, RGBAFormat, SRGBColorSpace } from 'three';

import { ELEMENTS, type Element } from '../elements';
import { Built } from './Built';
import { buildFlagIsland, buntingColors, buntingShape, CLOTH, CLOTH_TEXELS, clothColors, clothShape, flagToken, flutter, fly, paintCloth, type Shape } from './flagIsland';
import { useAnimation } from './parts';
import { useBuild, useMood } from './works';

// 깃발 섬 in the canvas: the island as it was built, and over it the two things on it that move, the flag's cloth and
// the lines of pennants. Each is one small mesh whose corners are set down again every frame (see flagIsland).

/** The flag's island on the stage: where it lies, and the element of the home whose village raised it (null before the home is built). */
export type StageFlag = { x: number; z: number; element: Element | null };

/** A colour by the name the app's stylesheet gives it, as the bridges' light is read. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

/** The flag: cloth in `field` with the element's character on it, flying from the mast. */
function Cloth({ element, field }: { element: Element | null; field: string }) {
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
    return { texture, material: new MeshStandardMaterial({ map: texture, side: DoubleSide, roughness: 0.86 }) };
  }, [field, element]);
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
    // A line gives a hand's width to the wind, and a pennant swings within its own fall.
    const made = moving(buntingShape(), 1);
    const color = new BufferAttribute(new Float32Array(made.position.count * 3), 3);
    made.geometry.setAttribute('color', color);
    return { ...made, color };
  }, []);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.84 }), []);
  // Before the first frame that shows them, and again when the colours change.
  useLayoutEffect(() => {
    (shape.color.array as Float32Array).set(buntingColors(colors));
    shape.color.needsUpdate = true;
  }, [shape, colors]);
  useEffect(() => () => shape.geometry.dispose(), [shape]);
  useEffect(() => () => material.dispose(), [material]);
  useAnimation((time) => {
    flutter(time, shape.position.array as Float32Array, shape.normal.array as Float32Array);
    shape.position.needsUpdate = true;
    shape.normal.needsUpdate = true;
  });
  return <mesh geometry={shape.geometry} material={material} castShadow receiveShadow />;
}

/**
 * The island with the flag, built after the homes (`turn` is its place in that order) and counted with them, so the
 * canvas waits for it too. Memoized as the homes' plots are: the page around the canvas renders again far more often
 * than a flag changes.
 */
export const FlagIsland = memo(function FlagIsland({ flag, lush, turn }: { flag: StageFlag; lush: boolean; turn: number }) {
  const make = useCallback(() => buildFlagIsland(lush), [lush]);
  const build = useBuild(make, turn);
  const origin = useMemo(() => [flag.x, 0, flag.z] as const, [flag.x, flag.z]);
  // The app's colours are its theme's, and the hour follows the theme: a new hour reads them again.
  const mood = useMood();
  const colors = useMemo(() => ({ field: token(flagToken(flag.element)), pennants: ELEMENTS.map((element) => token(flagToken(element))) }), [flag.element, mood]);
  if (!build) return null;
  return (
    <group position={[flag.x, 0, flag.z]}>
      <Built build={build} origin={origin} />
      <Cloth element={flag.element} field={colors.field} />
      <Bunting colors={colors.pennants} />
    </group>
  );
});
