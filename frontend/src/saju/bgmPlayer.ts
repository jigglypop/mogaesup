import type { Melody, Note } from './melody';

/** How far ahead of the clock notes are handed to the audio thread, and how often the queue is topped up. */
const AHEAD_SECONDS = 0.14;
const TICK_MS = 30;
/** Soft enough to sit under a page: the loudest a voice gets, of full scale. */
const LEVEL = { lead: 0.045, bass: 0.085 } as const;

export type BgmPlayer = {
  /** Starts `melody` from its first bar, or changes to it when another is playing. */
  play(melody: Melody): void;
  stop(): void;
  /** Stops and gives the audio device back. */
  dispose(): void;
};

/**
 * Plays a home's melody as a loop of chip tones (a square lead over a triangle bass), synthesized here: no sound file
 * is fetched. The browser allows it only after a press, so it starts from the widget's play button.
 */
export function createBgmPlayer(): BgmPlayer {
  let context: AudioContext | null = null;
  let output: AudioNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let melody: Melody | null = null;
  let step = 0;
  let at = 0;

  const sound = (audio: AudioContext, out: AudioNode, note: Note, when: number, stepSeconds: number) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const length = note.length * stepSeconds * (note.voice === 'lead' ? 0.82 : 0.96);
    oscillator.type = note.voice === 'lead' ? 'square' : 'triangle';
    oscillator.frequency.value = note.hz;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(LEVEL[note.voice], when + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0006, when + length);
    oscillator.connect(gain).connect(out);
    oscillator.start(when);
    oscillator.stop(when + length + 0.03);
  };

  const fill = () => {
    if (!context || !output || !melody) return;
    const stepSeconds = 60 / melody.bpm / 2;
    // A tab that slept wakes far behind the clock: it picks the loop up from now instead of playing what it missed.
    if (at < context.currentTime) at = context.currentTime + 0.05;
    while (at < context.currentTime + AHEAD_SECONDS) {
      for (const note of melody.notes) if (note.step === step) sound(context, output, note, at, stepSeconds);
      step = (step + 1) % melody.steps;
      at += stepSeconds;
    }
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    melody = null;
  };

  return {
    play(next) {
      if (!context) {
        context = new AudioContext();
        // The square wave's edge is taken off, as a small speaker would.
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2600;
        filter.connect(context.destination);
        output = filter;
      }
      void context.resume();
      melody = next;
      step = 0;
      at = context.currentTime + 0.06;
      if (timer === null) timer = setInterval(fill, TICK_MS);
      fill();
    },
    stop,
    dispose() {
      stop();
      void context?.close();
      context = null;
      output = null;
    },
  };
}
