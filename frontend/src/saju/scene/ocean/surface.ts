import { Color, Matrix4, Vector2, Vector3, Vector4, type Texture } from 'three';
import {
  abs,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  fract,
  fwidth,
  length,
  log2,
  Loop,
  max,
  min,
  mix,
  normalize,
  pmremTexture,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uniformArray,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';

import { WATER_LEVEL } from '../mood';
import { CASCADES, DISPLACED, type FFTWaves } from './FFTWaves';
import { SKIRT } from './ring';
import { SeaFields } from './seaFields';
import { BANK, BED, MAX_ISLANDS, OPEN_CREST, SHORE_CALM, SHORE_CREST, WATERLINE, type OceanIsland } from './shore';
import { WAVE_COUNT, type WaveField } from './waves';

// The lake's surface as the graphics card draws it. Its corners are laid on the water about the picture's middle and
// moved by the swell and the longest wind waves; every pixel is then shaded from the slopes of all of them: the sky and
// the islands mirrored in it, bent by the waves, the low sun's glitter, the water's own colour lightening and greening
// over the islands' banks, whitecaps where the crests fold, and the waves breaking white along every shore.

type Float = Node<'float'>;
type Vec4 = Node<'vec4'>;

/** Mean square slope of the ripple texture as it is laid on, for the pixels too coarse to show it. */
const DETAIL_SLOPE_VARIANCE = 0.025;
/** How far out from the waterline a breaker's front is first seen rolling in, and how far out it starts to break, in metres. */
const BREAK_REACH = 3.4;
const BREAKING = 1.7;
/** Seconds between two breakers of each of the two trains that arrive at every shore. */
const BREAKER_PERIODS = [6.3, 8.9] as const;
/** How high the water surges up a bank as a breaker arrives. */
const SURGE = 0.07;
/**
 * How much of each cascade's slope the surface is shaded with. The middle one holds the ripples a few pixels long at
 * the village's zooms: drawn a third stronger, they catch the sky in crisp glints, as imjin's sea does, and keep the
 * water lively by night, when the sky they give back is dim.
 */
const CASCADE_SHARE = [1, 1.3, 1] as const;
/** How much of the swell's own folding is taken off before whitecaps are drawn where the surface folds. */
const SWELL_FOLD = 0.65;

const smoothRange = (from: number, to: number, value: Float) => smoothstep(from, to, value);

/**
 * What changes with the hour: the light the water sees and the colours it shows. `deep` is how much of each colour the
 * water gives back of the light it takes in, `scatter` what a crest's thin top lets through; `shallow` is the colour over
 * the banks as it is seen.
 */
export type SurfaceLight = { toSun: Vector3; sun: Color; sky: Color; deep: Color; scatter: Color; shallow: Color; foam: Color };

export type SurfaceParts = {
  waves: WaveField;
  /** The wind waves' cascades, or null where they cannot be computed: the ripple tile shades the surface instead. */
  fft: FFTWaves | null;
  detail: Texture | null;
  foam: Texture;
  mirror: Texture;
  sky: Texture;
  /** Taps the mirror is read with: four draw a reflection out toward the viewer, one leaves it sharp and cheap. */
  mirrorTaps: 1 | 4;
};

export class Surface {
  readonly material: MeshBasicNodeMaterial;
  readonly time = uniform(0);
  /** Where the disc's middle lies on the water, and where the ends of its two radii fall from there. */
  readonly centre = uniform(new Vector2());
  readonly across = uniform(new Vector2(1, 0));
  readonly along = uniform(new Vector2(0, 1));
  /** Metres between the disc's corners where it lies now, the wider way. */
  readonly spacing = uniform(1);
  /** Toward the camera: the same for every pixel, as the camera draws without perspective. */
  readonly toCamera = uniform(new Vector3(0, 1, 0));
  /** The picture's right and up as they lie on the water, for bending the mirror the way the waves lean. */
  readonly screenRight = uniform(new Vector2(1, 0));
  readonly screenUp = uniform(new Vector2(0, -1));
  /** How far the mirror's picture moves for each unit of the water's slope, across and up. */
  readonly bend = uniform(new Vector2());
  /** How far up the mirror's picture a reflection is drawn out. */
  readonly smear = uniform(0.01);
  readonly mirrorMatrix = uniform(new Matrix4());
  /** How much of the mirror's picture is shown over the sky's reflection: none from the village's own slant. */
  readonly mirrorShare = uniform(0);
  readonly toSun = uniform(new Vector3(0, 1, 0));
  /** The light's colours as linear red, green and blue. */
  readonly sunLight = uniform(new Vector3());
  readonly skyLight = uniform(new Vector3());
  readonly deep = uniform(new Vector3());
  readonly scatterPaint = uniform(new Vector3());
  readonly shallow = uniform(new Vector3());
  readonly foamPaint = uniform(new Vector3());
  readonly whitecaps = uniform(0.5);
  readonly detailStrength = uniform(1);
  /** cos and sin of twice the wind's angle: the mirror across the wind that makes the second copy of a wave tile. */
  readonly mirrorWind = uniform(new Vector2(1, 0));
  private readonly waveA: Vector4[];
  private readonly waveB: Vector4[];
  /** Per island: its middle, the straight half of its waterline's side and its corners' radius. */
  private readonly shapes: Vector4[];
  /** Every reading of the sky the surface was built with: a new hour's sky is swapped into each. */
  private readonly skyNodes: ReturnType<typeof pmremTexture>[] = [];
  private sky: Texture;

  constructor(parts: SurfaceParts) {
    const { waves, fft, detail, foam, mirror } = parts;
    this.sky = parts.sky;
    this.waveA = Array.from({ length: WAVE_COUNT }, () => new Vector4());
    this.waveB = Array.from({ length: WAVE_COUNT }, () => new Vector4());
    this.shapes = Array.from({ length: MAX_ISLANDS }, () => new Vector4(1e5, 1e5, 0, 0.1));
    this.syncWaves(waves);
    const waveA = uniformArray<'vec4'>(this.waveA, 'vec4');
    const waveB = uniformArray<'vec4'>(this.waveB, 'vec4');
    const shapes = uniformArray<'vec4'>(this.shapes, 'vec4');
    const fields = new SeaFields(foam, this.time, waves.state.windAngle);
    const t = this.time;

    /** How strongly each cascade is drawn here: wave groups swell and ebb the longest, gusts roughen the shorter ones. */
    const cascadeWeight = (c: number, gust: Float, groups: Float): Float =>
      c === 0 ? mix(float(0.72), float(1.22), groups) : mix(float(0.5), float(1.4), gust).mul(CASCADE_SHARE[c] ?? 1);
    /** How much of the swell is left `fromWater` metres out from the nearest waterline (see shore.swellShare). */
    const swellShare = (fromWater: Float): Float => smoothRange(-0.6, 0, fromWater).mul(smoothRange(0, SHORE_CALM, fromWater).mul(0.7).add(0.3));

    /**
     * The breakers of one train at `fromWater` metres from the shore: how white the water is there, and how far the
     * water has surged up the bank. Each breaker rolls in from {@link BREAK_REACH}, whitens as it breaks and leaves
     * churned water behind it, runs up the bank and draws back; along a shore they arrive at different moments, as waves
     * coming in at a slant do, and break harder in some stretches than in others.
     */
    const breakerTrain = (fromWater: Float, period: number, offset: number, late: Float, strength: Float) => {
      const phase = fract(t.div(period).add(offset).add(late));
      const approach = saturate(phase.div(0.62));
      // Slowing as the water shoals, the front comes in fast and arrives gently.
      const front = float(1).sub(approach).pow(1.6).mul(BREAK_REACH);
      const behind = fromWater.sub(front);
      const breaking = smoothRange(BREAKING, 0.4, front).mul(strength);
      // The crest once it breaks: a narrow line, sharp at its front and feathering behind, and the churned water it leaves.
      const crest = smoothstep(-0.07, 0, behind).mul(float(1).sub(smoothstep(0, 0.2, behind)));
      const churn = smoothstep(-0.02, 0.08, behind).mul(exp(behind.negate().div(0.5)));
      const arriving = float(1).sub(smoothstep(0.6, 0.68, phase));
      const line = crest.mul(breaking).mul(arriving);
      // Then the wash: a sheet of foam over the shallows that draws back out, thinning, until the next one comes in.
      const after = saturate(phase.sub(0.6).div(0.4));
      const reach = after.mul(0.6).add(0.1);
      const wash = float(1).sub(smoothstep(reach.sub(0.3), reach, fromWater)).mul(float(1).sub(after).pow(2)).mul(smoothstep(0.58, 0.64, phase)).mul(strength).mul(0.8);
      const surge = smoothstep(0.42, 0.62, phase).mul(float(1).sub(smoothstep(0.62, 0.95, phase))).mul(strength);
      return { line, churn: churn.mul(breaking).mul(0.8).mul(arriving), wash, surge };
    };
    /**
     * Both trains: their breaking lines, the churned water and wash they leave, and the surge as a height. Small away from
     * the shore, nothing in a pond. `late` is how far behind the breakers here run, `strength` how hard they break (see
     * the corners' fields below).
     */
    const breakers = (fromWater: Float, late: Float, strength: Float) => {
      const first = breakerTrain(fromWater, BREAKER_PERIODS[0], 0, late, strength);
      const second = breakerTrain(fromWater, BREAKER_PERIODS[1], 0.37, late.mul(1.3), float(1.45).sub(strength));
      // Up to half a metre ashore: the waterline wanders either way of the square it is reckoned from, and where the
      // bank stands above the foam it hides it.
      const ashore = smoothRange(-1.1, -0.6, fromWater);
      const shore = float(1).sub(smoothRange(0.3, 1.6, fromWater));
      return {
        line: max(first.line, second.line.mul(0.85)).mul(ashore),
        churn: max(first.churn, second.churn.mul(0.85)).mul(ashore),
        wash: max(first.wash, second.wash.mul(0.85)).mul(ashore),
        surge: max(first.surge, second.surge.mul(0.75)).mul(shore).mul(ashore).mul(SURGE),
      };
    };

    // Carried from each corner of the disc to the pixels between them: where the corner lies on the water and how far
    // outside the nearest island's waterline square; the broad fields there (gusts, wave groups, the water's tint, how
    // late the breakers come); the patches that pick between the copies of the two longer tiles and how hard the
    // breakers break; and the swell's slopes, stretches and the slope too short for the corners.
    const vPlace = varyingProperty('vec4', 'vOceanPlace');
    const vFields = varyingProperty('vec4', 'vOceanFields');
    const vPicks = varyingProperty('vec4', 'vOceanPicks');
    const vSlope = varyingProperty('vec4', 'vOceanSlope');
    const vShear = varyingProperty('vec2', 'vOceanShear');

    const displaced = Fn(() => {
      const local = positionGeometry.xz;
      const r = length(local);
      const p0 = this.centre.add(this.across.mul(local.x)).add(this.along.mul(local.y)).toVar();
      // The skirt past the disc lies still: it is only ever seen far off the canvas's edge.
      const held = float(1).sub(smoothstep(1, SKIRT[0], r));
      // How far outside the nearest island's waterline square, and so from its waterline.
      const out = float(1e4).toVar();
      Loop(MAX_ISLANDS, ({ i }) => {
        const shape = shapes.element(i);
        const q = abs(p0.sub(shape.xy)).sub(shape.z);
        out.assign(min(out, length(max(q, vec2(0))).add(min(max(q.x, q.y), 0)).sub(shape.w)));
      });
      const nearest = out.sub(WATERLINE);
      const share = swellShare(nearest).mul(held);
      const groups = fields.groups(p0, float(0));
      const gust = fields.gust(p0, float(0));
      const setA = mix(float(0.45), float(1.45), groups);
      const setB = mix(float(0.5), float(1.4), gust);
      const setC = mix(float(1.4), float(0.5), groups);
      const dx = float(0).toVar();
      const dy = float(0).toVar();
      const dz = float(0).toVar();
      const gx = float(0).toVar();
      const gz = float(0).toVar();
      const sxx = float(0).toVar();
      const szz = float(0).toVar();
      const sxz = float(0).toVar();
      const lost = float(0).toVar();
      Loop(WAVE_COUNT, ({ i }) => {
        const a = waveA.element(i);
        const b = waveB.element(i);
        // A wave only a few corners long would alias between them: it is left to the shading's roughness.
        const keep = smoothstep(this.spacing.mul(4), this.spacing.mul(7), b.w);
        const third = i.mod(3);
        // In the shading each third of the swell rises and falls in sets of its own, so the long crests break into the
        // irregular sets of a real sea instead of running as corrugations across the lake.
        const sets = select(third.equal(0), setA, select(third.equal(1), setB, setC));
        const theta = a.z.mul(dot(a.xy, p0)).sub(a.w.mul(t)).add(b.z);
        const s = sin(theta);
        const c = cos(theta);
        dx.addAssign(b.y.mul(a.x).mul(c).mul(keep));
        dz.addAssign(b.y.mul(a.y).mul(c).mul(keep));
        dy.addAssign(b.x.mul(s).mul(keep));
        const qk = b.y.mul(a.z).mul(keep).mul(s).mul(sets);
        const ka = a.z.mul(b.x).mul(keep).mul(c).mul(sets);
        sxx.addAssign(qk.mul(a.x).mul(a.x));
        szz.addAssign(qk.mul(a.y).mul(a.y));
        sxz.addAssign(qk.mul(a.x).mul(a.y));
        gx.addAssign(ka.mul(a.x));
        gz.addAssign(ka.mul(a.y));
        const slopeAmp = a.z.mul(b.x);
        lost.addAssign(slopeAmp.mul(slopeAmp).mul(0.5).mul(float(1).sub(keep)));
      });
      if (fft) {
        for (let c = 0; c < DISPLACED; c += 1) {
          const size = CASCADES[c]!.size;
          const texel = size / fft.n;
          const lod = max(log2(this.spacing.mul(2.2).div(texel)), 0);
          const d = texture(fft.displacement[c]!, p0.div(size)).level(lod);
          const w = cascadeWeight(c, gust, groups);
          dx.addAssign(d.x.mul(w));
          dy.addAssign(d.y.mul(w));
          dz.addAssign(d.z.mul(w));
        }
      }
      // The fields change over tens of metres: read once a corner, they are carried smoothly to every pixel between.
      const late = fields.patch(p0, 0.4, 23).mul(0.9).add(gust.mul(0.25));
      const strength = fields.patch(p0, 1.9, 9).mul(0.55).add(0.45);
      // The breakers' lines bend a little along the shore, as the bed under them is uneven.
      const wobble = fields.patch(p0, -1.4, 7).sub(0.5).mul(0.8);
      const surge = breakers(nearest.add(wobble), late, strength).surge.mul(held);
      // The crest is held under what the shore allows (see shore.crestLimit and limitCrest).
      const limit = smoothRange(0, SHORE_CALM, nearest).mul(OPEN_CREST - SHORE_CREST).add(SHORE_CREST);
      const rise = dy.mul(share).add(surge).toVar();
      const height = select(rise.greaterThan(0), limit.mul(float(1).sub(exp(rise.negate().div(limit)))), rise);
      vPlace.assign(vec4(p0, out, wobble));
      vFields.assign(vec4(gust, groups, fields.tint(p0), late));
      vPicks.assign(vec4(fields.patch(p0, 0.83, CASCADES[0]!.size * 4.1), fields.patch(p0, -0.47, CASCADES[1]!.size * 5.3), strength, fields.clouds(p0)));
      vSlope.assign(vec4(gx, gz, sxx, szz).mul(share));
      vShear.assign(vec2(sxz.mul(share), lost.mul(share).mul(share)));
      return vec3(p0.x.add(dx.mul(share)), height.add(WATER_LEVEL), p0.y.add(dz.mul(share)));
    });

    const shaded = Fn(() => {
      const p0 = vPlace.xy;
      const fw = fwidth(p0);
      const footprint = max(max(fw.x, fw.y), 0.0001);
      const out = vPlace.z;
      const fromWater = out.sub(WATERLINE);
      // The bank as the islands are built: the lawn inside the waterline's square, the bed outside it (see shore.bankHeight).
      const depth = float(WATER_LEVEL - BED).add(smoothstep(-BANK.bed, -BANK.lawn, out.negate()).mul(BED));
      const share = swellShare(fromWater);
      const gust = vFields.x;
      const groups = vFields.y;
      const dyx = vSlope.x.toVar();
      const dyz = vSlope.y.toVar();
      const dxx = vSlope.z.negate().toVar();
      const dzz = vSlope.w.negate().toVar();
      const dxz = vShear.x.negate().toVar();
      // Mean square slope of the waves too small for this pixel. Filtering averages their slopes away; what is lost
      // widens the highlight instead, so the water seen from afar is glossy and its glitter broad rather than aliased.
      const lost = vShear.y.toVar();
      const ripple = float(0.5).toVar();
      // The finest cascade's compression, kept apart: ripples a hand long wrinkle the foam but do not break into it.
      const fineXX = float(0).toVar();
      const fineZZ = float(0).toVar();
      // The slope of the swell and the longest wind waves alone: what bends the mirrored islands. The ripples on them
      // only roughen the sky's reflection and scatter the sun.
      const broad = vec2(vSlope.x, vSlope.y).toVar();
      if (fft) {
        const spread = sqrt(max(fw.x.mul(fw.y), 1e-8)).mul(2);
        const variance = [fft.slopeVariance.x, fft.slopeVariance.y, fft.slopeVariance.z];
        for (let c = 0; c < CASCADES.length; c += 1) {
          const cascade = CASCADES[c]!;
          const size = cascade.size;
          let der: Vec4 = texture(fft.derivatives[c]!, p0.div(size));
          if (c < 2) {
            // Seen across a few tiles, a cascade's tile repeats as a grid. A second copy, mirrored across the wind (so
            // its waves still run downwind) and shifted, takes over in patches several tiles across, so no two
            // neighbouring tiles match.
            const m = this.mirrorWind;
            const q = vec2(m.x.mul(p0.x).add(m.y.mul(p0.y)), m.y.mul(p0.x).sub(m.x.mul(p0.y))).add(c === 0 ? vec2(16.8, 7.2) : vec2(2.9, 5.1));
            const alt = texture(fft.derivatives[c]!, q.div(size));
            // The slope turns with the mirror; the compression's cross term is not stored, so its diagonal is mixed only.
            const c2 = m.x.mul(m.x);
            const s2 = m.y.mul(m.y);
            const altD = vec4(m.x.mul(alt.x).add(m.y.mul(alt.y)), m.y.mul(alt.x).sub(m.x.mul(alt.y)), c2.mul(alt.z).add(s2.mul(alt.w)), s2.mul(alt.z).add(c2.mul(alt.w)));
            const pick = c === 0 ? vPicks.x : vPicks.y;
            const norm = float(1).div(sqrt(pick.mul(pick).add(float(1).sub(pick).mul(float(1).sub(pick)))));
            der = mix(der, altD, pick).mul(norm);
          }
          const w = c === 2 ? cascadeWeight(c, gust, groups).mul(this.detailStrength) : cascadeWeight(c, gust, groups);
          dyx.addAssign(der.x.mul(w));
          dyz.addAssign(der.y.mul(w));
          dxx.addAssign(der.z.mul(w));
          dzz.addAssign(der.w.mul(w));
          if (c === 2) {
            fineXX.assign(der.z.mul(w));
            fineZZ.assign(der.w.mul(w));
          }
          if (c === 0) {
            dxz.addAssign(texture(fft.displacement[0]!, p0.div(size)).w.mul(w));
            broad.assign(vec2(dyx, dyz));
          }
          // The cascade's waves span a range of lengths; the ones shorter than the pixel are lost.
          const longest = (2 * Math.PI) / cascade.kLow;
          const shareLost = saturate(log2(spread.div(cascade.minWave)).div(Math.log2(longest / cascade.minWave)));
          lost.addAssign(variance[c]!.mul(w).mul(w).mul(shareLost));
        }
      } else if (detail) {
        // Two scales of ripple at unrelated angles, a third laid over the first where the wave groups run, so the
        // tile never lines up into a pattern; gusts roughen it. The tiles are laid metres wide, so seen from the
        // village's height their repeats do not line up into a lattice, and they drift fast and crosswise, so the
        // ripples they make between them keep changing as a sea's do.
        const uv1 = p0.mul(1 / 6.8).add(vec2(t.mul(0.18), t.mul(0.1)));
        const uv1b = vec2(p0.x.mul(0.28).sub(p0.y.mul(0.96)), p0.x.mul(0.96).add(p0.y.mul(0.28))).mul(1 / 10.3).add(vec2(t.mul(0.07), t.mul(-0.15)));
        const uv2 = vec2(p0.x.mul(0.8).sub(p0.y.mul(0.6)), p0.x.mul(0.6).add(p0.y.mul(0.8))).mul(1 / 1.9).add(vec2(t.mul(-0.4), t.mul(0.3)));
        const blend = smoothstep(0.25, 0.75, groups);
        const keep = float(1).div(sqrt(blend.mul(blend).add(float(1).sub(blend).mul(float(1).sub(blend)))));
        const r1 = mix(texture(detail, uv1), texture(detail, uv1b), blend);
        const d1 = r1.xy.mul(2).sub(1).mul(keep);
        const d2 = texture(detail, uv2).xy.mul(2).sub(1);
        // The finer ripples fade where the pixel spans them, their slopes left to the highlight's breadth.
        const near = float(1).sub(smoothstep(0.08, 0.6, footprint));
        ripple.assign(r1.z);
        const strength = this.detailStrength.mul(mix(float(0.55), float(1.35), gust));
        const slope = d1.mul(0.28).add(d2.mul(0.17).mul(near)).mul(strength);
        dyx.addAssign(slope.x);
        dyz.addAssign(slope.y);
        broad.addAssign(d1.mul(0.28).mul(strength));
        lost.addAssign(float(1).sub(near).mul(strength).mul(strength).mul(DETAIL_SLOPE_VARIANCE));
      }
      // Over the banks the water calms; in a pond it lies all but still.
      const calm = share.mul(0.75).add(0.25);
      dyx.assign(dyx.mul(calm));
      dyz.assign(dyz.mul(calm));
      dxx.assign(dxx.mul(calm));
      dzz.assign(dzz.mul(calm));
      dxz.assign(dxz.mul(calm));
      const ix = float(1).add(dxx);
      const iz = float(1).add(dzz);
      const jacobian = ix.mul(iz).sub(dxz.mul(dxz));
      const V = this.toCamera;
      const raw = normalize(vec3(dyz.mul(dxz).sub(iz.mul(dyx)), max(jacobian, 0.05), dxz.mul(dyx).sub(dyz.mul(ix))));
      // The back of a steep wave, which the camera's slant cannot see, is turned just far enough to face it.
      const facing = dot(raw, V);
      const N = select(facing.lessThan(0.03), normalize(raw.add(V.mul(float(0.03).sub(facing)))), raw).toVar();
      // Where the wind waves fold over: whitecaps crown their crests. The swell only lifts them toward folding: a swell's
      // whole crest gone white would be a sheet of foam metres wide, not a whitecap.
      const breakX = ix.sub(fineXX.mul(calm)).add(vSlope.z.mul(SWELL_FOLD).mul(calm));
      const breakZ = iz.sub(fineZZ.mul(calm)).add(vSlope.w.mul(SWELL_FOLD).mul(calm));
      const breaking = breakX.mul(breakZ).sub(dxz.mul(dxz));

      const NoV = saturate(dot(N, V));
      // How shallow the water is over the bank: the sand under it shows, and the water's own colour with it.
      const shallowness = float(1).sub(smoothstep(0.02, 0.8, depth)).mul(0.8);
      // Water gives light back as glass does (Schlick's Fresnel): a few hundredths of the sky where it faces the eye, all of
      // it seen edge on. From the village's slant the sea mostly shows its own deep colour, and every wave face turned
      // away from the eye catches the sky: that is what makes the waves read, as they do at sea.
      const reflectance = float(0.02).add(float(0.98).mul(pow(float(1).sub(NoV), 5)));
      const R = reflect(V.negate(), N);
      const Rc = normalize(vec3(R.x, max(R.y, 0.03), R.z));
      // The sky is read as blurred as the waves too small for the pixel make it (their slopes, lost to filtering, spread
      // the reflection over more of the sky), and a little more for the swell's own slopes lost between the corners.
      const swellLost = vShear.y;
      const envBase = float(0.05).add(swellLost.mul(0.6)).min(0.45);
      const roughEnv = pow(pow(envBase, 4).add(lost.mul(0.35)), 0.25).min(0.55);
      const skyNode = pmremTexture(this.sky, Rc, roughEnv);
      this.skyNodes.push(skyNode);
      // A passing cloud's shade dims the sky the water gives back; toward a low sun its glare is held back, as every
      // pixel of a picture without perspective faces it at once.
      const given = skyNode.rgb;
      const glare = max(dot(given, vec3(0.2126, 0.7152, 0.0722)).sub(1.1), 0);
      const sky = given.mul(mix(float(0.78), float(1), vPicks.w)).div(glare.mul(0.5).add(1));

      // What stands over the water, mirrored, bent by the waves' lean and drawn out toward the viewer.
      const mirrored = this.mirrorMatrix.mul(vec4(positionWorld, 1));
      const lean = vec2(dot(broad, this.screenRight), dot(broad, this.screenUp)).mul(calm).negate();
      const at = mirrored.xy.div(mirrored.w).add(lean.mul(this.bend));
      // Up the mirror's picture is down its rows.
      const up = vec2(0, this.smear.negate());
      const image =
        parts.mirrorTaps === 4
          ? texture(mirror, at)
              .bias(float(0.6))
              .mul(0.4)
              .add(texture(mirror, at.add(up)).bias(float(1.4)).mul(0.25))
              .add(texture(mirror, at.sub(up)).bias(float(1.4)).mul(0.15))
              .add(texture(mirror, at.add(up.mul(2.4))).bias(float(2.2)).mul(0.2))
          : texture(mirror, at).bias(float(0.8));
      const reflection = mix(sky, image.rgb, saturate(image.a).mul(0.92).mul(this.mirrorShare));

      const L = this.toSun;
      const sunLight = this.sunLight;
      const skyLight = this.skyLight;
      const shallow = this.shallow;
      const H = normalize(L.add(V));
      const NoH = saturate(dot(N, H));
      const NoL = saturate(dot(N, L));
      const VoH = saturate(dot(V, H));
      const roughSpec = float(0.06).add(lost.mul(0.8)).min(0.5);
      const a2 = roughSpec.mul(roughSpec).mul(roughSpec).mul(roughSpec).add(lost).min(0.5);
      const dDen = NoH.mul(NoH).mul(a2.sub(1)).add(1);
      const D = a2.div(dDen.mul(dDen).mul(Math.PI));
      const Fs = float(0.02).add(float(0.98).mul(pow(float(1).sub(VoH), 5)));
      const glitter = sunLight.mul(D.mul(Fs).mul(NoL).div(max(NoV, 0.12).mul(4))).min(vec3(14));

      // The water's own colour: the sky's and the sun's light taken in and given back up out of the deep, teal and dark,
      // brighter on the faces of the swell turned to the sun and darker on those turned from it; light through the thin
      // water of a raised crest, the more the higher it stands over the troughs about it; lighter and greener over the
      // banks. The swell's light and shade are what make the sea seen from above heave and roll.
      const crest = smoothstep(-0.3, 0.2, positionWorld.y.sub(WATER_LEVEL));
      const backLit = pow(saturate(dot(L.negate(), V).mul(0.65).add(0.35)), 4);
      const thin = pow(saturate(float(0.5).sub(dot(L, N).mul(0.5))), 2);
      const scatterPaint = this.scatterPaint;
      const scatter = scatterPaint
        .mul(sunLight)
        .mul(crest.mul(backLit).mul(thin).mul(2.6).add(pow(NoV, 2).mul(0.25)))
        .mul(0.18)
        .add(scatterPaint.mul(skyLight).mul(crest.mul(0.8)));
      const tint = mix(vec3(1.1, 0.9, 0.94), vec3(0.9, 1.08, 1.04), vFields.z);
      const deepLit = this.deep.mul(tint).mul(skyLight.mul(4.2).add(sunLight.mul(NoL.mul(1.2).add(0.06))));
      const body = mix(deepLit, shallow, shallowness).add(scatter);

      const color = mix(body, reflection, reflectance).add(glitter).toVar();

      // Foam: whitecaps where the crests fold, gathered where the gusts blow; and the breakers along the shores.
      const foamUV = p0.mul(1 / 2.4).add(N.xz.mul(0.18)).add(vec2(t.mul(0.03), t.mul(-0.022)));
      const foamUV2 = p0.mul(1 / 0.75).add(N.xz.mul(0.08)).sub(vec2(t.mul(0.07), t.mul(0.026)));
      const fine = texture(foam, foamUV2).r;
      const pattern = texture(foam, foamUV).r.mul(0.62).add(fine.mul(0.38));
      const bubbles = texture(foam, p0.mul(1 / 0.19).add(N.xz.mul(0.02)).add(vec2(t.mul(0.09), t.mul(-0.06)))).r;
      // A whitecap's foam is drawn out downwind into streaks as it fades.
      const [windX, windZ] = [Math.cos(waves.state.windAngle), Math.sin(waves.state.windAngle)];
      const downwind = p0.x.mul(windX).add(p0.y.mul(windZ));
      const crosswind = p0.y.mul(windX).sub(p0.x.mul(windZ));
      const streaks = texture(foam, vec2(downwind.div(5.5).sub(t.mul(0.05)), crosswind.div(1.3))).r;
      const folded = saturate(float(0.86).sub(breaking).mul(2.4));
      // Without the cascades the swell alone never folds that far: the ripple tile's highest crests riding high on the
      // swell whiten instead, now and then.
      const caps = fft ? folded : max(folded, smoothstep(0.8, 0.96, ripple).mul(smoothstep(0.55, 0.95, crest)).mul(0.55));
      const whitecap = caps.mul(this.whitecaps).mul(mix(float(0.4), float(1.6), gust)).mul(share);
      const surf = breakers(fromWater.add(vPlace.w), vFields.w, vPicks.z);
      // Foam is lace, not paint: a soft edge into the lattice of the pattern, and bubbles that let the water show through.
      // A whitecap's lace is broad; the churn a breaker leaves is finer and more broken, and its breaking line nearly whole.
      const capsLace = saturate(whitecap.mul(0.95).mul(mix(pattern, streaks, 0.55).add(0.25)).sub(float(1).sub(pattern)).mul(1.25));
      const surfPattern = fine.mul(0.55).add(bubbles.mul(0.45));
      const churnLace = saturate(surf.churn.sub(float(1.15).sub(surfPattern)).mul(2.4));
      // The wash is thinner still: a scatter of lace over the shallows, holes and all.
      const washLace = saturate(surf.wash.sub(float(1.3).sub(surfPattern)).mul(2.2));
      const lineLace = saturate(surf.line.mul(1.4).sub(float(1).sub(surfPattern).mul(0.9)).mul(1.5));
      const lace = max(max(capsLace, churnLace), max(lineLace, washLace)).mul(mix(float(0.62), float(1), bubbles));
      // Foam is white water that scatters every light it gets: brighter than the sea it stands on.
      const foamLight = skyLight.mul(1.4).add(sunLight.mul(NoL.mul(0.6).add(0.25)).mul(1.5 / Math.PI));
      color.assign(mix(color, this.foamPaint.mul(foamLight), lace.mul(0.94)));

      // A little see-through over the banks, so the stones and sand under the shallows show; opaque out in the deep.
      const pond = float(1).sub(smoothRange(-0.9, -0.3, fromWater));
      const clear = mix(float(0.58), float(1), smoothstep(0.02, 0.85, depth));
      const alpha = max(mix(clear, float(0.82), pond), lace);
      return vec4(clamp(color, vec3(0), vec3(40)), alpha);
    });

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    material.fog = true;
    material.positionNode = displaced();
    material.colorNode = shaded();
    this.material = material;
  }

  /** Copies the waves into the uniforms the surface reads. */
  syncWaves(waves: WaveField) {
    for (let i = 0; i < WAVE_COUNT; i += 1) {
      const o = i * 4;
      this.waveA[i]!.set(waves.dirK[o]!, waves.dirK[o + 1]!, waves.dirK[o + 2]!, waves.dirK[o + 3]!);
      this.waveB[i]!.set(waves.ampQ[o]!, waves.ampQ[o + 1]!, waves.ampQ[o + 2]!, waves.ampQ[o + 3]!);
    }
    this.whitecaps.value = waves.state.whitecaps;
    this.detailStrength.value = waves.state.detail;
    this.mirrorWind.value.set(Math.cos(2 * waves.state.windAngle), Math.sin(2 * waves.state.windAngle));
  }

  /** Where the islands stand: their shapes, as many as are shaded; the rest are put far out of the way. */
  setIslands(islands: readonly OceanIsland[]) {
    for (let index = 0; index < MAX_ISLANDS; index++) {
      const island = islands[index];
      if (!island) {
        this.shapes[index]!.set(1e5, 1e5, 0, 0.1);
        continue;
      }
      const corner = Math.min(island.corner, island.half);
      this.shapes[index]!.set(island.x, island.z, island.half - corner, corner);
    }
  }

  setLight(light: SurfaceLight) {
    this.toSun.value.copy(light.toSun);
    const rgb = (target: Vector3, color: Color) => target.set(color.r, color.g, color.b);
    rgb(this.sunLight.value, light.sun);
    rgb(this.skyLight.value, light.sky);
    rgb(this.deep.value, light.deep);
    rgb(this.scatterPaint.value, light.scatter);
    rgb(this.shallow.value, light.shallow);
    rgb(this.foamPaint.value, light.foam);
  }

  setSky(sky: Texture) {
    this.sky = sky;
    for (const node of this.skyNodes) node.value = sky;
  }

  dispose() {
    this.material.dispose();
  }
}
