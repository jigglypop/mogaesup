import { useEffect, useRef, useState } from 'react';

import { createBgmPlayer, type BgmPlayer } from '../bgmPlayer';
import type { Melody } from '../melody';

/**
 * The 미니홈피's BGM player: plays the home's own melody. It keeps playing from one home to the next (the melody
 * changes with the home), rests while the tab is hidden, and stops with the page.
 */
export function Bgm({ melody }: { melody: Melody }) {
  const player = useRef<BgmPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const latest = useRef(melody);
  latest.current = melody;

  useEffect(() => () => player.current?.dispose(), []);
  // Another home's melody takes over from the one that was playing.
  useEffect(() => {
    if (playing) player.current?.play(melody);
  }, [melody, playing]);
  useEffect(() => {
    if (!playing) return undefined;
    const hidden = () => {
      if (document.hidden) player.current?.stop();
      else player.current?.play(latest.current);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [playing]);

  const toggle = () => {
    if (playing) {
      player.current?.stop();
      setPlaying(false);
      return;
    }
    try {
      player.current ??= createBgmPlayer();
      player.current.play(melody);
      setPlaying(true);
    } catch {
      // A browser without Web Audio has no sound to give; the button stays as it was.
    }
  };

  return (
    <div className={`mg-saju-bgm${playing ? ' is-playing' : ''}`} role="group" aria-label="BGM">
      <button type="button" aria-label={playing ? 'BGM 멈춤' : 'BGM 재생'} aria-pressed={playing} onClick={toggle}>
        <svg viewBox="0 0 9 9" width="12" height="12" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true" focusable="false">
          <path d={playing ? 'M1 1h3v7h-3zM5 1h3v7h-3z' : 'M2 1h1v7h-1zM3 2h2v5h-2zM5 3h1v3h-1zM6 4h1v1h-1z'} />
        </svg>
      </button>
      <span className="mg-saju-eq" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="mg-saju-bgm-title">
        <span>{melody.title}</span>
      </span>
    </div>
  );
}
