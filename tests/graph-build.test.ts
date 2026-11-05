import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { buildGraph, buildKey, TEST_DECISION_EFFECTS, v14Gates, type BuildInput } from '../src/graph/build.js';
import { BuildIndex, currentScopeAtoms } from '../src/graph/buildIndex.js';
import { scopeCards } from '../src/graph/intrinsic.js';
import { loadGraphPolicy, weightsSha } from '../src/graph/policy.js';
import { currentRuleSet, setRules } from '../src/graph/ruleSet.js';
import { loadTextTests } from '../src/graph/textTests.js';
import { draw } from '../src/util/draw.js';
import { maybe } from './helpers/realDb.js';

describe('buildKey (spec sec. 7.1, plan D4)', () => {
  const policy = loadGraphPolicy();
  const input: BuildInput = {
    atomSetSha: 'a', schemaVersion: 14, ruleSetVersion: 1, corpusId: 3, poolSnapshotId: 5, testsVersion: 1,
    weightsSha: weightsSha(policy), scope: 'BR', buildRulesSha: 'r', manaCostGate: true,
  };
  it('a change to the cycle limits or the golden values does not make a new build', () => {
    const other = { ...policy, cycles: { ...policy.cycles, top_k: policy.cycles.top_k + 1 }, golden: { ...policy.golden, round_size: 1 } };
    expect(buildKey({ ...input, weightsSha: weightsSha(other) })).toBe(buildKey(input));
  });
  it('a change to the weights, the atom set or the rule set makes a new build', () => {
    const w = { ...policy, weights: { ...policy.weights, cost_per_mv: policy.weights.cost_per_mv + 0.01 } };
    expect(buildKey({ ...input, weightsSha: weightsSha(w) })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, atomSetSha: 'b' })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, ruleSetVersion: 2 })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, buildRulesSha: 's' })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, manaCostGate: false })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, doubleObjectGate: true })).not.toBe(buildKey(input));
    expect(buildKey({ ...input, objectGate: true })).not.toBe(buildKey(input));
  });
  it('spec sec. 20.5: a v15 rule set turns off the mana cost gate and the "Double" object gate', () => {
    expect(v14Gates(14)).toEqual({ manaCostGate: true, doubleObjectGate: true });
    expect(v14Gates(15)).toEqual({ manaCostGate: false, doubleObjectGate: false });
  });
});

/** A scratch copy of data/app.db (plan "Test database rule"). */
function scratch(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'graph-build-'));
  const file = join(dir, 'app.db');
  copyFileSync(DB_PATH, file);
  for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, file + ext);
  const db = openDb(file);
  // The real database can hold builds already; the scratch copy starts with none (the rows cascade).
  // The owner's link reports, fix requests and decks point to a build and do not cascade: they go first.
  db.exec("DELETE FROM review_queue WHERE detail_table = 'edge_reports'; DELETE FROM fix_requests; DELETE FROM edge_reports; DELETE FROM decks; DELETE FROM graph_builds");
  return { db, dir };
}

