import { HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, Vector3 } from 'three';
import { cos, float, Fn, instancedArray, instanceIndex, max, select, sin, sqrt, textureStore, uniform, uvec2, vec2, vec4 } from 'three/tsl';
import { StorageTexture, type ComputeNode, type StorageBufferNode, type WebGPURenderer } from 'three/webgpu';

import { directionalSpectrum, gaussian, GRAVITY, mulberry32, type SpectrumParams } from './spectrum';
import { SWELL_CUTOFF } from './waves';

// The lake's wind waves, too many and too short to be summed one by one: the spectrum's waves below the swell, laid out
// on three tiles of their own size and moved through time by a Fourier transform on the graphics card, every frame. The
// longest tile moves the surface with the swell; all three shade it, the finest down to ripples a few centimetres long.

const TWO_PI = Math.PI * 2;

export type Cascade = { size: number; kLow: number; kHigh: number; minWave: number };

/** Each tile's side in metres, and the band of wavenumbers it holds. Their sizes share no measure, so their repeats never line up. */
export const CASCADES: readonly Cascade[] = [
  { size: 40.2, kLow: TWO_PI / SWELL_CUTOFF, kHigh: TWO_PI / 0.97, minWave: 0.97 },
  { size: 7.12, kLow: TWO_PI / 0.97, kHigh: TWO_PI / 0.181, minWave: 0.181 },
  { size: 1.68, kLow: TWO_PI / 0.181, kHigh: TWO_PI / 0.028, minWave: 0.028 },
];

const COUNT = CASCADES.length;
/** The cascades whose displacement the surface's corners are moved by. The finest one only bends the normals. */
export const DISPLACED = 2;

type Buffer = StorageBufferNode<'vec4'>;

function makeTexture(n: number) {
  const t = new StorageTexture(n, n);
  t.type = HalfFloatType;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 1;
  return t;
}

/**
 * The cascades' displacement and slope maps, evolved on the graphics card. `n` is each tile's grid (a power of two).
 * Displacement maps hold the sideways pull across, the height, the pull along and the shear; slope maps the height's
 * slope both ways and the pull's stretch both ways.
 */
export class FFTWaves {
  readonly displacement: StorageTexture[];
  readonly derivatives: StorageTexture[];
  readonly time = uniform(0);
  readonly choppiness = uniform(1);
  /** Mean square slope each cascade adds to the surface: what a pixel too coarse to resolve the cascade loses to filtering. */
  readonly slopeVariance = uniform(new Vector3());
  private readonly area: number;
  private readonly total: number;
  private readonly logN: number;
  private readonly h0Data: Float32Array;
  private readonly h0: Buffer;
  private readonly passes: ComputeNode[] = [];
  /** The time and choppiness the maps were last computed for. */
  private mapsTime = NaN;
  private mapsChoppiness = NaN;

