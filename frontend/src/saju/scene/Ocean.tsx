import { useEffect, useMemo, useRef } from 'react';

import { useFrame, useThree } from '@react-three/fiber';
import { Color, Matrix4, Vector3, type Mesh, type OrthographicCamera, type Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import type { Quality } from './look';
import type { Mood } from './mood';
import { detailTexture, foamTexture } from './ocean/detailNormals';
import { FFTWaves } from './ocean/FFTWaves';
import { Mirror } from './ocean/mirror';
import { placeRing, ringGeometry, type RingPlace } from './ocean/ring';
import type { OceanIsland } from './ocean/shore';
import { Surface, type SurfaceLight } from './ocean/surface';
import { heightScale, spectrumOf, VILLAGE_SEA, WaveField } from './ocean/waves';
import { useStill } from './parts';

export type { OceanIsland } from './ocean/shore';

// The lake the islands stand in, as a sea: a swell and wind waves running under a breeze, breaking white along every
// island's shore and drawing back, the sky and the islands mirrored in it and bent by the waves, the low sun glittering
// where the waves face it, and the water lightening and greening over the banks. It reaches past every edge of the
// picture, however the camera turns, tilts or zooms.

/** Rings in the surface's disc: as fine a grain as a laptop draws smoothly; coarser on a phone. */
const RINGS: Record<Quality, number> = { high: 128, low: 72 };
/**
 * The mirror's size against the canvas, how many frames apart it is drawn while the camera holds still (what stands
 * still is mirrored the same from one frame to the next), and how many taps it is read with.
 */
const MIRROR: Record<Quality, { scale: number; every: number; taps: 1 | 4 }> = { high: { scale: 0.5, every: 2, taps: 4 }, low: { scale: 0.35, every: 3, taps: 1 } };
/** After the camera has moved (the look's own frame callback) and before the frame is drawn (the darkroom's, at 1). */
const PRIORITY = 0.5;
/** The moment a still lake shows: breakers rolling in along most shores. */
const STILL_AT = 4.2;
/** How many frames apart a still scene's mirror is drawn while the camera holds still. */
const STILL_EVERY = 30;
/**
 * How much flat water mirrors, seen from the camera's slant, at which the islands' reflection begins to show against the
 * sky's, and at which it is drawn in full. From the village's own slant (33°) water mirrors a twenty-fifth of what it
 * faces: the islands' reflection cannot be told from the sky's there, and the mirror (the whole scene drawn a second
 * time) is not drawn at all. Tilted down toward the lowest slant (20°) it mirrors a seventh, and the mirror comes in.
 */
const MIRROR_FROM = 0.05;
const MIRROR_FULL = 0.09;
/** How far a reflection moves, in metres of the picture, for each unit of the water's slope; and how far up it is drawn out. */
const BEND_METRES = 1.4;
const SMEAR_METRES = 0.3;

/** The light of `mood` as the water sees it. */
function lightOf(mood: Mood): SurfaceLight {
  const sun = new Color(mood.sun).multiplyScalar(mood.sunPower);
  // The sky the water's body and its foam are lit by: overhead and all round the horizon, as the scene is lit.
  const sky = new Color(
    (mood.zenith[0] * 2 + mood.toward[0] + mood.away[0]) / 4,
    (mood.zenith[1] * 2 + mood.toward[1] + mood.away[1]) / 4,
    (mood.zenith[2] * 2 + mood.toward[2] + mood.away[2]) / 4,
  ).multiplyScalar(mood.skyPower);
  // The sea's own colours, imjin's turned a shade bluer for the village's pink evening: what the deep water gives back of
  // the light it takes in (a dark blue-teal), and what a crest's thin top lets through (a lighter teal). The hour changes
  // the light, not the water.
  const deep = new Color().setRGB(0.0045, 0.02, 0.037);
  const scatter = new Color().setRGB(0.016, 0.072, 0.082);
  // How much daylight is left: the shallows' green and the foam's white fade with it.
  const day = Math.min(1, Math.max(0, (mood.sunPower - 0.85) / (3.3 - 0.85)));
  const shallow = new Color('#58b09e').multiplyScalar(0.04 + 0.16 * day);
  const foam = new Color(0.62, 0.68, 0.76).lerp(new Color(0.93, 0.95, 0.96), day);
  return { toSun: mood.toSun.clone().normalize(), sun, sky, deep, scatter, shallow, foam };
}

type Made = { surface: Surface; mirror: Mirror; fft: FFTWaves | null; rings: number };

const place: RingPlace = { centre: new Vector3(), across: new Vector3(), along: new Vector3() };
const ahead = new Vector3();
const right = new Vector3();
const upward = new Vector3();

/**
 * The lake, about the place the camera looks at. `sky` is the sky as one picture (see mood); `islands` are the shapes
 * the water meets; `quality` low leaves out what a phone pays most for (the wave cascades, the mirror's breadth).
 * Mounted inside the village's canvas, whose frame is drawn by a callback of its own after this one's.
 */
export function Ocean({ mood, sky, islands, quality }: { mood: Mood; sky: Texture; islands: readonly OceanIsland[]; quality: Quality }) {
  const gl = useThree((state) => state.gl) as unknown as WebGPURenderer;
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  const still = useStill();
  const lake = useRef<Mesh>(null);
  const seen = useRef({ frames: 0, view: new Matrix4(), projection: new Matrix4() });
  const geometry = useMemo(() => ringGeometry(RINGS[quality]), [quality]);
  // Built once for a quality; the sky is swapped into the surface as the hour changes (below).
  const made = useMemo<Made>(() => {
    const waves = new WaveField(VILLAGE_SEA);
    // The cascades are computed where the graphics card can: not under WebGL, and not on a phone.
    const computes = quality === 'high' && (gl.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend === true;
    const fft = computes ? new FFTWaves(spectrumOf(VILLAGE_SEA), heightScale(VILLAGE_SEA), 128) : null;
    if (fft) fft.choppiness.value = VILLAGE_SEA.choppiness;
    const mirror = new Mirror();
    const surface = new Surface({
      waves,
      fft,
      detail: fft ? null : detailTexture(VILLAGE_SEA.windAngle),
      foam: foamTexture(),
      mirror: mirror.texture,
      sky,
      mirrorTaps: MIRROR[quality].taps,
    });
    return { surface, mirror, fft, rings: RINGS[quality] };
  }, [gl, quality]);
  useEffect(
    () => () => {
      made.surface.dispose();
      made.mirror.dispose();
      made.fft?.dispose();
    },
    [made],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  // The cascades are computed once as soon as they are made, while the canvas is still being made ready: their passes
  // are put together then, not in the first frame shown.
  useEffect(() => made.fft?.update(gl, STILL_AT), [made, gl]);
  useEffect(() => {
    made.surface.setLight(lightOf(mood));
    made.surface.setSky(sky);
  }, [made, mood, sky]);
  useEffect(() => made.surface.setIslands(islands), [made, islands]);
  useEffect(() => {
    const scale = MIRROR[quality].scale;
    made.mirror.setSize(size.width * dpr * scale, size.height * dpr * scale);
  }, [made, quality, size, dpr]);

  useFrame(({ scene, camera, clock }) => {
    const mesh = lake.current;
    if (!mesh) return;
    const view = camera as OrthographicCamera;
    const { surface, mirror, fft, rings } = made;
    if (!placeRing(view, size.width, size.height, place)) return;
    surface.centre.value.set(place.centre.x, place.centre.z);
    surface.across.value.set(place.across.x, place.across.z);
    surface.along.value.set(place.along.x, place.along.z);
    surface.spacing.value = Math.max(place.across.length(), place.along.length()) / rings;
    view.getWorldDirection(ahead);
    surface.toCamera.value.copy(ahead).negate();
    // The picture's right and up as they lie on the water; the mirror's picture runs right to left (see Mirror).
    right.set(1, 0, 0).applyQuaternion(view.quaternion).setY(0).normalize();
    upward.set(ahead.x, 0, ahead.z).normalize();
    surface.screenRight.value.set(-right.x, -right.z);
    surface.screenUp.value.set(upward.x, upward.z);
    // A wave bends what it mirrors by the same stretch of water whatever the zoom.
    surface.bend.value.set((BEND_METRES * view.zoom) / size.width, (BEND_METRES * view.zoom) / size.height);
    surface.smear.value = (SMEAR_METRES * view.zoom) / size.height;

    const time = still ? STILL_AT : clock.elapsedTime;
    surface.time.value = time;
    // A held-still lake keeps the cascades painted at STILL_AT (see the effect above); recomputing them every frame does nothing visible.
    if (!still) fft?.update(gl, time);

    // Schlick's Fresnel for flat water seen from the camera's slant: whether the islands' reflection shows at all.
    const flat = 0.02 + 0.98 * (1 + ahead.y) ** 5;
    const share = Math.min(1, Math.max(0, (flat - MIRROR_FROM) / (MIRROR_FULL - MIRROR_FROM)));
    surface.mirrorShare.value = share * share * (3 - 2 * share);
    // The mirror is drawn afresh every frame the camera moves, and otherwise only now and then: in a still scene, where
    // nothing it mirrors moves, seldom (an island may yet be raised).
    const last = seen.current;
    last.frames += 1;
    const moved = !last.view.equals(view.matrixWorld) || !last.projection.equals(view.projectionMatrix);
    last.view.copy(view.matrixWorld);
    last.projection.copy(view.projectionMatrix);
    if (share <= 0) {
      // Drawn afresh as soon as it is wanted again.
      last.frames = 0;
      return;
    }
    if (last.frames > 2 && !moved && last.frames % (still ? STILL_EVERY : MIRROR[quality].every) !== 0) return;
    mirror.draw(gl, scene, view, mesh);
    surface.mirrorMatrix.value.copy(mirror.matrix);
  }, PRIORITY);

  return <mesh ref={lake} name="lake" geometry={geometry} material={made.surface.material} frustumCulled={false} renderOrder={-1} />;
}