maybe('the graph build on scratch copies of the real database (plan Task 4 Step 5)', () => {
  let a: { db: DatabaseSync; dir: string };
  let b: { db: DatabaseSync; dir: string };
  let first: ReturnType<typeof buildGraph>;
  let second: ReturnType<typeof buildGraph>;
  let other: ReturnType<typeof buildGraph>;
  let index: BuildIndex;
  let ok = false;

  beforeAll(() => {
    a = scratch();
    b = scratch();
    ok = currentRuleSet(a.db) !== null;
    if (!ok) return;
    first = buildGraph(a.db, 'BR');
    second = buildGraph(a.db, 'BR');
    other = buildGraph(b.db, 'BR');
    index = BuildIndex.load(a.db, first.buildId);
  }, 600_000);

  afterAll(() => {
    for (const s of [a, b]) {
      s?.db.close();
      if (s) rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('two calls with the same input give the same build_key, and the second reuses the build', () => {
    if (!ok) return;
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.buildId).toBe(first.buildId);
    const key = (db: DatabaseSync, id: number) => (db.prepare('SELECT build_key k FROM graph_builds WHERE id = ?').get(id) as { k: string }).k;
    expect(key(b.db, other.buildId)).toBe(key(a.db, first.buildId));
  });

  it('card_degree has one row for each scope card, equal across two builds into two databases', () => {
    if (!ok) return;
    const rows = (db: DatabaseSync, id: number) => db.prepare(
      'SELECT oracle_id, out_degree, in_degree, out_weight, in_weight, class_edges, anti_degree FROM card_degree WHERE build_id = ? ORDER BY oracle_id',
    ).all(id);
    const ra = rows(a.db, first.buildId);
    expect(ra.map((r) => r['oracle_id'])).toEqual(scopeCards(a.db, 'BR'));
    expect(rows(b.db, other.buildId)).toEqual(ra);
    expect(ra.some((r) => Number(r['out_degree']) > 0)).toBe(true);
  });

  it('graph_build_atoms has the IDs of the current atoms of the scope', () => {
    if (!ok) return;
    const ids = (a.db.prepare('SELECT atom_id FROM graph_build_atoms WHERE build_id = ? ORDER BY atom_id').all(first.buildId) as
      Array<{ atom_id: number }>).map((r) => r.atom_id);
    expect(ids).toEqual(currentScopeAtoms(a.db, 'BR'));
  });

  it('the scope rule: colour identity in the scope colours; colourless cards are in each scope', () => {
    if (!ok) return;
    const ci = (id: string) => JSON.parse((a.db.prepare('SELECT color_identity c FROM cards WHERE oracle_id = ?').get(id) as { c: string }).c) as string[];
    const br = scopeCards(a.db, 'BR');
    expect(br.every((id) => ci(id).every((l) => l === 'B' || l === 'R'))).toBe(true);
    const colourless = br.filter((id) => ci(id).length === 0);
    expect(colourless.length).toBeGreaterThan(0);
    for (const s of ['B', 'R'] as const) {
      const cards = new Set(scopeCards(a.db, s));
      expect(colourless.every((id) => cards.has(id))).toBe(true);
      expect([...cards].every((id) => ci(id).every((l) => l === s))).toBe(true);
    }
  });

  it('graph_gaps has rows of each gap kind that applies, and each test_decision test', () => {
    if (!ok) return;
    const gaps = a.db.prepare('SELECT gap_kind, type_key, param, count FROM graph_gaps WHERE build_id = ?').all(first.buildId) as
      Array<{ gap_kind: string; type_key: string; param: string; count: number }>;
    const kinds = new Set(gaps.map((g) => g.gap_kind));
    for (const k of ['trigger_without_demand', 'trigger_word_inside', 'test_decision', 'unresolved_param']) expect(kinds).toContain(k);
    const decisions = loadTextTests().tests.filter((t) => t.decision?.gap_kind === 'test_decision').map((t) => t.test);
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(gaps.filter((g) => g.gap_kind === 'test_decision' && g.type_key === d).map((g) => g.param).sort())
        .toEqual([...TEST_DECISION_EFFECTS[d]!].sort());
    }
  });

  it('no edge table exists, and the build stores no edge rows', () => {
    if (!ok) return;
    const tables = (a.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables.filter((n) => /(^|_)edges?$|merged|atom_edge|card_pair/.test(n))).toEqual([]);
    const c = first.counts;
    const merged = c.merged_edges['+'].confirmed + c.merged_edges['+'].plausible;
    expect(merged).toBeGreaterThan(0);
    // The build rows are one per atom and one per card: no row per edge.
    const rows = (t: string) => (a.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE build_id = ?`).get(first.buildId) as { n: number }).n;
    expect(rows('graph_build_atoms')).toBe(c.atoms);
    expect(rows('card_degree')).toBe(c.scope_cards);
  });

  it('BuildIndex.edgesForCard gives edges whose degree agrees with card_degree, for 20 drawn cards', { timeout: 120_000 }, () => {
    if (!ok) return;
    const cards = index.cards().map((c) => ({ c, r: draw(4, c) })).sort((x, y) => x.r - y.r).slice(0, 20).map((x) => x.c);
    const get = a.db.prepare('SELECT out_degree, in_degree, out_weight, in_weight, class_edges, anti_degree FROM card_degree WHERE build_id = ? AND oracle_id = ?');
    for (const c of cards) {
      const stored = get.get(first.buildId, c) as Record<string, number>;
      const d = index.degreeOf(c);
      expect({ ...d, out_weight: Math.fround(d.out_weight), in_weight: Math.fround(d.in_weight) })
        .toEqual({ ...stored, out_weight: Math.fround(stored['out_weight']!), in_weight: Math.fround(stored['in_weight']!) });
      const e = index.edgesForCard(c);
      expect(new Set(e.out.map((x) => x.demand_oracle)).size).toBe(stored['out_degree']);
      expect(new Set(e.in.map((x) => x.supply_oracle)).size).toBe(stored['in_degree']);
    }
  });

  it('each explicit edge has a supply and a demand atom and rules with evidence; each class edge one atom, one class, a rule with evidence', () => {
    if (!ok) return;
    const rules = new Map(setRules(a.db, first.counts.rule_set.id, 'accepted').map((r) => [r.rule_hash, r]));
    const evidenced = (hs: string[]) => hs.length > 0 && hs.every((h) => (rules.get(h)?.evidence.length ?? 0) > 0);
    // sec. 7.10: the link gate removes the card-type class edges, so also draw cards that still have a class edge.
    const withClass = (a.db.prepare('SELECT oracle_id FROM card_degree WHERE build_id = ? AND class_edges > 0').all(first.buildId) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
    const drawn = (list: string[], n: number) => list.map((c) => ({ c, r: draw(5, c) })).sort((x, y) => x.r - y.r).slice(0, n).map((x) => x.c);
    const cards = [...new Set([...drawn(index.cards(), 30), ...drawn(withClass, 10)])];
    let explicit = 0;
    let classEdges = 0;
    const faults: string[] = [];
    for (const c of cards) {
      const e = index.edgesForCard(c);
      for (const x of [...e.out, ...e.in, ...e.anti.filter((y) => y.class_id === null)]) {
        explicit++;
        if (x.supply_oracle === null || x.atom_ids.length < 2 || !x.atom_ids.includes(x.demand_atom_id) || !evidenced(x.rule_hashes)) faults.push(x.key);
      }
      for (const x of [...e.classes, ...e.anti.filter((y) => y.class_id !== null)]) {
        classEdges++;
        if (x.atom_ids.length !== 1 || x.atom_ids[0] !== x.demand_atom_id || !index.classes.has(x.class_id!) || !evidenced(x.rule_hashes)) faults.push(x.key);
      }
    }
    expect(faults).toEqual([]);
    expect(explicit).toBeGreaterThan(0);
    expect(classEdges).toBeGreaterThan(0);
  }, 120_000);

  it('refreshes the rank of each pending edge_rule_disagreement finding of the set (spec sec. 10.1 rank 2)', () => {
    if (!ok) return;
    const pending = a.db.prepare(
      "SELECT rank_score FROM review_queue WHERE domain = 'edge' AND severity = 'edge_rule_disagreement' AND status = 'pending' AND rule_set_id = ?",
    ).all(first.counts.rule_set.id) as Array<{ rank_score: number }>;
    expect(first.counts.ranks_refreshed).toBe(pending.length);
    if (pending.length > 0) expect(pending.some((p) => p.rank_score > 0)).toBe(true);
  });

  it('isStale is false for the current atoms, and true after the current atom set of a card changes', () => {
    if (!ok) return;
    expect(index.isStale(a.db)).toBe(false);
    const atom = currentScopeAtoms(a.db, 'BR')[0]!;
    a.db.prepare('UPDATE atoms SET is_current = 0 WHERE id = ?').run(atom);
    expect(index.isStale(a.db)).toBe(true);
    a.db.prepare('UPDATE atoms SET is_current = 1 WHERE id = ?').run(atom);
  });
});