  constructor(
    params: SpectrumParams,
    scale: number,
    readonly n = 128,
    seed = 1592,
  ) {
    if (n < 16 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.area = n * n;
    this.total = COUNT * this.area;
    this.logN = Math.round(Math.log2(n));
    this.displacement = CASCADES.slice(0, DISPLACED).map(() => makeTexture(n));
    this.derivatives = CASCADES.map(() => makeTexture(n));
    this.h0Data = new Float32Array(this.total * 4);
    this.fill(params, scale, seed);
    this.h0 = instancedArray(this.h0Data, 'vec4');
    const a: Buffer[] = [instancedArray(this.total, 'vec4'), instancedArray(this.total, 'vec4')];
    const b: Buffer[] = [instancedArray(this.total, 'vec4'), instancedArray(this.total, 'vec4')];
    this.passes.push(this.evolvePass(a[0]!, b[0]!));
    let src = 0;
    for (const dir of [0, 1]) {
      for (let s = 0; s < this.logN; s += 1) {
        const size = 2 << s;
        this.passes.push(this.butterflyPass(dir, size, a[src]!, b[src]!, a[1 - src]!, b[1 - src]!));
        src = 1 - src;
      }
    }
    for (let c = 0; c < COUNT; c += 1) this.passes.push(this.assemblePass(c, a[src]!, b[src]!));
  }

  /** Draws the starting amplitudes from the spectrum and the seed, every height `scale` times the spectrum's. */
  private fill(params: SpectrumParams, scale: number, seed: number) {
    const n = this.n;
    const rand = mulberry32(seed);
    const data = this.h0Data;
    const amp = new Float32Array(this.area * 2);
    for (let c = 0; c < COUNT; c += 1) {
      const cas = CASCADES[c]!;
      const dk = TWO_PI / cas.size;
      let slope = 0;
      for (let y = 0; y < n; y += 1) {
        const m = y < n / 2 ? y : y - n;
        for (let x = 0; x < n; x += 1) {
          const kn = x < n / 2 ? x : x - n;
          const kx = kn * dk;
          const kz = m * dk;
          const k = Math.hypot(kx, kz);
          const i = y * n + x;
          const g1 = gaussian(rand);
          const g2 = gaussian(rand);
          if (k < cas.kLow || k >= cas.kHigh) {
            amp[i * 2] = 0;
            amp[i * 2 + 1] = 0;
            continue;
          }
          // The finest ripples, a few centimetres long, are damped as surface tension damps them.
          const damp = Math.exp(-k * k * 1.2e-5);
          const variance = directionalSpectrum(kx, kz, params) * dk * dk * damp * scale * scale;
          const s = Math.sqrt(variance / 2);
          amp[i * 2] = g1 * s;
          amp[i * 2 + 1] = g2 * s;
          slope += variance * k * k;
        }
      }
      // A mode and its mirror both carry the amplitude drawn above, so the surface holds twice the sum.
      (this.slopeVariance.value as Vector3).setComponent(c, slope * 2);
      const base = c * this.area;
      for (let y = 0; y < n; y += 1) {
        const my = (n - y) % n;
        for (let x = 0; x < n; x += 1) {
          const mx = (n - x) % n;
          const i = y * n + x;
          const j = my * n + mx;
          const o = (base + i) * 4;
          data[o] = amp[i * 2]!;
          data[o + 1] = amp[i * 2 + 1]!;
          data[o + 2] = amp[j * 2]!;
          data[o + 3] = -amp[j * 2 + 1]!;
        }
      }
    }
  }

  private indices() {
    const idx = instanceIndex;
    const c = idx.div(this.area);
    const rem = idx.mod(this.area);
    const y = rem.div(this.n);
    const x = rem.mod(this.n);
    return { idx, c, y, x };
  }

  private evolvePass(outA: Buffer, outB: Buffer): ComputeNode {
    const h0 = this.h0;
    const time = this.time;
    const n = this.n;
    const fn = Fn(() => {
      const { idx, c, y, x } = this.indices();
      const half = n / 2;
      const kn = select(x.lessThan(half), float(x), float(x).sub(n));
      const m = select(y.lessThan(half), float(y), float(y).sub(n));
      const size = select(c.equal(0), float(CASCADES[0]!.size), select(c.equal(1), float(CASCADES[1]!.size), float(CASCADES[2]!.size)));
      const dk = float(TWO_PI).div(size);
      const kx = kn.mul(dk);
      const kz = m.mul(dk);
      const k = max(sqrt(kx.mul(kx).add(kz.mul(kz))), 1e-5);
      const omega = sqrt(k.mul(GRAVITY));
      const phase = omega.mul(time);
      const cp = cos(phase);
      const sp = sin(phase);
      const v = h0.element(idx);
      const hr = v.x.mul(cp).sub(v.y.mul(sp)).add(v.z.mul(cp)).add(v.w.mul(sp));
      const hi = v.x.mul(sp).add(v.y.mul(cp)).sub(v.z.mul(sp)).add(v.w.mul(cp));
      const invK = float(1).div(k);
      const ikxR = kx.mul(hi).negate();
      const ikxI = kx.mul(hr);
      const ikzR = kz.mul(hi).negate();
      const ikzI = kz.mul(hr);
      const dxR = ikxR.mul(invK);
      const dxI = ikxI.mul(invK);
      const dzR = ikzR.mul(invK);
      const dzI = ikzI.mul(invK);
      const fxz = kx.mul(kz).mul(invK).negate();
      const dxzR = hr.mul(fxz);
      const dxzI = hi.mul(fxz);
      const fxx = kx.mul(kx).mul(invK).negate();
      const fzz = kz.mul(kz).mul(invK).negate();
      const dxxR = hr.mul(fxx);
      const dxxI = hi.mul(fxx);
      const dzzR = hr.mul(fzz);
      const dzzI = hi.mul(fzz);
      outA.element(idx).assign(vec4(dxR.sub(dzI), dxI.add(dzR), hr.sub(dxzI), hi.add(dxzR)));
      outB.element(idx).assign(vec4(ikxR.sub(ikzI), ikxI.add(ikzR), dxxR.sub(dzzI), dxxI.add(dzzR)));
    });
    return fn().compute(this.total, [64]);
  }

  private butterflyPass(dir: number, size: number, srcA: Buffer, srcB: Buffer, dstA: Buffer, dstB: Buffer): ComputeNode {
    const n = this.n;
    const area = this.area;
    const fn = Fn(() => {
      const { idx, c, y, x } = this.indices();
      const i = dir === 0 ? x : y;
      const evenIndex = i.div(size).mul(size / 2).add(i.mod(size / 2));
      const oddIndex = evenIndex.add(n / 2);
      const base = c.mul(area);
      const evenAddr = dir === 0 ? base.add(y.mul(n)).add(evenIndex) : base.add(evenIndex.mul(n)).add(x);
      const oddAddr = dir === 0 ? base.add(y.mul(n)).add(oddIndex) : base.add(oddIndex.mul(n)).add(x);
      const angle = float(i).mul(TWO_PI / size);
      const tw = vec2(cos(angle), sin(angle));
      const mix4 = (src: Buffer, dst: Buffer) => {
        const e = src.element(evenAddr);
        const o = src.element(oddAddr);
        const ax = tw.x.mul(o.x).sub(tw.y.mul(o.y));
        const ay = tw.x.mul(o.y).add(tw.y.mul(o.x));
        const bx = tw.x.mul(o.z).sub(tw.y.mul(o.w));
        const by = tw.x.mul(o.w).add(tw.y.mul(o.z));
        dst.element(idx).assign(vec4(e.x.add(ax), e.y.add(ay), e.z.add(bx), e.w.add(by)));
      };
      mix4(srcA, dstA);
      mix4(srcB, dstB);
    });
    return fn().compute(this.total, [64]);
  }

  private assemblePass(cascade: number, srcA: Buffer, srcB: Buffer): ComputeNode {
    const chop = this.choppiness;
    const disp = cascade < DISPLACED ? this.displacement[cascade]! : null;
    const deriv = this.derivatives[cascade]!;
    const n = this.n;
    const area = this.area;
    const fn = Fn(() => {
      const idx = instanceIndex;
      const y = idx.div(n);
      const x = idx.mod(n);
      const addr = idx.add(cascade * area);
      const b = srcB.element(addr);
      const coord = uvec2(x, y);
      if (disp) {
        const a = srcA.element(addr);
        textureStore(disp, coord, vec4(a.x.mul(chop), a.z, a.y.mul(chop), a.w.mul(chop))).toWriteOnly();
      }
      textureStore(deriv, coord, vec4(b.x, b.y, b.z.mul(chop), b.w.mul(chop))).toWriteOnly();
    });
    return fn().compute(area, [64]);
  }

  /** Brings the maps to the sea's `time`; asked again for the same moment, it does nothing. */
  update(renderer: WebGPURenderer, time: number) {
    if (time === this.mapsTime && this.choppiness.value === this.mapsChoppiness) return;
    this.mapsTime = time;
    this.mapsChoppiness = this.choppiness.value;
    this.time.value = time;
    void renderer.compute(this.passes);
  }

  dispose() {
    for (const map of [...this.displacement, ...this.derivatives]) map.dispose();
  }
}
