import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { loadPacketPolicy, matchTerms, measureBottomDecile, reachableRules } from '../src/rules/relevance.js';
import { parseComprehensiveRules } from '../src/rules/parse.js';
import { buildKeywordMap, persistCorpus } from '../src/rules/lookup.js';
import { buildTypeRuleMap } from '../src/rules/typemap.js';

const db = openDb();
const corpusId = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as
  { id: number } | undefined)?.id;
const maybe = corpusId ? describe : describe.skip;
const policy = loadPacketPolicy();

maybe('matchTerms', () => {
  it('anchors on word boundaries — "player" must not match the term "layer"', () => {
    const hits = matchTerms(db, corpusId!, 'Each player draws a card.', policy);
    expect(hits.map((h) => h.term_key)).not.toContain('layer');
  });

  it('strips an e-final past tense - "created", "exiled", "sacrificed" match their bare terms (Task 11, R11-7)', () => {
    // Run 9: a card whose only form was "are created" never reached the create rule, and its extractor
    // borrowed that rule from another card in the batch (a cross_card_citation rejection).
    const keys = (t: string) => new Set(matchTerms(db, corpusId!, t, policy).map((h) => h.term_key));
    expect(keys('those tokens plus a Clue token are created instead.')).toContain('create');
    expect(keys('Return the exiled card to the battlefield.')).toContain('exile');
    expect(keys('Whenever a creature is sacrificed, scry 1.')).toContain('sacrifice');
  });

  it('strips inflections — "attacks" matches the bare term', () => {
    const hits = matchTerms(db, corpusId!, 'Whenever this creature attacks, draw a card.', policy);
    expect(hits.some((h) => h.term_key === 'attack' || h.term_key === 'attacking')).toBe(true);
  });

  it('resolves a multi-word term', () => {
    const hits = matchTerms(db, corpusId!, 'Target creature gains first strike until end of turn.', policy);
    // normalizeTermKey collapses whitespace but does NOT remove it - the key is
    // 'first strike', not 'firststrike'. Two rows resolve (glossary + subsection title).
    expect(hits.map((h) => h.term_key)).toContain('first strike');
  });

  it('keeps the INNER term of a nesting pair — an outer term does not subsume it', () => {
    // 'any target' nests 'target'. Their rules are different, so both must survive.
    // Token-claiming would drop the inner one; that cost a rule on 24% of the pool.
    const hits = matchTerms(db, corpusId!, 'This spell deals 3 damage to any target.', policy);
    const keys = hits.map((h) => h.term_key);
    expect(keys).toContain('any target');
    expect(keys).toContain('target');
  });

  it('keeps CR 106 on cards that only say "mana value"', () => {
    // 'mana value' nests 'mana'. Claiming dropped the mana rules from 419 cards.
    const hits = matchTerms(db, corpusId!, 'Exile a card with mana value 3 or less.', policy);
    expect(hits.map((h) => h.term_key)).toContain('mana');
  });

  it('attributes the longest surface form to a term found inside a longer phrase', () => {
    const hits = matchTerms(db, corpusId!, 'This spell deals 3 damage to any target.', policy);
    expect(hits.find((h) => h.term_key === 'any target')?.surface).toBe('any target');
  });

  it('reports the matched surface form, not just the canonical term', () => {
    const hits = matchTerms(db, corpusId!, 'Whenever this creature attacks, draw a card.', policy);
    const attack = hits.find((h) => h.surface.toLowerCase().startsWith('attack'));
    expect(attack?.surface).toBe('attacks');
  });

  it('returns nothing for text with no rules vocabulary', () => {
    expect(matchTerms(db, corpusId!, 'zzz qqq', policy)).toHaveLength(0);
  });

  it('expands cross-references and respects crossref_depth', () => {
    // ORDER BY: LIMIT 1 with no ordering is not a stable subject - re-review finding 4.
    const card = db.prepare('SELECT oracle_id FROM cards ORDER BY oracle_id LIMIT 1').get() as
      { oracle_id: string };
    const at0 = reachableRules(db, corpusId!, card.oracle_id, { ...policy, crossref_depth: 0 });
    const at1 = reachableRules(db, corpusId!, card.oracle_id, { ...policy, crossref_depth: 1 });
    expect(at1.rules.size).toBeGreaterThanOrEqual(at0.rules.size);
    for (const r of at0.rules) expect(at1.rules.has(r)).toBe(true);   // depth 1 is a superset
  });
});

