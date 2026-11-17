import { OrthographicCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { AZIMUTH, cameraRange, clampTilt, dragShift, ELEVATION, frameOf, NO_INSET, onScreen, openArea, stand, TILT_RANGE, turnedExtent, waterDepth, wheelZoom, ZOOM_RANGE, zoomOf, zoomShift, type Inset } from '../scene/frames';
import { WATER_LEVEL } from '../scene/mood';
import { ISLANDS } from '../scene/terrain';
import { pictureFileName } from '../snapshot';
import { FLAG_SPOT, PLOT_REACH } from '../village';

/** How far an island of each kind reaches across the untouched picture from its middle: its bank, and the shore's stones. */
const WIDE = { home: ISLANDS.home.reach + 0.6, neighbour: ISLANDS.neighbour.reach + 0.6 };

describe('카메라의 틀', () => {
  it('한 집은 그 섬을 가운데에 둔다', () => {
    const frame = frameOf([{ x: PLOT_REACH, z: 0 }]);
    expect(frame.target).toEqual([PLOT_REACH, 1.5, 0]);
    expect(frame.halfWidth).toBeCloseTo(8, 9);
    expect(frame.halfHeight).toBeCloseTo(7, 9);
  });

  it('마을 한가운데의 내 섬은 이웃 섬보다 크게 담는다', () => {
    const mine = frameOf([{ x: 0, z: 0 }]);
    expect(mine.halfWidth).toBeCloseTo(WIDE.home, 9);
    expect(mine.halfHeight).toBeGreaterThan(7.5);
    // 어디에 있든 종류를 알려 주면 그 크기로 담는다.
    expect(frameOf([{ x: PLOT_REACH, z: 0, kind: 'home' }]).halfWidth).toBeCloseTo(WIDE.home, 9);
    expect(frameOf([{ x: 0, z: 0, kind: 'neighbour' }]).halfWidth).toBeCloseTo(WIDE.neighbour, 9);
  });

  it('두 집은 그 사이를 가운데에 두고 둘을 다 담는다', () => {
    const two = frameOf([{ x: 0, z: 0 }, { x: PLOT_REACH, z: 0 }]);
    expect(two.target).toEqual([PLOT_REACH / 2, 1.5, 0]);
    // 더 큰 내 섬이 어느 쪽 끝에든 올 수 있으니 양쪽에 그만큼 둔다.
    expect(two.halfWidth).toBeCloseTo(WIDE.home + (PLOT_REACH / 2) * Math.SQRT1_2, 5);
    expect(two.halfHeight).toBeGreaterThan(frameOf([{ x: 0, z: 0 }]).halfHeight);
  });

  it('마을은 네 방위의 집을 모두 담는다', () => {
    const R = PLOT_REACH;
    const village = frameOf([{ x: 0, z: 0 }, { x: R, z: 0 }, { x: 0, z: R }, { x: -R, z: 0 }, { x: 0, z: -R }]);
    expect(village.target).toEqual([0, 1.5, 0]);
    // 가운데의 내 섬은 어느 쪽으로 돌려도 가장자리에 오지 않는다: 가장자리는 이웃 섬의 크기로 담는다.
    expect(village.halfWidth).toBeCloseTo(8 + R * Math.SQRT1_2, 5);
    expect(village.reach).toBe(ISLANDS.neighbour.reach);
    // 화면에서 동쪽 집은 오른쪽 아래, 북쪽 집은 오른쪽 위다.
    expect(onScreen({ x: R, z: 0 }).right).toBeGreaterThan(0);
    expect(onScreen({ x: R, z: 0 }).up).toBeLessThan(0);
    expect(onScreen({ x: 0, z: -R }).right).toBeGreaterThan(0);
    expect(onScreen({ x: 0, z: -R }).up).toBeGreaterThan(0);
  });

  it('화면에 놓이는 자리의 가운데를 본다: 한쪽으로 치우친 마을도 꼭 맞게 담는다', () => {
    const R = PLOT_REACH;
    // 동쪽과 남쪽 집은 화면 아래 양옆이다. 틀은 그 셋이 화면에서 차지하는 만큼만 높다.
    const three = frameOf([{ x: 0, z: 0, kind: 'neighbour' }, { x: R, z: 0 }, { x: 0, z: R }]);
    expect(three.halfWidth).toBeCloseTo(8 + R * Math.SQRT1_2, 5);
    expect(three.halfHeight).toBeCloseTo(7 + (R * Math.SQRT1_2 * Math.sin(ELEVATION)) / 2, 5);
    // 가운데는 셋의 화면 한가운데에 놓이는 땅이다.
    const centre = onScreen({ x: three.target[0], z: three.target[2] });
    expect(centre.right).toBeCloseTo(0, 5);
    expect(centre.up).toBeCloseTo(-(R * Math.SQRT1_2 * Math.sin(ELEVATION)) / 2, 5);
  });

  it('깃발 섬은 꽉 찬 마을이 화면에 비워 두는 귀퉁이에 있어 틀을 넓히지 않는다', () => {
    const R = PLOT_REACH;
    const full = [-R, 0, R].flatMap((x) => [-R, 0, R].map((z) => ({ x, z })));
    const village = frameOf(full);
    expect(frameOf([...full, FLAG_SPOT])).toEqual(village);
    // 그 섬은 동쪽 집의 기슭 너머에 있다.
    expect(FLAG_SPOT.x - R).toBeGreaterThan(11);
    // 마을이 비어 있으면 깃발 섬까지 담도록 틀이 넓어진다.
    expect(frameOf([{ x: 0, z: 0 }, FLAG_SPOT]).halfWidth).toBeGreaterThan(frameOf([{ x: 0, z: 0 }]).halfWidth);
  });

  it('집이 없어도 틀은 있다', () => {
    const empty = frameOf([]);
    expect(empty.target).toEqual([0, 1.5, 0]);
    expect(empty.halfWidth).toBeCloseTo(8, 9);
    expect(empty.halfHeight).toBeCloseTo(7, 9);
  });

  it('카메라를 돌리면 같은 땅이 화면에 놓이는 대로 틀이 넓어지고 좁아진다', () => {
    const one = frameOf([{ x: 0, z: 0 }]);
    // 한 집은 어느 쪽에서 보아도 같은 크기다.
    for (const turn of [0, 0.7, Math.PI / 2, -2.4, 9]) expect(turnedExtent(one, turn)).toEqual({ halfWidth: one.halfWidth, halfHeight: one.halfHeight });
    // 화면을 가로지르던 두 집은 반의반 바퀴 돌리면 카메라에서 멀어지는 쪽으로 늘어선다.
    const across = Math.cos(Math.PI / 4) * PLOT_REACH;
    const two = frameOf([{ x: -across, z: across }, { x: across, z: -across }]);
    expect(two.halfWidth).toBeCloseTo(8 + PLOT_REACH, 5);
    expect(two.halfHeight).toBeCloseTo(7, 5);
    expect(turnedExtent(two, 0).halfWidth).toBeCloseTo(two.halfWidth, 9);
    expect(turnedExtent(two, 0).halfHeight).toBeCloseTo(two.halfHeight, 9);
    const quarter = turnedExtent(two, Math.PI / 2);
    expect(quarter.halfWidth).toBeCloseTo(8, 5);
    expect(quarter.halfHeight).toBeCloseTo(7 + PLOT_REACH * Math.sin(ELEVATION), 5);
    // 반 바퀴면 처음과 같고, 어느 쪽으로 돌리든 같다.
    expect(turnedExtent(two, Math.PI).halfWidth).toBeCloseTo(two.halfWidth, 5);
    expect(turnedExtent(two, -0.6)).toEqual(turnedExtent(two, 0.6));
    // 그 사이에서는 두 집이 다 들어오도록 넉넉하다.
    const eighth = turnedExtent(two, Math.PI / 4);
    expect(eighth.halfWidth).toBeGreaterThan(8 + PLOT_REACH * Math.SQRT1_2 - 1e-9);
    expect(eighth.halfHeight).toBeGreaterThan(7 + PLOT_REACH * Math.SQRT1_2 * Math.sin(ELEVATION) - 1e-9);
  });

  it('카메라를 세우면 땅이 화면에서 길어지고, 눕히면 서 있는 것이 길어진다', () => {
    const one = frameOf([{ x: PLOT_REACH, z: 0 }]);
    const R = PLOT_REACH;
    const village = frameOf([-R, 0, R].flatMap((x) => [-R, 0, R].map((z) => ({ x, z }))));
    // 섬의 너비는 기울기와 상관없다.
    for (const tilt of [TILT_RANGE.min, ELEVATION, TILT_RANGE.max]) expect(turnedExtent(one, 0.4, tilt).halfWidth).toBeCloseTo(one.halfWidth, 9);
    // 거의 내려다보면 섬의 땅이 그대로 보이고, 낮게 보면 나무와 둑이 더 차지한다.
    const high = turnedExtent(one, 0, TILT_RANGE.max).halfHeight;
    const low = turnedExtent(one, 0, TILT_RANGE.min).halfHeight;
    expect(high).toBeGreaterThan(ISLANDS.neighbour.reach * Math.sin(TILT_RANGE.max));
    expect(low).toBeGreaterThan(ISLANDS.neighbour.reach * Math.sin(TILT_RANGE.min));
    // 마을의 깊이는 세울수록 화면에서 길어진다.
    const tilted = [TILT_RANGE.min, ELEVATION, TILT_RANGE.max].map((tilt) => turnedExtent(village, 0.3, tilt).halfHeight);
    expect(tilted[0]!).toBeLessThan(tilted[1]!);
    expect(tilted[1]!).toBeLessThan(tilted[2]!);
    // 처음 기울기에서는 처음 틀 그대로다.
    expect(turnedExtent(village, 0, ELEVATION).halfHeight).toBeCloseTo(village.halfHeight, 9);
    expect(onScreen({ x: R, z: 0 }, ELEVATION)).toEqual(onScreen({ x: R, z: 0 }));
    expect(onScreen({ x: R, z: 0 }, TILT_RANGE.max).up).toBeLessThan(onScreen({ x: R, z: 0 }).up);
  });

  it('기울기는 15도에서 80도 사이다', () => {
    expect(clampTilt(0)).toBe(TILT_RANGE.min);
    expect(clampTilt(Math.PI / 2)).toBe(TILT_RANGE.max);
    expect(clampTilt(ELEVATION)).toBe(ELEVATION);
    expect((TILT_RANGE.min * 180) / Math.PI).toBeCloseTo(15, 9);
    expect((TILT_RANGE.max * 180) / Math.PI).toBeCloseTo(80, 9);
  });

  it('화면에 맞는 배율은 좁은 쪽이 정한다', () => {
    const frame = frameOf([{ x: PLOT_REACH, z: 0 }]);
    expect(zoomOf(frame, 800, 700)).toBeCloseTo(50, 9);
    expect(zoomOf(frame, 320, 700)).toBeCloseTo(20, 9);
  });
});

describe('손으로 옮기는 카메라', () => {
  const TARGET = [3, 1.5, -2] as const;
  /** A camera as the look stands it, `zoom` pixels a metre, turned and tilted, over a canvas 1440 by 900. */
  const cameraOf = (azimuth: number, tilt: number, zoom: number, target: readonly [number, number, number] = TARGET) => {
    const camera = new OrthographicCamera(-720, 720, 450, -450, 1, 600);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    stand(camera, target, azimuth, 120, tilt);
    return camera;
  };
  /** Where a point of the world falls on that canvas, in pixels from its top left. */
  const pixel = (camera: OrthographicCamera, point: Vector3) => {
    const at = point.clone().project(camera);
    return { x: (at.x * 0.5 + 0.5) * 1440, y: (-at.y * 0.5 + 0.5) * 900 };
  };
  /** The point of the level `height` up that the canvas shows at a pixel. */
  const under = (camera: OrthographicCamera, x: number, y: number, height: number) => {
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((x / 1440) * 2 - 1, -(y / 900) * 2 + 1), camera);
    return ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -height), new Vector3())!;
  };

  it('카메라는 돌린 방향에서 기운 만큼 내려다본다', () => {
    for (const tilt of [TILT_RANGE.min, ELEVATION, TILT_RANGE.max]) {
      for (const azimuth of [AZIMUTH, AZIMUTH + 2, AZIMUTH - 7]) {
        const camera = cameraOf(azimuth, tilt, 20);
        const look = camera.getWorldDirection(new Vector3());
        expect(Math.asin(-look.y)).toBeCloseTo(tilt, 9);
        expect(Math.atan2(-look.x, -look.z)).toBeCloseTo(Math.atan2(Math.sin(azimuth), Math.cos(azimuth)), 9);
      }
    }
  });

  it('끄는 손 밑의 땅은 손을 따라간다: 어느 방향, 어느 기울기에서도', () => {
    for (const [azimuth, tilt] of [[AZIMUTH, ELEVATION], [AZIMUTH + 2.5, TILT_RANGE.min], [AZIMUTH - 4, TILT_RANGE.max]] as const) {
      const zoom = 18;
      const before = cameraOf(azimuth, tilt, zoom);
      const spot = under(before, 500, 300, TARGET[1]);
      const shift = dragShift(40, -25, zoom, azimuth, tilt);
      const after = cameraOf(azimuth, tilt, zoom, [TARGET[0] + shift.x, TARGET[1], TARGET[2] + shift.z]);
      const moved = pixel(after, spot);
      expect(moved.x).toBeCloseTo(540, 6);
      expect(moved.y).toBeCloseTo(275, 6);
    }
  });

  it('휠은 포인터 밑의 땅을 그 자리에 둔 채 당긴다', () => {
    const [azimuth, tilt] = [AZIMUTH + 1.1, 0.9];
    const before = cameraOf(azimuth, tilt, 15);
    const spot = under(before, 1200, 150, TARGET[1]);
    const shift = zoomShift({ x: spot.x, z: spot.z }, { x: TARGET[0], z: TARGET[2] }, 1, 1.6);
    const after = cameraOf(azimuth, tilt, 15 * 1.6, [TARGET[0] + shift.x, TARGET[1], TARGET[2] + shift.z]);
    const kept = pixel(after, spot);
    expect(kept.x).toBeCloseTo(1200, 6);
    expect(kept.y).toBeCloseTo(150, 6);
    // 가운데에서는 옮기지 않는다.
    expect(zoomShift({ x: TARGET[0], z: TARGET[2] }, { x: TARGET[0], z: TARGET[2] }, 1, 2)).toEqual({ x: 0, z: 0 });
  });
});

