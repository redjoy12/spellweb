import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import {
  answerFault, confirmedSame, crDebaterDir, crPairs, loadVerdicts, prepareCrRound, renderCrPacket, submitCrRound, type CrDebateItem,
} from '../src/graph/crDebate.js';
import { crDuplicates, withConfirmed } from '../src/rules/crDuplicates.js';
import { maybe } from './helpers/realDb.js';

// Synthetic pairs check the mechanics only (owner decision 2026-10-18, report sec. 11.4 step A).
const item: CrDebateItem = {
  key: 'k1',
  main: { source: 'rule', ref: '1.1', text: 'Each player may then shuffle their decks.' },
  member: { source: 'glossary', ref: 'Shuffle', text: 'A player may shuffle a deck.' },
};

describe('answerFault', () => {
  const ok = { choice: 'same', argument: 'Only the words differ.', evidence: [{ source: 'rule', ref: '1.1', quote: 'shuffle their decks' }] };
  it('accepts a choice with an argument and a verbatim quote from Text A or Text B', () => {
    expect(answerFault(item, ok)).toBeNull();
    expect(answerFault(item, { ...ok, evidence: [{ source: 'glossary', ref: 'shuffle', quote: 'A player may shuffle a deck.' }] })).toBeNull();
  });
  it('accepts a quote from Text B when both texts are sentences of one entry', () => {
    const one: CrDebateItem = { key: 'k2', main: { source: 'glossary', ref: 'Copy', text: 'First sentence here.' }, member: { source: 'glossary', ref: 'Copy', text: 'Second sentence here.' } };
    expect(answerFault(one, { choice: 'same', argument: 'a', evidence: [{ source: 'glossary', ref: 'Copy', quote: 'Second sentence' }] })).toBeNull();
  });
  it('refuses another option, no evidence, a quote from outside the item, or a quote that is not verbatim', () => {
    expect(answerFault(item, { ...ok, choice: 'maybe' })).toMatch(/not same or different/);
    expect(answerFault(item, { ...ok, evidence: [] })).toBe('no evidence');
    expect(answerFault(item, { ...ok, evidence: [{ source: 'rule', ref: '9.9', quote: 'shuffle' }] })).toMatch(/not Text A or Text B/);
    expect(answerFault(item, { ...ok, evidence: [{ source: 'rule', ref: '1.1', quote: 'shuffle all decks' }] })).toMatch(/not verbatim/);
  });
});

describe('renderCrPacket', () => {
  it('holds the instructions, the pairs, the options and the arguments of the previous round', () => {
    const p = renderCrPacket(2, 1, 3, [item], new Map([['k1', [{ debater: 1, choice: 'same', argument: 'Same words.' }]]]));
    expect(p).toContain('## Instructions');
    expect(p).toContain('- Text A (rule 1.1): "Each player may then shuffle their decks."');
    expect(p).toContain('- Text B (glossary Shuffle): "A player may shuffle a deck."');
    expect(p).toContain('- Options: same, different');
    expect(p).toContain('Debater A: choice same. Argument: Same words.');
    expect(p).toContain('## Answer format');
  });
});

/** A full round on a scratch copy of the real database and a scratch debate folder. */
maybe('a debate round (owner decision 2026-10-18)', () => {
  let db: DatabaseSync;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-debate-'));
    const file = join(dir, 'app.db');
    copyFileSync(DB_PATH, file);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, file + ext);
    db = openDb(file);
    db.exec('DELETE FROM owner_decisions');
  });
  afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('an item is agreed only when all three debaters select the same option with valid quotes', () => {
    const corpus = (db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number }).id;
    const pairs = crPairs(db, corpus);
    const root = join(dir, 'debate');
    const verdicts = join(dir, 'verdicts.json');
    const m = prepareCrRound(db, corpus, 1, root, pairs.length);
    expect(m.batches).toHaveLength(1);
    const [p1, p2, p3] = pairs;
    const quote = (p: CrDebateItem) => [{ source: p.main.source, ref: p.main.ref, quote: p.main.text }];
    for (let d = 1; d <= 3; d++) {
      const answers = pairs.map((p, i) => ({
        item: `D${String(i + 1).padStart(2, '0')}`,
        // p1: all same; p2: one debater says different; p3: one answer has a bad quote.
        choice: p === p2 && d === 3 ? 'different' : 'same',
        argument: 'From the two texts.',
        evidence: p === p3 && d === 2 ? [{ source: 'rule', ref: 'nothing', quote: 'x' }] : quote(p),
      }));
      writeFileSync(join(crDebaterDir(1, 1, d, root), 'response.json'), JSON.stringify({ answers }));
    }
    const r = submitCrRound(db, 1, root, verdicts);
    expect(r.missing).toEqual([]);
    expect(r.faults).toBe(1);
    const v = loadVerdicts(verdicts)!;
    expect(v.decided_by).toBe('debate');
    expect(v.items[p1!.key]!.verdict).toBe('same');
    expect(v.items[p2!.key]!.verdict).toBe('no_agreement');
    expect(v.items[p3!.key]!.verdict).toBe('no_agreement');
    expect(v.items[p3!.key]!.votes).toEqual({ same: 2, different: 0, faults: 1 });
    // Round 2 has the items that are not agreed, with the arguments of round 1.
    const m2 = prepareCrRound(db, corpus, 2, root, pairs.length);
    expect(m2.batches[0]!.items).toContain(p2!.key);
    expect(m2.batches[0]!.items).not.toContain(p1!.key);
    expect(readFileSync(join(crDebaterDir(2, 1, 1, root), 'packet.md'), 'utf8')).toContain('Arguments of the previous round');
    // A `same` verdict joins the applied members; an owner answer `different` overrides it.
    const member = (k: string) => k.slice(k.indexOf(':') + 1, k.indexOf('>'));
    expect(confirmedSame(db, corpus, verdicts).has(member(p1!.key))).toBe(true);
    const d = withConfirmed(crDuplicates(db, corpus), confirmedSame(db, corpus, verdicts));
    expect(d.mainOf.has(member(p1!.key))).toBe(true);
    db.prepare("INSERT INTO owner_decisions (kind, item_key, choice, note, decided_at) VALUES ('cr_text', ?, 'different', '', 'now')").run(p1!.key);
    expect(confirmedSame(db, corpus, verdicts).has(member(p1!.key))).toBe(false);
  });
});
