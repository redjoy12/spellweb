import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/client.js';
import { parseComprehensiveRules } from '../src/rules/parse.js';
import { buildKeywordMap, persistCorpus } from '../src/rules/lookup.js';
import { buildTypeRuleMap } from '../src/rules/typemap.js';
import {
  assemblePacket, assembleScopedPacket, loadCorePacketConfig, renderRule, resetConfigCache,
  type CorePacketConfig,
} from '../src/rules/packet.js';

let db: DatabaseSync;

beforeAll(() => {
  resetConfigCache();
  db = openDb(':memory:');
  const corpus = parseComprehensiveRules(readFileSync('tests/fixtures/cr.sample.txt', 'utf8'));
  const map = buildKeywordMap(corpus, ['Deathtouch', 'Landwalk', 'Delirium'], new Set(['delirium']));
  persistCorpus(db, {
    sourceUri: 'u', sha256: 'd'.repeat(64), corpus,
    keywordMap: map, typeMap: buildTypeRuleMap(corpus),
  });

  db.prepare(
    `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
     VALUES ('t','u','t',datetime('now'),'complete')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
       rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
     VALUES (?,?,?,2,?,'[]','[]',?,'common','aaa','1','h',1,1,0)`,
  );
  ins.run('deadly', 'Deadly Thing', 'normal', 'Creature - Snake', JSON.stringify(['Deathtouch']));
  ins.run('plain', 'Plain Thing', 'normal', 'Creature - Bear', JSON.stringify([]));
  ins.run('weird', 'Weird Thing', 'normal', 'Creature - Horror', JSON.stringify(['Delirium', 'Fakewalk']));
  ins.run('classy', 'Classy Thing', 'class', 'Enchantment - Class', JSON.stringify([]));
  ins.run('sagey', 'Saga Thing', 'saga', 'Enchantment - Saga', JSON.stringify([]));
  ins.run('gear', 'Gear Thing', 'normal', 'Artifact - Equipment', JSON.stringify([]));

  db.prepare(
    `INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors)
     VALUES (?,?,?,?,?,?)`,
  ).run('deadly', 0, 'Deadly Thing', 'Creature - Snake', 'This creature has deathtouch.', '[]');
});

