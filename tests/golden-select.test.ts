import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { loadPacketPolicy } from '../src/rules/relevance.js';
import { loadGraphPolicy, type GraphPolicy } from '../src/graph/policy.js';
import { crSubtypeLists } from '../src/graph/subtypes.js';
import {
  DEMAND_TYPE_MIN_ATOMS, cardTerms, demandTypeKeys, loadSlice, persistRound, sampleRound, strata,
  type PairCandidate, type SliceData,
} from '../src/graph/goldenSelect.js';
import { maybe, realCorpusId, realDb } from './helpers/realDb.js';

// spec rev. 6 sec. 11.2 on the real BR slice. Every expectation is mechanical: it reads atoms,
// schema rows and CR text, never a Magic fact.

const take = (g: Generator<PairCandidate>, n: number) => {
  const out: PairCandidate[] = [];
  for (let r = g.next(); !r.done && out.length < n; r = g.next()) out.push(r.value);
  return out;
};
const key = (p: PairCandidate) => [p.supply_oracle, p.demand_oracle].sort().join('|');

maybe('golden selection (spec sec. 11.2) on the real slice', () => {
  let d: SliceData;
  let policy: GraphPolicy;
  let gens: ReturnType<typeof strata>;
  const has = (card: string, test: (a: SliceData['atoms'] extends Map<string, infer A> ? A extends Array<infer X> ? X : never : never) => boolean) =>
    d.atoms.get(card)!.some(test);

  beforeAll(() => {
    policy = loadGraphPolicy();
    d = loadSlice(realDb);
    gens = strata(realDb, d, 1, policy, { corpusId: realCorpusId, scope: 'BR', termPolicy: loadPacketPolicy() });
  });

  it('demand_type: one pair for each CARES_ABOUT type with slice atoms and each other type with 20 or more slice atoms', () => {
    const ca = new Set(d.caresAboutTypes);
    const want = new Set([...d.typeAtoms].filter(([t, n]) => (ca.has(t) ? n > 0 : n >= DEMAND_TYPE_MIN_ATOMS)).map(([t]) => t));
    expect([...want].filter((t) => ca.has(t)).length).toBeGreaterThan(0);
    const first = take(gens.demand_type, want.size);
    expect(new Set(first.map((p) => p.basis))).toEqual(want);
    // M3: one fixed order, the CARES_ABOUT types first.
    const keys = demandTypeKeys(d);
    expect(keys.slice(0, [...want].filter((t) => ca.has(t)).length).every((t) => ca.has(t))).toBe(true);
    expect(first.map((p) => p.basis)).toEqual(keys);
    for (const p of first) {
      const [family, type_key] = p.basis!.split('.');
      expect(has(p.demand_oracle, (a) => a.family === family && a.type_key === type_key)).toBe(true);
      expect(has(p.supply_oracle, (a) => a.family === 'PRODUCES' || a.family === 'ENABLES')).toBe(true);
      expect(p.supply_oracle).not.toBe(p.demand_oracle);
    }
  });

  it('shared_term: both cards have the term in their atom quotes, and no term is on more than the share limit', () => {
    const terms = cardTerms(realDb, d, realCorpusId, loadPacketPolicy());
    const cardsWith = (t: string) => d.cards.filter((c) => terms.get(c)!.has(t)).length;
    const pairs = take(gens.shared_term, 20);
    expect(pairs.length).toBe(20);
    for (const p of pairs) {
      expect(terms.get(p.supply_oracle)!.has(p.basis!)).toBe(true);
      expect(terms.get(p.demand_oracle)!.has(p.basis!)).toBe(true);
      expect(cardsWith(p.basis!)).toBeLessThanOrEqual(policy.golden.shared_term_max_share * d.scope.length);
    }
  });

  it('interaction: card A has an INTERACTION atom, card B a CARES_ABOUT atom', () => {
    for (const p of take(gens.interaction, 10)) {
      expect(has(p.supply_oracle, (a) => a.family === 'INTERACTION')).toBe(true);
      expect(has(p.demand_oracle, (a) => a.family === 'CARES_ABOUT')).toBe(true);
    }
  });

  it('param_gap: card B has a CARES_ABOUT atom with params (D11), card A an atom of a type with no params', () => {
    const schema = (realDb.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number }).v;
    const noParams = new Set((realDb.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?')
      .all(schema) as Array<{ family: string; type_key: string; params_schema: string }>)
      .filter((t) => Object.keys((JSON.parse(t.params_schema) as { properties?: object }).properties ?? {}).length === 0)
      .map((t) => `${t.family}.${t.type_key}`));
    for (const p of take(gens.param_gap, 10)) {
      expect(has(p.demand_oracle, (a) => a.family === 'CARES_ABOUT' && Object.keys(a.params).length > 0)).toBe(true);
      expect(has(p.supply_oracle, (a) => noParams.has(`${a.family}.${a.type_key}`))).toBe(true);
    }
  });

  it('unrecorded_restriction: card B has a CARES_ABOUT quote that contains a subtype of the CR subtype lists', () => {
    const subtypes = new Set([...crSubtypeLists(realDb, realCorpusId).values()].flat());
    const pairs = take(gens.unrecorded_restriction, 10);
    expect(pairs.length).toBe(10);
    for (const p of pairs) {
      expect(subtypes.has(p.basis!)).toBe(true);
      expect(d.atoms.get(p.demand_oracle)!.some((a) => a.family === 'CARES_ABOUT' && a.quote.includes(p.basis!))).toBe(true);
    }
    // M2: card A alternates, so the first pairs have both kinds of card A.
    const lines = realDb.prepare('SELECT type_line FROM card_faces WHERE oracle_id = ?');
    const member = (p: PairCandidate) => (lines.all(p.supply_oracle) as Array<{ type_line: string }>)
      .some((f) => f.type_line.includes('—') && f.type_line.slice(f.type_line.indexOf('—')).includes(p.basis!));
    expect(pairs.filter(member).length).toBeGreaterThan(0);
    expect(pairs.filter((p) => !member(p)).length).toBeGreaterThan(0);
  });

  it('random: two different slice cards, with or without atoms', () => {
    expect(d.scope.length).toBeGreaterThanOrEqual(d.cards.length);
    for (const p of take(gens.random, 10)) {
      expect(d.scope).toContain(p.supply_oracle);
      expect(d.scope).toContain(p.demand_oracle);
      expect(p.supply_oracle).not.toBe(p.demand_oracle);
    }
  });

  it('a round has round_size pairs from all six strata; the same round gives the same pairs, a different round different pairs', () => {
    const a = sampleRound(realDb, 1, policy, { slice: d });
    const b = sampleRound(realDb, 1, policy, { slice: d });
    const c = sampleRound(realDb, 2, policy, { slice: d });
    expect(a).toHaveLength(policy.golden.round_size);
    expect(b).toEqual(a);
    expect(c.map(key)).not.toEqual(a.map(key));
    expect(new Set(a.map(key)).size).toBe(a.length);
    expect(new Set(a.map((p) => p.stratum))).toEqual(new Set(['demand_type', 'shared_term', 'interaction', 'param_gap', 'unrecorded_restriction', 'random']));
  });
});

