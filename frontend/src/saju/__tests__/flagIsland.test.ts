import { describe, expect, it } from 'vitest';

import { ELEMENTS, type Element } from '../elements';
import { buildFlagIsland, buntingColors, buntingShape, CLOTH, CLOTH_TEXELS, clothColors, clothShape, flagToken, flutter, fly, HULL, paintCloth, PENNANTS, POSTS, RISE_SECONDS, sunk, type Shape } from '../scene/flagIsland';
import { AZIMUTH, ELEVATION, frameOf, onScreen } from '../scene/frames';
import { WATER_LEVEL } from '../scene/mood';
import { ISLANDS } from '../scene/terrain';
import { FLAG_SPOT, ISLAND, PLOT_REACH } from '../village';

/** A neighbour's island (the east one is) is drawn this far out from its middle, its bed under the water included. */
const HOME_REACH = ISLANDS.neighbour.reach;
/** A home is visited through a box about its island: half this wide, high and deep, its middle this far up (the stage's own). */
const HOME_BOX = { half: [5.3, 2.7, 5.3], up: 1.8 } as const;
/** How far a drag turns the camera to either side of where it stands (the stage's own). */
const MAX_TURN = (40 * Math.PI) / 180;
/** The moments the moving parts are looked at: the first, the one a still scene shows, and some later ones. */
const MOMENTS = [0, 0.4, 1.7, 3.3, 9.1, 47.5];

type Point = [number, number, number];

/** Every corner of what stands still on the island, and where each scattered leaf and stone is put. */
function pointsOf(build: ReturnType<typeof buildFlagIsland>): { corners: Point[]; scattered: Point[] } {
  const corners: Point[] = [];
  for (const { geometry } of build.meshes) {
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) corners.push([position.getX(index), position.getY(index), position.getZ(index)]);
  }
  const scattered: Point[] = [];
  for (const { count, matrices } of build.sprigs) {
    for (let index = 0; index < count; index++) scattered.push([matrices[index * 16 + 12]!, matrices[index * 16 + 13]!, matrices[index * 16 + 14]!]);
  }
  return { corners, scattered };
}

const pointsIn = (positions: Float32Array): Point[] => Array.from({ length: positions.length / 3 }, (_, index): Point => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!]);

/** Of a shape's faces, those its indices from `from` up to `to` make: how many are wound to look the way their corners face, and how many the other way. */
function facing({ positions, normals, indices }: Shape, from = 0, to = indices.length): { out: number; in: number } {
  const [corners, ways] = [pointsIn(positions), pointsIn(normals)];
  const count = { out: 0, in: 0 };
  for (let index = from; index < to; index += 3) {
    const [a, b, c] = [corners[indices[index]!]!, corners[indices[index + 1]!]!, corners[indices[index + 2]!]!];
    const [ab, ac] = [[b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const, [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const];
    const wound = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]] as const;
    const faced = [0, 1, 2].map((axis) => ways[indices[index]!]![axis]! + ways[indices[index + 1]!]![axis]! + ways[indices[index + 2]!]![axis]!);
    count[wound[0] * faced[0]! + wound[1] * faced[1]! + wound[2] * faced[2]! > 0 ? 'out' : 'in'] += 1;
  }
  return count;
}

