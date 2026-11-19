import { useEffect, useRef, useState } from 'react';

import type { SajuReading } from '../../api/types';
import { Icon } from '../../ui/icons';
import type { Birth } from '../engine';
import { profileOf } from '../profile';
import type { Picture } from '../report/pages';
import type { IslandDecor } from '../scene/Decor';
import { Snapshot } from '../scene/Snapshot';
import { saveBlob } from '../snapshot';

/** How long the island may take to draw for the cover before the cover goes without it. */
const DRAW_WAIT_MS = 15_000;

/**
 * PDF 저장: the home's chart and its reading as a PDF to keep (`<name>-팔자피자.pdf`). Its cover carries the home's
 * 미연시 picture, or, without one, the island drawn alone as the saved picture draws it.
 */
export function SaveReport({ name, birth, reading, pictureUrl, decor }: { name: string; birth: Birth; reading: SajuReading; pictureUrl: string | null; decor: IslandDecor | null }) {
  const [state, setState] = useState<'idle' | 'making' | 'failed'>('idle');
  // While the island is drawn for the cover: where its picture goes.
  const [shoot, setShoot] = useState<((picture: Picture | null) => void) | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const island = () =>
    new Promise<Picture | null>((resolve) => {
      const done = (picture: Picture | null) => {
        clearTimeout(timer);
        if (mounted.current) setShoot(null);
        resolve(picture);
      };
      const timer = setTimeout(() => done(null), DRAW_WAIT_MS);
      setShoot(() => done);
    });

  const make = async () => {
    setState('making');
    try {
      // The PDF's makings come with the first PDF asked for: most visits never ask for one.
      const { pictureAt, reportFileName, reportOf } = await import('../report/make');
      const picture = (pictureUrl ? await pictureAt(pictureUrl).catch(() => null) : null) ?? (await island());
      const report = await reportOf({ name, birth, reading, picture });
      // A page left before the PDF was ready does not hand a file over after it.
      if (!mounted.current) return;
      saveBlob(report, reportFileName(name));
      setState('idle');
    } catch {
      if (mounted.current) setState('failed');
    }
  };

  return (
    <>
      <button className="mg-btn is-small" disabled={state === 'making'} onClick={() => void make()}>
        <Icon name="download" /> <span>{state === 'making' ? 'PDF 만드는 중…' : 'PDF 저장'}</span>
      </button>
      {state === 'failed' && (
        <p className="mg-error" role="alert">
          PDF를 만들지 못했어요
        </p>
      )}
      {shoot && decor && <Snapshot profile={profileOf(birth)} decor={decor} onShot={shoot} />}
    </>
  );
}
