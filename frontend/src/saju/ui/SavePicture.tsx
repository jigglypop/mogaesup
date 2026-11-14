import { useEffect, useRef, useState } from 'react';

import { Icon } from '../../ui/icons';
import type { Profile } from '../profile';
import { Snapshot } from '../scene/Snapshot';
import { composePicture, pictureFileName, saveBlob } from '../snapshot';

/** How long the picture may take to draw before the attempt is given up. */
const DRAW_WAIT_MS = 15_000;
const SAVED_MS = 2_400;

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * 내 집 이미지 저장하기: draws the home on its island on a square canvas off the page, puts its name under it, and saves
 * the picture as a PNG.
 */
export function SavePicture({ name, profile }: { name: string; profile: Profile }) {
  const [state, setState] = useState<'idle' | 'drawing' | 'saved' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const settle = (next: 'saved' | 'failed') => {
    if (timer.current) clearTimeout(timer.current);
    setState(next);
    timer.current = setTimeout(() => setState('idle'), SAVED_MS);
  };
  const start = () => {
    setState('drawing');
    timer.current = setTimeout(() => settle('failed'), DRAW_WAIT_MS);
  };
  const shot = (canvas: HTMLCanvasElement) => {
    const element = profile.balance.dominant;
    void document.fonts
      .load(`800 46px ${token('--mg-font')}`)
      .catch(() => undefined)
      .then(() => {
        const picture = composePicture(canvas, {
          title: `${name}의 집`,
          line: profile.badge,
          mark: token(`--mg-${element}`),
          ink: '#1d1830',
          muted: '#5d5675',
          font: token('--mg-font'),
        });
        return new Promise<Blob | null>((resolve) => picture.toBlob(resolve, 'image/png'));
      })
      .then(
        (blob) => {
          if (!blob) return settle('failed');
          saveBlob(blob, pictureFileName(name));
          settle('saved');
        },
        () => settle('failed'),
      );
  };
  return (
    <>
      <button className="mg-btn mg-saju-save" disabled={state === 'drawing'} onClick={start}>
        <Icon name="download" /> {state === 'drawing' ? '그리는 중…' : '내 집 이미지 저장하기'}
      </button>
      {state === 'saved' && (
        <p className="mg-saju-toast mg-glass" role="status">
          <Icon name="check" /> 이미지를 저장했어요
        </p>
      )}
      {state === 'failed' && (
        <p className="mg-saju-toast mg-glass mg-error" role="alert">
          이미지를 만들지 못했어요
        </p>
      )}
      {state === 'drawing' && <Snapshot profile={profile} onShot={shot} />}
    </>
  );
}
