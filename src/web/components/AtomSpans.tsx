import type { CSSProperties } from 'react';
import type { AtomFace, AtomFamily, FocusSpan } from '../api.js';

/**
 * Which thing a click in AtomSpans selected. The plan's `onSelect?(atomId|clauseIndex)`
 * is ambiguous across faces, so this carries enough to dereference either side. An atom has a
 * stable `id`; a clause is identified by face + clause_index (clause_index is per-face).
 */
export type AtomSelection =
  | { kind: 'atom'; id: number }
  | { kind: 'clause'; faceIndex: number; clauseIndex: number };

/**
 * Six families → six existing tokens from docs/design/phase-1-ui/DESIGN.md. No new colour
 * values are introduced; every entry is an existing palette variable. The reserved "needs
 * attention" amber (`--res-unresolved`) is kept for uncovered clauses, so a family never
 * collides with the finding treatment.
 */
export const ATOM_FAMILY_COLOR: Record<AtomFamily, string> = {
  PRODUCES: 'var(--g)',             // green   — outputs / tokens / mana
  CARES_ABOUT: 'var(--u)',          // pale blue — observes a condition
  ENABLES: 'var(--gold-bright)',    // gold    — grants / amplifies
  COMBAT: 'var(--r)',               // pale red — damage / combat math
  INTERACTION: 'var(--res-glossary)', // sky   — cross-object effects
  CONSTRAINTS: 'var(--b)',          // pale gray — restrictions / "can't"
};

/** Stacked-underline geometry. The primary family colour is a 2px border-bottom; each
 *  additional active atom draws its own BAND_BASE_PX inset band offset by BAND_GAP_PX per
 *  atom, with paddingBottom giving the extra bands room so text stays readable. */
const BAND_BASE_PX = 3;   // first inset band sits 3px above the primary border
const BAND_GAP_PX = 2;    // each further band sits 2px above the previous one

/** One non-overlapping character run: a slice of oracle_text plus the atoms/clauses active in it. */
interface Run {
  start: number;
  end: number;
  slice: string;
  atoms: AtomFace['atoms'];
  clauses: AtomFace['clauses'];
  unclassified: AtomFace['unclassified'];
  /** Inside a span a review-queue deep link asked to outline. */
  focused: boolean;
}

/** Collects every boundary offset, sorts, and emits the runs between adjacent boundaries.
 *  A run is "active" for an atom/clause whose span fully contains it — guaranteed because we
 *  put every span edge into the boundary set, so no run ever partially overlaps anything. */
function buildRuns(face: AtomFace, focus: FocusSpan[]): Run[] {
  const text = face.oracle_text;
  const bounds = new Set<number>([0, text.length]);
  for (const f of focus) { bounds.add(f.span_start); bounds.add(f.span_end); }
  for (const a of face.atoms) { bounds.add(a.span_start); bounds.add(a.span_end); }
  for (const c of face.clauses) { bounds.add(c.span_start); bounds.add(c.span_end); }
  for (const u of face.unclassified) { bounds.add(u.span_start); bounds.add(u.span_end); }
  const sorted = [...bounds].filter((b) => b >= 0 && b <= text.length).sort((x, y) => x - y);

  const runs: Run[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start >= end) continue;
    runs.push({
      start, end, slice: text.slice(start, end),
      atoms: face.atoms.filter((a) => a.span_start <= start && a.span_end >= end),
      clauses: face.clauses.filter((c) => c.span_start <= start && c.span_end >= end),
      unclassified: face.unclassified.filter((u) => u.span_start <= start && u.span_end >= end),
      focused: focus.some((f) => f.span_start <= start && f.span_end >= end),
    });
  }
  return runs;
}