/** Whether the stretch from `p` to `q` passes through the face `a`, `b`, `c`. */
function crosses(p: Point, q: Point, a: Point, b: Point, c: Point): boolean {
  const [dx, dy, dz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const [abx, aby, abz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [acx, acy, acz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const [hx, hy, hz] = [dy * acz - dz * acy, dz * acx - dx * acz, dx * acy - dy * acx];
  const det = abx * hx + aby * hy + abz * hz;
  if (Math.abs(det) < 1e-12) return false;
  const [sx, sy, sz] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const u = (sx * hx + sy * hy + sz * hz) / det;
  if (u < 0 || u > 1) return false;
  const [qx, qy, qz] = [sy * abz - sz * aby, sz * abx - sx * abz, sx * aby - sy * abx];
  const v = (dx * qx + dy * qy + dz * qz) / det;
  if (v < 0 || u + v > 1) return false;
  const t = (acx * qx + acy * qy + acz * qz) / det;
  return t >= 0 && t <= 1;
}

/** The cloth and the lines of pennants at each of {@link MOMENTS}, every corner of them. */
function movingPoints(): Point[] {
  const cloth = clothShape();
  const bunting = buntingShape();
  return MOMENTS.flatMap((time) => {
    fly(time, cloth.positions, cloth.normals);
    flutter(time, bunting.positions, bunting.normals);
    return [...pointsIn(cloth.positions), ...pointsIn(bunting.positions)];
  });
}

describe('깃발 섬', () => {
  const build = buildFlagIsland();
  const { corners, scattered } = pointsOf(build);
  const moving = movingPoints();
  // A scattered thing reaches a little past the spot it is put on: a boulder, a reed.
  const all = [...corners, ...moving, ...scattered.flatMap(([x, y, z]): Point[] => [[x - 0.6, y, z - 0.6], [x + 0.6, y + 1.2, z + 0.6]])];

  it('지어진다: 땅과 돌, 풀과 꽃, 솔과 등불이 있다', () => {
    expect(build.meshes.length).toBeGreaterThan(4);
    expect(build.meshes.every((mesh) => mesh.geometry.index!.count > 0)).toBe(true);
    const kinds = new Map(build.sprigs.map((sprigs) => [sprigs.kind, sprigs.count]));
    for (const kind of ['blade', 'bloom', 'leaf', 'needle', 'pebble', 'pad'] as const) expect(kinds.get(kind)).toBeGreaterThan(5);
    expect(build.lives.some((life) => life.kind === 'fireflies')).toBe(true);
    for (const [x, y, z] of all) expect(Number.isFinite(x + y + z)).toBe(true);
  });

  it('집의 섬보다 뚜렷이 작다', () => {
    const grass = build.sprigs.find((sprigs) => sprigs.kind === 'blade')!;
    const lawn = Array.from({ length: grass.count }, (_, index) => Math.hypot(grass.matrices[index * 16 + 12]!, grass.matrices[index * 16 + 14]!));
    expect(Math.max(...lawn)).toBeGreaterThan(2.4);
    expect(Math.max(...lawn)).toBeLessThan(ISLAND * 0.35);
    // 물 위로 드러난 것은 가운데에서 다섯 미터 안쪽에 있다: 집의 섬은 기슭까지 여섯 미터가 넘는다.
    expect(Math.max(...corners.filter(([, y]) => y > 0).map(([x, , z]) => Math.hypot(x, z)))).toBeLessThan(5);
  });

  it('동쪽 집의 섬에 닿지 않는다', () => {
    const shore = PLOT_REACH + HOME_REACH;
    expect(Math.min(...all.map(([x]) => FLAG_SPOT.x + x))).toBeGreaterThan(shore + 0.3);
  });

  it('깃대 끝과 물 밑까지, 카메라가 한 섬에 내어 주는 틀 안에 든다', () => {
    const frame = frameOf([FLAG_SPOT]);
    const middle = frame.target[1] * Math.cos(ELEVATION);
    for (const [x, y, z] of all) {
      const spot = onScreen({ x, z });
      expect(Math.abs(spot.right)).toBeLessThan(frame.halfWidth - 1);
      expect(Math.abs(spot.up + y * Math.cos(ELEVATION) - middle)).toBeLessThan(frame.halfHeight - 0.5);
    }
  });

  it('깃대는 이웃집 지붕 위로 솟는다', () => {
    const top = Math.max(...corners.map(([, y]) => y));
    expect(top).toBeGreaterThan(6.5);
    expect(top).toBeLessThanOrEqual(7.5);
    // 깃발과 줄은 깃대 끝보다 높이 오르지 않는다.
    expect(Math.max(...moving.map(([, y]) => y))).toBeLessThan(top);
  });

  it('깃대 끝은 북동쪽 집의 기슭에 닿아 보이지 않는다', () => {
    // 돌리지 않은 그림에서 깃대는 북동쪽 집의 섬 바로 아래에 선다. 그 섬의 땅이 화면에서 가장 낮게 내려오는 모서리와
    // 깃대 끝 사이로 물이 보여야 한다: 기슭의 돌이 그 틈을 한 뼘쯤 더 메운다.
    const top = Math.max(...corners.map(([, y]) => y));
    const tip = onScreen(FLAG_SPOT).up + top * Math.cos(ELEVATION);
    const shore = onScreen({ x: PLOT_REACH + ISLAND / 2, z: -PLOT_REACH + ISLAND / 2 }).up;
    expect(shore - tip).toBeGreaterThan(0.5);
  });

  it('등불이 섬 위에 켜져 있다', () => {
    expect(build.lamps.length).toBeGreaterThanOrEqual(6);
    for (const lamp of build.lamps) {
      expect(lamp.power).toBeGreaterThan(0);
      expect(lamp.at[1]).toBeGreaterThan(0.2);
      expect(Math.hypot(lamp.at[0], lamp.at[2])).toBeLessThan(4.8);
    }
  });

  it('볼 때마다 같은 섬이다', () => {
    const again = buildFlagIsland();
    expect(again.sprigs.map((sprigs) => [sprigs.kind, sprigs.count])).toEqual(build.sprigs.map((sprigs) => [sprigs.kind, sprigs.count]));
    expect(Array.from(again.sprigs[0]!.matrices.slice(0, 64))).toEqual(Array.from(build.sprigs[0]!.matrices.slice(0, 64)));
    expect(again.lamps).toEqual(build.lamps);
  });

  it('휴대폰에는 성기게 심는다', () => {
    const count = (target: typeof build) => target.sprigs.reduce((sum, sprigs) => sum + sprigs.count, 0);
    expect(count(buildFlagIsland(false))).toBeLessThan(count(build) * 0.8);
  });
});

describe('깃발의 천', () => {
  const wide = CLOTH.columns + 1;
  const at = (positions: Float32Array, row: number, column: number): Point => {
    const index = (row * wide + column) * 3;
    return [positions[index]!, positions[index + 1]!, positions[index + 2]!];
  };
  const flown = (time: number) => {
    const cloth = clothShape();
    fly(time, cloth.positions, cloth.normals);
    return cloth;
  };

  it('깃대 쪽 가장자리는 언제나 제자리다', () => {
    const first = flown(0).positions;
    for (const time of MOMENTS) {
      const { positions } = flown(time);
      for (let row = 0; row <= CLOTH.rows; row++) expect(at(positions, row, 0)).toEqual(at(first, row, 0));
    }
    // 그 가장자리는 곧게 서 있고, 천의 높이만큼이다.
    const [foot, head] = [at(first, 0, 0), at(first, CLOTH.rows, 0)];
    expect([head[0], head[2]]).toEqual([foot[0], foot[2]]);
    expect(head[1] - foot[1]).toBeCloseTo(CLOTH.height, 5);
  });

  it('아무리 접혀도 길이는 그대로다', () => {
    for (const time of MOMENTS) {
      const { positions } = flown(time);
      for (const row of [0, CLOTH.rows / 2, CLOTH.rows]) {
        let length = 0;
        for (let column = 1; column <= CLOTH.columns; column++) {
          const [a, b] = [at(positions, row, column - 1), at(positions, row, column)];
          length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        }
        expect(length).toBeCloseTo(CLOTH.length, 4);
      }
    }
  });

  it('깃대에서 멀수록 크게 나부낀다', () => {
    const times = Array.from({ length: 48 }, (_, index) => index * 0.21);
    const shots = times.map((time) => flown(time).positions);
    /** How far a column strays from where it is on average, over all the moments. */
    const sway = (column: number) => {
      let total = 0;
      for (let row = 0; row <= CLOTH.rows; row++) {
        const places = shots.map((positions) => at(positions, row, column));
        const mean = [0, 1, 2].map((axis) => places.reduce((sum, place) => sum + place[axis]!, 0) / places.length);
        total += places.reduce((sum, place) => sum + Math.hypot(place[0] - mean[0]!, place[1] - mean[1]!, place[2] - mean[2]!), 0) / places.length;
      }
      return total / (CLOTH.rows + 1);
    };
    const [hoist, quarter, half, threeQuarters, free] = [0, 9, 18, 27, 36].map(sway);
    expect(hoist).toBe(0);
    expect(quarter).toBeGreaterThan(0.01);
    expect(half).toBeGreaterThan(quarter!);
    expect(threeQuarters).toBeGreaterThan(half!);
    expect(free).toBeGreaterThan(threeQuarters!);
    expect(free).toBeGreaterThan(0.15);
  });

  it('주름은 깃대에서 끝자락 쪽으로 흘러간다', () => {
    /** How each step of the middle row is turned on the ground, against the row's own mean. */
    const turns = (time: number) => {
      const { positions } = flown(time);
      const row = CLOTH.rows / 2;
      const headings = Array.from({ length: CLOTH.columns }, (_, column) => {
        const [a, b] = [at(positions, row, column), at(positions, row, column + 1)];
        return Math.atan2(b[2] - a[2], b[0] - a[0]);
      });
      const mean = headings.reduce((sum, heading) => sum + heading, 0) / headings.length;
      return headings.map((heading) => heading - mean);
    };
    const [before, after] = [turns(2), turns(2.12)];
    /** How alike the later folds are to the earlier ones moved `shift` steps toward the free end. */
    const alike = (shift: number) => {
      let sum = 0;
      for (let column = 6; column < CLOTH.columns - 6; column++) sum += before[column - shift]! * after[column]!;
      return sum;
    };
    expect(Math.max(alike(1), alike(2))).toBeGreaterThan(alike(0));
    expect(alike(0)).toBeGreaterThan(Math.max(alike(-1), alike(-2)));
  });

  it('같은 순간에는 같은 모양이다: 시간을 멈추면 천도 멈춘다', () => {
    const [a, b, later] = [flown(1.7), flown(1.7), flown(2.1)];
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
    expect(Array.from(later.positions)).not.toEqual(Array.from(a.positions));
  });

  it('면마다 향하는 쪽이 있고, 그림은 깃대에서 끝자락까지 한 번 펼쳐진다', () => {
    const { normals, uvs, indices, positions } = flown(1.7);
    for (let index = 0; index < normals.length; index += 3) expect(Math.hypot(normals[index]!, normals[index + 1]!, normals[index + 2]!)).toBeCloseTo(1, 5);
    // 면이 감긴 쪽과 모서리가 향하는 쪽이 같다: 어긋나면 양면 재질이 빛을 뒤집어 받는다.
    for (const time of MOMENTS) expect(facing(flown(time))).toEqual({ out: CLOTH.columns * CLOTH.rows * 2, in: 0 });
    expect(indices.length).toBe(CLOTH.columns * CLOTH.rows * 6);
    expect(Math.max(...indices)).toBe(positions.length / 3 - 1);
    expect([uvs[0], uvs[1]]).toEqual([0, 0]);
    expect([uvs[uvs.length - 2], uvs[uvs.length - 1]]).toEqual([1, 1]);
  });
});

describe('깃발의 빛깔과 글자', () => {
  const { width, height } = CLOTH_TEXELS;
  /** The picture's colour at a spot on the cloth, in metres from the hoist and up from the foot. */
  const texel = (data: Uint8Array, x: number, y: number) => {
    const index = (Math.floor((y / CLOTH.height) * height) * width + Math.floor((x / CLOTH.length) * width)) * 4;
    return [data[index]! / 255, data[index + 1]! / 255, data[index + 2]! / 255] as const;
  };
  const bright = (color: readonly number[]) => color[0]! + color[1]! + color[2]!;
  /** The app's colours for the elements and for itself, as its stylesheet has them by day. */
  const FIELDS: Record<Element | 'none', string> = { wood: '#4fb286', fire: '#f0705a', earth: '#dba63c', metal: '#9aa7bd', water: '#4f93dc', none: '#6a4de0' };
  /** How many texels are in ink. */
  const inked = (data: Uint8Array, field: readonly number[]) => {
    let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index]! + data[index + 1]! + data[index + 2]! < bright(field) * 255 * 0.6) count += 1;
    return count;
  };

  it('오행마다 앱이 정한 빛깔의 이름을 읽고, 집을 짓기 전에는 앱의 빛깔이다', () => {
    expect(ELEMENTS.map(flagToken)).toEqual(['--mg-wood', '--mg-fire', '--mg-earth', '--mg-metal', '--mg-water']);
    expect(flagToken(null)).toBe('--mg-primary');
  });

  it('띠와 원은 바탕을 옅게, 글자는 짙게 한 빛깔이다', () => {
    const colors = clothColors('#4f93dc');
    expect(colors.field[0]).toBeCloseTo(0x4f / 255, 4);
    expect(colors.field[1]).toBeCloseTo(0x93 / 255, 4);
    expect(colors.field[2]).toBeCloseTo(0xdc / 255, 4);
    for (const axis of [0, 1, 2] as const) {
      expect(colors.band[axis]).toBeGreaterThan(colors.field[axis]);
      expect(colors.disc[axis]).toBeGreaterThan(colors.band[axis]);
      expect(colors.ink[axis]).toBeLessThan(colors.field[axis] * 0.5);
    }
  });

  it.each([...ELEMENTS, null])('%s의 깃발: 바탕, 위아래의 옅은 띠, 가운데의 원', (element) => {
    const colors = clothColors(FIELDS[element ?? 'none']);
    const data = paintCloth(colors, element);
    expect(data.length).toBe(width * height * 4);
    // 바탕은 제 빛깔이고(물들인 천이라 조금씩 다르다), 띠는 그보다 옅다.
    const field = texel(data, 2.6, 1);
    for (const axis of [0, 1, 2] as const) expect(Math.abs(field[axis] - colors.field[axis])).toBeLessThan(0.05);
    for (const y of [0.145, CLOTH.height - 0.145]) {
      const band = texel(data, 2.6, y);
      expect(bright(band)).toBeGreaterThan(bright(field) + 0.2);
      for (const axis of [0, 1, 2] as const) expect(Math.abs(band[axis] - colors.band[axis])).toBeLessThan(0.05);
    }
    // 원은 가장 옅고, 깃대 쪽 가장자리의 천도 그렇다.
    expect(bright(texel(data, 1.42 + 0.72 * 0.78, 1.01))).toBeGreaterThan(bright(colors.band));
    expect(bright(texel(data, 0.03, 1))).toBeGreaterThan(bright(colors.band));
    for (let index = 3; index < data.length; index += 4) expect(data[index]).toBe(255);
    // 글자는 오행이 있을 때만 쓴다. 없으면 원은 비어 있고, 먹은 테두리의 가는 줄뿐이다.
    if (element) {
      expect(inked(data, colors.field)).toBeGreaterThan(2500);
    } else {
      expect(inked(data, colors.field)).toBeLessThan(1500);
      const heart = texel(data, 1.42, 1);
      for (const axis of [0, 1, 2] as const) expect(Math.abs(heart[axis] - colors.disc[axis])).toBeLessThan(0.05);
    }
  });

  it('마을만큼 멀리서 보아도 글자의 획이 남는다', () => {
    // 꽉 찬 마을을 창에 맞추면 천 1미터가 열여섯 픽셀쯤이다. 그만큼 줄인 그림에서 획은 픽셀을 온전히 덮을 만큼 굵어야
    // 한다: 픽셀 하나를 다 채우지 못하는 획은 원의 빛깔에 섞여 얼룩으로 남는다.
    const scale = 16;
    const [wide, tall] = [CLOTH.length * scale, CLOTH.height * scale];
    for (const element of ELEMENTS) {
      const colors = clothColors(FIELDS[element]);
      const data = paintCloth(colors, element);
      const sums = new Float64Array(wide * tall);
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const pixel = Math.floor((row * tall) / height) * wide + Math.floor((column * wide) / width);
          sums[pixel]! += data[(row * width + column) * 4]! + data[(row * width + column) * 4 + 1]! + data[(row * width + column) * 4 + 2]!;
        }
      }
      const texels = (width / wide) * (height / tall) * 255;
      // 먹이 아홉 푼 넘게 덮은 픽셀.
      const solid = Array.from(sums).filter((sum) => sum / texels < bright(colors.ink) + (bright(colors.disc) - bright(colors.ink)) * 0.1).length;
      expect(solid).toBeGreaterThan(40);
    }
  });

  it('다섯 글자는 서로 다르다', () => {
    const colors = clothColors('#4f93dc');
    const marks = ELEMENTS.map((element) => {
      const data = paintCloth(colors, element);
      return Array.from({ length: width * height }, (_, index) => data[index * 4]! + data[index * 4 + 1]! + data[index * 4 + 2]! < bright(colors.field) * 255 * 0.6);
    });
    for (const [index, mark] of marks.entries()) {
      for (const other of marks.slice(index + 1)) expect(mark.filter((ink, texelIndex) => ink !== other[texelIndex]).length).toBeGreaterThan(800);
    }
  });
});