describe('패널이 남기는 자리', () => {
  it('패널이 덮은 만큼을 뺀 크기와, 그 가운데가 캔버스 가운데에서 비낀 만큼이다', () => {
    // 넓은 창: 위 막대, 왼쪽 레일, 오른쪽 패널, 아래 독.
    expect(openArea(1440, 900, { top: 74, right: 412, bottom: 68, left: 98 })).toEqual({ x: -157, y: 3, width: 930, height: 758 });
    expect(openArea(390, 844, NO_INSET)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  });

  it('그림을 놓을 틈이 남지 않으면 그 방향은 캔버스 전체에 맞춘다', () => {
    // 작은 창에서 패널을 열면 위 막대와 독 사이가 한 픽셀이거나 그보다도 없다.
    expect(openArea(667, 375, { top: 58, right: 0, bottom: 316, left: 0 })).toEqual({ x: 0, y: 0, width: 667, height: 375 });
    expect(openArea(568, 320, { top: 58, right: 0, bottom: 291, left: 0 })).toEqual({ x: 0, y: 0, width: 568, height: 320 });
    // 틈이 없는 방향만 그렇다.
    expect(openArea(300, 800, { top: 74, right: 150, bottom: 68, left: 98 })).toEqual({ x: 0, y: 3, width: 300, height: 658 });
    // 좁아도 그림이 들어가는 띠는 그대로 쓴다.
    expect(openArea(568, 320, { top: 58, right: 0, bottom: 192, left: 0 })).toEqual({ x: 0, y: -67, width: 568, height: 70 });
    // 그릴 자리가 아예 없는 캔버스에서도 배율은 0이 되지 않는다.
    expect(openArea(0, 0, NO_INSET)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('휠로 당기는 배율', () => {
  it('휠 한 칸은 조금 당기고, 트랙패드 핀치의 잔걸음은 같은 길이에 더 많이 당긴다', () => {
    expect(wheelZoom(-100, false)).toBeCloseTo(Math.exp(0.16), 10);
    expect(wheelZoom(100, false)).toBeCloseTo(Math.exp(-0.16), 10);
    expect(wheelZoom(-4, true)).toBeCloseTo(Math.exp(0.048), 10);
    expect(wheelZoom(4, true)).toBeCloseTo(Math.exp(-0.048), 10);
    expect(wheelZoom(-4, true)).toBeGreaterThan(wheelZoom(-4, false));
    expect(wheelZoom(0, true)).toBe(1);
  });

  it('ctrl을 누른 채 돌린 마우스 휠 한 칸은 그냥 돌린 한 칸만큼만 당긴다', () => {
    expect(wheelZoom(-100, true)).toBeCloseTo(wheelZoom(-100, false), 10);
    expect(wheelZoom(100, true)).toBeCloseTo(wheelZoom(100, false), 10);
    // 줄 단위로 오는 휠(세 줄, 48픽셀)도 한 칸을 넘지 않는다.
    expect(wheelZoom(-48, true)).toBeCloseTo(wheelZoom(-100, false), 10);
    // 두 칸에 배율의 처음부터 끝까지 가지 않는다.
    expect(wheelZoom(-100, true) ** 2).toBeLessThan(1.5);
    expect(ZOOM_RANGE.max / ZOOM_RANGE.min).toBeGreaterThan(5);
  });
});

describe('카메라가 서는 거리', () => {
  /** The point every frame looks at stands this far over the lake. */
  const TARGET = [0, 1.5, 0] as const;
  const DROP = TARGET[1] - WATER_LEVEL;
  /** The camera as the look stands it: `distance` from the point it looks at, turned `turn` about it. */
  const cameraOf = (distance: number, far: number, turn = 0, tilt = ELEVATION) => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1, far);
    stand(camera, TARGET, AZIMUTH + turn, distance, tilt);
    return camera;
  };
  /** How far in front of `camera` the lake lies where the picture shows it `up` metres above the camera's own line. */
  const waterAhead = (camera: OrthographicCamera, up: number) => {
    const from = new Vector3(0, up, 0).applyMatrix4(camera.matrixWorld);
    return (WATER_LEVEL - from.y) / camera.getWorldDirection(new Vector3()).y;
  };
  /**
   * A canvas with the whole village fitted into what `inset` leaves of it: how tall it is, how far below its middle
   * the village's middle is drawn, and the pixels a metre takes.
   */
  const fitted = (width: number, height: number, inset: Inset, zoomed = 1, turn = 0, tilt = ELEVATION) => {
    const R = PLOT_REACH;
    const village = frameOf([-R, 0, R].flatMap((x) => [-R, 0, R].map((z) => ({ x, z }))));
    const open = openArea(width, height, inset);
    return { height, shift: open.y, zoom: zoomOf(turnedExtent(village, turn, tilt), open.width, open.height) * zoomed };
  };
  const PANELS: Inset = { top: 74, right: 412, bottom: 68, left: 98 };
  const PHONE: Inset = { top: 58, right: 0, bottom: 192, left: 0 };

  it('물이 카메라에서 얼마나 먼지는 그림에서 놓이는 높이로 정해진다', () => {
    const camera = cameraOf(120, 400);
    for (const up of [-79, -20, 0, 35, 170]) expect(waterAhead(camera, up)).toBeCloseTo(120 + waterDepth(up, DROP), 9);
    // 돌려 보아도 같다.
    expect(waterAhead(cameraOf(120, 400, 0.6), -50)).toBeCloseTo(120 + waterDepth(-50, DROP), 9);
    // 보는 점 바로 아래의 물은 그 점보다 조금 멀다.
    expect(waterDepth(-DROP * Math.cos(ELEVATION), DROP)).toBeCloseTo(DROP * Math.sin(ELEVATION), 9);
  });

  it('틀이 창을 채우는 화면은 늘 서던 자리에서 그린다', () => {
    const wide = fitted(1440, 900, PANELS);
    expect(cameraRange(wide.height, wide.shift, wide.zoom, DROP, 1)).toEqual({ distance: 120, far: 400 });
    // 휴대폰에 꼭 맞춘 내 섬도, 가까이 당긴 집도 그렇다.
    const phone = openArea(390, 844, PHONE);
    expect(cameraRange(844, phone.y, zoomOf(frameOf([{ x: 0, z: 0 }]), phone.width, phone.height), DROP, 1)).toEqual({ distance: 120, far: 400 });
    expect(cameraRange(900, 3, 54, DROP, 1)).toEqual({ distance: 120, far: 400 });
  });

  it.each([
    ['세운 태블릿에서 패널 옆의 마을', 820, 1180, PANELS, 1, 0, ELEVATION],
    ['좁은 창에서 끝까지 물리고 돌린 마을', 721, 900, PANELS, ZOOM_RANGE.min, (40 * Math.PI) / 180, ELEVATION],
    ['휴대폰에서 끝까지 물린 마을', 390, 844, PHONE, ZOOM_RANGE.min, 0, ELEVATION],
    ['물 위로 낮게 눕혀 뒤로 돌린 마을', 1440, 900, PANELS, ZOOM_RANGE.min, Math.PI, TILT_RANGE.min],
  ] as const)('%s: 캔버스의 아래 끝과 위 끝에 보이는 물까지 그린다', (_, width, height, inset, zoomed, turn, tilt) => {
    const { shift, zoom } = fitted(width, height, inset, zoomed, turn, tilt);
    const below = (height / 2 - shift) / zoom;
    const above = (height / 2 + shift) / zoom;
    // 늘 서던 자리에서는 아래쪽 물이 카메라 뒤로 넘어가 그려지지 않는다.
    expect(waterAhead(cameraOf(120, 400, turn, tilt), -below)).toBeLessThan(1);
    const { distance, far } = cameraRange(height, shift, zoom, DROP, 1, tilt);
    expect(distance).toBeGreaterThan(120);
    const camera = cameraOf(distance, far, turn, tilt);
    expect(waterAhead(camera, -below)).toBeGreaterThan(1);
    expect(waterAhead(camera, above)).toBeLessThan(far);
    // 보는 점 너머로는 적어도 늘 그리던 만큼 그린다.
    expect(far - distance).toBeGreaterThan(280 - 1e-9);
  });

  it('거의 내려다보는 카메라는 늘 서던 자리에서 그린다', () => {
    const { height, shift, zoom } = fitted(1440, 900, PANELS, ZOOM_RANGE.min, 0.5, TILT_RANGE.max);
    expect(cameraRange(height, shift, zoom, DROP, 1, TILT_RANGE.max)).toEqual({ distance: 120, far: 400 });
  });

  it('위로 멀리까지 보이는 창에서는 먼 쪽도 그만큼 더 그린다', () => {
    const { height, shift, zoom } = fitted(721, 900, PANELS, ZOOM_RANGE.min, (40 * Math.PI) / 180);
    expect(waterAhead(cameraOf(120, 400), (height / 2 + shift) / zoom)).toBeGreaterThan(400);
    const { distance, far } = cameraRange(height, shift, zoom, DROP, 1);
    expect(far - distance).toBeGreaterThan(280);
  });

  it('세운 그 자리에서 카메라의 행렬이 맞는다: 도는 동안에도 이름표가 제 섬 위에 놓인다', () => {
    const camera = new OrthographicCamera(-720, 720, 450, -450, 1, 400);
    camera.zoom = 17;
    camera.updateProjectionMatrix();
    stand(camera, TARGET, AZIMUTH, 120);
    // 다음 프레임: 끄는 손을 따라 조금 돌았다.
    stand(camera, TARGET, AZIMUTH + 0.013, 120);
    // 보는 점은 그대로 화면 한가운데다.
    const middle = new Vector3(...TARGET).project(camera);
    expect(middle.x).toBeCloseTo(0, 9);
    expect(middle.y).toBeCloseTo(0, 9);
    // 옆집 이름표가 놓이는 자리는, 그리는 쪽이 행렬을 다시 맞춘 뒤 그 집이 그려지는 자리와 같다.
    const label = new Vector3(PLOT_REACH, 5.9, 0).project(camera);
    camera.updateMatrixWorld();
    const drawn = new Vector3(PLOT_REACH, 5.9, 0).project(camera);
    expect(label.x).toBeCloseTo(drawn.x, 12);
    expect(label.y).toBeCloseTo(drawn.y, 12);
  });
});

describe('저장하는 그림의 이름', () => {
  it('파일 이름에 못 쓰는 글자는 뺀다', () => {
    expect(pictureFileName('가온')).toBe('가온-집.png');
    expect(pictureFileName(' a/b:c*?"<>| ')).toBe('abc-집.png');
    expect(pictureFileName('///')).toBe('사주-집.png');
  });
});
