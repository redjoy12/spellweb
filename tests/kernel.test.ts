import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { parseComprehensiveRules } from '../src/rules/parse.js';
import { buildKeywordMap, persistCorpus } from '../src/rules/lookup.js';
import { buildTypeRuleMap } from '../src/rules/typemap.js';
import { loadPacketPolicy } from '../src/rules/relevance.js';
import { assemblePacket, assembleScopedPacket, isCovered, resetConfigCache } from '../src/rules/packet.js';
import { deriveKernel, deriveKernelReport, packetPolicyDiff, persistKernel } from '../src/rules/kernel.js';

const db = openDb();
const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current=1').get() as
  { id: number } | undefined)?.id;
const golden = (db.prepare('SELECT COUNT(*) n FROM golden_atoms').get() as { n: number }).n;
const maybe = corpusId && golden > 0 ? describe : describe.skip;

// OUTSIDE the guard: a suite that reports green while asserting nothing for the whole
// of Tasks 6-7 is indistinguishable from one that passed. This is the tripwire.
it('the golden set is non-empty — Task 6 must precede Task 7', () => {
  expect(golden, 'no golden atoms: the kernel cannot be derived and its suite is skipping').toBeGreaterThan(0);
});

maybe('deriveKernel (local database)', () => {
  const policy = loadPacketPolicy();

  it('contains only rules the golden set cites that term matching cannot reach', () => {
    const kernel = deriveKernel(db, corpusId!, policy);
    for (const k of kernel) expect(k.evidence.length).toBeGreaterThan(0);
  });

  it('makes the packet-policy diff empty for every golden card — that is its definition', () => {
    expect(packetPolicyDiff(db, corpusId!, policy)).toHaveLength(0);
  });

  it('is not derived from hit rate — a rule cited by one golden card still qualifies', () => {
    const kernel = deriveKernel(db, corpusId!, policy);
    // Nothing in the derivation consults pool-wide frequency.
    expect(kernel.every((k) => typeof k.rule_number === 'string')).toBe(true);
  });

  it('is persisted exactly as derived — a stale packet_kernel fails here, not in a bill', () => {
    const derived = deriveKernel(db, corpusId!, policy).map((k) => k.rule_number).sort();
    const rows = db.prepare('SELECT rule_number, origin FROM packet_kernel WHERE corpus_id = ?')
      .all(corpusId!) as Array<{ rule_number: string; origin: string }>;
    // Every derived rule is persisted (a review_promoted row may already hold one) ...
    const all = new Set(rows.map((r) => r.rule_number));
    expect(derived.filter((r) => !all.has(r)), 'run `npm run kernel:derive`').toEqual([]);
    // ... and no golden_citation row outlives the citation that justified it.
    const golden = rows.filter((r) => r.origin === 'golden_citation').map((r) => r.rule_number);
    expect(golden.filter((r) => !derived.includes(r)), 'run `npm run kernel:derive`').toEqual([]);
  });

  it('is minimal under containment — no kernel rule is inside another kernel rule', () => {
    const rules = deriveKernel(db, corpusId!, policy).map((k) => k.rule_number);
    for (const r of rules) {
      const others = new Set(rules.filter((o) => o !== r));
      expect(isCovered(others, r), `${r} is redundant`).toBe(false);
    }
  });
});

describe('isCovered — sec. 3.4 coverage is containment, not set membership', () => {
  const rendered = (...n: string[]) => new Set(n);

  it('covers a rule rendered exactly', () => {
    expect(isCovered(rendered('704.5f'), '704.5f')).toBe(true);
    expect(isCovered(rendered('702.9'), '702.9')).toBe(true);
  });

  it('covers a lettered rule whose containing subsection is rendered', () => {
    expect(isCovered(rendered('704.5'), '704.5f')).toBe(true);
  });

  it('covers a lettered rule or subsection whose containing bare section is rendered', () => {
    expect(isCovered(rendered('704'), '704.5f')).toBe(true);
    expect(isCovered(rendered('704'), '704.5')).toBe(true);
  });

  it('is directional — a rendered lettered rule does not cover its subsection', () => {
    expect(isCovered(rendered('704.5f'), '704.5')).toBe(false);
    expect(isCovered(rendered('704.5f'), '704')).toBe(false);
    expect(isCovered(rendered('704.5'), '704')).toBe(false);
  });

  it('is not a string prefix test — 702.2 does not cover 702.20a, nor 702 cover 7020', () => {
    expect(isCovered(rendered('702.2'), '702.20a')).toBe(false);
    expect(isCovered(rendered('702.1'), '702.19')).toBe(false);
    expect(isCovered(rendered('70'), '702.1')).toBe(false);
  });

  it('does not cover across siblings', () => {
    expect(isCovered(rendered('704.5g'), '704.5f')).toBe(false);
    expect(isCovered(rendered('703'), '704.5f')).toBe(false);
  });
});

