import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DraftDetail, type DraftAtomView, type DraftFaceView } from '../api.js';

/**
 * One drafted golden card, laid out for adjudication rather than for reading.
 *
 * The ordering is deliberate: the card's own text first, then each proposed atom
 * beside the quote it claims and the FULL text of every rule it cites. The owner
 * is checking a reading, not reconstructing one (`docs/golden-set-procedure.md`,
 * "Your part") — so nothing here is summarised, and the vocabulary's own label
 * for a type sits next to the type name, because "does this atom fit?" is a
 * question about that label.
 *
 * Two things this component must never do, both of which would quietly undo the
 * gates the CLI enforces:
 *
 *  - Decide completeness for the owner. `complete` is sent only when the owner
 *    presses the complete button; coverage is recomputed here purely to disable
 *    a button that the server would refuse anyway.
 *  - Hide a validation failure. Errors are shown verbatim and block acceptance;
 *    warnings are shown and do not.
 */

function spanOverlaps(a: { span_start: number; span_end: number }, b: { span_start: number; span_end: number }): boolean {
  return Math.max(0, Math.min(a.span_end, b.span_end) - Math.max(a.span_start, b.span_start)) > 0;
}

/** The face's text with one atom's claimed span marked, so the quote is checked in context. */
function FaceText({ face, highlight }: { face: DraftFaceView; highlight: DraftAtomView | null }) {
  if (!highlight || highlight.face_index !== face.face_index) {
    return <p className="gr-face-text">{face.oracle_text}</p>;
  }
  return (
    <p className="gr-face-text">
      {face.oracle_text.slice(0, highlight.span_start)}
      <mark className="gr-mark">{face.oracle_text.slice(highlight.span_start, highlight.span_end)}</mark>
      {face.oracle_text.slice(highlight.span_end)}
    </p>
  );
}

function RuleCitation({ number, text, inPacket, forceOpen }: {
  number: string; text: string; inPacket: boolean; forceOpen: boolean;
}) {
  return (
    <details className="gr-rule" open={forceOpen}>
      <summary>
        <span className="gr-rulenum">{number}</span>
        {/* A citation the term index could not reach is the interesting case (sec. 3.4
            kernel candidate), so it is labelled rather than left to look identical. */}
        {!inPacket && <span className="chip chip-glossary" title="read via --lookup; term matching never reached it">looked up</span>}
        <span className="gr-rulepeek">{text.slice(0, 96)}{text.length > 96 ? '…' : ''}</span>
      </summary>
      <p className="gr-ruletext">{text}</p>
    </details>
  );
}

