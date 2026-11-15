import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { sajuApi } from '../../api/endpoints';
import { useFocusTrap } from '../../ui/focus';
import { Icon } from '../../ui/icons';
import { keyOf, type Birth } from '../engine';
import type { Profile } from '../profile';
import { Snapshot } from '../scene/Snapshot';
import { Making, useMade, type MadeState } from './Reading';

/** The island is sent to be drawn again as a square this many pixels a side. */
export const PICTURE_SOURCE = 1024;
/** How long the island may take to draw before the attempt is given up. */
const DRAW_WAIT_MS = 20_000;
/** How long the owner's island is left to settle on the page before it is drawn again off it. */
const SETTLE_MS = 1_500;

/** What a drawn picture is: a stored file and its size. */
type Picture = { url: string; width: number; height: number };
export type PictureState = MadeState<Picture>;

/** A picture whose every pixel is within this of every other, in each channel, is one colour: nothing was drawn. */
const FLAT = 6;

/** Whether `canvas` holds one colour only, as a canvas the graphics card never drew into does. */
function isFlat(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 16;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(canvas, 0, 0, 16, 16);
  const { data } = context.getImageData(0, 0, 16, 16);
  for (let channel = 0; channel < 3; channel++) {
    let low = 255;
    let high = 0;
    for (let index = channel; index < data.length; index += 4) {
      low = Math.min(low, data[index] ?? 0);
      high = Math.max(high, data[index] ?? 0);
    }
    if (high - low > FLAT) return false;
  }
  return true;
}

/**
 * The island as the server takes it: drawn into a square of {@link PICTURE_SOURCE} and written as WebP, or as JPEG by
 * a browser that cannot write WebP (it hands back a PNG instead, which can be larger than the server takes). A canvas
 * of one colour is refused: it would be drawn again, and paid for, as a picture of nothing.
 */
export function encodePicture(source: CanvasImageSource): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PICTURE_SOURCE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is not available');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, PICTURE_SOURCE, PICTURE_SOURCE);
  if (isFlat(canvas)) throw new Error('the island was not drawn');
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.92);
}

/** Draws the home's island alone off the page, as the saved picture does, and hands it over encoded. */
function PictureShot({ profile, onImage, onFail }: { profile: Profile; onImage: (image: string) => void; onFail: () => void }) {
  const done = useRef(false);
  const failed = useRef(onFail);
  failed.current = onFail;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (done.current) return;
      done.current = true;
      failed.current();
    }, DRAW_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const shot = (canvas: HTMLCanvasElement) => {
    if (done.current) return;
    done.current = true;
    let image: string;
    try {
      image = encodePicture(canvas);
    } catch {
      onFail();
      return;
    }
    onImage(image);
  };
  return <Snapshot profile={profile} onShot={shot} />;
}

/**
 * A home's island drawn again as a 미연시 picture, bound to the home's birth (`birth` and `profile`, null while the
 * home is not built). For the owner (`ownerId`) it is drawn once the island is `complete` (built and on the canvas)
 * if none is drawn for this birth, once, and looked at again while `poll` holds and it is being drawn. `draw` draws it
 * on the owner's say: `again` for a new one in place of the one drawn. `shot` is what draws the island, to put in the
 * page while it does.
 */