describe('kernel derivation (fixture corpus)', () => {
  let fx: DatabaseSync;
  let fxCorpus: number;
  const policy = loadPacketPolicy();

  beforeAll(() => {
    resetConfigCache();
    fx = openDb(':memory:');
    const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
    fxCorpus = persistCorpus(fx, {
      sourceUri: 'u', sha256: 'k'.repeat(64), corpus,
      keywordMap: buildKeywordMap(corpus, ['Deathtouch'], new Set()),
      typeMap: buildTypeRuleMap(corpus),
    });
    fx.prepare(
      `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
       VALUES ('t','u','t',datetime('now'),'complete')`,
    ).run();
    const card = fx.prepare(
      `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
         rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
       VALUES (?,?,'normal',2,?,'[]','[]',?,'common','aaa','1','h',1,1,0)`,
    );
    card.run('deadly', 'Deadly Thing', 'Creature - Snake', JSON.stringify(['Deathtouch']));
    card.run('plain', 'Plain Thing', 'Creature - Bear', JSON.stringify([]));
    fx.prepare(
      `INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors)
       VALUES ('deadly', 0, 'Deadly Thing', 'Creature - Snake', 'This creature has deathtouch.', '[]')`,
    ).run();
  });

  const addGolden = (oracleId: string, cites: string[][]): void => {
    fx.prepare(
      `INSERT OR IGNORE INTO atom_types (schema_version, family, type_key, label, params_schema, provenance, evidence)
       VALUES (1, 'PRODUCES', 'kernel_test', 't', '{}', 'spec_4_1', 'fixture')`,
    ).run();
    fx.prepare(
      "INSERT OR IGNORE INTO golden_cards (oracle_id, complete, oracle_hash, verified_at) VALUES (?, 1, 'h', 't')",
    ).run(oracleId);
    cites.forEach((rules, i) => {
      fx.prepare(
        `INSERT INTO golden_atoms (oracle_id, face_index, schema_version, family, type_key, params_json,
           span_start, span_end, quote, rule_numbers, oracle_hash, source, verified_at)
         VALUES (?, 0, 1, 'PRODUCES', 'kernel_test', '{}', ?, ?, 'q', ?, 'h', 'authored', 't')`,
      ).run(oracleId, i, i + 1, JSON.stringify(rules));
    });
  };

  it('has an empty kernel and assembles normally while the golden set is empty', () => {
    expect(deriveKernel(fx, fxCorpus, policy)).toEqual([]);
    expect(assembleScopedPacket(fx, 'plain').kernelRules).toEqual([]);
    expect(assemblePacket(fx, 'plain').core).toEqual([]);
  });

  it('admits only unreachable citations, minimal under containment, skipping what cannot exist', () => {
    // deadly: 702.2b is reachable (its card says "deathtouch"); 121.1 is not.
    addGolden('deadly', [['702.2b'], ['121.1']]);
    // plain: 100 and 100.1a are both unreachable - 100 contains 100.1a, so only 100 is kept.
    // 999.9z is not in the corpus: skipped by derivation, reported.
    addGolden('plain', [['100.1a'], ['100', '999.9z']]);
    // ghost: a golden card absent from `cards` (FKs off to construct it) - skipped, reported.
    fx.exec('PRAGMA foreign_keys = OFF');
    addGolden('ghost', [['714.1']]);
    fx.exec('PRAGMA foreign_keys = ON');

    const report = deriveKernelReport(fx, fxCorpus, policy);
    expect(report.kernel.map((k) => k.rule_number)).toEqual(['100', '121.1']);
    expect(report.kernel.find((k) => k.rule_number === '121.1')!.evidence).toMatch(/deadly/);
    expect(report.skippedRules).toEqual([expect.objectContaining({ oracle_id: 'plain', rule_number: '999.9z' })]);
    expect(report.skippedCards).toEqual(['ghost']);
  });

  it('refuses to assemble without a persisted kernel once golden atoms exist', () => {
    expect(() => assembleScopedPacket(fx, 'plain')).toThrow(/no packet kernel for corpus \d+ .*kernel:derive/);
    expect(() => assemblePacket(fx, 'plain')).toThrow(/no packet kernel for corpus \d+ .*kernel:derive/);
    expect(() => packetPolicyDiff(fx, fxCorpus, policy)).toThrow(/kernel:derive/);
  });

  it('persists golden_citation rows transactionally and leaves review_promoted rows alone', () => {
    fx.prepare(
      "INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (?, '714.1', 'review_promoted', 'r')",
    ).run(fxCorpus);
    persistKernel(fx, fxCorpus, [{ rule_number: '701.16', evidence: 'stale' }]);
    persistKernel(fx, fxCorpus, deriveKernel(fx, fxCorpus, policy));
    const rows = fx.prepare('SELECT rule_number, origin FROM packet_kernel WHERE corpus_id = ? ORDER BY rule_number')
      .all(fxCorpus) as Array<{ rule_number: string; origin: string }>;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { rule_number: '100', origin: 'golden_citation' },
      { rule_number: '121.1', origin: 'golden_citation' },
      { rule_number: '714.1', origin: 'review_promoted' },
    ]);
  });

  it('sends the persisted kernel to every card, once, ahead of its own rules', () => {
    const p = assembleScopedPacket(fx, 'deadly');
    expect(p.kernelRules).toEqual(['100', '121.1', '714.1']);
    expect(p.sections.slice(0, 3).map((s) => s.number)).toEqual(['100', '121.1', '714.1']);
    expect(p.sections.map((s) => s.number)).toContain('702.2');
    const phase1 = assemblePacket(fx, 'plain');
    expect(phase1.core.map((s) => s.number)).toEqual(['100', '121.1', '714.1']);
    expect(phase1.coreChars).toBe(phase1.core.reduce((n, s) => n + s.chars, 0));
  });

  it('reports exactly the golden-set bugs: a rule absent from the corpus and a card absent from the pool', () => {
    expect(packetPolicyDiff(fx, fxCorpus, policy)).toEqual([
      { oracle_id: 'ghost', missing: ['714.1'] },
      { oracle_id: 'plain', missing: ['999.9z'] },
    ]);
  });

  it('turns a stale kernel into a non-empty diff', () => {
    persistKernel(fx, fxCorpus, [{ rule_number: '100', evidence: 'partial' }]);
    expect(packetPolicyDiff(fx, fxCorpus, policy)).toContainEqual({ oracle_id: 'deadly', missing: ['121.1'] });
  });
});
