import { useEffect, useRef, useState } from 'react';
import { factoryApi, wardrobeUrls, wardrobePartSha, type WardrobePart } from '../factory/api';
import { partLabels as labels } from '../factory/parts';
import { canDrawThumbnails, partThumbnail, type Thumbnail } from '../part-thumbnails';

type View = 'drawing' | 'checking' | 'model' | 'label';
/** How long asking why a drawing failed may take before it counts as failed too. */
const PROBE_MS = 15_000;

/**
 * A wardrobe card's picture: the server's picture of the part; for a part it has none of (404 `preview_missing`, as an
 * uploaded GLB can be) a still picture of the part's model, drawn once the card is on screen; else its slot's name. A
 * picture that fails is asked about once at once, and once more each time the list is read again (`refreshed`).
 */
export function PartPreview({ part, refreshed }: { part: WardrobePart; refreshed?: number }) {
  const [view, setView] = useState<View>('drawing');
  const [attempt, setAttempt] = useState(0);
  const [picture, setPicture] = useState<Thumbnail | null>(null);
  const holder = useRef<HTMLSpanElement>(null);
  const asked = useRef(false), probe = useRef<AbortController | null>(null);
  const shown = useRef(view); shown.current = view;
  const url = wardrobeUrls.preview(part);
  useEffect(() => () => { probe.current?.abort(); probe.current = null; }, []);
  useEffect(() => {
    asked.current = false;
    if (shown.current === 'label') { setAttempt(value => value + 1); setView('drawing'); }
  }, [refreshed]);
  useEffect(() => {
    if (view !== 'model' || picture || !canDrawThumbnails()) return;
    const controller = new AbortController();
    const draw = () => partThumbnail(wardrobeUrls.part(part), wardrobePartSha(part), controller.signal)
      .then(value => { if (!controller.signal.aborted) setPicture(value); }, () => undefined);
    const element = holder.current;
    if (!element || typeof IntersectionObserver === 'undefined') { void draw(); return () => controller.abort(); }
    // Only cards on screen ask, so a long closet never queues pictures nobody looks at.
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect(); void draw();
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => { observer.disconnect(); controller.abort(); };
  }, [view, picture, part.job_id, part.version, part.slot, part.sha256, part.runtime_name, part.runtime_sha256]);

  async function failed() {
    if (asked.current) { setView('label'); return; }
    asked.current = true; setView('checking');
    probe.current?.abort();
    const controller = new AbortController(); probe.current = controller;
    const timer = setTimeout(() => controller.abort(), PROBE_MS);
    const answer = await factoryApi.wardrobePreviewAnswer(part, controller.signal);
    clearTimeout(timer);
    // Gone, or overtaken by a newer question; a question that ran out of time is a failure like any other.
    if (probe.current !== controller) return;
    if (answer === 'ok') { setAttempt(value => value + 1); setView('drawing'); }
    else setView(answer === 'missing' ? 'model' : 'label');
  }

  // The card that holds the picture already names the part; the picture itself is not read out a second time.
  if (view === 'drawing') return <img src={attempt ? `${url}&attempt=${attempt}` : url} alt="" loading="lazy" onError={() => void failed()} />;
  if (view === 'model' && picture) return <img src={picture.src} alt="" data-renderer={picture.renderer} />;
  return <span ref={holder} className="wardrobe-card-empty">{labels[part.slot] || part.slot}</span>;
}
