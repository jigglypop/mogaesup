import { describe, expect, it } from 'vitest';

import { ELEMENTS, type Element } from '../elements';
import { buildFlagIsland, buntingColors, buntingShape, CLOTH, CLOTH_TEXELS, clothColors, clothShape, flagToken, flutter, fly, paintCloth, PENNANTS, POSTS } from '../scene/flagIsland';
import { ELEVATION, frameOf, onScreen } from '../scene/frames';
import { FLAG_SPOT, ISLAND, PLOT_REACH } from '../village';

/** A home's island is drawn this far out from its middle, its bed under the water included (the ground's own reach). */
const HOME_REACH = 7.4;
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
    for (const y of [0.245, CLOTH.height - 0.245]) {
      const band = texel(data, 2.6, y);
      expect(bright(band)).toBeGreaterThan(bright(field) + 0.2);
      for (const axis of [0, 1, 2] as const) expect(Math.abs(band[axis] - colors.band[axis])).toBeLessThan(0.05);
    }
    // 원은 가장 옅고, 깃대 쪽 가장자리의 천도 그렇다.
    expect(bright(texel(data, 1.42 + 0.56 * 0.78, 1.01))).toBeGreaterThan(bright(colors.band));
    expect(bright(texel(data, 0.03, 1))).toBeGreaterThan(bright(colors.band));
    for (let index = 3; index < data.length; index += 4) expect(data[index]).toBe(255);
    // 글자는 오행이 있을 때만 쓴다. 없으면 원은 비어 있고, 먹은 테두리의 가는 줄뿐이다.
    if (element) {
      expect(inked(data, colors.field)).toBeGreaterThan(2500);
    } else {
      expect(inked(data, colors.field)).toBeLessThan(800);
      const heart = texel(data, 1.42, 1);
      for (const axis of [0, 1, 2] as const) expect(Math.abs(heart[axis] - colors.disc[axis])).toBeLessThan(0.05);
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
    for (const time of MOMENTS) {
      const all = corners(hung(time).positions);
      for (const [x, , z] of all.slice(all.length - PENNANTS * 3)) expect(Math.hypot(x, z)).toBeGreaterThan(0.07);
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
