import { bandVariance, GRAVITY, jonswap, mulberry32, peakOmega, spreading, type SpectrumParams } from './spectrum';

// The long waves that move the lake's surface: a handful of Gerstner waves drawn from the village's spectrum, each
// running its own way about the wind, and under them a swell run in from beyond the village, long, low and steady, from
// a way of its own. Together they heave the whole sea and rise and fall against the islands' banks. The shorter waves of
// the spectrum only shade the surface (see FFTWaves, and the ripple texture where those cannot be computed).

/** The wind's own long waves, and the swell's. */
export const WIND_WAVES = 16;
export const SWELL_WAVES = 7;
export const WAVE_COUNT = WIND_WAVES + SWELL_WAVES;
/** Waves at least this long move the surface; the shorter ones are the cascades'. */
export const SWELL_CUTOFF = 5.9;

/** The way the wind blows over the lake, east and a little north: the way the homes' smoke drifts and the flag flies. */
export const WIND_ANGLE = Math.atan2(-0.5, 0.85);

export type SeaState = {
  windAngle: number;
  wind: number;
  fetch: number;
  spread: number;
  /** How far the crests lean and sharpen (Gerstner's steepness, and the cascades' sideways pull). */
  choppiness: number;
  /** How strongly the finest waves shade the surface. */
  detail: number;
  /** How readily the crests out in the lake whiten. */
  whitecaps: number;
  /** The open lake's significant wave height, in metres: the whole spectrum is scaled to it. */
  height: number;
  swell: Swell;
};

/**
 * A swell run in from beyond the village: the way it travels (radians from +x toward +z), its waves' length at their
 * peak and its significant height, in metres. It is what makes the whole sea heave and roll.
 */
export type Swell = { angle: number; length: number; height: number };

/**
 * The village's sea: a fresh breeze that has crossed some kilometres of water, its waves about seven metres long at their
 * peak and a quarter of a metre high, as steep as imjin's rough sea; and under them a swell twenty metres long rolling in
 * toward the village's camera as it first stands (from the far side of the picture, a little off its middle), so its
 * crests face the eye and their light and shade read across the whole sea. The swell is far higher than the lawns allow:
 * its crests are held under them (see shore.limitCrest) and the shores calm it, while its slopes shade the open sea in
 * full.
 */
export const VILLAGE_SEA: SeaState = {
  windAngle: WIND_ANGLE,
  wind: 3.5,
  fetch: 8000,
  spread: 1,
  choppiness: 1.2,
  detail: 1.15,
  whitecaps: 1,
  height: 0.25,
  swell: { angle: Math.PI / 4 + 0.3, length: 20, height: 2 },
};

export function spectrumOf(state: SeaState): SpectrumParams {
  return { wind: state.wind, fetch: state.fetch, angle: state.windAngle, spread: state.spread };
}

/** The shortest wave the spectrum is drawn to, anywhere: the finest cascade's last ripple. */
export const SHORTEST_WAVE = 0.028;
/** The longest: past a few times the peak's length the spectrum holds nothing. */
const LONGEST_WAVE = 60;

/**
 * How much every wave's height is multiplied by for the whole spectrum, from the longest wave to the finest ripple, to
 * hold `state.height` as its significant height (four times the surface's standard deviation).
 */
export function heightScale(state: SeaState): number {
  const variance = bandVariance((2 * Math.PI) / LONGEST_WAVE, (2 * Math.PI) / SHORTEST_WAVE, spectrumOf(state), 4000);
  return state.height / (4 * Math.sqrt(Math.max(variance, 1e-12)));
}

export class WaveField {
  /** Per wave: its direction (x, z), wavenumber and angular frequency. */
  readonly dirK = new Float32Array(WAVE_COUNT * 4);
  /** Per wave: its amplitude, its sideways pull (Gerstner's Q times amplitude), its phase and its wavelength. */
  readonly ampQ = new Float32Array(WAVE_COUNT * 4);
  state: SeaState = VILLAGE_SEA;
  /** No point of the surface is higher than this: the sum of every wave's amplitude. */
  crest = 0;
  private readonly seed: number;

  constructor(state = VILLAGE_SEA, seed = 1592) {
    this.seed = seed;
    this.setState(state);
  }

