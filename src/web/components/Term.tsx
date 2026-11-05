import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryEntry, type TermId } from '../lib/terms.js';

/**
 * A project word with its plain explanation. The word has a dotted underline and a small "?" button;
 * a click opens a short bubble with the meaning and a link to the full guide. Works with touch and keyboard.
 */
export function Term({ id, children }: { id: TermId; children?: ReactNode }) {
  const entry: GlossaryEntry = GLOSSARY[id];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <span className="term" ref={ref}>
      <span className="term-word" onClick={() => setOpen(!open)}>{children ?? entry.term}</span>
      <button type="button" className="term-q" aria-label={`What does "${entry.term}" mean?`} aria-expanded={open} onClick={() => setOpen(!open)}>?</button>
      {open && (
        <span className="term-pop" role="dialog" aria-label={entry.term}>
          <b>{entry.term}</b>
          <span>{entry.plain}</span>
          {entry.more && <span>{entry.more}</span>}
          <a href={`#/guide?term=${id}`} onClick={() => setOpen(false)}>All terms in the guide</a>
        </span>
      )}
    </span>
  );
}