describe('loadCorePacketConfig', () => {
  it('no longer authors which sections every card receives - the kernel is derived', () => {
    const raw = JSON.parse(readFileSync('config/core-packet.json', 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('core_sections');
    expect(Object.keys(loadCorePacketConfig())).toEqual(['layout_aliases']);
  });

  it('authors English aliases but no rule numbers for card forms', () => {
    const cfg = loadCorePacketConfig();
    expect(cfg.layout_aliases['prepare']).toBe('Preparation');
    expect(JSON.stringify(cfg.layout_aliases)).not.toMatch(/\d{3}/);
  });
});

describe('assemblePacket', () => {
  it('has an empty core while this corpus has no kernel and no golden set', () => {
    const p = assemblePacket(db, 'deadly');
    expect(p.core).toEqual([]);
    expect(p.coreChars).toBe(0);
    expect(p.missingRules).toEqual([]);
  });

  it('adds the keyword-ability section for each of the card\'s keywords', () => {
    const p = assemblePacket(db, 'deadly');
    const numbers = p.cardSpecific.map((s) => s.number);
    expect(numbers).toContain('702.2');
    const dt = p.cardSpecific.find((s) => s.number === '702.2')!;
    expect(dt.title).toBe('Deathtouch');
    expect(dt.rules.map((r) => r.number)).toContain('702.2a');
  });

  it('adds NOTHING card-specific for a vanilla creature', () => {
    const p = assemblePacket(db, 'plain');
    expect(p.cardSpecific).toHaveLength(0);
    expect(p.cardChars).toBe(0);
  });

  it('adds a derived subtype section when no kernel contains it', () => {
    const p = assemblePacket(db, 'gear');
    expect(p.cardSpecific.map((s) => s.number)).toContain('301.5');
    expect(p.suppressedAsCore).toEqual([]);
  });

  it('adds the subtype section derived from rule 205.3, with the right number', () => {
    const p = assemblePacket(db, 'classy');
    const numbers = p.cardSpecific.map((s) => s.number);
    expect(numbers).toContain('716');
    expect(numbers).not.toContain('717');
    expect(p.cardSpecific.find((s) => s.number === '716')!.title).toBe('Class Cards');
  });

  it('adds the card-form section derived from the Scryfall layout', () => {
    const p = assemblePacket(db, 'sagey');
    expect(p.cardSpecific.map((s) => s.number)).toContain('714');
    expect(p.unmappedLayouts).toEqual([]);
  });

  it('does not add the same section twice when subtype and layout agree', () => {
    const p = assemblePacket(db, 'sagey');
    const numbers = p.cardSpecific.map((s) => s.number);
    expect(numbers.filter((n) => n === '714')).toHaveLength(1);
  });

  it('reports unresolved keywords instead of silently dropping them', () => {
    const p = assemblePacket(db, 'weird');
    expect(p.unresolvedKeywords).toContain('Fakewalk');
  });

  it('does not treat an ability word as unresolved', () => {
    const p = assemblePacket(db, 'weird');
    expect(p.unresolvedKeywords).not.toContain('Delirium');
  });

  it('never emits a section number absent from the corpus', () => {
    const p = assemblePacket(db, 'deadly');
    const known = new Set(
      (db.prepare('SELECT number FROM rule_sections').all() as any[]).map((r) => r.number),
    );
    for (const s of [...p.core, ...p.cardSpecific]) {
      const root = s.number.split('.')[0]!;
      expect(known.has(s.number) || known.has(root)).toBe(true);
    }
  });

  it('throws a clear error when no current corpus exists', () => {
    const empty = openDb(':memory:');
    expect(() => assemblePacket(empty, 'anything')).toThrow(/corpus/i);
  });

  it('throws a clear error when the oracle_id matches no card', () => {
    expect(() => assemblePacket(db, 'no-such-id')).toThrow(/oracle_id/);
  });

  it('reports a layout with no alias in unmappedLayouts', () => {
    db.prepare(
      `INSERT INTO cards (oracle_id,name,layout,cmc,type_line,colors,color_identity,keywords,
         rarity,set_code,collector_number,oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
       VALUES ('mystery','Mystery Thing','mystery',2,'Creature - Mystery','[]','[]','[]','common','aaa','1','h',1,1,0)`,
    ).run();
    expect(assemblePacket(db, 'mystery').unmappedLayouts).toContain('mystery');
  });

  it('honours an injected config - the layout alias map is the only thing it authors', () => {
    const real = loadCorePacketConfig();
    const noSaga: CorePacketConfig = { layout_aliases: { ...real.layout_aliases, saga: 'No Such Form' } };
    expect(assemblePacket(db, 'sagey', noSaga).unmappedLayouts).toEqual(['saga']);
  });

  describe('with a persisted kernel', () => {
    beforeAll(() => {
      db.prepare(
        `INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence)
         VALUES ((SELECT id FROM rules_corpus WHERE is_current = 1), ?, 'golden_citation', 'test')`,
      ).run('301');
      db.prepare(
        `INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence)
         VALUES ((SELECT id FROM rules_corpus WHERE is_current = 1), ?, 'golden_citation', 'test')`,
      ).run('999.1z');
    });
    afterAll(() => {
      db.prepare('DELETE FROM packet_kernel').run();
    });

    it('sends the kernel as the core of every card, identically', () => {
      const a = assemblePacket(db, 'deadly');
      const b = assemblePacket(db, 'plain');
      expect(a.core.map((s) => s.number)).toEqual(['301']);
      expect(b.core).toEqual(a.core);
      expect(a.coreChars).toBe(b.coreChars);
      expect(a.coreChars).toBeGreaterThan(0);
    });

    it('suppresses a derived section the kernel contains - by containment, not membership', () => {
      const p = assemblePacket(db, 'gear');
      expect(p.suppressedAsCore).toContain('301.5');
      expect(p.cardSpecific.map((s) => s.number)).not.toContain('301.5');
    });

    it('reports a kernel row absent from the corpus in missingRules instead of swallowing it', () => {
      expect(assemblePacket(db, 'deadly').missingRules).toEqual(['999.1z']);
      expect(assembleScopedPacket(db, 'deadly').missingKernelRules).toEqual(['999.1z']);
    });

    it('prefixes the scoped packet with the kernel, and sends nothing the kernel contains twice', () => {
      const p = assembleScopedPacket(db, 'gear');
      expect(p.kernelRules).toEqual(['301']);
      expect(p.sections[0]!.number).toBe('301');
      expect(p.sections.map((s) => s.number)).not.toContain('301.5');
    });
  });
});

describe('assembleScopedPacket', () => {
  it('returns matched sections for a card with real oracle text', () => {
    const p = assembleScopedPacket(db, 'deadly');
    expect(p.sections.length).toBeGreaterThan(0);
    expect(p.sections.map((s) => s.number)).toContain('702.2');
    expect(p.matchedTerms.some((t) => t.term_key === 'deathtouch')).toBe(true);
  });

  it('has no kernel rules while this corpus has no kernel and no golden set', () => {
    expect(assembleScopedPacket(db, 'deadly').kernelRules).toEqual([]);
  });

  it('counts exactly what it renders: its sections plus matched glossary definitions', () => {
    const p = assembleScopedPacket(db, 'deadly');
    const defs = p.matchedTerms.reduce((n, m) => n + (m.definition?.length ?? 0), 0);
    expect(p.selectedChars).toBeGreaterThan(0);
    expect(p.selectedChars).toBe(p.sections.reduce((n, s) => n + s.chars, 0) + defs);
  });

  it('adds the card-form rule derived from the Scryfall layout, same as assemblePacket', () => {
    const p = assembleScopedPacket(db, 'sagey');
    expect(p.sections.map((s) => s.number)).toContain('714');
  });
});

describe('renderRule without subrules (Phase 3 spec rev. 6 sec. 5.2 item 2)', () => {
  const corpusId = () => (db.prepare('SELECT id FROM rules_corpus').get() as { id: number }).id;
  /** A numbered rule "NNN.N" that has text and lettered subrules with text, from the fixture. */
  const ruleWithLetters = () => db.prepare(
    `SELECT p.number, p.section_number FROM rules p
      WHERE p.corpus_id = ? AND p.text <> '' AND p.number NOT GLOB '*[a-z]'
        AND EXISTS (SELECT 1 FROM rules c WHERE c.corpus_id = p.corpus_id AND c.subsection_number = p.number
                      AND c.number GLOB '*[a-z]' AND c.text <> '')
      ORDER BY p.ordinal LIMIT 1`,
  ).get(corpusId()) as { number: string; section_number: string };

  it('gives the rule "NNN.N" alone', () => {
    const r = ruleWithLetters();
    expect(renderRule(db, corpusId(), r.number)!.rules.length).toBeGreaterThan(1);
    expect(renderRule(db, corpusId(), r.number, { subrules: false })!.rules.map((x) => x.number)).toEqual([r.number]);
  });

  it('gives a section as its numbered rules, without lettered subrules', () => {
    const { section_number: s } = ruleWithLetters();
    const got = renderRule(db, corpusId(), s, { subrules: false })!.rules.map((x) => x.number);
    const want = (db.prepare(
      `SELECT number FROM rules WHERE corpus_id = ? AND section_number = ? AND text <> '' AND number NOT GLOB '*[a-z]' ORDER BY ordinal`,
    ).all(corpusId(), s) as Array<{ number: string }>).map((x) => x.number);
    expect(got).toEqual(want);
    expect(got.some((n) => /[a-z]$/.test(n))).toBe(false);
  });

  it('gives a title row (no text of its own) with its subrules', () => {
    const title = db.prepare(
      `SELECT p.number FROM rules p WHERE p.corpus_id = ? AND p.text = '' AND p.number NOT GLOB '*[a-z]'
          AND EXISTS (SELECT 1 FROM rules c WHERE c.corpus_id = p.corpus_id AND c.subsection_number = p.number AND c.text <> '')
        LIMIT 1`,
    ).get(corpusId()) as { number: string };
    const want = (db.prepare(
      "SELECT number FROM rules WHERE corpus_id = ? AND subsection_number = ? AND text <> '' ORDER BY ordinal",
    ).all(corpusId(), title.number) as Array<{ number: string }>).map((x) => x.number);
    expect(want.length).toBeGreaterThan(0);
    expect(renderRule(db, corpusId(), title.number, { subrules: false })!.rules.map((x) => x.number)).toEqual(want);
  });

  it('does not change a lettered rule', () => {
    const lettered = (db.prepare(
      "SELECT number FROM rules WHERE corpus_id = ? AND number GLOB '*[a-z]' AND text <> '' LIMIT 1",
    ).get(corpusId()) as { number: string }).number;
    expect(renderRule(db, corpusId(), lettered, { subrules: false })).toEqual(renderRule(db, corpusId(), lettered));
  });
});
