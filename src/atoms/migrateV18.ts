/**
 * The schema v18 move of stored atoms (spec sec. 23). Mechanical: no model reads a card again.
 *
 * - B1: a Destroy or Exile atom with a Targeted removal atom of the same object on its span merges
 *   into that atom, unless the atom says `targeted` false. A targeted Destroy atom with no such atom
 *   becomes a Targeted removal atom (review 1 F5). Each other Targeted removal atom takes
 *   `removal_type` from the action atoms on its span.
 * - B2: an Anthem atom becomes a STAT_CHANGE atom with `scope` set. A STAT_CHANGE atom gets `scope` one.
 * - B3: an opponent and a self life-loss atom of one span and amount are one atom. `player` is `target`
 *   when the quote says "target player", else `each`. A single atom gets `opponent` or `you`.
 * - B5: a counter atom with `counter_type` other takes the counter name of its quote.
 *
 * A param that an old atom does not state stays absent: the move guesses no value. Only the atoms
 * that change get a new row, in a new run on v18. The old rows stay, with is_current = 0, so that the
 * old builds keep their atoms. The golden atoms change in place: a golden card has one answer.
 */
import type { DatabaseSync } from 'node:sqlite';
import { validateAtomParams } from './schema.js';
import { ANTHEM, COUNTERS, counterNames, DAMAGE, DESTROY, EXILE, LIFE_LOSS, OPPONENT_LOSS, REMOVAL, SELF_LOSS, STAT_CHANGE } from './schemaV18.js';

export type V18Item = 'B1' | 'B2' | 'B3' | 'B5';
export interface V18Atom {
  id: number; face_index: number; family: string; type_key: string;
  span_start: number; span_end: number; params: Record<string, unknown>; quote: string;
}
export type V18Change =
  | { kind: 'drop'; id: number; item: V18Item; into: number }
  | { kind: 'change'; id: number; item: V18Item; type: string; params: Record<string, unknown> };

const typeOf = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;
const sameSpan = (a: V18Atom, b: V18Atom) => a.face_index === b.face_index && a.span_start === b.span_start && a.span_end === b.span_end;
const sameObject = (a: V18Atom, b: V18Atom) => a.params['object_type'] === b.params['object_type'] && a.params['object_controller'] === b.params['object_controller'];

/** B1: the Destroy or Exile details that the Targeted removal atom takes. An absent detail stays absent. */
const actionDetails = (a: V18Atom) => Object.fromEntries(['object', 'from_zone'].filter((k) => k in a.params).map((k) => [k, a.params[k]]));