  setState(state: SeaState) {
    this.state = state;
    const rand = mulberry32(this.seed);
    const params = spectrumOf(state);
    const scale = heightScale(state);
    const kp = peakOmega(params) ** 2 / GRAVITY;
    const kMax = (2 * Math.PI) / SWELL_CUTOFF;
    const kMin = Math.min(kMax * 0.5, kp * 0.35);
    const steps = 512;
    const cdf = new Float64Array(steps + 1);
    const dk = (kMax - kMin) / steps;
    for (let i = 0; i < steps; i += 1) {
      const k = kMin + (i + 0.5) * dk;
      const omega = Math.sqrt(GRAVITY * k);
      cdf[i + 1] = cdf[i]! + jonswap(omega, params) * (GRAVITY / (2 * omega)) * dk;
    }
    const total = Math.max(1e-9, cdf[steps]!);
    const variance = bandVariance(kMin, kMax, params) * scale * scale;
    const amp = Math.sqrt((2 * variance) / WIND_WAVES);
    for (let i = 0; i < WIND_WAVES; i += 1) {
      const u = ((i + 0.15 + rand() * 0.7) / WIND_WAVES) * total;
      let lo = 0;
      let hi = steps;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid]! < u) lo = mid;
        else hi = mid;
      }
      const k = kMin + (lo + rand()) * dk;
      const omega = Math.sqrt(GRAVITY * k);
      let theta = 0;
      for (let tries = 0; tries < 64; tries += 1) {
        const cand = (rand() * 2 - 1) * Math.PI;
        if (rand() * 1.2 < spreading(cand, omega, params)) {
          theta = cand;
          break;
        }
      }
      const angle = state.windAngle + theta;
      const a = amp * (0.85 + rand() * 0.3);
      this.place(i, angle, k, a, Math.min(a * state.choppiness, 0.85 / (k * WAVE_COUNT)), rand() * Math.PI * 2);
    }
    // The swell: a band of lengths about its peak, each wave up to a quarter turn's sixth off its way, so their crests run
    // in sets that build and fade, broken along their length, instead of as one corrugation across the sea (as they would
    // seen low over the water, the crests facing the eye). Each wave holds an even share of its height.
    const swell = state.swell;
    const swellAmp = (swell.height / 4) * Math.sqrt(2 / SWELL_WAVES);
    for (let j = 0; j < SWELL_WAVES; j += 1) {
      const length = swell.length * (0.64 + (0.72 * (j + 0.2 + rand() * 0.6)) / SWELL_WAVES);
      const k = (2 * Math.PI) / length;
      const angle = swell.angle + (rand() * 2 - 1) * 0.45;
      const a = swellAmp * (0.85 + rand() * 0.3);
      // Long and low, a swell's crests round over rather than sharpen.
      this.place(WIND_WAVES + j, angle, k, a, Math.min(a * state.choppiness * 0.5, 0.85 / (k * WAVE_COUNT)), rand() * Math.PI * 2);
    }
    let crest = 0;
    for (let i = 0; i < WAVE_COUNT; i += 1) crest += this.ampQ[i * 4]!;
    this.crest = crest;
  }

  /** Writes wave `i`: running along `angle` with wavenumber `k`, `a` high, pulled `qa` sideways, starting at `phase`. */
  private place(i: number, angle: number, k: number, a: number, qa: number, phase: number) {
    const o = i * 4;
    this.dirK[o] = Math.cos(angle);
    this.dirK[o + 1] = Math.sin(angle);
    this.dirK[o + 2] = k;
    this.dirK[o + 3] = Math.sqrt(GRAVITY * k);
    this.ampQ[o] = a;
    this.ampQ[o + 1] = qa;
    this.ampQ[o + 2] = phase;
    this.ampQ[o + 3] = (2 * Math.PI) / k;
  }

  /**
   * The surface height under the point (x, z) at `t`: the horizontal displacement of every wave is undone by
   * fixed-point iteration, then the height is summed there.
   */
  heightAt(x: number, z: number, t: number) {
    const dirK = this.dirK;
    const ampQ = this.ampQ;
    let px = x;
    let pz = z;
    let dy = 0;
    for (let it = 0; it < 5; it += 1) {
      let dx = 0;
      let dz = 0;
      dy = 0;
      for (let i = 0; i < WAVE_COUNT; i += 1) {
        const o = i * 4;
        const Dx = dirK[o]!;
        const Dz = dirK[o + 1]!;
        const theta = dirK[o + 2]! * (Dx * px + Dz * pz) - dirK[o + 3]! * t + ampQ[o + 2]!;
        const c = Math.cos(theta);
        const qa = ampQ[o + 1]!;
        dx += qa * Dx * c;
        dz += qa * Dz * c;
        dy += ampQ[o]! * Math.sin(theta);
      }
      px = x - dx;
      pz = z - dz;
    }
    return dy;
  }

  significantHeight() {
    let sum = 0;
    for (let i = 0; i < WAVE_COUNT; i += 1) sum += this.ampQ[i * 4]! ** 2;
    return 4 * Math.sqrt(sum / 2);
  }
}
