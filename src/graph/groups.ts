/**
 * Ability groups (Phase 3 spec sec. 4). A group is one paragraph of a face's oracle text; each
 * atom goes into the paragraph that holds its span start. The kind, the cost and the limits
 * come from the mechanical text tests only (textTests.ts), never from the atoms - so the
 * disagreements between trigger atoms and trigger words (spec sec. 3, fact 6) do not change it.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentCorpusId } from '../atoms/golden.js';
import {
  activatedCost, activatedSeparator, costResidueSteps, countManaSymbols, hasHybridSymbol, hasTapSymbol, hasTriggerWordInside,
  hasTurnWord, isTriggered, manaLetters, removeSymbols, stripGroupText, tapSymbol, timingLimitType, type TextTests,
} from './textTests.js';

export type GroupKind = 'triggered' | 'activated' | 'other';

export interface AbilityGroup {
  oracle_id: string; face_index: number; group_index: number;
  span_start: number; span_end: number; kind: GroupKind;
  cost: { mana: number | 'unknown'; tap: boolean; atom_ids: number[] } | null;
  cost_unparsed: boolean; per_turn_limit: boolean; unknown_limit: boolean;
  oracle_hash: string; tests_version: number;
  /** `groupAtomSha` of the atoms the group was made from: the cost and limit columns depend on them. */
  atom_sha: string;
}

/**
 * The atom-set part of the group key (plan Task 8): a short sha of the card's sorted atom IDs.
 * A requeue gives the card new atoms, so its groups get new rows, and an old build keeps its own.
 */
