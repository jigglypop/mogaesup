import type { Texture } from 'three';
import { smoothstep, texture, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';

// Smooth fields over the lake, read from a broad noise tile at scales and angles unrelated to each other and to the
// wave tiles, so nothing they shape repeats across the village: gusts that roughen the short waves and set off
// whitecaps as they run downwind, wave groups that swell and ebb, and patches of greener or darker water.

type Float = Node<'float'>;
type Vec2 = Node<'vec2'>;

export class SeaFields {
  private readonly wind: [number, number];

  constructor(
    private readonly tile: Texture,
    private readonly time: Float,
    windAngle: number,
  ) {
    this.wind = [Math.cos(windAngle), Math.sin(windAngle)];
  }

  /** The tile's broad field (green) at `xz`, turned `angle` and stretched to repeat every `span` metres. */
  private read(xz: Vec2, angle: number, span: number, level?: Float): Float {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const uv = vec2(xz.x.mul(c).sub(xz.y.mul(s)), xz.x.mul(s).add(xz.y.mul(c))).div(span);
    const node = texture(this.tile, uv);
    return (level === undefined ? node : node.level(level)).g;
  }

  /** 0 in a lull, 1 in a gust. The patches travel downwind at about the wind's own pace. */
  gust(xz: Vec2, level?: Float): Float {
    const p = xz.sub(vec2(this.wind[0], this.wind[1]).mul(this.time.mul(2.4)));
    const broad = this.read(p, 0.61, 97, level);
    const fine = this.read(p, -1.13, 41, level);
    return smoothstep(0.22, 0.78, broad.mul(0.62).add(fine.mul(0.38)));
  }

  /** 0 between wave groups, 1 in the middle of one; slow, and drifting with the swell. */
  groups(xz: Vec2, level?: Float): Float {
    const p = xz.sub(vec2(this.wind[0], this.wind[1]).mul(this.time.mul(1.3)));
    const broad = this.read(p, 2.2, 150, level);
    const fine = this.read(p, 0.95, 63, level);
    return smoothstep(0.2, 0.8, broad.mul(0.55).add(fine.mul(0.45)));
  }

  /** 0 to 1 over patches about `span` metres across, at an angle of its own: picks between two copies of a wave tile. */
  patch(xz: Vec2, angle: number, span: number, level?: Float): Float {
    return smoothstep(0.3, 0.7, this.read(xz, angle, span, level));
  }

  /** 0 where a cloud's shade dims the sky the water mirrors, 1 under open sky; the patches drift with the wind. */
  clouds(xz: Vec2, level?: Float): Float {
    const p = xz.sub(vec2(this.wind[0], this.wind[1]).mul(this.time.mul(1.1)));
    return smoothstep(0.34, 0.72, this.read(p, 2.6, 58, level).mul(0.7).add(this.read(p, -0.9, 23, level).mul(0.3)));
  }

  /** 0 to 1 over patches tens of metres across, where the water is a shade greener or darker. */
  tint(xz: Vec2): Float {
    const broad = this.read(xz, 1.7, 210, undefined);
    const fine = this.read(xz, -0.4, 77, undefined);
    return smoothstep(0.25, 0.75, broad.mul(0.6).add(fine.mul(0.4)));
  }
}