/** The changes of one card's atoms (all faces). Atoms with no change are not listed. A second run gives none. */
export function v18Changes(atoms: readonly V18Atom[]): V18Change[] {
  const out: V18Change[] = [];
  const of = (t: string) => atoms.filter((a) => typeOf(a) === t);
  const on = (a: V18Atom, t: string) => of(t).filter((b) => sameSpan(a, b));

  // B1: the merges come first, because each Targeted removal atom takes one action atom only.
  const taken = new Set<number>();
  for (const [type, removal_type] of [[DESTROY, 'destroy'], [EXILE, 'exile']] as const) {
    for (const a of of(type)) {
      if (a.params['targeted'] === false) continue;
      const r = on(a, REMOVAL).find((x) => !taken.has(x.id) && !('removal_type' in x.params) && sameObject(x, a));
      if (r) {
        taken.add(r.id);
        out.push({ kind: 'drop', id: a.id, item: 'B1', into: r.id });
        out.push({ kind: 'change', id: r.id, item: 'B1', type: REMOVAL, params: { ...r.params, removal_type, ...actionDetails(a) } });
      } else if (type === DESTROY && a.params['targeted'] === true) {
        const { targeted: _targeted, ...rest } = a.params;
        out.push({ kind: 'change', id: a.id, item: 'B1', type: REMOVAL, params: { ...rest, removal_type } });
      }
    }
  }
  for (const r of of(REMOVAL)) {
    if (taken.has(r.id) || 'removal_type' in r.params) continue;
    const minus = on(r, STAT_CHANGE).some((s) => s.params['sign'] === '-' || s.params['sign'] === 'mixed') || on(r, COUNTERS).some((c) => c.params['counter_type'] === '-1/-1');
    const removal_type = on(r, DESTROY).length ? 'destroy' : on(r, EXILE).length ? 'exile' : on(r, DAMAGE).length ? 'damage' : minus ? 'minus' : 'other';
    out.push({ kind: 'change', id: r.id, item: 'B1', type: REMOVAL, params: { ...r.params, removal_type } });
  }

  // B2. No Anthem atom shares a span with a STAT_CHANGE atom, so no atom merges.
  for (const a of of(ANTHEM)) {
    const { duration, ...rest } = a.params;
    out.push({ kind: 'change', id: a.id, item: 'B2', type: STAT_CHANGE, params: {
      ...rest, scope: 'set', ...(duration === undefined ? {} : { duration: duration === 'end_of_turn' ? 'until_end_of_turn' : duration }),
    } });
  }
  for (const a of of(STAT_CHANGE)) {
    if (!('scope' in a.params)) out.push({ kind: 'change', id: a.id, item: 'B2', type: STAT_CHANGE, params: { ...a.params, scope: 'one' } });
  }

  // B3
  const paired = new Set<number>();
  for (const o of of(OPPONENT_LOSS)) {
    const s = on(o, SELF_LOSS).find((x) => !paired.has(x.id) && JSON.stringify(x.params['amount']) === JSON.stringify(o.params['amount']));
    if (s) {
      paired.add(s.id);
      out.push({ kind: 'drop', id: s.id, item: 'B3', into: o.id });
      out.push({ kind: 'change', id: o.id, item: 'B3', type: LIFE_LOSS, params: { ...o.params, player: /\btarget player\b/i.test(o.quote) ? 'target' : 'each' } });
    } else out.push({ kind: 'change', id: o.id, item: 'B3', type: LIFE_LOSS, params: { ...o.params, player: 'opponent' } });
  }
  for (const s of of(SELF_LOSS)) {
    if (!paired.has(s.id)) out.push({ kind: 'change', id: s.id, item: 'B3', type: LIFE_LOSS, params: { ...s.params, player: 'you' } });
  }

  // B5
  for (const a of of(COUNTERS)) {
    const name = a.params['counter_type'] === 'other' ? counterNames(a.quote) : null;
    if (name) out.push({ kind: 'change', id: a.id, item: 'B5', type: COUNTERS, params: { ...a.params, counter_type: name } });
  }
  return out;
}

export interface V18Tally { dropped: Record<string, number>; changed: Record<string, number> }
export interface V18MoveResult {
  runId: number | null;
  cards: number;
  atoms: V18Tally & { unchanged: number };
  golden: V18Tally & { atoms: number };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const nameOf = (a: { family: string; type_key: string }, c: V18Change) =>
  (c.kind === 'drop' ? `${c.item} ${typeOf(a)} merged` : c.type === typeOf(a) ? `${c.item} ${typeOf(a)}` : `${c.item} ${typeOf(a)} -> ${c.type}`);

function groupByCard<T extends V18Atom & { oracle_id: string; params_json: string }>(rows: T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    r.params = JSON.parse(r.params_json) as Record<string, unknown>;
    const l = by.get(r.oracle_id);
    if (l) l.push(r); else by.set(r.oracle_id, [r]);
  }
  return by;
}

/**
 * Moves the current atoms that change to a new v18 run and changes the golden atoms, then checks
 * every golden atom against v18. One transaction: a failure rolls all of it back. `dryRun` counts
 * and writes nothing.
 */