/**
 * Review finding 1 + finding 4: the real corpus doesn't give deterministic, hand-checkable
 * control over which rule shapes seed the frontier (bare section vs. bare subsection vs.
 * lettered subrule). This block builds its own tiny corpus from the shared parse fixture
 * (already exercised in packet.test.ts / rules-parse.test.ts) so each shape can be pinned
 * independently, with a card crafted to seed exactly one of them.
 */
describe('reachableRules — cross-reference expansion (synthetic corpus)', () => {
  let sdb: DatabaseSync;
  let sCorpusId: number;
  const spolicy = loadPacketPolicy();

  beforeAll(() => {
    sdb = openDb(':memory:');
    const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
    sCorpusId = persistCorpus(sdb, {
      sourceUri: 'u', sha256: 'r'.repeat(64), corpus,
      keywordMap: buildKeywordMap(corpus, [], new Set()),
      typeMap: buildTypeRuleMap(corpus),
    });

    sdb.prepare(
      `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
       VALUES ('t','u','t',datetime('now'),'complete')`,
    ).run();
    const ins = sdb.prepare(
      `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
         rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
       VALUES (?,?,'normal',2,?,'[]','[]','[]','common','aaa','1','h',1,1,0)`,
    );
    const insFace = sdb.prepare(
      `INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors)
       VALUES (?,0,?,?,?,'[]')`,
    );

    // Seeds a lettered rule (205.3g) via a glossary term - "Long Dash" cites it, and
    // 205.3g's own text cites 717/301.5/301.6/301.7. Finding 1: subsectionText's
    // `subsection_number = ?` filter never matches a lettered number (that column is
    // always bare "NNN.M"), so this seed must still expand at depth 1.
    ins.run('lettered-seed', 'Lettered Seed', 'Artifact');
    insFace.run('lettered-seed', 'Lettered Seed', 'Artifact',
      'This permanent cares about the long dash on a type line.');

    // Seeds a bare, titled subsection (702.444, "Testlink") via its subsection-title term.
    // Its own subrule 702.444a cites rule 100 in plain text - a case the existing
    // (unfixed) code already handles correctly, and this pins that it keeps working.
    ins.run('subsection-seed', 'Subsection Seed', 'Artifact');
    insFace.run('subsection-seed', 'Subsection Seed', 'Artifact', 'This permanent has testlink.');

    // Seeds a bare SECTION (717, via the "Attraction" subtype cross-reference) with no dot.
    // 717.1's own text DOES cite something ("See rule 100") precisely so this test can
    // discriminate: a bare section must never cascade at all (see relevance.ts's comment
    // on why), regardless of what its rows say. If the guard were ever weakened back to
    // the original section-keyed query, this seed would pull in rule 100 at depth 1 and
    // the exact-set assertion below would catch it.
    ins.run('section-seed', 'Section Seed', 'Artifact');
    insFace.run('section-seed', 'Section Seed', 'Artifact', 'This permanent is an Attraction.');
  });

  it('finding 1: expands a lettered-rule seed (205.3g) to the rules its own text cites', () => {
    const at0 = reachableRules(sdb, sCorpusId, 'lettered-seed', { ...spolicy, crossref_depth: 0 });
    expect(at0.rules.has('205.3g')).toBe(true);
    expect(at0.rules.has('717')).toBe(false);   // not yet, before expansion

    // Exact set, not membership: 205.3g sits in section 205 next to sibling lettered
    // subrule 205.3h, which cites an entirely disjoint set of rules (303.4/719/716/
    // 303.7/714, the enchantment-type cross-refs - 205.3g is the artifact-type one).
    // A membership check on 717/301.5 alone would not notice if expansion scanned all
    // of section 205 instead of just 205.3g's own row - those two would still be
    // present and the checks would pass even though 205.3h's unrelated citations had
    // also leaked in. Pinning the exact set catches that.
    const at1 = reachableRules(sdb, sCorpusId, 'lettered-seed', { ...spolicy, crossref_depth: 1 });
    expect(at1.rules).toEqual(new Set([...at0.rules, '717', '301.5', '301.6', '301.7']));
  });

  it('finding 4: a bare titled SUBSECTION in the seed set expands at depth 1, not depth 0', () => {
    const at0 = reachableRules(sdb, sCorpusId, 'subsection-seed', { ...spolicy, crossref_depth: 0 });
    expect(at0.rules.has('702.444')).toBe(true);
    expect(at0.rules.has('100')).toBe(false);

    // Exact set, not membership: 702.444 sits in section 702 alongside sibling
    // subsections 702.2/702.14/702.186 that cite nothing. A membership check alone
    // would not notice if expansion scanned the whole section instead of just
    // 702.444's own rows - it would still find '100' and pass. Pinning the exact
    // set means any such over-scan that pulled in a sibling's rules would fail here.
    const at1 = reachableRules(sdb, sCorpusId, 'subsection-seed', { ...spolicy, crossref_depth: 1 });
    expect(at1.rules).toEqual(new Set([...at0.rules, '100']));
  });

  it('finding 4: a bare SECTION (no dot) in the seed set contributes no expansion at any depth', () => {
    const at0 = reachableRules(sdb, sCorpusId, 'section-seed', { ...spolicy, crossref_depth: 0 });
    expect(at0.rules.has('717')).toBe(true);
    expect(at0.rules.has('100')).toBe(false);

    // Exact-set assertion, not membership: 717.1's text cites rule 100, so if the
    // `continue` guard (or the subsection/number-keyed query it backs up) were ever
    // weakened, '100' would leak into this set and this equality would fail. A
    // membership check (`.has('100')).toBe(false)` alone would not catch an
    // over-expansion that added extra unrelated rules without removing '717'.
    const at1 = reachableRules(sdb, sCorpusId, 'section-seed', { ...spolicy, crossref_depth: 1 });
    expect(at1.rules).toEqual(at0.rules);
    expect(at1.rules.has('100')).toBe(false);
  });
});

