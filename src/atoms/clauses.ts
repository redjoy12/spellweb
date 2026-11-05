import type { DatabaseSync } from 'node:sqlite';

/** Bump on any behavioural change. Stored clauses carrying an older value are stale (sec. 5.2). */
export const SPLITTER_VERSION = 1;

export type ClauseKind = 'ability' | 'reminder' | 'mode' | 'flavor_word' | 'chapter' | 'loyalty';

export interface Clause {
  face_index: number;
  clause_index: number;
  span_start: number;
  span_end: number;
  text: string;
  kind: ClauseKind;
}

const RE_LOYALTY = /^[-+\u2212]?\d+:\s/;  // "+1: ", "-3: ", "−3:"(U+2212), "0: " — three literals, hyphen-first
// Roman numerals for Sagas; "To solve"/"Solved" for Case cards, which sec. 5.1 also
// calls chapters. Without the second alternative all 12 Case faces classify as
// flavor_word, contradicting the spec's own kind table.
const RE_CHAPTER = /^(?:[IVX]+(?:\s*,\s*[IVX]+)*|To solve|Solved)\s*—\s/;
const RE_FLAVOR  = /^[A-Z][A-Za-z0-9' -]{2,30}\s—\s/;  // "Landfall — ", "Descend 8 — ", "Animal May-Ham — "
const RE_MODE    = /^•\s/;                              // "• "

/**
 * Splits a line into [text, reminder] runs, tracking paren depth so nested text stays whole.
 * Assumes oracle text is paren-balanced; an unbalanced `(` absorbs the rest of the line as a
 * non-reminder run, and an orphan `)` is folded into the surrounding non-reminder run.
 */
function splitReminders(line: string, base: number): Array<{ start: number; end: number; reminder: boolean }> {
  const runs: Array<{ start: number; end: number; reminder: boolean }> = [];
  let depth = 0;
  let cursor = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '(') {
      if (depth === 0) {
        if (i > cursor) runs.push({ start: base + cursor, end: base + i, reminder: false });
        cursor = i;
      }
      depth++;
    } else if (line[i] === ')') {
      depth--;
      if (depth === 0) {
        runs.push({ start: base + cursor, end: base + i + 1, reminder: true });
        cursor = i + 1;
      }
    }
  }
  if (cursor < line.length) runs.push({ start: base + cursor, end: base + line.length, reminder: false });
  return runs;
}

/** Sentence boundaries inside a single non-reminder run. Oracle text has no abbreviations. */
function splitSentences(text: string, base: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
      const next = text[i + 1];
      if (next === undefined || next === ' ') {
        out.push({ start: base + start, end: base + i + 1 });
        start = i + 1;
        while (start < text.length && text[start] === ' ') start++;
        i = start - 1;
      }
    }
  }
  if (start < text.length) out.push({ start: base + start, end: base + text.length });
  return out;
}

/**
 * sec. 5.1. Marker-bearing lines (mode, chapter, loyalty, flavor word) tag every clause
 * they emit with that line's marker kind - splitting the marker off would make it permanently
 * uncoverable by any atom, failing every one of the 753 faces that carry an em-dash. A
 * multi-sentence marker line is sentence-split, and the marker rides on the FIRST clause of
 * that line; the kind still applies to every clause emitted from the line.
 */