export function AtomSpans({ face, onSelect, focus = [] }: {
  face: AtomFace;
  onSelect?: (sel: AtomSelection) => void;
  /** Spans to outline - a review finding's deep link. Only this face's are used. */
  focus?: FocusSpan[];
}) {
  const runs = buildRuns(face, focus.filter((f) => f.face_index === face.face_index));

  const handleClick = (run: Run) => {
    if (!onSelect) return;
    if (run.atoms.length > 0) {
      // The primary family/colour for the run is the outermost spanning atom — the one
      // that started earliest in the text (atoms arrive ordered by span_start from the
      // route) — chosen for anchor stability; additional active atoms are shown as
      // stacked underline bands. The pick behaviour is unchanged.
      onSelect({ kind: 'atom', id: run.atoms[0]!.id });
      return;
    }
    // A reminder-only run must NOT select a clause: reminders are intentionally never
    // extracted, so reporting one as an "uncovered finding" would be factually wrong.
    const clause = run.clauses.find((c) => c.kind !== 'reminder');
    if (clause) onSelect({ kind: 'clause', faceIndex: face.face_index, clauseIndex: clause.clause_index });
  };

  const hover = (run: Run): string => {
    if (run.atoms.length > 0) {
      const families = [...new Set(run.atoms.map((a) => a.family))].join(' · ');
      return `${run.atoms.length} atom${run.atoms.length > 1 ? 's' : ''}: ${families} — click to inspect`;
    }
    if (run.clauses.some((c) => c.kind !== 'reminder')) {
      const c = run.clauses.find((c) => c.kind !== 'reminder')!;
      return `clause ${c.clause_index} (${c.kind}) — uncovered (no atom covers this)`;
    }
    if (run.clauses.length > 0) return 'reminder text — reminders are never extracted';
    return '';
  };

  return (
    <div className="atom-spans" data-face={face.face_index}>
      {runs.length > 0 && (
        <code className="atom-text">
          {runs.map((run, i) => {
            const covered = run.atoms.length > 0;
            const hasAbility = run.clauses.some((c) => c.kind !== 'reminder');
            const isReminder = !covered && !hasAbility && run.clauses.length > 0;
            const uncovered = !covered && hasAbility;

            const cls = [
              'atom-run',
              covered && 'atom-run--covered',
              uncovered && 'atom-run--uncovered',
              isReminder && 'atom-run--reminder',
              run.focused && 'atom-run--focus',
            ].filter(Boolean).join(' ');

            const style: CSSProperties = {};
            if (covered) {
              const primary = run.atoms[0]!;
              style.borderBottomColor = ATOM_FAMILY_COLOR[primary.family];
              // Stacked underlines for additional atoms: each extra active atom draws its own
              // 2px inset band above the primary border, so a clause covered by three atoms
              // shows three distinct family colours without nesting backgrounds over the text.
              // Geometry: band idx sits at -(BAND_BASE_PX + idx * BAND_GAP_PX) px; paddingBottom
              // grows by BAND_GAP_PX per extra band so the bands have room to render.
              if (run.atoms.length > 1) {
                style.boxShadow = run.atoms
                  .slice(1)
                  .map((a, idx) => `inset 0 ${-(BAND_BASE_PX + idx * BAND_GAP_PX)}px 0 0 ${ATOM_FAMILY_COLOR[a.family]}`)
                  .join(', ');
                style.paddingBottom = `${BAND_GAP_PX + (run.atoms.length - 1) * BAND_GAP_PX}px`;
              }
            }

            const title = hover(run);
            const markUnclassified = run.unclassified.length > 0 ? (
              <sup
                className="atom-mark atom-mark--unclassified"
                title={run.unclassified.map((u) => `unclassified: "${u.quote}" → ${u.proposed_label}`).join('\n')}
              >†</sup>
            ) : null;

            return (
              <span
                key={i}
                className={cls}
                style={style}
                title={title || undefined}
                onClick={onSelect ? () => handleClick(run) : undefined}
              >
                {run.slice}{markUnclassified}
              </span>
            );
          })}
        </code>
      )}

      {face.missingRules.length > 0 && (
        <ul className="missing-rules">
          {face.missingRules.map((m) => (
            <li key={m.id} className="mr-item" title={`status: ${m.status}`}>
              <span className="mr-mark">‡</span> {m.statement} <span className="muted">— “{m.quote}”</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}