export function usePicture({ username, ownerId, birth, profile, complete, poll }: {
  username: string;
  ownerId: string | null;
  birth: Birth | null;
  profile: Profile | null;
  complete: boolean;
  poll: boolean;
}) {
  const key = birth ? `${username}:${keyOf(birth)}` : null;
  const made = useMade<Picture>({
    key,
    read: () => sajuApi.picture(username),
    poll: !!ownerId && poll,
    gaveUp: '그림을 끝내지 못했어요',
  });
  const { ask, fail } = made;
  /** The island being drawn, for which key, and whether in place of one drawn. */
  const [shooting, setShooting] = useState<{ key: string; again: boolean } | null>(null);
  const drawing = !!shooting && shooting.key === key;
  const draw = useCallback(
    (again: boolean) => {
      if (key && ownerId && profile) setShooting({ key, again });
    },
    [key, ownerId, profile],
  );
  const drawn = useRef(new Set<string>());
  const none = made.made?.status === 'none';
  useEffect(() => {
    if (!ownerId || !key || !complete || !none || drawn.current.has(key)) return undefined;
    const timer = setTimeout(() => {
      drawn.current.add(key);
      draw(false);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ownerId, key, complete, none, draw]);
  const shot =
    drawing && shooting && ownerId && profile ? (
      <PictureShot
        key={`${shooting.key}:${shooting.again}`}
        profile={profile}
        onImage={(image) => {
          setShooting(null);
          ask(() => sajuApi.draw({ expectedOwnerId: ownerId, image, ...(shooting.again ? { again: true } : {}) }));
        }}
        onFail={() => {
          setShooting(null);
          fail('이미지를 만들지 못했어요');
        }}
      />
    ) : null;
  return { ...made, drawing, draw, shot };
}

/** The picture over the page, as large as the window lets it be; Escape, 닫기 or a press beside it closes it. */
function PictureView({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialog, close);
  return createPortal(
    <div
      className="mg-modal-backdrop mg-saju-picture-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div ref={dialog} className="mg-saju-picture-view" role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1}>
        <img src={url} alt={alt} width={PICTURE_SOURCE} height={PICTURE_SOURCE} />
        <button ref={close} className="mg-icon-btn mg-saju-picture-close" aria-label="닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 섬 그림, on the 홈 tab: the picture, opening larger on a press. The owner also sees it being drawn and why it could
 * not be, and may draw it again. A visitor sees a drawn picture and nothing else.
 */
export function PictureCard({ name, state, drawing, owner, onDraw, onReload }: {
  /** The home's name, for what the picture is called. */
  name: string;
  state: PictureState;
  /** The island is being drawn on this page to be sent. */
  drawing: boolean;
  owner: boolean;
  /** Draws the island again: `again` for a new picture in place of the one drawn. */
  onDraw: (again: boolean) => void;
  /** Reads the state again, after the server could not be asked. */
  onReload: () => void;
}) {
  const { made, problem, asking, off } = state;
  const [open, setOpen] = useState(false);
  const title = '섬 그림';
  const alt = `${name}의 섬 그림`;
  if (made?.status === 'ready') {
    return (
      <section className="mg-saju-card mg-saju-picture" aria-label={title}>
        <h2 className="mg-heading">{title}</h2>
        <button className="mg-saju-picture-open" aria-haspopup="dialog" aria-label={`${alt} 크게 보기`} onClick={() => setOpen(true)}>
          <img src={made.url} alt="" width={made.width} height={made.height} />
        </button>
        {owner && problem && (
          <p className="mg-error" role="alert">
            {problem}
          </p>
        )}
        {owner &&
          (drawing || asking ? (
            <Making label="그림을 그리고 있어요" />
          ) : (
            <button className="mg-btn is-small mg-saju-picture-again" onClick={() => onDraw(true)}>
              <Icon name="rotate" /> 다시 그리기
            </button>
          ))}
        {open && <PictureView url={made.url} alt={alt} onClose={() => setOpen(false)} />}
      </section>
    );
  }
  if (!owner) return null;
  if (drawing || asking || made?.status === 'pending') {
    return (
      <section className="mg-saju-card mg-saju-picture" aria-label={title} aria-busy="true">
        <h2 className="mg-heading">{title}</h2>
        <Making label="그림을 그리고 있어요" />
      </section>
    );
  }
  if (off) return null;
  const failure = made?.status === 'failed' ? made.message : problem;
  if (!failure) return null;
  return (
    <section className="mg-saju-card mg-saju-picture" aria-label={title}>
      <h2 className="mg-heading">{title}</h2>
      <p className="mg-error" role="alert">
        {failure}
      </p>
      <button className="mg-btn is-small mg-saju-picture-again" onClick={() => (made ? onDraw(false) : onReload())}>
        <Icon name="rotate" /> 다시 시도
      </button>
    </section>
  );
}