export function splitOracleText(text: string, faceIndex: number): Clause[] {
  if (text.trim() === '') return [];

  const clauses: Clause[] = [];
  let offset = 0;

  for (const rawLine of text.split('\n')) {
    const lineStart = offset;
    offset += rawLine.length + 1;                       // +1 for the consumed newline
    if (rawLine.trim() === '') continue;

    const lead = rawLine.trimStart();
    const markerKind: ClauseKind | null =
      RE_MODE.test(lead) ? 'mode'
      : RE_LOYALTY.test(lead) ? 'loyalty'
      : RE_CHAPTER.test(lead) ? 'chapter'
      : RE_FLAVOR.test(lead) ? 'flavor_word'
      : null;

    const runs = splitReminders(rawLine, lineStart);

    // Runs are walked in text order; reversing the iteration flips [ability, reminder] to [reminder, ability].
    //
    // Non-reminder text is buffered and flushed (sentence-split) right before each
    // reminder and once more at line end, rather than joined across the WHOLE line.
    // Because a flush always happens at a reminder boundary, everything inside one
    // buffer is contiguous in the source by construction - no offset gap can occur,
    // so no separate contiguous-chunk bookkeeping is needed. This also fixes a second
    // bug found only against real data: joining across the whole line let a sentence's
    // span straddle an omitted reminder, so its span sliced back MORE text than its own
    // `text` held. Confirmed on "Dion, Bahamut's Dominant"'s Case chapter line
    // ("...return it to the battlefield (front face up)."): span_end landed past the
    // reminder, so text.slice(span_start, span_end) included "(front face up)" while
    // `text` did not - a real I3 violation, not a hypothetical one. Flushing before the
    // gap ever opens means the trailing "." (after the reminder) becomes its own
    // punctuation-only fragment and is dropped, same effect as the join intended,
    // without the mismatched span.
    let joined = '';
    const offsets: number[] = [];               // offsets[i] = source index of joined[i]

    const flush = (): void => {
      if (joined.trim() === '') { joined = ''; offsets.length = 0; return; }
      for (const p of splitSentences(joined, 0)) {
        let s = p.start;
        let e = p.end;
        while (s < e && /\s/.test(joined[s]!)) s++;
        while (e > s && /\s/.test(joined[e - 1]!)) e--;
        if (s >= e) continue;
        const sliceText = joined.slice(s, e);
        if (!/[\p{L}\p{N}]/u.test(sliceText)) continue;   // drop punctuation-only fragments
        clauses.push({
          face_index: faceIndex, clause_index: clauses.length,
          span_start: offsets[s]!, span_end: offsets[e - 1]! + 1,
          text: sliceText, kind: markerKind ?? 'ability',
        });
      }
      joined = '';
      offsets.length = 0;
    };

    for (const run of runs) {
      if (run.reminder) {
        flush();
        const slice = text.slice(run.start, run.end);
        if (slice.trim() === '') continue;
        clauses.push({
          face_index: faceIndex, clause_index: clauses.length,
          span_start: run.start, span_end: run.end, text: slice, kind: 'reminder',
        });
      } else {
        for (let i = run.start; i < run.end; i++) { joined += text[i]; offsets.push(i); }
      }
    }
    flush();
  }

  return clauses;
}

/**
 * Idempotently (re)persists every clause for a card's faces: DELETEs existing rows then
 * re-INSERTs via splitOracleText. Returns the number of clauses written. The clauses FK is
 * `ON DELETE CASCADE`, so removing the card cleans up its rows. Clause spans are offsets into
 * the original (unredacted) oracle_text. `version` is stamped on every row; only tests of a
 * splitter-version bump (reconcileSplitterVersion) pass anything but the current one.
 */
export function persistClauses(
  db: DatabaseSync,
  oracleId: string,
  oracleHash: string,
  version: number = SPLITTER_VERSION,
): number {
  const faces = db
    .prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; oracle_text: string }>;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM clauses WHERE oracle_id = ?').run(oracleId);
    const ins = db.prepare(
      `INSERT INTO clauses (oracle_id, face_index, clause_index, span_start, span_end, text, kind, oracle_hash, splitter_version)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    let n = 0;
    for (const f of faces) {
      for (const c of splitOracleText(f.oracle_text, f.face_index)) {
        ins.run(oracleId, c.face_index, c.clause_index, c.span_start, c.span_end,
                c.text, c.kind, oracleHash, version);
        n++;
      }
    }
    db.exec('COMMIT');
    return n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