const describeCopy = existsSync(DB_PATH) && realDb ? describe : describe.skip;

describeCopy('golden rounds on a scratch copy of the real database', () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'golden-select-'));
    const scratch = join(dir, 'app.db');
    copyFileSync(DB_PATH, scratch);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, scratch + ext);
    db = openDb(scratch);
    db.exec('DELETE FROM edge_golden_pairs');
  });
  afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('no pair of a later round repeats a pair of an earlier round, in either direction; a round is written one time', () => {
    const policy = loadGraphPolicy();
    const slice = loadSlice(db);
    const r1 = sampleRound(db, 1, policy, { slice });
    const ids = persistRound(db, 1, r1);
    expect(ids).toHaveLength(r1.length);
    expect(() => persistRound(db, 1, r1)).toThrow(/already sampled/);
    expect(sampleRound(db, 1, policy, { slice })).toEqual(r1);       // round 1 does not exclude itself
    const r2 = sampleRound(db, 2, policy, { slice });
    const earlier = new Set(r1.map(key));
    expect(r2.filter((p) => earlier.has(key(p)))).toEqual([]);
    // M3: round 2 continues the demand_type key order where round 1 stopped.
    const keys = demandTypeKeys(slice);
    const done = r1.filter((p) => p.stratum === 'demand_type').length;
    expect(r2.find((p) => p.stratum === 'demand_type')!.basis).toBe(keys[done % keys.length]);
    const row = db.prepare('SELECT status, oracle_hashes FROM edge_golden_pairs WHERE id = ?').get(ids[0]!) as { status: string; oracle_hashes: string };
    expect(row.status).toBe('sampled');
    expect(JSON.parse(row.oracle_hashes)).toHaveLength(2);
  });
});