describe('measureBottomDecile (synthetic corpus)', () => {
  let sdb: DatabaseSync;
  let sCorpusId: number;
  const spolicy = loadPacketPolicy();
  const THIN = 'This permanent does nothing.';
  const THICK = 'This permanent has deathtouch and testlink.';

  beforeAll(() => {
    sdb = openDb(':memory:');
    const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
    sCorpusId = persistCorpus(sdb, {
      sourceUri: 'u', sha256: 'b'.repeat(64), corpus,
      keywordMap: buildKeywordMap(corpus, [], new Set()),
      typeMap: buildTypeRuleMap(corpus),
    });
    sdb.prepare(
      `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
       VALUES ('t','u','t',datetime('now'),'complete')`,
    ).run();
    const ins = sdb.prepare(
      `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
         rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
       VALUES (?,?,'normal',2,'Artifact','[]','[]','[]','common','aaa','1','h',1,1,?)`,
    );
    const insFace = sdb.prepare(
      `INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors)
       VALUES (?,0,?,'Artifact',?,'[]')`,
    );
    const card = (id: string, text: string, rotated = 0) => {
      ins.run(id, id, rotated);
      insFace.run(id, id, text);
    };
    // 10 live cards: three tied at the thin count, seven thick. floor(10 * 0.1) = 1,
    // so the threshold is the thin count and all three ties must be kept.
    card('thin-c', THIN); card('thin-a', THIN); card('thin-b', THIN);
    for (let i = 0; i < 7; i++) card(`thick-${i}`, THICK);
    // A rotated card is not in the pool, however thin its packet.
    card('rotated-thin', THIN, 1);
  });

  const countOf = (text: string) =>
    new Set(matchTerms(sdb, sCorpusId, `${text}\nArtifact`, spolicy).flatMap((h) => h.rule_numbers)).size;

  it('measures the non-rotated pool, keeps ties at the threshold, and sorts thinnest first', () => {
    const thin = countOf(THIN);
    expect(thin).toBeLessThan(countOf(THICK));   // precondition: the fixture discriminates

    const m = measureBottomDecile(sdb, sCorpusId, spolicy);
    expect(m.pool_size).toBe(10);
    expect(m.bottom_decile_index).toBe(1);
    expect(m.bottom_decile_threshold_rule_count).toBe(thin);
    expect(m.cards).toEqual(['thin-a', 'thin-b', 'thin-c'].map((id) => ({ oracle_id: id, name: id, rule_count: thin })));
  });
});