export function moveToV18(db: DatabaseSync, opts: { dryRun?: boolean } = {}): V18MoveResult {
  const v18 = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = 18').get() as { n: number };
  if (v18.n === 0) throw new Error('schema v18 is not in atom_types: run `npm run generate:atom-schema -- --persist` first');
  const live = groupByCard(db.prepare('SELECT * FROM atoms WHERE is_current = 1 ORDER BY oracle_id, id').all() as Array<Record<string, unknown> & V18Atom & { oracle_id: string; params_json: string }>);
  const golden = groupByCard(db.prepare('SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, quote, params_json FROM golden_atoms ORDER BY oracle_id, id').all() as unknown as Array<V18Atom & { oracle_id: string; params_json: string }>);
  const res: V18MoveResult = { runId: null, cards: 0, atoms: { unchanged: 0, dropped: {}, changed: {} }, golden: { atoms: 0, dropped: {}, changed: {} } };

  db.exec('BEGIN');
  try {
    const last = db.prepare('SELECT corpus_id, packet_policy_sha, splitter_version FROM extraction_runs WHERE schema_version = 17 ORDER BY id DESC LIMIT 1')
      .get() as { corpus_id: number; packet_policy_sha: string; splitter_version: number };
    const moved = [...live.values()].map((atoms) => ({ atoms, changes: v18Changes(atoms) })).filter((x) => x.changes.length);
    res.cards = moved.length;
    const now = new Date().toISOString();
    const runId = Number(db.prepare(
      `INSERT INTO extraction_runs (started_at, finished_at, provider, model, schema_version, corpus_id, packet_policy_sha,
         splitter_version, batch_kind, cards_attempted, cards_passed, status)
       VALUES (?, ?, 'schema-v18-move', 'none', 18, ?, ?, ?, 'requeue', ?, ?, 'complete')`,
    ).run(now, now, last.corpus_id, last.packet_policy_sha, last.splitter_version, moved.length, moved.length).lastInsertRowid);
    res.runId = runId;
    const insert = db.prepare(
      `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote,
         span_ambiguous, rule_numbers, confidence, confidence_source, oracle_hash, pass_index, consensus, is_current)
       VALUES (?, ?, ?, 18, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const retire = db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?');
    for (const { atoms, changes } of moved) {
      const of = new Map(atoms.map((a) => [a.id, a]));
      for (const c of changes) {
        const a = of.get(c.id)!;
        retire.run(a.id);
        if (c.kind === 'drop') { bump(res.atoms.dropped, nameOf(a, c)); continue; }
        bump(res.atoms.changed, nameOf(a, c));
        const [family, type_key] = c.type.split('.') as [string, string];
        insert.run(runId, a.oracle_id, a.face_index, family, type_key, JSON.stringify(c.params), a.span_start, a.span_end,
          a.quote, a['span_ambiguous'] as number, a['rule_numbers'] as string, a['confidence'] as number,
          a['confidence_source'] as string, a['oracle_hash'] as string, a['pass_index'] as number, a['consensus'] as number);
      }
    }
    res.atoms.unchanged = [...live.values()].reduce((n, l) => n + l.length, 0) - moved.reduce((n, m) => n + m.changes.length, 0);

    const del = db.prepare('DELETE FROM golden_atoms WHERE id = ?');
    const upd = db.prepare('UPDATE golden_atoms SET schema_version = 18, family = ?, type_key = ?, params_json = ? WHERE id = ?');
    for (const atoms of golden.values()) {
      const changes = v18Changes(atoms);
      // The drops go first: a row that changes type can take the key of a row that goes.
      for (const c of [...changes].sort((a, b) => (a.kind === 'drop' ? 0 : 1) - (b.kind === 'drop' ? 0 : 1))) {
        const a = atoms.find((x) => x.id === c.id)!;
        if (c.kind === 'drop') { bump(res.golden.dropped, nameOf(a, c)); del.run(c.id); continue; }
        bump(res.golden.changed, nameOf(a, c));
        const [family, type_key] = c.type.split('.') as [string, string];
        upd.run(family, type_key, JSON.stringify(c.params), c.id);
      }
    }
    const all = db.prepare('SELECT id, family, type_key, params_json FROM golden_atoms').all() as Array<{ id: number; family: string; type_key: string; params_json: string }>;
    res.golden.atoms = all.length;
    const failed = all.map((g) => ({ g, v: validateAtomParams(db, 18, g.family, g.type_key, JSON.parse(g.params_json)) }))
      .filter((x) => !x.v.ok).map((x) => `${x.g.id} ${x.g.family}.${x.g.type_key}: ${(x.v as { error: string }).error}`);
    if (failed.length) throw new Error(`golden atoms fail the v18 params check:\n${failed.join('\n')}`);
    db.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
    if (opts.dryRun) res.runId = null;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}
