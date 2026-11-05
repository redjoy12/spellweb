import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';
import type { DecisionPage } from '../src/graph/ownerDecisions.js';
import { diffWords } from '../src/web/lib/decisionsApi.js';
import { maybe } from './helpers/realDb.js';
import { applyGoldenCheck, NOTE_PREFIX } from '../src/graph/goldenCheck.js';
import { loadLinkRuleSample } from '../src/graph/linkRuleQuestions.js';
import { GROUP_COUNTS } from '../src/graph/linkRuleRound2.js';
import { ROUND_5_KINDS, ROUND_5_ORDER } from '../src/graph/linkRuleRound5.js';
import { ROUND_6_ORDER } from '../src/graph/linkRuleRound6.js';
import { LINK_KINDS } from '../src/graph/linkRuleV2.js';

describe('diffWords', () => {
  it('marks the words that only one text has', () => {
    const w = diffWords('To activate an activated ability.', 'To activate an ability.');
    expect(w.filter((x) => x.changed).map((x) => x.word)).toEqual(['activated']);
    expect(w.map((x) => x.word).join('')).toBe('To activate an activated ability.');
  });
});

/** The "Your decisions" API on a scratch copy of the real database (it writes answers). */
maybe('the decisions API (owner request 2026-10-18)', () => {
  let db: DatabaseSync;
  let dir: string;
  let page: DecisionPage;
  const app = () => buildServer(db);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decisions-'));
    const file = join(dir, 'app.db');
    // VACUUM INTO, not a file copy: app.db is WAL, and a copy can be stale.
    const src = new DatabaseSync(DB_PATH, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    db = openDb(file);
    db.exec('DELETE FROM owner_decisions');
    page = (await app().inject({ method: 'GET', url: '/api/decisions' })).json() as DecisionPage;
  });
  afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('lists the three kinds of question and the counts on other pages', () => {
    expect(page.items.cr_text.length).toBeGreaterThan(0);
    expect(page.items.rule_conflict.length).toBeGreaterThan(0);
    expect(page.items.supply_twin.length).toBeGreaterThan(0);
    expect(page.decisions).toEqual([]);
    expect(page.elsewhere.review_edge_rules).toBeGreaterThanOrEqual(0);
    // The most used pairs come first.
    const q = page.items.cr_text.map((i) => i.quotes);
    expect([...q].sort((a, b) => b - a)).toEqual(q);
  });

  it('saves, replaces and removes an answer; a wrong answer or item is refused', async () => {
    const c = page.items.rule_conflict[0]!;
    const keep = `keep:${c.rules[0]!.rule_id}`;
    let r = await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'rule_conflict', item_key: c.key, choice: 'keep_both', note: ' both ' } });
    expect(r.statusCode).toBe(200);
    r = await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'rule_conflict', item_key: c.key, choice: keep } });
    expect(r.json().decision.choice).toBe(keep);
    const saved = ((await app().inject({ method: 'GET', url: '/api/decisions' })).json() as DecisionPage).decisions;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.choice).toBe(keep);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'rule_conflict', item_key: c.key, choice: 'same' } })).statusCode).toBe(400);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'cr_text', item_key: 'nothing', choice: 'same' } })).statusCode).toBe(400);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'other', item_key: c.key, choice: 'same' } })).statusCode).toBe(400);
    r = await app().inject({ method: 'DELETE', url: `/api/decisions?kind=rule_conflict&item_key=${encodeURIComponent(c.key)}` });
    expect(r.json().removed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM owner_decisions').get()).toEqual({ n: 0 });
  });

  it('lists the link-check pairs and saves a mark (spec rev. 17 sec. 5.9)', async () => {
    const items = page.items.link_check;
    // 20 pairs for each round. A build round has 10 wide and 10 random pairs; a keyword-part round
    // (owner request 2026-10-24) has pairs that only the keyword parts link, each with its part.
    expect(items.length % 20).toBe(0);
    const build = items.filter((i) => i.stratum !== 'keyword_part');
    expect(build.filter((i) => i.stratum === 'wide')).toHaveLength(build.length / 2);
    for (const i of items.filter((x) => x.stratum === 'keyword_part')) expect(i.part?.part_label).toBeTruthy();
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    for (const i of items) {
      expect(i.supply.oracle_id).not.toBe(i.demand.oracle_id);
      expect(i.reasons.length).toBeGreaterThan(0);
    }
    const key = items[0]!.key;
    let r = await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'link_check', item_key: key, choice: 'weak_link' } });
    expect(r.statusCode).toBe(200);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'link_check', item_key: key, choice: 'same' } })).statusCode).toBe(400);
    r = await app().inject({ method: 'DELETE', url: `/api/decisions?kind=link_check&item_key=${encodeURIComponent(key)}` });
    expect(r.json().removed).toBe(true);
  });

  it('lists the high-help questions and saves an answer for each kind (owner request 2026-10-19)', async () => {
    const { reading, type_role: roles, wrong_link: wrong } = page.items;
    expect(reading.length).toBeGreaterThan(0);
    expect(roles.length).toBeGreaterThan(0);
    expect(wrong.length).toBeGreaterThan(0);
    for (const i of reading) {
      expect(i.examples.length).toBeGreaterThan(0);
      for (const e of i.examples) expect(e.line).toContain(e.match);
    }
    for (const i of roles) expect(i.pairs.length).toBeGreaterThan(0);
    const cases: Array<[string, string, string, string]> = [
      ['reading', reading[0]!.key, reading[0]!.choices[0]!.choice, 'keep_both'],
      ['type_role', roles[0]!.key, 'both', 'yes'],
      ['wrong_link', wrong[0]!.key, 'anti', 'same'],
    ];
    for (const [kind, key, good, bad] of cases) {
      expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind, item_key: key, choice: good } })).statusCode).toBe(200);
      expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind, item_key: key, choice: bad } })).statusCode).toBe(400);
      expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=${kind}&item_key=${encodeURIComponent(key)}` })).json().removed).toBe(true);
    }
  });

  it('lists the tag-check cards and saves a mark (owner request 2026-10-21)', async () => {
    const items = page.items.tag_check;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.tags.length).toBeGreaterThan(0);
    const key = items[0]!.key;
    const r = await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'tag_check', item_key: key, choice: 'needs_fixing', note: 'a tag is missing' } });
    expect(r.statusCode).toBe(200);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'tag_check', item_key: key, choice: 'same' } })).statusCode).toBe(400);
    expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=tag_check&item_key=${encodeURIComponent(key)}` })).json().removed).toBe(true);
  });

  it('lists the tag-merge proposals with CR text and saves an answer (owner request 2026-10-23)', async () => {
    const items = page.items.tag_merge.filter((i) => (i.round ?? 1) === 1);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.a.atoms).toBeGreaterThan(0);
      expect(i.together).toBeGreaterThan(0);
      expect(i.together).toBeLessThanOrEqual(i.a.atoms);
      expect(i.examples.length).toBeGreaterThan(0);
      for (const e of i.evidence) expect(e.text.length).toBeGreaterThan(0);
    }
    const key = items[0]!.key;
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'tag_merge', item_key: key, choice: 'merge' } })).statusCode).toBe(200);
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'tag_merge', item_key: key, choice: 'keep' } })).statusCode).toBe(400);
    expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=tag_merge&item_key=${encodeURIComponent(key)}` })).json().removed).toBe(true);
  });

  it('lists the round 2 tag-merge pairs with both sides, measured effects and their own answers (owner request 2026-10-24)', async () => {
    const items = page.items.tag_merge.filter((i) => i.round === 2);
    expect(items.map((i) => i.key)).toContain('merge2:ENABLES.SACRIFICE_OUTLET>PRODUCES.SACRIFICE');
    expect(page.items.tag_merge.some((i) => (i.round ?? 1) === 1)).toBe(true);
    for (const i of items) {
      expect(i.a.atoms).toBeGreaterThan(0);
      expect(i.one_meaning!.length).toBeGreaterThan(0);
      expect(i.two_meanings!.length).toBeGreaterThan(0);
      expect(i.effects!.length).toBeGreaterThan(0);
      expect(i.choices!.map((c) => c.choice)).toContain('unsure');
      for (const e of i.evidence) expect(e.text.length).toBeGreaterThan(0);
    }
    const outlet = items.find((i) => i.a.type === 'ENABLES.SACRIFICE_OUTLET')!;
    expect(outlet.together).toBe(outlet.a.atoms);
    const removal = items.find((i) => i.a.type === 'COMBAT.STAT_CHANGE')!;
    const post = (key: string, choice: string) => app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'tag_merge', item_key: key, choice } });
    expect((await post(removal.key, 'only_removal')).statusCode).toBe(200);
    expect((await post(removal.key, 'merge_wide')).statusCode).toBe(400);
    expect((await post(outlet.key, 'merge_wide')).statusCode).toBe(200);
    for (const key of [removal.key, outlet.key]) {
      expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=tag_merge&item_key=${encodeURIComponent(key)}` })).json().removed).toBe(true);
    }
  });
  it('lists the golden synergy pairs with no label, and applies the owner answers (owner request 2026-10-24)', async () => {
    // Six seeded open pairs, so that the test does not depend on the owner's real answers.
    const ids = (db.prepare("SELECT id FROM edge_golden_pairs WHERE status != 'stale' ORDER BY id LIMIT 6").all() as Array<{ id: number }>).map((r) => r.id);
    db.prepare(`UPDATE edge_golden_pairs SET status = 'accepted', label = 'synergy', owner_note = NULL WHERE id IN (${ids.join(',')})`).run();
    // Remove the marks of a real apply on this copy, so that only the seeded pairs count.
    db.prepare("UPDATE edge_golden_pairs SET owner_note = NULL WHERE owner_note LIKE ?").run(`${NOTE_PREFIX}%`);
    const get = async () => ((await app().inject({ method: 'GET', url: '/api/decisions' })).json() as DecisionPage).items;
    const items = (await get()).golden_check;
    const open = (db.prepare("SELECT id FROM edge_golden_pairs WHERE status = 'accepted' AND label = 'synergy'").all() as Array<{ id: number }>).map((r) => r.id);
    expect(items.map((i) => i.pair_id)).toEqual(expect.arrayContaining(open));
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['demand', 'key', 'pair_id', 'supply']);
    // A wrong_link item of a golden-check pair is hidden: it shows the label.
    const asked = new Set(items.map((i) => i.pair_id));
    for (const w of (await get()).wrong_link) expect(asked.has(w.pair_id)).toBe(false);
    const [a, b, c, d, e, f] = ids.map((id) => items.find((i) => i.pair_id === id)!) as Array<typeof items[0]>;
    const post = (key: string, choice: string, note = '') => app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'golden_check', item_key: key, choice, note } });
    const del = async (key: string) => (await app().inject({ method: 'DELETE', url: `/api/decisions?kind=golden_check&item_key=${key}` })).json();
    for (const [x, choice] of [[a, 'link'], [b, 'no_link'], [c, 'unsure'], [d, 'link'], [e, 'weak_link'], [f, 'no_link']] as const) {
      expect((await post(x!.key, choice, x === b ? 'only a creature' : '')).statusCode).toBe(200);
    }
    expect((await post(a!.key, 'same')).statusCode).toBe(400);
    // A new label round gives pair d the label none: the old answer must not accept that label.
    db.prepare("UPDATE edge_golden_pairs SET label = 'none' WHERE id = ?").run(d!.pair_id);
    const sorted = (x: number[]) => [...x].sort((p, q) => p - q);
    expect(applyGoldenCheck(db, { dryRun: true })).toEqual({
      accepted: sorted([a!.pair_id, e!.pair_id]), corrected: sorted([b!.pair_id, f!.pair_id]), anti: [], waiting: [c!.pair_id], skipped: [d!.pair_id], conflicts: [],
    });
    expect(db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?').get(a!.pair_id)).toEqual({ status: 'accepted' });
    applyGoldenCheck(db);
    const row = (id: number) => db.prepare('SELECT status, label, owner_note FROM edge_golden_pairs WHERE id = ?').get(id) as { status: string; label: string; owner_note: string };
    expect(row(a!.pair_id)).toMatchObject({ status: 'owner_accepted', label: 'synergy' });
    expect(row(e!.pair_id)).toMatchObject({ status: 'owner_accepted', label: 'synergy' });
    expect(row(e!.pair_id).owner_note).toContain('weak_link');
    expect(row(b!.pair_id)).toMatchObject({ status: 'owner_corrected', label: 'none' });
    expect(row(b!.pair_id).owner_note).toContain('only a creature');
    expect(row(c!.pair_id).status).toBe('accepted');
    expect(row(d!.pair_id)).toMatchObject({ status: 'accepted', label: 'none' });
    expect(applyGoldenCheck(db, { dryRun: true }).conflicts).toEqual([]);
    // Answers changed after the apply (yes -> no, no -> yes, yes -> not sure), and an Undo, are conflicts.
    expect((await post(a!.key, 'no_link')).statusCode).toBe(200);
    expect((await post(f!.key, 'link')).statusCode).toBe(200);
    expect((await post(e!.key, 'unsure')).statusCode).toBe(200);
    expect(await del(b!.key)).toEqual({ removed: true });
    const again = applyGoldenCheck(db, { dryRun: true });
    expect(again.skipped).toEqual(sorted([a!.pair_id, b!.pair_id, d!.pair_id, e!.pair_id, f!.pair_id]));
    expect(again.conflicts).toEqual(sorted([a!.pair_id, b!.pair_id, e!.pair_id, f!.pair_id]));
    // The Undo keeps the applied pair on the page, with no answer.
    const page2 = await app().inject({ method: 'GET', url: '/api/decisions' });
    const p2 = page2.json() as DecisionPage;
    expect(p2.items.golden_check.map((i) => i.pair_id)).toContain(b!.pair_id);
    expect(p2.decisions.some((x) => x.kind === 'golden_check' && x.item_key === b!.key)).toBe(false);
  });
  it('applies a "works against" answer as an anti label on the same clauses and CR chain (owner, 2026-10-25)', async () => {
    const g = db.prepare(
      `SELECT id, supply_clause, demand_clause, cr_chain_json FROM edge_golden_pairs
        WHERE label = 'synergy' AND status != 'stale' AND demand_clause IS NOT NULL AND cr_chain_json NOT IN ('', '[]') ORDER BY id DESC LIMIT 1`,
    ).get() as { id: number; supply_clause: string; demand_clause: string; cr_chain_json: string };
    db.prepare("UPDATE edge_golden_pairs SET status = 'accepted', owner_note = NULL WHERE id = ?").run(g.id);
    db.exec("DELETE FROM owner_decisions WHERE kind = 'golden_check'");
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'golden_check', item_key: `gp${g.id}`, choice: 'anti' } })).statusCode).toBe(200);
    const r = applyGoldenCheck(db);
    expect(r.anti).toEqual([g.id]);
    expect(db.prepare('SELECT status, label, supply_clause, demand_clause, cr_chain_json FROM edge_golden_pairs WHERE id = ?').get(g.id)).toEqual({
      status: 'owner_corrected', label: 'anti', supply_clause: g.supply_clause, demand_clause: g.demand_clause, cr_chain_json: g.cr_chain_json,
    });
    expect(applyGoldenCheck(db, { dryRun: true }).conflicts).not.toContain(g.id);
  });
  describe.each([
    ['lr1:', 'round 1', Object.values(LINK_KINDS).reduce((n, k) => n + k.sample, 0)],
    ['lr2:', 'round 2', Object.values(GROUP_COUNTS).reduce((n, k) => n + k, 0)],
  ])('link rule questions of %s (%s)', (prefix, _round, size) => {
    it('lists one blind card pair for each question, with no card twice in the round', () => {
      const items = page.items.link_rule.filter((i) => i.key.startsWith(prefix));
      expect(items.length).toBe(size);
      for (const i of items) {
        // The page gets the two cards and nothing that steers the owner.
        expect(Object.keys(i).sort()).toEqual(['demand', 'key', 'supply']);
        expect(i.supply.name.length).toBeGreaterThan(0);
        expect(i.demand.name.length).toBeGreaterThan(0);
      }
      const cards = items.flatMap((i) => [i.supply.oracle_id, i.demand.oracle_id]);
      expect(new Set(cards).size).toBe(cards.length);
    });
    it('saves and removes an answer, so that the owner can change it', async () => {
      const key = page.items.link_rule.find((i) => i.key.startsWith(prefix))!.key;
      const post = (choice: string) => app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'link_rule', item_key: key, choice, note: 'a note' } });
      expect((await post('other')).statusCode).toBe(200);
      expect((await post('approve')).statusCode).toBe(400);
      expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=link_rule&item_key=${encodeURIComponent(key)}` })).json()).toEqual({ removed: true });
    });
  });
  it('lists 15 blind pairs of round 3, with no supply card twice, or none before its sample', () => {
    const items = page.items.link_rule.filter((i) => i.key.startsWith('lr3:'));
    if (items.length === 0) return;
    expect(items.length).toBe(15);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['demand', 'key', 'supply']);
    expect(new Set(items.map((i) => i.supply.oracle_id)).size).toBe(15);
  });
  it('lists 16 blind pairs of round 6, with a kind and a golden pair only in the file', () => {
    const items = page.items.link_rule.filter((i) => i.key.startsWith('lr6:'));
    expect(items.length).toBe(16);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['demand', 'key', 'supply']);
    const sample = loadLinkRuleSample(6)!;
    expect(sample.pools).toEqual({ owner_no: 11, labeler_none: 5 });
    expect(sample.pairs.every((p) => typeof p.golden_pair === 'number')).toBe(true);
  });
  it('gives a follow-up its question and its contrast pair, and saves a free answer', async () => {
    const items = page.items.link_rule.filter((i) => i.key.startsWith('lrf:'));
    if (items.length === 0) return;
    for (const i of items) expect(i.ask?.length).toBeGreaterThan(0);
    const compare = items.find((i) => i.compare)!.compare!;
    expect(compare.supply.oracle_text.length).toBeGreaterThan(0);
    expect(compare.answer.length).toBeGreaterThan(0);
    const key = items[0]!.key;
    expect((await app().inject({ method: 'POST', url: '/api/decisions', payload: { kind: 'link_rule', item_key: key, choice: 'other', note: 'a reason' } })).statusCode).toBe(200);
    expect((await app().inject({ method: 'DELETE', url: `/api/decisions?kind=link_rule&item_key=${encodeURIComponent(key)}` })).json()).toEqual({ removed: true });
  });
  it('shows all rounds of link rule questions, and no group name in the data of a pair', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/decisions' });
    const items = (res.json() as DecisionPage).items.link_rule;
    expect(items.filter((i) => /^lr[123456f]:/.test(i.key)).length).toBe(items.length);
    const text = JSON.stringify(items);
    for (const word of [...Object.keys(GROUP_COUNTS), ...ROUND_5_ORDER, ...Object.keys(ROUND_5_KINDS), ...ROUND_6_ORDER, 'descended', 'forced', 'discard', 'blood_rule', 'blood_token', 'connive']) expect(text.includes(`"${word}"`), word).toBe(false);
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('"group"');
    expect(text).not.toContain('"golden_pair"');
  });
});
