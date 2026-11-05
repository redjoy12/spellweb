/**
 * Schema v15 plan Task 4: move the atom references of the edge golden pairs to the current atoms.
 *
 * A re-extraction demotes the atoms that a golden pair names (supply_atom_id, demand_atom_id).
 * The full score uses the clause spans, so it does not need them; the deriver-only score and the
 * miss classes read the type of the named atom. This module finds, for each named atom, the
 * current consensus atom of the same card, face and type whose span overlaps it the most. A v15
 * twin that submit drops (V9: TOKENS, CARDS_TO_GRAVEYARD) moves to its keyword type.
 *
 * It changes only the two atom IDs. It never changes a label, a clause or a status, so it is not a
 * labelling act (the edge-golden CLI rule). Each change returns the old ID for the report.
 */
import type { DatabaseSync } from 'node:sqlite';
import { V9_TWINS } from '../atoms/schemaV15.js';
import { V16_REMOVED, V16_TWINS } from '../atoms/schemaV16.js';
import { V17_REMOVED } from '../atoms/schemaV17.js';
import { V18_MOVED } from '../atoms/schemaV18.js';

export interface ReanchorItem {
  pair_id: number;
  side: 'supply' | 'demand';
  oracle_id: string;
  old_atom_id: number;
  old_type: string;
  old_quote: string;
  /** The new atom ID, or null when no current atom of the type overlaps the old span. */
  new_atom_id: number | null;
  new_type: string | null;
  /** 'same' when the old atom is still current; 'moved'; 'twin' (V9 keyword type); 'lost'. */
  outcome: 'same' | 'moved' | 'twin' | 'lost';
  /** For a lost atom: the current types on the old span, for the report. */
  types_on_span: string[];
}

interface AtomRow {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string;
  span_start: number; span_end: number; quote: string; is_current: number;
}

const overlap = (a: AtomRow, b: AtomRow) =>
  Math.max(0, Math.min(a.span_end, b.span_end) - Math.max(a.span_start, b.span_start));

/** Plans the moves. Reads the database, never writes it. */
export function planReanchor(db: DatabaseSync): ReanchorItem[] {
  const pairs = db.prepare(
    'SELECT id, supply_atom_id, demand_atom_id FROM edge_golden_pairs WHERE supply_atom_id IS NOT NULL OR demand_atom_id IS NOT NULL ORDER BY id',
  ).all() as Array<{ id: number; supply_atom_id: number | null; demand_atom_id: number | null }>;
  const atomById = db.prepare(
    'SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, quote, is_current FROM atoms WHERE id = ?',
  );
  const currentOnFace = db.prepare(
    `SELECT id, oracle_id, face_index, family, type_key, span_start, span_end, quote, is_current FROM atoms
      WHERE oracle_id = ? AND face_index = ? AND is_current = 1 AND consensus = 1 ORDER BY span_start, id`,
  );

  const out: ReanchorItem[] = [];
  for (const p of pairs) {
    for (const side of ['supply', 'demand'] as const) {
      const id = side === 'supply' ? p.supply_atom_id : p.demand_atom_id;
      if (id === null) continue;
      const old = atomById.get(id) as AtomRow | undefined;
      if (!old) throw new Error(`golden pair ${p.id}: ${side} atom ${id} does not exist`);
      const oldType = `${old.family}.${old.type_key}`;
      const base = { pair_id: p.id, side, oracle_id: old.oracle_id, old_atom_id: id, old_type: oldType, old_quote: old.quote };
      if (old.is_current === 1) {
        out.push({ ...base, new_atom_id: id, new_type: oldType, outcome: 'same', types_on_span: [] });
        continue;
      }
      const face = currentOnFace.all(old.oracle_id, old.face_index) as unknown as AtomRow[];
      const best = (type: string) => face
        .filter((a) => `${a.family}.${a.type_key}` === type && overlap(a, old) > 0)
        .sort((a, b) => overlap(b, old) - overlap(a, old) || a.id - b.id)[0];
      const same = best(oldType);
      if (same) {
        out.push({ ...base, new_atom_id: same.id, new_type: oldType, outcome: 'moved', types_on_span: [] });
        continue;
      }
      // The type that keeps the fact of a dropped type: a v15 twin (V9), a v16, v17 or v18 moved type
      // (M1, M2, S3, B1-B3) or the keyword kind of a v16 ACTIVATE (M3).
      const keeps = [
        ...V9_TWINS.filter((t) => t.drop === oldType).map((t) => t.keep),
        ...[...V16_REMOVED, ...V17_REMOVED, ...V18_MOVED].filter((r) => r.type === oldType).map((r) => r.into),
        ...V16_TWINS.filter((t) => t.drop === oldType).map((t) => t.keep),
      ];
      const keep = keeps.find((k) => best(k));
      if (keep) {
        out.push({ ...base, new_atom_id: best(keep)!.id, new_type: keep, outcome: 'twin', types_on_span: [] });
        continue;
      }
      out.push({
        ...base, new_atom_id: null, new_type: null, outcome: 'lost',
        types_on_span: [...new Set(face.filter((a) => overlap(a, old) > 0).map((a) => `${a.family}.${a.type_key}`))],
      });
    }
  }
  return out;
}

/**
 * Writes the moves. A lost atom keeps its old ID: the old row still exists, so the deriver score
 * keeps the old type, and the report names the pair for the owner.
 */
export function applyReanchor(db: DatabaseSync, items: readonly ReanchorItem[]): number {
  const set = {
    supply: db.prepare('UPDATE edge_golden_pairs SET supply_atom_id = ? WHERE id = ? AND supply_atom_id = ?'),
    demand: db.prepare('UPDATE edge_golden_pairs SET demand_atom_id = ? WHERE id = ? AND demand_atom_id = ?'),
  };
  let changed = 0;
  db.exec('SAVEPOINT reanchor');
  try {
    for (const it of items) {
      if (it.outcome !== 'moved' && it.outcome !== 'twin') continue;
      changed += Number(set[it.side].run(it.new_atom_id, it.pair_id, it.old_atom_id).changes);
    }
    db.exec('RELEASE reanchor');
  } catch (err) {
    db.exec('ROLLBACK TO reanchor');
    db.exec('RELEASE reanchor');
    throw err;
  }
  return changed;
}
