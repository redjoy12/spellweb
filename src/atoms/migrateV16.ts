/**
 * The schema v16 move of stored atoms (spec sec. 21). Mechanical: no model reads a card again.
 *
 * - M1, M2: an atom of a removed type is dropped when the same card face has an atom of the type
 *   that keeps its fact; else it becomes an atom of that type.
 * - M2: PRODUCES.DISCARD takes the v16 params: `object_type` becomes `card_types` ([] for any),
 *   `excluded_card_types` is []. `card_choice` stays absent: only a new reading can state it.
 * - M3: an ACTIVATE atom whose span overlaps a keyword-kind atom on the same face is dropped. The
 *   keyword atom takes the ACTIVATE cost params that it does not have.
 * - M4: a PRODUCES.DISCARD atom whose span overlaps a CYCLING atom on the same face is dropped.
 *   `applyV16Twins` applies a twin rule that came after the move to the current v16 atoms.
 *
 * The live atoms move to a new run on v16 (the v15 rows stay, with is_current = 0, so that the old
 * builds keep their atoms). The golden atoms change in place: a golden card has one answer.
 */
import type { DatabaseSync } from 'node:sqlite';
import { V16_REMOVED, V16_TWINS } from './schemaV16.js';

export interface V16Atom {
  id: number; face_index: number; family: string; type_key: string;
  span_start: number; span_end: number; params: Record<string, unknown>;
}
export type V16Change =
  | { kind: 'drop'; id: number; item: 'M1' | 'M2' | 'M3' | 'M4'; into: string }
  | { kind: 'convert'; id: number; item: 'M1' | 'M2'; into: string; params: Record<string, unknown> }
  | { kind: 'params'; id: number; item: 'M2' | 'M3'; params: Record<string, unknown> };

const typeOf = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;
const overlaps = (a: V16Atom, b: V16Atom) => a.face_index === b.face_index && a.span_start < b.span_end && b.span_start < a.span_end;

/**
 * The v16 params of a PRODUCES.DISCARD atom (from v15 params, or from an INTERACTION.DISCARD atom).
 * A param that the old atom does not state stays absent: the move guesses no value.
 */
export function discardParamsV16(p: Record<string, unknown>): Record<string, unknown> {
  if ('card_types' in p) return p;
  const { object_type: ot, whose } = p;
  return {
    ...('object' in p ? { object: p['object'] } : {}),
    ...(ot !== undefined ? { card_types: ot === 'any' ? [] : [ot], excluded_card_types: [] } : {}),
    ...('actor' in p || whose !== undefined ? { actor: p['actor'] ?? whose } : {}),
  };
}

/** The changes of one card's atoms (all faces). Atoms with no change are not listed. */
export function v16Changes(atoms: readonly V16Atom[]): V16Change[] {
  const out: V16Change[] = [];
  const params = new Map<number, Record<string, unknown>>();
  const item = (t: string) => V16_REMOVED.find((r) => r.type === t)!.item as 'M1' | 'M2';
  // The twin keeper of an atom of type `t` (M3, M4): an overlapping atom of the `keep` type.
  const keeperOf = (a: V16Atom, t: string) => atoms.find((b) => overlaps(a, b) && V16_TWINS.some((w) => w.drop === t && w.keep === typeOf(b)));
  for (const a of atoms) {
    const t = typeOf(a);
    const removed = V16_REMOVED.find((r) => r.type === t);
    if (removed) {
      // A keeper on the same face that a twin rule drops too is no keeper (for example a Discard atom on a Cycling text, M4).
      const kept = atoms.some((b) => b.face_index === a.face_index && typeOf(b) === removed.into && !keeperOf(b, removed.into));
      const twin = keeperOf(a, removed.into);
      if (kept) out.push({ kind: 'drop', id: a.id, item: item(t), into: removed.into });
      else if (twin) out.push({ kind: 'drop', id: a.id, item: V16_TWINS.find((w) => w.drop === removed.into && w.keep === typeOf(twin))!.item, into: typeOf(twin) });
      else out.push({ kind: 'convert', id: a.id, item: item(t), into: removed.into, params: removed.into === 'PRODUCES.DISCARD' ? discardParamsV16(a.params) : {} });
      continue;
    }
    const keeper = keeperOf(a, t);
    if (keeper) {
      const twin = V16_TWINS.find((w) => w.drop === t && w.keep === typeOf(keeper))!;
      const to = { ...(params.get(keeper.id) ?? keeper.params) };
      for (const p of twin.move) if (!(p in to) && p in a.params) to[p] = a.params[p];
      params.set(keeper.id, to);
      params.delete(a.id);
      out.push({ kind: 'drop', id: a.id, item: twin.item, into: typeOf(keeper) });
      continue;
    }
    if (t === 'PRODUCES.DISCARD') params.set(a.id, discardParamsV16(params.get(a.id) ?? a.params));
  }
  const dropped = new Set(out.filter((c) => c.kind === 'drop').map((c) => c.id));
  for (const [id, p] of params) {
    if (dropped.has(id)) continue;
    const a = atoms.find((x) => x.id === id)!;
    if (JSON.stringify(p) !== JSON.stringify(a.params)) out.push({ kind: 'params', id, item: typeOf(a) === 'PRODUCES.DISCARD' ? 'M2' : 'M3', params: p });
  }
  return out;
}

