import type { DatabaseSync } from 'node:sqlite';

/**
 * On a scratch copy of the real database: make the atoms of a stored build current again, as they
 * were when the build ran. A re-extraction (schema v15 run 22) demotes them, and the route tests
 * that start from the latest build need its atoms current. Never call this on data/app.db itself.
 */
export function restoreBuildCurrency(db: DatabaseSync, buildId: number): void {
  db.exec('UPDATE atoms SET is_current = 0 WHERE is_current = 1');
  db.prepare('UPDATE atoms SET is_current = 1 WHERE id IN (SELECT atom_id FROM graph_build_atoms WHERE build_id = ?)').run(buildId);
}
