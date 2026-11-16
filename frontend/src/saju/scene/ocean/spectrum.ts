// The sea's spectrum: how much of the surface's height each length and direction of wave holds, for a wind that has
// blown so long over so much water (JONSWAP, with a spreading about the wind that narrows near the peak). The village's
// waves, the long ones the surface is moved by and the short ones it is shaded with, are all drawn from it.

/** Gravity as the village's waves feel it. A metre here is about two of ours, so a wave keeps the pace of one twice its length. */
export const GRAVITY = 9.81 / 2;

export type SpectrumParams = {
  /** The wind, in metres a second, and the open water it has blown over, in metres. */
  wind: number;
  fetch: number;
  /** The way it blows, in radians from +x toward +z. */
  angle: number;
  /** How narrowly the waves keep to the wind's way: 1 as the sea does, more for narrower. */
  spread: number;
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number) {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function peakOmega(p: SpectrumParams) {
  return 22 * Math.pow((GRAVITY * GRAVITY) / (p.wind * p.fetch), 1 / 3);
}

/** The wavelength the most energy is in. */
export function peakWavelength(p: SpectrumParams) {
  const omega = peakOmega(p);
  return (2 * Math.PI * GRAVITY) / (omega * omega);
}

export function jonswap(omega: number, p: SpectrumParams) {
  if (omega <= 0) return 0;
  const g = GRAVITY;
  const alpha = 0.076 * Math.pow((p.wind * p.wind) / (p.fetch * g), 0.22);
  const wp = peakOmega(p);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return ((alpha * g * g) / omega ** 5) * Math.exp(-1.25 * (wp / omega) ** 4) * Math.pow(3.3, r);
}

export function spreading(theta: number, omega: number, p: SpectrumParams) {
  const wp = peakOmega(p);
  const ratio = omega / wp;
  const s = (ratio < 1 ? 6 * Math.pow(ratio, 4) + 2 : 8 * Math.pow(ratio, -2.5) + 1) * p.spread;
  const c = Math.cos(theta / 2);
  const base = Math.pow(Math.abs(c), 2 * s);
  const norm = 0.5 / Math.sqrt(Math.PI / (s + 0.5));
  return base * norm * 2 + 0.002;
}

export function directionalSpectrum(kx: number, kz: number, p: SpectrumParams) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const omega = Math.sqrt(GRAVITY * k);
  const dOmegaDk = GRAVITY / (2 * omega);
  let theta = Math.atan2(kz, kx) - p.angle;
  theta = Math.atan2(Math.sin(theta), Math.cos(theta));
  return (jonswap(omega, p) * dOmegaDk * spreading(theta, omega, p)) / k;
}

/** The height's variance the waves between wavenumbers `kMin` and `kMax` hold, in square metres. */
export function bandVariance(kMin: number, kMax: number, p: SpectrumParams, steps = 400) {
  let sum = 0;
  const dk = (kMax - kMin) / steps;
  for (let i = 0; i < steps; i += 1) {
    const k = kMin + (i + 0.5) * dk;
    const omega = Math.sqrt(GRAVITY * k);
    sum += jonswap(omega, p) * (GRAVITY / (2 * omega)) * dk;
  }
  return sum;
}
