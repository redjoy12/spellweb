import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The large picture of the card under the pointer (owner request 2026-11-01). One layer in App listens
 * on the document, so a page only marks a card name or picture with `data-card-id` (its oracle id) or
 * `data-card-name` (its name, where the page has no id). The layer takes no pointer events, so it
 * never blocks a click. A touch screen has no hover, so the layer shows nothing there.
 */

const MARKED = '[data-card-id],[data-card-name]';
const DELAY_MS = 120; // a pointer that only passes over a card does not load its picture
const GAP = 24; // from the pointer
const EDGE = 12; // from the window edge

const known = new Map<string, Promise<string[]>>();

function imagesOf(mark: string): Promise<string[]> {
  let found = known.get(mark);
  if (!found) {
    found = api.cardImages(mark).then((r) => r.images).catch(() => []);
    known.set(mark, found);
  }
  return found;
}

/** The query of the marked element under the pointer, or null. */
function markAt(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(MARKED) : null;
  if (!el) return null;
  const { cardId, cardName } = el.dataset;
  return new URLSearchParams(cardId ? { id: cardId } : { name: cardName ?? '' }).toString();
}

export function CardZoomLayer() {
  const [images, setImages] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const place = () => {
    const el = box.current;
    if (!el) return;
    const { x, y } = pointer.current;
    const left = x + GAP + el.offsetWidth + EDGE <= window.innerWidth ? x + GAP : Math.max(EDGE, x - GAP - el.offsetWidth);
    const top = Math.max(EDGE, Math.min(y - el.offsetHeight / 2, window.innerHeight - el.offsetHeight - EDGE));
    el.style.transform = `translate(${left}px, ${top}px)`;
  };
  useLayoutEffect(place, [images]);

  useEffect(() => {
    let mark: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { mark = null; clearTimeout(timer); setImages([]); };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      pointer.current = { x: e.clientX, y: e.clientY };
      place();
      const next = markAt(e.target);
      if (next === mark) return;
      if (!next) { clear(); return; }
      mark = next;
      clearTimeout(timer);
      timer = setTimeout(() => { void imagesOf(next).then((list) => { if (mark === next) setImages(list); }); }, DELAY_MS);
    };
    // After each of these, the card under the pointer can change with no pointer move.
    const stops = ['pointerdown', 'keydown', 'hashchange'] as const;
    document.addEventListener('pointermove', onMove);
    document.documentElement.addEventListener('pointerleave', clear);
    window.addEventListener('scroll', clear, true);
    for (const s of stops) window.addEventListener(s, clear);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', clear);
      window.removeEventListener('scroll', clear, true);
      for (const s of stops) window.removeEventListener(s, clear);
    };
  }, []);

  if (images.length === 0) return null;
  return (
    <div ref={box} className="card-zoom" aria-hidden="true">
      {images.map((src) => <img key={src} src={src} alt="" />)}
    </div>
  );
}
