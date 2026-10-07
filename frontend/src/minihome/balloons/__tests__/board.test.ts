import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBalloonBoard,
  designOfSpeaker,
  HEAD_HEIGHT,
  LEAVE_MS,
  NAME_TAG_HEIGHT,
  OWN_KEY,
  type BalloonBoard,
  type Frame,
  type Point,
} from '../board';
import { balloonAccent, balloonTtl, PERSON_COLORS } from '../designs';
import { createBalloonDom, type BalloonDom, type BalloonSize } from '../dom';

/** A camera looking straight down from far away: one metre is ten pixels, the island's origin at (500, 500). */
const toScreen = ({ x, y, z }: Point) => ({ x: 500 + x * 10, y: 500 + z * 10, distance: 40 - y });
/** The screen those pixels are on. */
const WIDTH = 1000;
const across = (transform: string) => Number(/translate\(([-\d.]+)px, [-\d.]+px\)/.exec(transform)![1]);
const up = (transform: string) => Number(/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(transform)![1]);

describe('말풍선 판', () => {
  let host: HTMLElement;
  let dom: BalloonDom;
  let board: BalloonBoard;
  let places: Map<string, Point | null>;
  let hidden: Set<string>;
  let listener: Point | null;
  let sizes: Map<string, BalloonSize>;
  const element = (key: string) =>
    [...host.querySelectorAll<HTMLElement>('.mg-balloon')].find((balloon) => balloon.dataset['key'] === key);
  const frame = (now: number, changes: Partial<Frame> = {}) =>
    board.frame({
      now,
      delta: 1,
      locate: (key, own) => places.get(own ? 'me' : key) ?? null,
      hidden: (key) => hidden.has(key),
      listener,
      toScreen,
      width: WIDTH,
      ...changes,
    });
  const said = (speech: Record<string, string>, now: number, own: string | null = 'me') =>
    board.hear(new Map(Object.entries(speech)), now, (key) => (key === own ? 'heart' : `design-of-${key}`), own);

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    const real = createBalloonDom(host);
    sizes = new Map();
    // Each balloon carries its speaker, for the test to find it.
    dom = {
      ...real,
      say(key, text, design) {
        const size = real.say(key, text, design);
        const all = host.querySelectorAll<HTMLElement>('.mg-balloon');
        all[all.length - 1]!.dataset['key'] = key;
        sizes.set(key, size);
        return size;
      },
    };
    board = createBalloonBoard(dom);
    places = new Map([
      ['me', { x: 0, y: 0, z: 0 }],
      ['p1', { x: 4, y: 0, z: 0 }],
    ]);
    hidden = new Set();
    listener = { x: 0, y: 0, z: 0 };
  });
  afterEach(() => {
    dom.dispose();
    host.remove();
  });

  it('새 말만 올리고, 같은 말이 그대로 있으면 다시 올리지 않으며, 사라졌다 다시 오면 새 말이다', () => {
    said({ p1: '안녕' }, 0);
    expect([...board.shown()]).toEqual([['p1', { text: '안녕', design: 'design-of-p1', own: false }]]);
    const first = element('p1');
    said({ p1: '안녕' }, 100);
    expect(element('p1')).toBe(first);
    said({ p1: '반가워' }, 200);
    expect(element('p1')).not.toBe(first);
    const second = element('p1');
    said({}, 300);
    said({ p1: '반가워' }, 400);
    expect(element('p1')).not.toBe(second);
    expect(host.querySelectorAll('.mg-balloon')).toHaveLength(1);
  });

  it('내 말은 내 디자인으로, 이름표가 없는 내 머리 바로 위에 둔다', () => {
    said({ me: '나야' }, 0);
    expect(board.shown().get(OWN_KEY)).toEqual({ text: '나야', design: 'heart', own: true });
    const heights: number[] = [];
    frame(10, {
      toScreen: (point) => {
        heights.push(point.y);
        return toScreen(point);
      },
    });
    expect(heights).toEqual([HEAD_HEIGHT]);
    const balloon = element(OWN_KEY)!;
    expect(balloon.style.transform).toMatch(/^translate\(/);
    expect(balloon.style.opacity).toBe('');
  });

  it('방에 다시 들어가 아이디가 바뀌어도 내 새 말은 내 지난 말풍선을 바꾼다', () => {
    said({ me: '나야' }, 0);
    frame(10);
    // Another balloon picked: the room is joined again under a new id, and its map starts empty.
    said({}, 100, 'me-again');
    said({ 'me-again': '새 말풍선이야' }, 200, 'me-again');
    expect([...board.shown()]).toEqual([[OWN_KEY, { text: '새 말풍선이야', design: 'heart', own: true }]]);
    expect(host.querySelectorAll('.mg-balloon')).toHaveLength(1);
  });

  it('같은 거리의 두 말풍선은 새 말이 제자리에 있고 지난 말이 위로 간다', () => {
    places.set('p2', { x: 4, y: 0, z: 0 });
    said({ p1: '먼저 한 말' }, 0);
    said({ p1: '먼저 한 말', p2: '나중에 한 말' }, 50);
    frame(100);
    frame(200);
    const y = (key: string) => Number(/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(element(key)!.style.transform)![1]);
    expect(y('p1')).toBeLessThan(y('p2') - 30);
  });

  it('글자 수만큼 떠 있다가 흐려지고, 다 흐려지면 치운다(방의 만료와 상관없이)', () => {
    const line = '오늘 섬에 놀러 와 줘서 고마워요';
    said({ p1: line }, 0);
    // The room's own entry goes after 2.5 seconds; the balloon stays.
    said({}, 2500);
    frame(balloonTtl(line) - 1);
    expect(element('p1')?.classList.contains('is-leaving')).toBe(false);
    frame(balloonTtl(line));
    expect(element('p1')?.classList.contains('is-leaving')).toBe(true);
    frame(balloonTtl(line) + LEAVE_MS);
    expect(element('p1')).toBeUndefined();
    expect(board.shown().size).toBe(0);
  });

  it('방을 떠난 사람의 말풍선은 그 자리에서 흐려지고, 한 번도 놓이지 않았으면 바로 치운다', () => {
    said({ p1: '안녕', p2: '잘 가' }, 0);
    frame(10);
    places.delete('p1');
    frame(20);
    expect(element('p1')?.classList.contains('is-leaving')).toBe(true);
    expect(element('p2')).toBeUndefined();
  });

  it('게임이 숨긴 사람, 섬 아래로 내려간 사람, 멀리 있는 사람의 말풍선은 가리고, 돌아오면 다시 보인다', () => {
    said({ p1: '안녕' }, 0);
    frame(10);
    hidden.add('p1');
    frame(20);
    expect(element('p1')!.style.display).toBe('none');
    hidden.clear();
    frame(30);
    expect(element('p1')!.style.display).toBe('');
    places.set('p1', { x: 4, y: -500, z: 0 });
    frame(40);
    expect(element('p1')!.style.display).toBe('none');
    places.set('p1', { x: 30, y: 0, z: 0 });
    frame(50);
    expect(element('p1')!.style.display).toBe('none');
    places.set('p1', { x: 21, y: 0, z: 0 });
    frame(60);
    frame(70);
    expect(element('p1')!.style.display).toBe('');
    expect(Number(element('p1')!.style.opacity)).toBeCloseTo(0.5, 1);
  });

  it('카메라 뒤나 화면 밖이면 가린다', () => {
    said({ p1: '안녕' }, 0);
    frame(10, { toScreen: () => null });
    expect(element('p1')!.style.display).toBe('none');
  });

  it('말한 사람을 따라가고, 꼬리 끝은 이름표 위에 온다', () => {
    said({ p1: '안녕' }, 0);
    const heights: number[] = [];
    frame(10, {
      toScreen: (point) => {
        heights.push(point.y);
        return toScreen(point);
      },
    });
    expect(heights).toEqual([NAME_TAG_HEIGHT]);
    const placed = element('p1')!.style.transform;
    places.set('p1', { x: 10, y: 0, z: 0 });
    frame(20, { delta: 0.05 });
    const moving = element('p1')!.style.transform;
    expect(moving).not.toBe(placed);
    frame(30, { delta: 5 });
    expect(element('p1')!.style.transform).not.toBe(moving);
  });

  it('겹치는 두 말풍선은 가까운 것을 두고 먼 것을 그 위로 쌓는다', () => {
    places.set('p1', { x: 0.5, y: 0, z: 0 });
    said({ me: '나야', p1: '나도 여기' }, 0);
    // p1 stands a little further from the camera.
    const screen = (point: Point) => ({ ...toScreen(point), distance: 40 + point.x });
    frame(10, { toScreen: screen });
    frame(20, { toScreen: screen });
    const y = (key: string) => Number(/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(element(key)!.style.transform)![1]);
    // The farther one goes up by more than a balloon's height.
    expect(y('p1')).toBeLessThan(y(OWN_KEY) - 40);
  });

  it('같은 거리에 같은 때 올라온 두 말풍선은 프레임마다 같은 자리이고, 한쪽이 다시 말하면 그 새 말이 아래에 온다', () => {
    places.set('p2', { x: 4, y: 0, z: 0 });
    said({ p1: '하나', p2: '둘' }, 0);
    frame(10);
    const at = () => ['p1', 'p2'].map((key) => up(element(key)!.style.transform));
    const first = at();
    expect(first[0]).not.toBe(first[1]);
    for (const now of [20, 30, 40, 50]) {
      frame(now);
      expect(at()).toEqual(first);
    }
    said({ p1: '하나', p2: '셋' }, 60);
    frame(70);
    frame(80);
    const [one, three] = at();
    expect(three).toBeGreaterThan(one! + 30);
  });

  it('처음 놓이는 말풍선은 쌓인 자리에서 시작한다(겹친 자리에서 미끄러져 오르지 않는다)', () => {
    places.set('p1', { x: 0.5, y: 0, z: 0 });
    const screen = (point: Point) => ({ ...toScreen(point), distance: 40 + point.x });
    said({ me: '나야' }, 0);
    frame(10, { delta: 0.016, toScreen: screen });
    said({ me: '나야', p1: '나도 여기' }, 20);
    frame(30, { delta: 0.016, toScreen: screen });
    expect(up(element('p1')!.style.transform)).toBeLessThan(up(element(OWN_KEY)!.style.transform) - 40);
  });

  it('화면 가장자리에 선 사람의 말풍선은 꼬리째 화면 안으로 들어오고, 가운데 선 사람의 것은 그대로다', () => {
    places.set('p1', { x: -49.6, y: 0, z: 0 });
    places.set('p2', { x: 49.6, y: 0, z: 0 });
    places.set('p3', { x: 0, y: 0, z: 0 });
    said({ p1: '왼쪽 끝이야', p2: '오른쪽 끝이야', p3: '가운데' }, 0);
    // The listener walks to each side in turn (balloons further than 24 m go).
    listener = { x: -45, y: 0, z: 0 };
    frame(10);
    expect(across(element('p1')!.style.transform)).toBe(6);
    listener = { x: 45, y: 0, z: 0 };
    frame(20);
    expect(across(element('p2')!.style.transform) + sizes.get('p2')!.width).toBe(WIDTH - 6);
    listener = { x: 0, y: 0, z: 0 };
    frame(30);
    expect(across(element('p3')!.style.transform)).toBe(Math.round(500 - sizes.get('p3')!.width / 2));
  });

  describe('방에 다시 들어온 사람', () => {
    // The room as the engine keeps it: everyone else by `client_id`, with the colour they joined in and where they stand.
    let players: Map<string, { color: string; at: Point }>;
    const heard = (speech: Record<string, string>, now: number, ownKey: string | null = 'me', ownDesign = 'glass') =>
      board.hear(new Map(Object.entries(speech)), now, designOfSpeaker(ownKey, ownDesign, players), ownKey);
    const inRoom = (now: number) =>
      frame(now, { locate: (key, own) => (own ? places.get('me') : players.get(key)?.at) ?? null });

    beforeEach(() => {
      players = new Map([['p1', { color: balloonAccent('cloud')!, at: { x: 4, y: 0, z: 0 } }]]);
    });

    for (const [why, next] of [
      ['끊겼다 같은 말풍선으로', 'cloud'],
      ['다른 말풍선을 골라', 'heart'],
    ] as const) {
      it(`${why} 다시 들어온 사람의 말은 그 말풍선으로 올리고, 전의 말풍선은 제자리에서 흐려져 하나만 남는다`, () => {
        heard({ p1: '안녕' }, 0);
        inRoom(10);
        expect(board.shown().get('p1')).toEqual({ text: '안녕', design: 'cloud', own: false });
        // Their socket closes (PlayerLeft) and another opens, under a new id, in the colour of the balloon they talk in.
        const { at } = players.get('p1')!;
        players.delete('p1');
        inRoom(20);
        expect(element('p1')?.classList.contains('is-leaving')).toBe(true);
        players.set('p1-again', { color: balloonAccent(next)!, at });
        // The room's map keeps the old line until it runs out; the same words under the new id are a new line.
        heard({ p1: '안녕', 'p1-again': '안녕' }, 30);
        inRoom(20 + LEAVE_MS);
        expect([...board.shown()]).toEqual([['p1-again', { text: '안녕', design: next, own: false }]]);
        expect(host.querySelectorAll('.mg-balloon')).toHaveLength(1);
        expect(element('p1-again')!.dataset['design']).toBe(next);
      });
    }

    it('방의 색이 그 자리에서 바뀌면 떠 있는 말은 제 말풍선 그대로이고, 다음 말부터 새 말풍선이다', () => {
      heard({ p1: '하나' }, 0);
      players.get('p1')!.color = balloonAccent('night')!;
      // The room answering again with the same words is not a new line.
      heard({ p1: '하나' }, 10);
      expect(board.shown().get('p1')?.design).toBe('cloud');
      heard({ p1: '둘' }, 20);
      expect(board.shown().get('p1')).toEqual({ text: '둘', design: 'night', own: false });
      expect(element('p1')!.dataset['design']).toBe('night');
    });

    it('기본 말풍선인 사람(사람마다의 색), 색을 모르는 사람, 아직 상태가 오지 않은 사람은 기본으로 그린다', () => {
      players.set('p2', { color: PERSON_COLORS[3]!, at: { x: 2, y: 0, z: 0 } });
      players.set('p3', { color: 'tomato', at: { x: 3, y: 0, z: 0 } });
      heard({ p2: '안녕', p3: '반가워', p4: '누구게' }, 0);
      for (const key of ['p2', 'p3', 'p4']) expect(board.shown().get(key)?.design).toBe('glass');
    });

    it('내가 다른 말풍선으로 다시 들어가면 떠 있던 내 말은 그대로 두고, 다음 말부터 새 말풍선이며 내 말풍선은 하나다', () => {
      heard({ me: '전에 한 말' }, 0, 'me', 'heart');
      inRoom(10);
      // The page leaves (the room's map empties), joins again under a new id, and the viewer talks in 구름 now.
      heard({}, 100, null, 'cloud');
      heard({}, 200, 'me-2', 'cloud');
      inRoom(210);
      expect([...board.shown()]).toEqual([[OWN_KEY, { text: '전에 한 말', design: 'heart', own: true }]]);
      heard({ 'me-2': '바꿨어' }, 300, 'me-2', 'cloud');
      inRoom(310);
      expect([...board.shown()]).toEqual([[OWN_KEY, { text: '바꿨어', design: 'cloud', own: true }]]);
      expect(host.querySelectorAll('.mg-balloon')).toHaveLength(1);
    });

    it('내 지난 아이디로 방에 남은 말은 남의 말로 그리지 않는다', () => {
      // The island drawn again after the viewer joined again: the room's map still has their last line under the old id,
      // which is nobody in the room now.
      heard({ me: '전에 한 말' }, 0, 'me-2', 'cloud');
      inRoom(10);
      expect(board.shown().size).toBe(0);
      expect(host.querySelectorAll('.mg-balloon')).toHaveLength(0);
    });
  });
});