export function groupAtomSha(atomIds: Iterable<number>): string {
  return createHash('sha256').update([...atomIds].sort((a, b) => a - b).join(','), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The stored rows of one atom set: the rows with this `atom_sha`, or else the rows written before
 * migration 10 (`atom_sha = ''`). `rows` holds both kinds for one card, hash and tests version.
 */
export function pickAtomSet<T extends { atom_sha: string }>(rows: T[], atomSha: string): T[] {
  const own = rows.filter((r) => r.atom_sha === atomSha);
  return own.length > 0 ? own : rows.filter((r) => r.atom_sha === '');
}

/**
 * The effect counts of the project decisions (spec sec. 4.2): the groups or atoms that each
 * decision touches. The build writes them to the gap report; `--groups` prints them.
 */
export interface GroupEffects {
  trigger_word_inside: number;   // groups with a trigger word that is not at the start
  hybrid_cost: number;           // activated groups whose cost has a symbol with the unknown mark
  unknown_mana: number;          // activated groups whose mana count is unknown, for any reason
  colon_in_quotes: number;       // groups with a colon only inside quotation marks
  prefix_stripped: number;       // groups that lost a prefix to prefix_strip
  prefix_refused: number;        // groups whose text before the prefix marker prefix_strip kept
  reminder_stripped: number;     // groups that lost text to reminder_strip
  unclosed_reminder: number;     // groups with an open delimiter and no close: that text stays
  timing_atoms: number;          // timing_limit atoms
  turn_word: number;             // groups with the turn word and no per-turn limit
  cost_unparsed: number;         // activated groups that cost_residue marks
}

export const emptyEffects = (): GroupEffects => ({
  trigger_word_inside: 0, hybrid_cost: 0, unknown_mana: 0, colon_in_quotes: 0, prefix_stripped: 0, prefix_refused: 0,
  reminder_stripped: 0, unclosed_reminder: 0, timing_atoms: 0, turn_word: 0, cost_unparsed: 0,
});

/** spec sec. 4.1: one group per paragraph. Empty paragraphs give no group. */
export function splitGroups(faceText: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const para of faceText.split('\n')) {
    const end = start + para.length;
    if (para.trim() !== '') out.push({ start, end });
    start = end + 1;
  }
  return out;
}

interface AtomRow { id: number; face_index: number; family: string; type_key: string; span_start: number; span_end: number; span_ambiguous: number }

const lettersCache = new WeakMap<DatabaseSync, Map<TextTests, string[]>>();
function lettersFor(db: DatabaseSync, t: TextTests): string[] {
  let m = lettersCache.get(db);
  if (!m) lettersCache.set(db, (m = new Map()));
  let l = m.get(t);
  if (!l) m.set(t, (l = manaLetters(db, currentCorpusId(db), t)));
  return l;
}

/** The index of the group that holds `offset`: the last group that starts at or before it. */
function groupAt(groups: Array<{ start: number }>, offset: number): number {
  let g = 0;
  for (let i = 0; i < groups.length; i++) if (groups[i]!.start <= offset) g = i;
  return g;
}

/**
 * spec sec. 4.2 `cost_residue`: remove what the test names (the cost atom spans, the tap
 * symbol, the brace symbols, single characters); any text that stays means the cost is not parsed.
 */
export function costResidue(face: string, cost: { faceStart: number; faceEnd: number; cost: string },
  costAtoms: ReadonlyArray<{ span_start: number; span_end: number }>, stripped: { text: string; toFace: number[] }, t: TextTests): boolean {
  const steps = costResidueSteps(t);
  // The stripped cost characters with their face offsets (reminder text is already gone).
  const kept = stripped.toFace.filter((o) => o >= cost.faceStart && o < cost.faceEnd)
    .filter((o) => !steps.atomSpans || !costAtoms.some((a) => o >= a.span_start && o < a.span_end));
  let rest = kept.map((o) => face[o]).join('');
  if (steps.tap) rest = rest.split(tapSymbol(t)).join('');
  if (steps.symbols) rest = removeSymbols(rest, t);
  for (const c of steps.chars) rest = rest.split(c).join('');
  return rest !== '';
}

/**
 * The groups of every face of one card, with the group of each atom. `atomIds` selects the
 * atoms (a build's atom set); the default is the card's current atoms.
 */
export function groupsForCard(db: DatabaseSync, oracleId: string, t: TextTests, atomIds?: readonly number[]): {
  groups: AbilityGroup[]; atomGroup: Map<number, number>; ambiguous: number; effects: GroupEffects;
} {
  const card = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(oracleId) as { oracle_hash: string } | undefined;
  if (!card) throw new Error(`no card ${oracleId}`);
  const faces = db.prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; oracle_text: string }>;
  const atoms = (atomIds
    ? db.prepare(`SELECT a.id, a.face_index, a.family, a.type_key, a.span_start, a.span_end, a.span_ambiguous
                    FROM atoms a JOIN json_each(?) j ON j.value = a.id WHERE a.oracle_id = ? ORDER BY a.id`).all(JSON.stringify(atomIds), oracleId)
    : db.prepare(`SELECT id, face_index, family, type_key, span_start, span_end, span_ambiguous
                    FROM atoms WHERE oracle_id = ? AND is_current = 1 ORDER BY id`).all(oracleId)) as unknown as AtomRow[];
  const atomSha = groupAtomSha(atoms.map((a) => a.id));
  const letters = lettersFor(db, t);
  const separator = activatedSeparator(t);
  const timing = timingLimitType(t);

  const groups: AbilityGroup[] = [];
  const atomGroup = new Map<number, number>();
  const effects = emptyEffects();
  let ambiguous = 0;

  for (const face of faces) {
    const spans = splitGroups(face.oracle_text);
    const faceAtoms = atoms.filter((a) => a.face_index === face.face_index);
    const byGroup = spans.map(() => [] as AtomRow[]);
    for (const a of faceAtoms) {
      if (spans.length === 0) continue;
      const g = groupAt(spans, a.span_start);
      byGroup[g]!.push(a);
      atomGroup.set(a.id, g);
      if (a.span_ambiguous) ambiguous++;
    }

    spans.forEach((span, gi) => {
      const raw = face.oracle_text.slice(span.start, span.end);
      const stripped = stripGroupText(raw, span.start, t);
      const inGroup = byGroup[gi]!;
      const timingAtoms = inGroup.filter((a) => a.family === timing.family && a.type_key === timing.type_key).length;

      let kind: GroupKind = 'other';
      let cost: AbilityGroup['cost'] = null;
      let costUnparsed = false;
      const triggered = isTriggered(stripped.text, t);
      const c = triggered ? null : activatedCost(stripped, t);
      if (triggered) kind = 'triggered';
      else if (c) {
        kind = 'activated';
        const costAtoms = inGroup.filter((a) => a.span_start >= c.faceStart && a.span_end <= c.faceEnd);
        const mana = countManaSymbols(c.cost, letters, t);
        cost = { mana, tap: hasTapSymbol(c.cost, t), atom_ids: costAtoms.map((a) => a.id) };
        costUnparsed = costResidue(face.oracle_text, c, costAtoms, stripped, t);
        if (mana === 'unknown') effects.unknown_mana++;
        if (hasHybridSymbol(c.cost, t)) effects.hybrid_cost++;
        if (costUnparsed) effects.cost_unparsed++;
      } else if (stripped.text.includes(separator)) {
        effects.colon_in_quotes++;
      }
      if (hasTriggerWordInside(stripped.text, t)) effects.trigger_word_inside++;
      if (stripped.prefixStripped) effects.prefix_stripped++;
      if (stripped.prefixRefused) effects.prefix_refused++;
      if (stripped.reminderStripped) effects.reminder_stripped++;
      if (stripped.unclosed) effects.unclosed_reminder++;
      effects.timing_atoms += timingAtoms;

      const perTurn = (cost?.tap ?? false) || timingAtoms > 0;
      const unknownLimit = hasTurnWord(stripped.text, t) && !perTurn;
      if (unknownLimit) effects.turn_word++;

      groups.push({
        oracle_id: oracleId, face_index: face.face_index, group_index: gi,
        span_start: span.start, span_end: span.end, kind, cost,
        cost_unparsed: costUnparsed, per_turn_limit: perTurn, unknown_limit: unknownLimit,
        oracle_hash: card.oracle_hash, tests_version: t.tests_version, atom_sha: atomSha,
      });
    });
  }
  return { groups, atomGroup, ambiguous, effects };
}