export interface V16MoveResult {
  runId: number | null;
  cards: number;
  atoms: { moved: number; dropped: Record<string, number>; converted: Record<string, number>; params: Record<string, number> };
  golden: { dropped: Record<string, number>; converted: Record<string, number>; params: Record<string, number> };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/**
 * Moves the current v15 atoms to a new v16 run and changes the golden atoms. One transaction.
 * `dryRun` counts and writes nothing.
 */
export function moveToV16(db: DatabaseSync, opts: { dryRun?: boolean } = {}): V16MoveResult {
  const v16 = db.prepare('SELECT COUNT(*) n FROM atom_types WHERE schema_version = 16').get() as { n: number };
  if (v16.n === 0) throw new Error('schema v16 is not in atom_types: run `npm run generate:atom-schema -- --persist` first');
  const rows = db.prepare(`SELECT * FROM atoms WHERE is_current = 1 AND schema_version = 15 ORDER BY oracle_id, id`).all() as Array<Record<string, unknown> & V16Atom & { oracle_id: string; params_json: string }>;
  const byCard = new Map<string, typeof rows>();
  for (const r of rows) {
    r.params = JSON.parse(r.params_json) as Record<string, unknown>;
    const l = byCard.get(r.oracle_id);
    if (l) l.push(r); else byCard.set(r.oracle_id, [r]);
  }
  const res: V16MoveResult = { runId: null, cards: byCard.size, atoms: { moved: 0, dropped: {}, converted: {}, params: {} }, golden: { dropped: {}, converted: {}, params: {} } };

  const golden = db.prepare('SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, params_json FROM golden_atoms ORDER BY oracle_id, id')
    .all() as unknown as Array<V16Atom & { oracle_id: string; params_json: string }>;
  const goldenByCard = new Map<string, typeof golden>();
  for (const g of golden) {
    g.params = JSON.parse(g.params_json) as Record<string, unknown>;
    const l = goldenByCard.get(g.oracle_id);
    if (l) l.push(g); else goldenByCard.set(g.oracle_id, [g]);
  }

  if (!opts.dryRun) db.exec('BEGIN');
  try {
    let runId = 0;
    if (!opts.dryRun) {
      const last = db.prepare('SELECT corpus_id, packet_policy_sha, splitter_version FROM extraction_runs WHERE schema_version = 15 ORDER BY id DESC LIMIT 1')
        .get() as { corpus_id: number; packet_policy_sha: string; splitter_version: number };
      const now = new Date().toISOString();
      runId = Number(db.prepare(
        `INSERT INTO extraction_runs (started_at, finished_at, provider, model, schema_version, corpus_id, packet_policy_sha,
           splitter_version, batch_kind, cards_attempted, cards_passed, status)
         VALUES (?, ?, 'schema-v16-move', 'none', 16, ?, ?, ?, 'requeue', ?, ?, 'complete')`,
      ).run(now, now, last.corpus_id, last.packet_policy_sha, last.splitter_version, byCard.size, byCard.size).lastInsertRowid);
      res.runId = runId;
    }
    const insert = db.prepare(
      `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote,
         span_ambiguous, rule_numbers, confidence, confidence_source, oracle_hash, pass_index, consensus, is_current)
       VALUES (?, ?, ?, 16, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const retire = db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?');
    for (const atoms of byCard.values()) {
      const changes = new Map(v16Changes(atoms).map((c) => [c.id, c]));
      for (const a of atoms) {
        const c = changes.get(a.id);
        if (c?.kind === 'drop') { bump(res.atoms.dropped, `${typeOf(a)} -> ${c.into}`); if (!opts.dryRun) retire.run(a.id); continue; }
        const [family, type_key] = c?.kind === 'convert' ? c.into.split('.') as [string, string] : [a.family, a.type_key];
        const params = c ? c.params : a.params;
        if (c?.kind === 'convert') bump(res.atoms.converted, `${typeOf(a)} -> ${c.into}`);
        if (c?.kind === 'params') bump(res.atoms.params, typeOf(a));
        res.atoms.moved++;
        if (opts.dryRun) continue;
        insert.run(runId, a.oracle_id, a.face_index, family, type_key, JSON.stringify(params), a.span_start, a.span_end,
          a['quote'] as string, a['span_ambiguous'] as number, a['rule_numbers'] as string, a['confidence'] as number,
          a['confidence_source'] as string, a['oracle_hash'] as string, a['pass_index'] as number, a['consensus'] as number);
        retire.run(a.id);
      }
    }

    const del = db.prepare('DELETE FROM golden_atoms WHERE id = ?');
    const upd = db.prepare('UPDATE golden_atoms SET schema_version = 16, family = ?, type_key = ?, params_json = ? WHERE id = ?');
    for (const atoms of goldenByCard.values()) {
      for (const c of v16Changes(atoms)) {
        const a = atoms.find((x) => x.id === c.id)!;
        if (c.kind === 'drop') { bump(res.golden.dropped, `${typeOf(a)} -> ${c.into}`); if (!opts.dryRun) del.run(c.id); continue; }
        const [family, type_key] = c.kind === 'convert' ? c.into.split('.') as [string, string] : [a.family, a.type_key];
        bump(c.kind === 'convert' ? res.golden.converted : res.golden.params, c.kind === 'convert' ? `${typeOf(a)} -> ${c.into}` : typeOf(a));
        if (!opts.dryRun) upd.run(family, type_key, JSON.stringify(c.params), c.id);
      }
    }
    if (!opts.dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!opts.dryRun) db.exec('ROLLBACK');
    throw err;
  }
  return res;
}

/**
 * Applies the v16 twin rules (M3, M4) to the current v16 atoms in place: a twin atom gets
 * is_current = 0 (it stays for the builds that have it), and the kept atom takes the moved params.
 * The golden atoms change in place. One transaction; `dryRun` counts and writes nothing.
 */
export function applyV16Twins(db: DatabaseSync, opts: { dryRun?: boolean } = {}): { atoms: Record<string, number>; golden: Record<string, number> } {
  const res = { atoms: {} as Record<string, number>, golden: {} as Record<string, number> };
  const load = (sql: string) => {
    const by = new Map<string, Array<V16Atom & { oracle_id: string }>>();
    for (const r of db.prepare(sql).all() as unknown as Array<V16Atom & { oracle_id: string; params_json: string }>) {
      r.params = JSON.parse(r.params_json) as Record<string, unknown>;
      const l = by.get(r.oracle_id);
      if (l) l.push(r); else by.set(r.oracle_id, [r]);
    }
    return by;
  };
  const live = load('SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, params_json FROM atoms WHERE is_current = 1 AND schema_version = 16 ORDER BY oracle_id, id');
  const golden = load('SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, params_json FROM golden_atoms ORDER BY oracle_id, id');
  const twinOnly = (c: V16Change) => c.kind === 'drop' ? c.item === 'M3' || c.item === 'M4' : c.kind === 'params' && c.item === 'M3';
  if (!opts.dryRun) db.exec('BEGIN');
  try {
    const retire = db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?');
    const setParams = db.prepare('UPDATE atoms SET params_json = ? WHERE id = ?');
    const delGolden = db.prepare('DELETE FROM golden_atoms WHERE id = ?');
    const setGolden = db.prepare('UPDATE golden_atoms SET schema_version = 16, params_json = ? WHERE id = ?');
    for (const [store, by] of [['atoms', live], ['golden', golden]] as const) {
      for (const atoms of by.values()) {
        for (const c of v16Changes(atoms).filter(twinOnly)) {
          const a = atoms.find((x) => x.id === c.id)!;
          bump(res[store], c.kind === 'drop' ? `${typeOf(a)} -> ${c.into} (${c.item})` : `${typeOf(a)} params (${c.item})`);
          if (opts.dryRun) continue;
          if (c.kind === 'drop') (store === 'atoms' ? retire : delGolden).run(c.id);
          else if (c.kind === 'params') (store === 'atoms' ? setParams.run(JSON.stringify(c.params), c.id) : setGolden.run(JSON.stringify(c.params), c.id));
        }
      }
    }
    if (!opts.dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!opts.dryRun) db.exec('ROLLBACK');
    throw err;
  }
  return res;
}
