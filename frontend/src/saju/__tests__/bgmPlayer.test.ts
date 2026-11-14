import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBgmPlayer } from '../bgmPlayer';
import type { Melody } from '../melody';

type Started = { type: string; hz: number; at: number; stop: number };

/** Just enough of Web Audio to see what was scheduled and when. */
function fakeAudio() {
  const started: Started[] = [];
  const state = { now: 0, resumed: 0, closed: 0, created: 0 };
  const node = () => ({ connect: (next: unknown) => next });
  class FakeContext {
    destination = node();
    constructor() {
      state.created += 1;
    }
    get currentTime() {
      return state.now;
    }
    resume() {
      state.resumed += 1;
      return Promise.resolve();
    }
    close() {
      state.closed += 1;
      return Promise.resolve();
    }
    createBiquadFilter() {
      return { ...node(), type: '', frequency: { value: 0 } };
    }
    createGain() {
      return { ...node(), gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
    createOscillator() {
      const sound: Started = { type: '', hz: 0, at: -1, stop: -1 };
      const oscillator = {
        ...node(),
        frequency: {
          set value(hz: number) {
            sound.hz = hz;
          },
        },
        set type(type: string) {
          sound.type = type;
        },
        start(at: number) {
          sound.at = at;
          started.push(sound);
        },
        stop(at: number) {
          sound.stop = at;
        },
      };
      return oscillator;
    }
  }
  return { started, state, FakeContext };
}

/** Two bars of quarter-second steps: a lead note on every step and a bass note under each bar. */
const melody: Melody = {
  title: '시험 가락',
  bpm: 120,
  steps: 8,
  notes: [
    ...Array.from({ length: 8 }, (_, step) => ({ step, length: 1, hz: 400 + step, voice: 'lead' as const })),
    { step: 0, length: 2, hz: 100, voice: 'bass' },
    { step: 4, length: 2, hz: 110, voice: 'bass' },
  ],
};

describe('BGM 재생기', () => {
  let audio: ReturnType<typeof fakeAudio>;
  beforeEach(() => {
    vi.useFakeTimers();
    audio = fakeAudio();
    vi.stubGlobal('AudioContext', audio.FakeContext);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Lets the audio clock and the page's timers run `seconds` together. */
  const pass = (seconds: number) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 0.03) {
      audio.state.now += 0.03;
      vi.advanceTimersByTime(30);
    }
  };

  it('누르기 전에는 소리 장치를 잡지 않고, 재생하면 첫 박부터 조금 앞서 예약한다', () => {
    const player = createBgmPlayer();
    expect(audio.state.created).toBe(0);
    player.play(melody);
    expect(audio.state.created).toBe(1);
    expect(audio.state.resumed).toBe(1);
    // 첫 박의 선율과 베이스.
    expect(audio.started.map((sound) => [sound.type, sound.hz])).toEqual([['square', 400], ['triangle', 100]]);
    expect(audio.started.every((sound) => sound.at > 0 && sound.at < 0.2 && sound.stop > sound.at)).toBe(true);
    player.dispose();
  });

  it('박마다 이어서 예약하고, 끝나면 처음으로 돌아간다', () => {
    const player = createBgmPlayer();
    player.play(melody);
    pass(2.2);
    const lead = audio.started.filter((sound) => sound.type === 'square');
    expect(lead.slice(0, 9).map((sound) => sound.hz)).toEqual([400, 401, 402, 403, 404, 405, 406, 407, 400]);
    // 한 박은 4분의 1초다.
    expect(lead[1]!.at - lead[0]!.at).toBeCloseTo(0.25, 5);
    expect(audio.started.filter((sound) => sound.type === 'triangle').slice(0, 3).map((sound) => sound.hz)).toEqual([100, 110, 100]);
    player.dispose();
  });

  it('멈추면 더 예약하지 않고, 다른 가락으로 바꾸면 첫 박부터 다시 한다', () => {
    const player = createBgmPlayer();
    player.play(melody);
    pass(0.6);
    player.stop();
    const before = audio.started.length;
    pass(1);
    expect(audio.started).toHaveLength(before);

    player.play({ ...melody, notes: [{ step: 0, length: 1, hz: 880, voice: 'lead' }] });
    expect(audio.started.at(-1)).toMatchObject({ hz: 880 });
    // 같은 장치를 다시 쓴다.
    expect(audio.state.created).toBe(1);
    player.dispose();
    expect(audio.state.closed).toBe(1);
  });

  it('잠들었다 깬 탭은 밀린 박을 몰아 치지 않는다', () => {
    const player = createBgmPlayer();
    player.play(melody);
    pass(0.3);
    const before = audio.started.length;
    // 시계만 십 초 흘렀고, 타이머는 그동안 돌지 못했다.
    audio.state.now += 10;
    vi.advanceTimersByTime(30);
    const woke = audio.started.slice(before);
    expect(woke.length).toBeLessThanOrEqual(3);
    expect(woke.every((sound) => sound.at >= audio.state.now)).toBe(true);
    player.dispose();
  });
});
