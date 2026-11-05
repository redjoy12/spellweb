/**
 * Spec sec. 25.8: the CARES_ABOUT.PERMANENT_DIES atoms on a "would die this turn, exile it instead"
 * text leave the live atoms, with no model. An atom gets is_current = 0, so it stays for the builds
 * that have it. Each card must keep a PRODUCES.EXILE atom on that text, and no golden atom may
 * disagree. One transaction; `dryRun` counts and writes nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isWouldDieRider } from './schemaV20.js';

interface LiveAtom { id: number; oracle_id: string; face_index: number; family: string; type_key: string; span_start: number; span_end: number; quote: string; name: string }

export interface RetiredRider { id: number; name: string; quote: string }

export function retireWouldDieRiders(db: DatabaseSync, opts: { dryRun?: boolean } = {}): RetiredRider[] {
  const riders = (db.prepare(`SELECT a.id, a.oracle_id, a.face_index, a.family, a.type_key, a.span_start, a.span_end, a.quote, c.name
    FROM atoms a JOIN cards c USING (oracle_id)
    WHERE a.is_current = 1 AND a.family = 'CARES_ABOUT' AND a.type_key = 'PERMANENT_DIES' ORDER BY c.name, a.id`).all() as unknown as LiveAtom[]).filter(isWouldDieRider);
  const golden = (db.prepare("SELECT family, type_key, quote FROM golden_atoms WHERE family = 'CARES_ABOUT' AND type_key = 'PERMANENT_DIES'").all() as unknown as Array<{ family: string; type_key: string; quote: string }>).filter(isWouldDieRider);
  if (golden.length) throw new Error(`${golden.length} golden atom(s) have this text: "${golden[0]!.quote}"`);
  const keeper = db.prepare(`SELECT 1 FROM atoms WHERE oracle_id = ? AND face_index = ? AND is_current = 1 AND family = 'PRODUCES' AND type_key = 'EXILE'
    AND span_start < ? AND ? < span_end LIMIT 1`);
  const bare = riders.filter((a) => !keeper.get(a.oracle_id, a.face_index, a.span_end, a.span_start));
  if (bare.length) throw new Error(`no PRODUCES.EXILE atom on this text: ${bare.map((a) => a.name).join(', ')}`);
  if (!opts.dryRun) {
    db.exec('BEGIN');
    try {
      const retire = db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?');
      for (const a of riders) retire.run(a.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return riders.map(({ id, name, quote }) => ({ id, name, quote }));
}