export function addEffects(into: GroupEffects, e: GroupEffects): GroupEffects {
  for (const k of Object.keys(into) as Array<keyof GroupEffects>) into[k] += e[k];
  return into;
}

/** The stored form of a group, column by column. */
function groupRow(g: AbilityGroup) {
  return {
    span_start: g.span_start, span_end: g.span_end, kind: g.kind, cost_json: g.cost ? JSON.stringify(g.cost) : null,
    cost_unparsed: g.cost_unparsed ? 1 : 0, per_turn_limit: g.per_turn_limit ? 1 : 0, unknown_limit: g.unknown_limit ? 1 : 0,
  };
}

/** A stored group that differs from the group the current code and atoms give. */
export class GroupConflictError extends Error {}

/**
 * Writes groups. A row is new only when its (oracle_id, face_index, oracle_hash, tests_version,
 * atom_sha, group_index) is new: errata, a test change or a requeue adds rows, and old builds keep
 * their old groups. The atom set is in the key (plan Task 8) because some columns depend on the
 * atoms (cost atoms, the timing atoms of per_turn_limit, cost_unparsed). Thus an existing row with
 * the same key must be equal to the new one; a difference means the code changed without a new
 * tests_version, throws GroupConflictError and writes nothing more.
 * Returns the rows inserted.
 */
export function persistGroups(db: DatabaseSync, groups: AbilityGroup[]): number {
  const get = db.prepare(
    `SELECT span_start, span_end, kind, cost_json, cost_unparsed, per_turn_limit, unknown_limit FROM ability_groups
      WHERE oracle_id = ? AND face_index = ? AND oracle_hash = ? AND tests_version = ? AND atom_sha = ? AND group_index = ?`,
  );
  const ins = db.prepare(
    `INSERT INTO ability_groups (oracle_id, face_index, group_index, span_start, span_end, kind, cost_json,
                                 cost_unparsed, per_turn_limit, unknown_limit, oracle_hash, tests_version, atom_sha)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const g of groups) {
    const row = groupRow(g);
    const stored = get.get(g.oracle_id, g.face_index, g.oracle_hash, g.tests_version, g.atom_sha, g.group_index) as Record<string, unknown> | undefined;
    if (stored) {
      const diff = (Object.keys(row) as Array<keyof typeof row>).filter((k) => stored[k] !== row[k]);
      if (diff.length > 0) {
        throw new GroupConflictError(`group ${g.oracle_id} face ${g.face_index} group ${g.group_index} (tests v${g.tests_version}) `
          + `differs from the stored row in ${diff.join(', ')}. The atoms or the code changed without a new tests_version.`);
      }
      continue;
    }
    ins.run(g.oracle_id, g.face_index, g.group_index, row.span_start, row.span_end, row.kind, row.cost_json,
      row.cost_unparsed, row.per_turn_limit, row.unknown_limit, g.oracle_hash, g.tests_version, g.atom_sha);
    n++;
  }
  return n;
}
