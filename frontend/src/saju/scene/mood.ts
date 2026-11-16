import { Color, DataTexture, DataUtils, EquirectangularReflectionMapping, HalfFloatType, LinearFilter, RepeatWrapping, RGBAFormat, Vector3 } from 'three';

// The hour the village is seen at: where the sun stands, what colour its light and the sky's are, and how the lake
// answers them. The sun's lamp, the sky the scene is lit by, the haze and the water all read the same mood, so they agree.

/** The lake's surface, below the lawns at y = 0. */
export const WATER_LEVEL = -0.3;

type Rgb = [number, number, number];

export type Mood = {
  /** From the scene toward the sun. */
  toSun: Vector3;
  sun: string;
  sunPower: number;
  /** The sky overhead, at the horizon under the sun, and at the horizon away from it; then what the ground gives back. */
  zenith: Rgb;
  toward: Rgb;
  away: Rgb;
  ground: Rgb;
  /** The glow about the sun. */
  glow: Rgb;
  /** How strongly the sky lights the scene. */
  skyPower: number;
  /** The air's colour in the distance. */
  haze: string;
  /** The lake where it is deep. */
  deep: string;
  /** Lamps and lit windows: 1 by day's last light, more as it gets dark. */
  lamps: number;
  /** How bright the picture is developed. */
  exposure: number;
};

/** A colour as the light it stands for, `gain` times as bright. */
function light(hex: string, gain = 1): Rgb {
  const color = new Color(hex);
  return [color.r * gain, color.g * gain, color.b * gain];
}

/** 해 질 녘: the sun low at the viewer's left, peach light, violet shade. */
export const GOLDEN: Mood = {
  toSun: new Vector3(-0.4, 0.44, 0.8).normalize(),
  sun: '#ffb983',
  sunPower: 3.3,
  zenith: light('#7d8cdc', 1.05),
  toward: light('#ffc89a', 2.3),
  away: light('#f2a9c6', 1.3),
  ground: light('#7a6652', 0.5),
  glow: light('#ff9b58', 1.5),
  skyPower: 0.62,
  haze: '#f3bfa6',
  deep: '#1b2a44',
  lamps: 1,
  exposure: 1.06,
};

/** 어스름: after sunset, the sky's last blue, lamps and windows carrying the picture. */
export const DUSK: Mood = {
  toSun: new Vector3(-0.4, 0.4, 0.82).normalize(),
  sun: '#9db4ff',
  sunPower: 0.85,
  zenith: light('#27356f', 0.9),
  toward: light('#d9809a', 0.9),
  away: light('#55508f', 0.8),
  ground: light('#2a2a3a', 0.4),
  glow: light('#ff8f6a', 0.5),
  skyPower: 0.75,
  haze: '#4a4a78',
  deep: '#0f1a33',
  lamps: 1.7,
  exposure: 1.15,
};

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The sky's light from direction (x, y, z), a unit vector. */
function skyAt(mood: Mood, x: number, y: number, z: number): Rgb {
  const flat = Math.hypot(x, z) || 1;
  const sunFlat = Math.hypot(mood.toSun.x, mood.toSun.z) || 1;
  const facing = (x * mood.toSun.x + z * mood.toSun.z) / (flat * sunFlat);
  const horizon = mix(mood.away, mood.toward, smooth(-1, 1, facing) ** 1.5);
  let color: Rgb;
  if (y >= 0) color = mix(horizon, mood.zenith, Math.sqrt(y));
  else color = mix([horizon[0] * 0.7, horizon[1] * 0.7, horizon[2] * 0.7], mood.ground, smooth(0, -0.3, y));
  const toSun = Math.max(0, x * mood.toSun.x + y * mood.toSun.y + z * mood.toSun.z);
  const halo = toSun ** 6 * 0.9 + toSun ** 48 * 2.5;
  return [color[0] + mood.glow[0] * halo, color[1] + mood.glow[1] * halo, color[2] + mood.glow[2] * halo];
}

const SKY_WIDTH = 256;
const SKY_HEIGHT = 128;

/** The whole sky as one picture (longitude across, latitude up), in light's own units: what lights the scene. */
export function skyTexture(mood: Mood): DataTexture {
  const data = new Uint16Array(SKY_WIDTH * SKY_HEIGHT * 4);
  for (let row = 0; row < SKY_HEIGHT; row++) {
    const latitude = ((row + 0.5) / SKY_HEIGHT - 0.5) * Math.PI;
    for (let column = 0; column < SKY_WIDTH; column++) {
      const longitude = ((column + 0.5) / SKY_WIDTH - 0.5) * Math.PI * 2;
      const [r, g, b] = skyAt(mood, Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude));
      const at = (row * SKY_WIDTH + column) * 4;
      data[at] = DataUtils.toHalfFloat(r);
      data[at + 1] = DataUtils.toHalfFloat(g);
      data[at + 2] = DataUtils.toHalfFloat(b);
      data[at + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const texture = new DataTexture(data, SKY_WIDTH, SKY_HEIGHT, RGBAFormat, HalfFloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
