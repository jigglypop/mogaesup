import { OrthographicCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { AZIMUTH, cameraRange, ELEVATION, frameOf, NO_INSET, onScreen, openArea, stand, turnedExtent, waterDepth, wheelZoom, ZOOM_RANGE, zoomOf, type Inset } from '../scene/frames';
import { WATER_LEVEL } from '../scene/mood';
import { pictureFileName } from '../snapshot';
import { FLAG_SPOT, PLOT_REACH } from '../village';

describe('카메라의 틀', () => {
  it('한 집은 그 섬을 가운데에 둔다', () => {
    const frame = frameOf([{ x: PLOT_REACH, z: 0 }]);
    expect(frame.target).toEqual([PLOT_REACH, 1.5, 0]);
    expect(frame.halfWidth).toBe(8);
    expect(frame.halfHeight).toBe(7);
  });

  it('두 집은 그 사이를 가운데에 두고 둘을 다 담는다', () => {
    const one = frameOf([{ x: 0, z: 0 }]);
    const two = frameOf([{ x: 0, z: 0 }, { x: PLOT_REACH, z: 0 }]);
    expect(two.target).toEqual([PLOT_REACH / 2, 1.5, 0]);
    expect(two.halfWidth).toBeCloseTo(one.halfWidth + (PLOT_REACH / 2) * Math.SQRT1_2, 5);
    expect(two.halfHeight).toBeGreaterThan(one.halfHeight);
  });

  it('마을은 네 방위의 집을 모두 담는다', () => {
    const R = PLOT_REACH;
    const village = frameOf([{ x: 0, z: 0 }, { x: R, z: 0 }, { x: 0, z: R }, { x: -R, z: 0 }, { x: 0, z: -R }]);
    expect(village.target).toEqual([0, 1.5, 0]);
    expect(village.halfWidth).toBeCloseTo(8 + R * Math.SQRT1_2, 5);
    // 화면에서 동쪽 집은 오른쪽 아래, 북쪽 집은 오른쪽 위다.
    expect(onScreen({ x: R, z: 0 }).right).toBeGreaterThan(0);
    expect(onScreen({ x: R, z: 0 }).up).toBeLessThan(0);
    expect(onScreen({ x: 0, z: -R }).right).toBeGreaterThan(0);
    expect(onScreen({ x: 0, z: -R }).up).toBeGreaterThan(0);
  });

  it('화면에 놓이는 자리의 가운데를 본다: 한쪽으로 치우친 마을도 꼭 맞게 담는다', () => {
    const R = PLOT_REACH;
    // 동쪽과 남쪽 집은 화면 아래 양옆이다. 틀은 그 셋이 화면에서 차지하는 만큼만 높다.
    const three = frameOf([{ x: 0, z: 0 }, { x: R, z: 0 }, { x: 0, z: R }]);
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
    expect(frameOf([])).toEqual({ target: [0, 1.5, 0], halfWidth: 8, halfHeight: 7 });
  });

  it('카메라를 돌리면 같은 땅이 화면에 놓이는 대로 틀이 넓어지고 좁아진다', () => {
    const one = frameOf([{ x: 0, z: 0 }]);
    // 한 집은 어느 쪽에서 보아도 같은 크기다.
    for (const turn of [0, 0.7, Math.PI / 2, -2.4]) expect(turnedExtent(one, turn)).toEqual({ halfWidth: 8, halfHeight: 7 });
    // 화면을 가로지르던 두 집은 반의반 바퀴 돌리면 카메라에서 멀어지는 쪽으로 늘어선다.
    const across = Math.cos(Math.PI / 4) * PLOT_REACH;
    const two = frameOf([{ x: -across, z: across }, { x: across, z: -across }]);
    expect(two.halfWidth).toBeCloseTo(8 + PLOT_REACH, 5);
    expect(two.halfHeight).toBeCloseTo(7, 5);
    expect(turnedExtent(two, 0)).toEqual({ halfWidth: two.halfWidth, halfHeight: two.halfHeight });
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

  it('화면에 맞는 배율은 좁은 쪽이 정한다', () => {
    const frame = frameOf([{ x: 0, z: 0 }]);
    expect(zoomOf(frame, 800, 700)).toBe(50);
    expect(zoomOf(frame, 320, 700)).toBe(20);
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
  const cameraOf = (distance: number, far: number, turn = 0) => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1, far);
    stand(camera, TARGET, AZIMUTH + turn, distance);
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
  const fitted = (width: number, height: number, inset: Inset, zoomed = 1, turn = 0) => {
    const R = PLOT_REACH;
    const village = frameOf([-R, 0, R].flatMap((x) => [-R, 0, R].map((z) => ({ x, z }))));
    const open = openArea(width, height, inset);
    return { height, shift: open.y, zoom: zoomOf(turnedExtent(village, turn), open.width, open.height) * zoomed };
  };
  const WIDE: Inset = { top: 74, right: 412, bottom: 68, left: 98 };
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
    const wide = fitted(1440, 900, WIDE);
    expect(cameraRange(wide.height, wide.shift, wide.zoom, DROP, 1)).toEqual({ distance: 120, far: 400 });
    // 휴대폰에 꼭 맞춘 마을도, 가까이 당긴 집도 그렇다.
    const phone = fitted(390, 844, PHONE);
    expect(cameraRange(phone.height, phone.shift, phone.zoom, DROP, 1)).toEqual({ distance: 120, far: 400 });
    expect(cameraRange(900, 3, 54, DROP, 1)).toEqual({ distance: 120, far: 400 });
  });

  it.each([
    ['세운 태블릿에서 패널 옆의 마을', 820, 1180, WIDE, 1, 0],
    ['좁은 창에서 끝까지 물리고 돌린 마을', 721, 900, WIDE, ZOOM_RANGE.min, (40 * Math.PI) / 180],
    ['휴대폰에서 끝까지 물린 마을', 390, 844, PHONE, ZOOM_RANGE.min, 0],
  ] as const)('%s: 캔버스의 아래 끝과 위 끝에 보이는 물까지 그린다', (_, width, height, inset, zoomed, turn) => {
    const { shift, zoom } = fitted(width, height, inset, zoomed, turn);
    const below = (height / 2 - shift) / zoom;
    const above = (height / 2 + shift) / zoom;
    // 늘 서던 자리에서는 아래쪽 물이 카메라 뒤로 넘어가 그려지지 않는다.
    expect(waterAhead(cameraOf(120, 400, turn), -below)).toBeLessThan(1);
    const { distance, far } = cameraRange(height, shift, zoom, DROP, 1);
    expect(distance).toBeGreaterThan(120);
    const camera = cameraOf(distance, far, turn);
    expect(waterAhead(camera, -below)).toBeGreaterThan(1);
    expect(waterAhead(camera, above)).toBeLessThan(far);
    // 보는 점 너머로는 적어도 늘 그리던 만큼 그린다.
    expect(far - distance).toBeGreaterThanOrEqual(280);
  });

  it('위로 멀리까지 보이는 창에서는 먼 쪽도 그만큼 더 그린다', () => {
    const { height, shift, zoom } = fitted(721, 900, WIDE, ZOOM_RANGE.min, (40 * Math.PI) / 180);
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
