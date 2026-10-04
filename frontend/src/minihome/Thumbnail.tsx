import { useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react';

import { problemText } from '../api/client';
import type { HomeView } from '../api/types';
import { Icon } from '../ui/icons';
import { captureIsland, PictureError, thumbnailFromFile } from './sharePicture';

/** The site's own picture (frontend/public), which a link to an island shows until its owner picks one. */
export const SITE_PICTURE = '/share.jpg';
const PICTURE_TYPES = ['image/png', 'image/jpeg'];

type Work = 'file' | 'island' | 'remove';

/**
 * 공유 사진: the picture a link to the island shows in chats. Its owner picks a file (or pastes a picture while a control
 * here has focus), takes the island as it is drawn now, or goes back to the site's own.
 */
export function IslandThumbnail({
  view,
  onChange,
  islandCanvas,
}: {
  view: HomeView;
  /** Saves the picture (a JPEG data URL), or null for the site's own. */
  onChange: (image: string | null) => Promise<void>;
  /** The island's canvas to take, when the page draws one. */
  islandCanvas?: (() => HTMLCanvasElement | null) | undefined;
}) {
  const [working, setWorking] = useState<Work | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const run = (work: Work, picture: () => Promise<string | null>) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(work);
    setError('');
    void picture()
      .then(onChange)
      .catch((problem: unknown) => setError(problem instanceof PictureError ? problem.message : problemText(problem)))
      .finally(() => {
        busy.current = false;
        setWorking(null);
      });
  };
  const takeFile = (file: File) => run('file', () => thumbnailFromFile(file));
  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) takeFile(file);
  };
  const paste = (event: ClipboardEvent) => {
    const file = Array.from(event.clipboardData.files).find((item) => PICTURE_TYPES.includes(item.type));
    if (!file) return;
    event.preventDefault();
    takeFile(file);
  };
  const takeIsland = () =>
    run('island', () => {
      const canvas = islandCanvas?.();
      return canvas ? captureIsland(canvas) : Promise.reject(new PictureError('섬 화면을 담지 못했어요.'));
    });
  const { thumbnailUrl } = view.profile;

  return (
    <div className="mg-label" onPaste={paste}>
      공유 사진
      <div className="mg-thumb" tabIndex={-1}>
        <img src={thumbnailUrl || SITE_PICTURE} alt="" width={1200} height={630} />
      </div>
      <div className="mg-row">
        <button className="mg-btn is-small" disabled={!!working} onClick={() => input.current?.click()}>
          <Icon name="plus" /> {working === 'file' ? '올리는 중…' : '사진 고르기'}
        </button>
        {islandCanvas && (
          <button className="mg-btn is-small" disabled={!!working} onClick={takeIsland}>
            <Icon name="island" /> {working === 'island' ? '올리는 중…' : '섬 화면으로'}
          </button>
        )}
        {thumbnailUrl && (
          <button className="mg-btn is-quiet is-small" disabled={!!working} onClick={() => run('remove', async () => null)}>
            <Icon name="undo" /> {working === 'remove' ? '되돌리는 중…' : '기본으로'}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept={PICTURE_TYPES.join(',')} hidden onChange={chosen} />
      {error && <span className="mg-error" role="alert">{error}</span>}
    </div>
  );
}
