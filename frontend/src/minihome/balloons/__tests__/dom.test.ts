import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { balloonElement, createBalloonDom, type BalloonDom } from '../dom';

describe('말풍선 층', () => {
  let host: HTMLElement;
  let dom: BalloonDom;
  const balloons = () => [...host.querySelectorAll<HTMLElement>('.mg-balloon')];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    dom = createBalloonDom(host);
  });
  afterEach(() => {
    dom.dispose();
    host.remove();
  });

  it('캔버스 옆에 읽히지 않는 층 하나를 두고, 치우면 함께 사라진다', () => {
    const layer = host.querySelector('.mg-balloon-layer');
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    dom.say('p1', '안녕', 'glass');
    dom.dispose();
    expect(host.querySelector('.mg-balloon-layer, .mg-balloon')).toBeNull();
  });

  it('말한 사람마다 말풍선 하나이고, 새로 말하면 그 자리에서 바뀐다', () => {
    dom.say('p1', '안녕', 'glass');
    dom.say('p2', '반가워', 'cloud');
    dom.say('p1', '또 만나', 'mint');
    expect(balloons().map((element) => [element.dataset['design'], element.querySelector('b')?.textContent])).toEqual([
      ['cloud', '반가워'],
      ['mint', '또 만나'],
    ]);
  });

  it('말은 글자 그대로 넣고 마크업으로 읽지 않는다', () => {
    const line = '<img src=x onerror="alert(1)"><b>굵게</b> & 끝';
    dom.say('p1', line, 'glass');
    const [balloon] = balloons();
    expect(balloon!.querySelector('b')!.textContent).toBe(line);
    expect(balloon!.querySelectorAll('img, b b')).toHaveLength(0);
  });

  it('놓을 때까지 보이지 않고, 꼬리 끝이 그 점에 오며, 반 픽셀 넘게 움직일 때만 다시 쓴다', () => {
    const size = dom.say('p1', '안녕하세요', 'glass');
    const [balloon] = balloons();
    expect(balloon!.style.opacity).toBe('0');
    dom.place('p1', 300, 200, 1);
    expect(balloon!.style.opacity).toBe('');
    expect(balloon!.style.transform).toBe(`translate(${Math.round(300 - size.width / 2)}px, ${Math.round(200 - size.height)}px)`);
    const placed = balloon!.style.transform;
    dom.place('p1', 300.3, 199.8, 1);
    expect(balloon!.style.transform).toBe(placed);
    dom.place('p1', 302, 200, 0.5);
    expect(balloon!.style.transform).not.toBe(placed);
    expect(balloon!.style.opacity).toBe('0.5');
  });

  it('가렸다가 다시 놓으면 보이고, 떠날 때 흐려졌다가 치우면 없어진다', () => {
    dom.say('p1', '안녕', 'heart');
    const [balloon] = balloons();
    dom.place('p1', 10, 10, 1);
    dom.hide('p1');
    expect(balloon!.style.display).toBe('none');
    dom.place('p1', 10, 10, 1);
    expect(balloon!.style.display).toBe('');
    dom.leave('p1');
    expect(balloon!.classList.contains('is-leaving')).toBe(true);
    dom.remove('p1');
    expect(balloons()).toHaveLength(0);
    // A key that was taken away is not an error.
    dom.place('p1', 10, 10, 1);
    dom.hide('p1');
  });

  it('말풍선 하나는 몸·글·꼬리로 된다', () => {
    const element = balloonElement('안녕', 'pixel');
    expect(element.outerHTML).toBe(
      '<span class="mg-balloon" data-design="pixel"><span class="mg-balloon-pop"><span class="mg-balloon-body">' +
        '<b>안녕</b></span><i class="mg-balloon-tail"></i></span></span>',
    );
  });
});
