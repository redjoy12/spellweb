import { it, expect } from 'vitest';
import { currentSchemaVersion } from '../src/atoms/schema.js';
import { packetContext } from '../src/graph/edgePackets.js';
import { liveTypes, stageBTypes } from '../src/graph/liveTypes.js';
import { V17_REMOVED } from '../src/atoms/schemaV17.js';
import { maybe, realDb } from './helpers/realDb.js';

// spec rev. 10 sec. 5.3. Read-only on the real database.
maybe('the Stage B scope (spec rev. 10 sec. 5.3)', () => {
  it('keeps every type of a golden pair atom in the scope, so the deriver-only score cannot lose a pair', () => {
    const v = currentSchemaVersion(realDb);
    const live = liveTypes(realDb, v);
    const used = realDb.prepare(
      `SELECT DISTINCT a.family || '.' || a.type_key t FROM edge_golden_pairs p
         JOIN atoms a ON a.id IN (p.supply_atom_id, p.demand_atom_id)`,
    ).all() as Array<{ t: string }>;
    expect(used.length).toBeGreaterThan(0);
    // A removed type counts as the type that keeps its fact: its rules move there, and the golden
    // reanchor moves the atom reference (spec sec. 22.5).
    const keeper = (t: string) => V17_REMOVED.find((r) => r.type === t)?.into ?? t;
    expect(used.map((r) => keeper(r.t)).filter((t) => !live.has(t))).toEqual([]);
  });

  it('a live type is one that a current atom has, or one that no earlier schema had', () => {
    const v = currentSchemaVersion(realDb);
    const live = liveTypes(realDb, v);
    const has = new Set((realDb.prepare("SELECT DISTINCT family || '.' || type_key t FROM atoms WHERE is_current = 1").all() as Array<{ t: string }>).map((r) => r.t));
    const older = new Set((realDb.prepare("SELECT DISTINCT family || '.' || type_key t FROM atom_types WHERE schema_version < ?").all(v) as Array<{ t: string }>).map((r) => r.t));
    for (const t of live) expect(has.has(t) || !older.has(t)).toBe(true);
  });

  it("scope 'all' defers nothing; scope 'live' splits the set's types into live and deferred", () => {
    const set = realDb.prepare("SELECT id, corpus_id, schema_version FROM edge_rule_sets WHERE status = 'in_progress' ORDER BY id DESC").get() as
      { id: number; corpus_id: number; schema_version: number } | undefined;
    if (!set) return;
    const base = packetContext(realDb, { corpusId: set.corpus_id, schemaVersion: set.schema_version });
    const all = stageBTypes(realDb, set.id, { ...base, graph: { ...base.graph, stage_b_scope: 'all' } });
    const live = stageBTypes(realDb, set.id, { ...base, graph: { ...base.graph, stage_b_scope: 'live' } });
    expect(all.deferred).toEqual([]);
    const lost = [...new Set([...all.supply, ...all.demand])].filter((t) => !live.supply.includes(t) && !live.demand.includes(t)).sort();
    expect(live.deferred).toEqual(lost);
    for (const t of live.supply) expect(all.supply).toContain(t);
  });
});