describe('오색 깃발 줄', () => {
  const corners = (positions: Float32Array) => pointsIn(positions);
  const hung = (time: number) => {
    const bunting = buntingShape();
    flutter(time, bunting.positions, bunting.normals);
    return bunting;
  };
  const far = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('말뚝은 다섯이고 고르게 둘러서며, 깃발이 나부끼는 쪽은 비워 둔다', () => {
    expect(POSTS).toHaveLength(5);
    const bearings = POSTS.map(([x, , z]) => Math.atan2(z, x));
    const reach = Math.hypot(POSTS[0]![0], POSTS[0]![2]);
    for (const [x, y, z] of POSTS) {
      expect(Math.hypot(x, z)).toBeCloseTo(reach, 6);
      expect(y).toBe(POSTS[0]![1]);
    }
    // 천은 깃대에서 바람 쪽으로 뻗는다: 처음 순간의 천 끝이 그 방향이다.
    const cloth = clothShape();
    const tip = pointsIn(cloth.positions)[CLOTH.columns]!;
    const wind = Math.atan2(tip[2], tip[0]);
    for (const bearing of bearings) {
      const apart = Math.abs(((bearing - wind + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      expect(apart).toBeGreaterThan((25 * Math.PI) / 180);
    }
  });

  it('줄은 깃대 끝에서 말뚝까지 이어지고, 그 두 끝은 움직이지 않는다', () => {
    const [first, later] = [corners(hung(0).positions), corners(hung(5.3).positions)];
    const head: Point = [0, Math.max(...first.map(([, y]) => y)), 0];
    for (const end of [head, ...POSTS]) {
      const made = first.flatMap((corner, index) => (far(corner, end as Point) < 0.05 ? [index] : []));
      expect(made.length).toBeGreaterThanOrEqual(3);
      for (const index of made) expect(later[index]).toEqual(first[index]);
    }
    // 그 사이는 처지고, 바람에 조금 밀린다.
    expect(later).not.toEqual(first);
  });

  it('줄은 곧게 당겨지지 않고 제 무게로 처진다', () => {
    const all = corners(hung(0).positions);
    const rope = all.slice(0, all.length - PENNANTS * 3);
    const head: Point = [0, Math.max(...all.map(([, y]) => y)), 0];
    for (const post of POSTS) {
      const run = [post[0] - head[0], post[1] - head[1], post[2] - head[2]] as const;
      let deepest = 0;
      for (const corner of rope) {
        // 두 끝을 곧게 이은 선에서 이 모서리가 벗어난 만큼: 줄 한가운데 언저리만 본다.
        const along = ((corner[0] - head[0]) * run[0] + (corner[1] - head[1]) * run[1] + (corner[2] - head[2]) * run[2]) / (run[0] ** 2 + run[1] ** 2 + run[2] ** 2);
        const off = [0, 1, 2].map((axis) => corner[axis]! - head[axis]! - run[axis]! * along);
        const away = Math.hypot(off[0]!, off[1]!, off[2]!);
        if (along < 0.35 || along > 0.65 || away > 0.5) continue;
        expect(off[1]).toBeLessThan(0);
        deepest = Math.max(deepest, away);
      }
      expect(deepest).toBeGreaterThan(0.15);
      expect(deepest).toBeLessThan(0.4);
    }
  });

  it('작은 깃발은 깃대에 닿지 않게 걸린다', () => {
    // 한참을 촘촘히 본다: 바람을 마주한 줄은 줄째 깃대 쪽으로 밀리고, 그 줄의 깃발은 옆으로 비키지 않는다.
    const bunting = buntingShape();
    const first = bunting.positions.length / 3 - PENNANTS * 3;
    let nearest = Infinity;
    for (let time = 0; time < 60; time += 0.05) {
      flutter(time, bunting.positions, bunting.normals);
      const flags = corners(bunting.positions).slice(first);
      for (const [index, [px, , pz]] of flags.entries()) {
        // 세모의 변이 깃대의 한가운데에서 떨어진 만큼, 땅에서 본 대로.
        const [qx, , qz] = flags[index - (index % 3) + ((index + 1) % 3)]!;
        const [dx, dz] = [qx - px, qz - pz];
        const along = Math.min(1, Math.max(0, -(px * dx + pz * dz) / (dx * dx + dz * dz)));
        nearest = Math.min(nearest, Math.hypot(px + dx * along, pz + dz * along));
      }
    }
    // 깃발이 걸리는 높이에서 대나무의 굵기는 반지름 6센티미터쯤이다.
    expect(nearest).toBeGreaterThan(0.09);
  });

  it('작은 깃발은 큰 깃발의 천을 뚫지 않는다', () => {
    const cloth = clothShape();
    const bunting = buntingShape();
    const first = bunting.positions.length / 3 - PENNANTS * 3;
    const pierced = new Set<number>();
    for (let time = 0; time < 60; time += 0.05) {
      fly(time, cloth.positions, cloth.normals);
      flutter(time, bunting.positions, bunting.normals);
      const sheet = corners(cloth.positions);
      const flags = corners(bunting.positions).slice(first);
      const low = Math.min(...sheet.map(([, y]) => y));
      for (let pennant = 0; pennant < PENNANTS; pennant++) {
        const [a, b, c] = [flags[pennant * 3]!, flags[pennant * 3 + 1]!, flags[pennant * 3 + 2]!];
        // 천보다 아래에 걸린 깃발은 천에 닿을 수 없다.
        if (Math.max(a[1], b[1], c[1]) < low) continue;
        for (let face = 0; face < cloth.indices.length; face += 3) {
          const [s, t, u] = [sheet[cloth.indices[face]!]!, sheet[cloth.indices[face + 1]!]!, sheet[cloth.indices[face + 2]!]!];
          // 높이나 동서로 떨어져 있는 면은 볼 것도 없다.
          if ([0, 1].some((axis) => Math.min(s[axis]!, t[axis]!, u[axis]!) > Math.max(a[axis]!, b[axis]!, c[axis]!) || Math.max(s[axis]!, t[axis]!, u[axis]!) < Math.min(a[axis]!, b[axis]!, c[axis]!))) continue;
          // 세모의 변이 천의 면을 지나거나, 천의 변이 세모를 지난다.
          if (crosses(a, b, s, t, u) || crosses(b, c, s, t, u) || crosses(c, a, s, t, u) || crosses(s, t, a, b, c) || crosses(t, u, a, b, c) || crosses(u, s, a, b, c)) pierced.add(pennant);
        }
      }
    }
    expect([...pierced]).toEqual([]);
  });

  it('줄마다 깃대 끝에서 말뚝까지 한 가닥 실이 따라간다', () => {
    // 멀리서는 줄이 픽셀 하나보다 가늘어 점으로 흩어진다. 같은 모서리를 이은 실은 얼마나 멀든 이어져 그려진다.
    const { positions, threads } = hung(3.3);
    const all = corners(positions);
    expect(Math.max(...threads)).toBeLessThan(all.length - PENNANTS * 3);
    /** Each piece of thread, by the corner it starts from. */
    const next = new Map(Array.from({ length: threads.length / 2 }, (_, piece) => [threads[piece * 2]!, threads[piece * 2 + 1]!]));
    const head: Point = [0, Math.max(...all.map(([, y]) => y)), 0];
    const starts = [...next.keys()].filter((corner) => far(all[corner]!, head) < 0.05);
    expect(starts).toHaveLength(POSTS.length);
    const ends = starts.map((start) => {
      let [at, pieces] = [start, 0];
      for (let to = next.get(at); to !== undefined; to = next.get(at)) {
        // 토막마다 짧고, 아래로 내려간다.
        expect(far(all[at]!, all[to]!)).toBeLessThan(0.8);
        expect(all[to]![1]).toBeLessThan(all[at]![1]);
        at = to;
        pieces += 1;
      }
      expect(pieces).toBeGreaterThan(8);
      return all[at]!;
    });
    // 가닥마다 제 말뚝에서 끝난다.
    for (const post of POSTS) expect(ends.some((end) => far(end, post as Point) < 0.05)).toBe(true);
  });

  it('줄과 깃발의 면은 감긴 쪽으로 향한다', () => {
    for (const time of MOMENTS) {
      const bunting = hung(time);
      const rope = bunting.indices.length - PENNANTS * 3;
      const lines = facing(bunting, 0, rope);
      expect(lines.out).toBeGreaterThan(100);
      expect(lines.in).toBe(0);
      expect(facing(bunting, rope)).toEqual({ out: PENNANTS, in: 0 });
    }
  });

  it('깃발은 세모꼴이고, 나부껴도 크기는 그대로다', () => {
    expect(PENNANTS).toBeGreaterThan(40);
    const sizes = [0, 1.7, 6.2].map((time) => {
      const { positions, normals } = hung(time);
      const all = corners(positions);
      const flags = all.slice(all.length - PENNANTS * 3);
      const facing = corners(normals).slice(all.length - PENNANTS * 3);
      return Array.from({ length: PENNANTS }, (_, index) => {
        const [a, b, c] = [flags[index * 3]!, flags[index * 3 + 1]!, flags[index * 3 + 2]!];
        expect(far(facing[index * 3]!, [0, 0, 0])).toBeCloseTo(1, 5);
        return { wide: far(a, b), fall: far(c, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]) };
      });
    });
    for (const [index, { wide, fall }] of sizes[0]!.entries()) {
      expect(wide).toBeGreaterThan(0.2);
      expect(wide).toBeLessThan(0.34);
      for (const other of sizes.slice(1)) {
        expect(other[index]!.fall).toBeCloseTo(fall, 6);
        expect(other[index]!.wide).toBeCloseTo(wide, 2);
      }
    }
  });

  it('깃발은 다섯 빛깔을 차례로 입는다', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'];
    const tints = buntingColors(colors, '#000000');
    const { positions } = buntingShape();
    expect(tints.length).toBe(positions.length);
    const flags = tints.slice(tints.length - PENNANTS * 9);
    expect(Array.from(tints.slice(0, tints.length - PENNANTS * 9)).every((value) => value === 0)).toBe(true);
    const worn = new Map<string, number>();
    for (let index = 0; index < PENNANTS; index++) {
      const [a, b, c] = [0, 3, 6].map((corner) => Array.from(flags.slice(index * 9 + corner, index * 9 + corner + 3)).join());
      expect(b).toBe(a);
      expect(c).toBe(a);
      worn.set(a!, (worn.get(a!) ?? 0) + 1);
    }
    expect(worn.size).toBe(5);
    for (const count of worn.values()) expect(count).toBeGreaterThanOrEqual(Math.floor(PENNANTS / 5) - 3);
  });

  it('같은 순간에는 같은 자리다', () => {
    expect(Array.from(hung(1.7).positions)).toEqual(Array.from(hung(1.7).positions));
    expect(Array.from(hung(1.7).normals)).toEqual(Array.from(hung(1.7).normals));
  });
});

describe('포인터가 닿는 겉틀', () => {
  const { cone, cloth } = HULL;
  /** Whether a point of the island, about its middle, is inside the hull: in the cone as its flat sides bound it, or in the cloth's box. */
  const inside = ([x, y, z]: Point) => {
    const inCone = y >= cone.foot && y <= cone.tip && Math.hypot(x, z) <= ((cone.radius * (cone.tip - y)) / (cone.tip - cone.foot)) * Math.cos(Math.PI / cone.sides);
    // The box lies down the wind: turned back, how far along it and across it the point is.
    const along = x * Math.cos(cloth.turn) - z * Math.sin(cloth.turn);
    const across = x * Math.sin(cloth.turn) + z * Math.cos(cloth.turn);
    return inCone || (along >= 0 && along <= cloth.length && Math.abs(across) <= cloth.half && y >= cloth.foot && y <= cloth.head);
  };
  /** The nine plots of a village, and the ways the camera looks across it as a drag turns it from one side to the other. */
  const plots = [-PLOT_REACH, 0, PLOT_REACH].flatMap((x) => [-PLOT_REACH, 0, PLOT_REACH].map((z) => ({ x, z })));
  const views = Array.from({ length: 33 }, (_, index) => {
    const azimuth = AZIMUTH - MAX_TURN + (index / 32) * 2 * MAX_TURN;
    return [-Math.cos(ELEVATION) * Math.sin(azimuth), -Math.sin(ELEVATION), -Math.cos(ELEVATION) * Math.cos(azimuth)] as const;
  });
  /** Whether the camera, at some turn, sees the island's point `local` with a home's box behind it. */
  const beforeHome = (local: Point) => {
    const from = [local[0] + FLAG_SPOT.x, local[1], local[2] + FLAG_SPOT.z] as const;
    return views.some((view) =>
      plots.some(({ x, z }) => {
        const middle = [x, HOME_BOX.up, z] as const;
        let [enters, leaves] = [0, Infinity];
        for (const axis of [0, 1, 2] as const) {
          const [one, other] = [(middle[axis] - HOME_BOX.half[axis] - from[axis]) / view[axis], (middle[axis] + HOME_BOX.half[axis] - from[axis]) / view[axis]];
          enters = Math.max(enters, Math.min(one, other));
          leaves = Math.min(leaves, Math.max(one, other));
        }
        return enters <= leaves;
      }),
    );
  };

  it('천과 깃발 줄은 나부껴도 겉틀을 벗어나지 않는다', () => {
    const sheet = clothShape();
    const bunting = buntingShape();
    const strays: Point[] = [];
    for (let time = 0; time < 120; time += 0.25) {
      fly(time, sheet.positions, sheet.normals);
      flutter(time, bunting.positions, bunting.normals);
      for (const point of [...pointsIn(sheet.positions), ...pointsIn(bunting.positions)]) if (!inside(point)) strays.push(point);
    }
    expect(strays).toEqual([]);
  });

  it('집 앞에 그려질 수 있는 것은 모두 겉틀 안에 있다', () => {
    // 카메라를 동쪽으로 돌리면 깃발 섬이 동쪽 집 앞에 선다. 그때 집의 상자를 가리는 것이 겉틀 밖에 있으면 그것을 누른
    // 포인터가 뒤의 집으로 간다.
    const { corners } = pointsOf(buildFlagIsland());
    const standing = corners.filter(beforeHome);
    // 깃대의 윗부분이 그렇다. 땅과 마당, 솔과 선착장은 어느 쪽에서 보아도 집을 가리지 않는다.
    expect(standing.length).toBeGreaterThan(100);
    expect(Math.min(...standing.map(([, y]) => y))).toBeGreaterThan(3);
    expect(standing.filter((point) => !inside(point))).toEqual([]);
    // 천은 거의 다 가린다.
    const sheet = clothShape();
    fly(1.7, sheet.positions, sheet.normals);
    expect(pointsIn(sheet.positions).filter(beforeHome).length).toBeGreaterThan(CLOTH.columns * CLOTH.rows * 0.5);
  });

  it('겉틀은 섬과 깃발보다 크지 않다', () => {
    // 겉틀이 가리는 것은 깃발 섬뿐이어야 한다: 물 위로 드러난 섬보다 넓지 않고, 깃대 끝 위로 한 뼘을 넘지 않는다.
    const { corners } = pointsOf(buildFlagIsland());
    expect(cone.radius).toBeLessThan(Math.max(...corners.filter(([, y]) => y > cone.foot).map(([x, , z]) => Math.hypot(x, z))));
    expect(cone.tip - Math.max(...corners.map(([, y]) => y))).toBeLessThan(0.2);
    expect(cloth.length).toBeLessThanOrEqual(CLOTH.length);
    expect(cloth.head - cloth.foot).toBeLessThan(CLOTH.height * 1.5);
    expect(cloth.half).toBeLessThan(CLOTH.height / 2);
  });
});

describe('뒤늦게 서는 섬', () => {
  it('호수 밑에서 나와 제자리까지 천천히 올라온다', () => {
    const { corners } = pointsOf(buildFlagIsland());
    const top = Math.max(...corners.map(([, y]) => y));
    // 처음에는 깃대 끝까지 물 밑에 있다.
    expect(top - sunk(0)).toBeLessThan(WATER_LEVEL);
    expect(top - sunk(0)).toBeGreaterThan(WATER_LEVEL - 0.5);
    // 다 올라오면 제자리이고, 그 뒤로도 그대로다.
    expect(sunk(RISE_SECONDS)).toBe(0);
    expect(sunk(RISE_SECONDS + 30)).toBe(0);
    // 한 프레임에 서지 않는다: 일 초 넘게 걸려 오르기만 하고, 한 프레임에 한 뼘을 넘지 않으며, 떠날 때와 닿을 때는 거의 서 있다.
    expect(RISE_SECONDS).toBeGreaterThan(1);
    const frames = Math.round(RISE_SECONDS * 60);
    const steps = Array.from({ length: frames }, (_, frame) => sunk((frame * RISE_SECONDS) / frames) - sunk(((frame + 1) * RISE_SECONDS) / frames));
    for (const step of steps) {
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.2);
    }
    expect(steps[0]).toBeLessThan(0.01);
    expect(steps[frames - 1]).toBeLessThan(0.01);
  });
});
