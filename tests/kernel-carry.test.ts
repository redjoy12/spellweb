import { describe, it, expect } from 'vitest';
import { carryPromotedKernel, persistKernel } from '../src/rules/kernel.js';
import { fixtureWithClauses } from './helpers/fixture.js';

/** Corpus 1 (the fixture's) with a promoted and a derived kernel rule; corpus 2 is the CR refresh. */
function refreshed(newRules: string[]) {
  const db = fixtureWithClauses('Draw a card.');
  db.exec(`INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES
           (1, '704.5f', 'review_promoted', 'accepted missing-rule report #1'),
           (1, '603.1', 'review_promoted', 'accepted missing-rule report #2'),
           (1, '700.1', 'golden_citation', 'derived')`);
  db.exec("INSERT INTO rules_corpus (source_uri,effective_date,sha256,fetched_at,section_count,rule_count,glossary_count,is_current) VALUES ('u2','d2','s2','t',1,1,1,0)");
  const rule = db.prepare('INSERT INTO rules (corpus_id, number, section_number, subsection_number, text, ordinal) VALUES (2,?,?,?,?,?)');
  newRules.forEach((n, i) => rule.run(n, n.split('.')[0]!, null, `text of ${n}`, i));
  return db;
}
const kernelOf = (db: ReturnType<typeof refreshed>, corpus: number) =>
  db.prepare('SELECT rule_number, origin FROM packet_kernel WHERE corpus_id = ? ORDER BY rule_number').all(corpus);

describe('carryPromotedKernel', () => {
  it('carries review-promoted rules into the new corpus, and only those', () => {
    const db = refreshed(['704.5f', '603.1', '700.1']);
    expect(carryPromotedKernel(db, 2)).toEqual({ carried: ['603.1', '704.5f'], dropped: [] });
    expect(kernelOf(db, 2)).toEqual([
      { rule_number: '603.1', origin: 'review_promoted' },
      { rule_number: '704.5f', origin: 'review_promoted' },
    ]);
    expect(db.prepare("SELECT evidence FROM packet_kernel WHERE corpus_id = 2 AND rule_number = '704.5f'").get())
      .toEqual({ evidence: 'accepted missing-rule report #1 [carried from corpus 1]' });
  });

  it('reports a promoted rule the new corpus no longer has instead of carrying it', () => {
    const db = refreshed(['603.1']);
    expect(carryPromotedKernel(db, 2)).toEqual({ carried: ['603.1'], dropped: ['704.5f'] });
  });

  it('survives the re-derivation that follows it in sync:rules', () => {
    const db = refreshed(['704.5f', '603.1', '700.1']);
    carryPromotedKernel(db, 2);
    persistKernel(db, 2, [{ rule_number: '704.5f', evidence: 'derived' }, { rule_number: '700.1', evidence: 'derived' }]);
    expect(kernelOf(db, 2)).toEqual([
      { rule_number: '603.1', origin: 'review_promoted' },
      { rule_number: '700.1', origin: 'golden_citation' },
      { rule_number: '704.5f', origin: 'review_promoted' },
    ]);
  });

  it('is idempotent, and a no-op for the corpus the rows already live in', () => {
    const db = refreshed(['704.5f', '603.1']);
    carryPromotedKernel(db, 2);
    expect(carryPromotedKernel(db, 2)).toEqual({ carried: [], dropped: [] });
    expect(carryPromotedKernel(db, 1)).toEqual({ carried: [], dropped: [] });
  });
});