export function DraftReview({ detail, onDecided }: { detail: DraftDetail; onDecided: () => void }) {
  const [excludedAtoms, setExcludedAtoms] = useState<Set<number>>(new Set());
  const [excludedUnclassified, setExcludedUnclassified] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const [expandRules, setExpandRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // A new card is a new decision: never carry exclusions or a note across.
  useEffect(() => {
    setExcludedAtoms(new Set());
    setExcludedUnclassified(new Set());
    setNote('');
    setHover(null);
    setError(null);
  }, [detail.oracle_id]);

  const includedAtoms = detail.atoms.filter((a) => !excludedAtoms.has(a.index));
  const includedUnclassified = detail.unclassified.filter((u) => !excludedUnclassified.has(u.index));
  const struckCount = excludedAtoms.size + excludedUnclassified.size;

  /**
   * Coverage over what is actually going to be written. `detail.validation` is
   * computed server-side over the WHOLE proposal, so it goes stale the moment the
   * owner strikes an atom — and the completeness button's enabled state has to
   * track the exclusions, not the draft. The server re-checks regardless.
   */
  const uncovered = useMemo(() => {
    const out: Array<{ face_index: number; text: string }> = [];
    for (const f of detail.faces) {
      for (const c of f.clauses) {
        if (c.kind === 'reminder') continue;
        const covered =
          includedAtoms.some((a) => a.face_index === f.face_index && spanOverlaps(a, c)) ||
          includedUnclassified.some((u) => u.face_index === f.face_index && spanOverlaps(u, c));
        if (!covered) out.push({ face_index: f.face_index, text: c.text });
      }
    }
    return out;
  }, [detail.faces, includedAtoms, includedUnclassified]);

  // Two different emptinesses, and only one of them is a refusal (the server
  // draws the same line in `acceptProposal`). A draft the owner has struck bare
  // has no reading left to stand behind and goes back for redrafting. A draft
  // that proposed nothing to begin with is the vanilla case — no oracle text, so
  // no clauses — where "yields no atoms" is the correct ground truth and the
  // only card shape that scores a provider for inventing atoms.
  const proposedNothing = detail.atoms.length === 0 && detail.unclassified.length === 0;
  const struckBare =
    !proposedNothing && includedAtoms.length === 0 && includedUnclassified.length === 0;
  const blocked = !detail.validation.ok || struckBare || busy;
  const needsNote = struckCount > 0 && !note.trim();

  async function decide(kind: 'partial' | 'complete' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'reject') {
        await api.goldenReject(detail.oracle_id, note.trim());
      } else {
        await api.goldenAccept(detail.oracle_id, {
          complete: kind === 'complete',
          note: note.trim(),
          exclude: struckCount > 0
            ? { atoms: [...excludedAtoms], unclassified: [...excludedUnclassified] }
            : undefined,
        });
      }
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Keyboard: the queue is ~125 cards, and reaching for the mouse on every one of
  // them is most of the friction. Never fires while typing a note.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'p' && !blocked && !needsNote) void decide('partial');
      else if (e.key === 'c' && !blocked && !needsNote && uncovered.length === 0) void decide('complete');
      else if (e.key === 'r') { e.preventDefault(); noteRef.current?.focus(); }
      else if (e.key === 'e') setExpandRules((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const decided = detail.review !== null;
  const hovered = hover === null ? null : (detail.atoms.find((a) => a.index === hover) ?? null);

  return (
    <div className="gr">
      <header className="gr-head">
        <div>
          <h2 className="gr-title"><span data-card-id={detail.oracle_id}>{detail.name}</span></h2>
          <div className="muted">
            {detail.type_line} · {detail.layout} · {detail.rarity} ·{' '}
            <a href={`#/card/${detail.oracle_id}`}>open in inspector</a>
          </div>
        </div>
        <div className="gr-head-meta">
          <span className="status-pill">drafted by <b>{detail.drafted_by.split(' ')[0]}</b></span>
          <span className="status-pill">{detail.atoms.length} atoms</span>
          <span className="status-pill">{detail.lookups.length} lookups</span>
          {detail.claims_complete && (
            <span className="status-pill" title="the drafter's claim — a hint, never the decision">
              claims complete
            </span>
          )}
        </div>
      </header>

      {decided && (
        <div className="warning-block">
          Already {detail.review?.decision} on {new Date(detail.review!.reviewed_at).toLocaleString()}
          {detail.review?.note ? ` — “${detail.review.note}”` : ''}. Deciding again re-writes the card.
        </div>
      )}

      {!detail.validation.ok && (
        <div className="error-block">
          <b>This draft cannot be accepted.</b>
          <ul>{detail.validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {detail.validation.warnings.length > 0 && (
        <div className="warning-block">
          <ul>{detail.validation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {detail.notes.trim() && (
        <div className="gr-notes">
          <span className="gr-notes-label">drafter's note</span>
          <p>{detail.notes}</p>
        </div>
      )}

      {detail.faces.map((f) => (
        <section key={f.face_index} className="gr-face">
          <h3 className="gr-face-name">face {f.face_index} — <span data-card-id={detail.oracle_id}>{f.name}</span></h3>
          <FaceText face={f} highlight={hovered} />
        </section>
      ))}

      <div className="gr-atoms-head">
        <h3>Proposed atoms</h3>
        <button className="gr-btn gr-btn-ghost" onClick={() => setExpandRules((v) => !v)}>
          {expandRules ? 'collapse' : 'expand'} all rule text <kbd>e</kbd>
        </button>
      </div>

      {detail.atoms.map((a) => {
        const struck = excludedAtoms.has(a.index);
        return (
          <article
            key={a.index}
            className={`gr-atom${struck ? ' struck' : ''}`}
            onMouseEnter={() => setHover(a.index)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="gr-atom-head">
              <label className="type-chk">
                <input
                  type="checkbox"
                  checked={!struck}
                  onChange={() =>
                    setExcludedAtoms((prev) => {
                      const next = new Set(prev);
                      if (next.has(a.index)) next.delete(a.index);
                      else next.add(a.index);
                      return next;
                    })
                  }
                />
                include
              </label>
              <span className="gr-type">{a.family}.{a.type_key}</span>
              <span className="muted">face {a.face_index} · span {a.span_start}–{a.span_end}</span>
            </div>
            {/* The vocabulary's label, verbatim. Most adjudications are a judgement
                about whether the clause matches THIS sentence. */}
            <div className="gr-label">{a.label ?? <em>no label at this schema version</em>}</div>
            <blockquote className="gr-quote">{a.quote}</blockquote>
            {Object.keys(a.params).length > 0 && (
              <div className="gr-params">params: <code>{JSON.stringify(a.params)}</code></div>
            )}
            <p className="gr-why">{a.rationale}</p>
            <div className="gr-rules">
              {a.rules.map((r) => (
                <RuleCitation key={r.number} number={r.number} text={r.text} inPacket={r.in_packet} forceOpen={expandRules} />
              ))}
            </div>
          </article>
        );
      })}

      {detail.unclassified.length > 0 && (
        <>
          <h3>Unclassified candidates</h3>
          {detail.unclassified.map((u) => {
            const struck = excludedUnclassified.has(u.index);
            return (
              <article key={u.index} className={`gr-atom${struck ? ' struck' : ''}`}>
                <div className="gr-atom-head">
                  <label className="type-chk">
                    <input
                      type="checkbox"
                      checked={!struck}
                      onChange={() =>
                        setExcludedUnclassified((prev) => {
                          const next = new Set(prev);
                          if (next.has(u.index)) next.delete(u.index);
                          else next.add(u.index);
                          return next;
                        })
                      }
                    />
                    include
                  </label>
                  <span className="gr-type">{u.proposed_label}</span>
                  <span className="muted">face {u.face_index} · no vocabulary fit claimed</span>
                </div>
                <blockquote className="gr-quote">{u.quote}</blockquote>
                <p className="gr-why">{u.rationale}</p>
              </article>
            );
          })}
        </>
      )}

      <footer className="gr-decide">
        {uncovered.length > 0 && (
          <div className="muted gr-uncovered">
            {uncovered.length} non-reminder clause(s) not covered by what you're including — this can
            be accepted as partial, not as complete:
            <ul>{uncovered.map((c, i) => <li key={i}>face {c.face_index}: “{c.text}”</li>)}</ul>
          </div>
        )}
        {struckBare && <div className="error-block">Nothing left to write. Reject the draft instead.</div>}
        {proposedNothing && (
          <div className="muted gr-uncovered">
            This draft proposes nothing, and the card has no oracle text to propose anything from.
            Accepting as complete asserts that this card yields no atoms — which is what makes it
            score a provider that invents one.
          </div>
        )}
        {error && <div className="error-block">{error}</div>}
        <textarea
          ref={noteRef}
          className="gr-note"
          placeholder={
            struckCount > 0
              ? 'Required: why you struck those items — the drafter corrects rather than guesses'
              : 'Note (optional for acceptance, required to reject)'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
        <div className="gr-buttons">
          <button
            className="gr-btn gr-btn-accept"
            disabled={blocked || needsNote}
            onClick={() => void decide('partial')}
            title="Writes the card with complete = false. Costs nothing: sec. 8.2 scores precision over complete cards only."
          >
            Accept as partial <kbd>p</kbd>
          </button>
          <button
            className="gr-btn gr-btn-complete"
            disabled={blocked || needsNote || uncovered.length > 0}
            onClick={() => void decide('complete')}
            title="Your claim that every non-reminder clause is accounted for."
          >
            Accept as complete <kbd>c</kbd>
          </button>
          <button
            className="gr-btn gr-btn-reject"
            disabled={busy || !note.trim()}
            onClick={() => void decide('reject')}
            title="Records the decision and leaves the draft on disk for redrafting."
          >
            Reject <kbd>r</kbd>
          </button>
          {struckCount > 0 && (
            <span className="muted">striking {struckCount} item(s) — a note is required</span>
          )}
        </div>
      </footer>
    </div>
  );
}
