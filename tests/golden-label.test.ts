import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { ownShortNames, redactWithMap, redactionNames } from '../src/atoms/extract.js';
import { loadGraphPolicy, type GraphPolicy } from '../src/graph/policy.js';
import { loadSlice, persistRound, sampleRound } from '../src/graph/goldenSelect.js';
import {
  LABEL_INSTRUCTIONS, answerFault, buildLabelPacket, labelContext, ownerSampleGaps, prepareLabelRound, resetLabelRound, retireStalePairs,
  selectOwnerSample, submitLabelRound, votePair, type LabelManifest, type PassAnswer,
} from '../src/graph/goldenLabel.js';
import { prepareReview, reviewAgreement, submitReview } from '../src/graph/goldenReview.js';
import { realDb } from './helpers/realDb.js';

// spec rev. 6 sec. 11.3-11.4. The responses here are synthetic: the test writes them from the
// manifest and from CR rows that the packet shows, so no answer states a Magic fact.

const describeCopy = existsSync(DB_PATH) && realDb ? describe : describe.skip;

describeCopy('label rounds (spec sec. 11.3) on a scratch copy of the real database', () => {
  let db: DatabaseSync;
  let dir: string;
  let policy: GraphPolicy;
  let passDirs: string[];
  let manifest: LabelManifest;
  let packet: string;
  let goodQuote: { source: 'rule'; ref: string; quote: string };
  let outsideQuote: { source: 'rule'; ref: string; quote: string };
  const before = process.env['EDGE_GOLDEN_BATCHES_DIR'];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'golden-label-'));
    process.env['EDGE_GOLDEN_BATCHES_DIR'] = join(dir, 'batches');
    const scratch = join(dir, 'app.db');
    copyFileSync(DB_PATH, scratch);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, scratch + ext);
    db = openDb(scratch);
    db.exec('DELETE FROM edge_golden_votes; DELETE FROM edge_golden_owner_sample; DELETE FROM edge_golden_batches; DELETE FROM edge_golden_pairs;');
    policy = loadGraphPolicy();
    persistRound(db, 1, sampleRound(db, 1, policy, { slice: loadSlice(db) }));
    passDirs = prepareLabelRound(db, 1, policy);
    manifest = JSON.parse(readFileSync(join(passDirs[0]!, 'manifest.json'), 'utf8')) as LabelManifest;
    packet = readFileSync(join(passDirs[0]!, 'packet.md'), 'utf8');

    const refs = JSON.parse((db.prepare('SELECT refs_json FROM edge_golden_batches WHERE round = 1 AND batch_index = 1').get() as { refs_json: string }).refs_json) as string[];
    const shown = refs.find((r) => !r.startsWith('glossary:'))!;
    const text = (db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(manifest.corpus_id, shown) as { text: string }).text;
    goodQuote = { source: 'rule', ref: shown, quote: text.slice(0, Math.min(30, text.length)) };
    const inPacket = new Set(refs);
    const other = db.prepare("SELECT number, text FROM rules WHERE corpus_id = ? AND text <> '' ORDER BY ordinal").all(manifest.corpus_id) as Array<{ number: string; text: string }>;
    const out = other.find((r) => !inPacket.has(r.number))!;
    outsideQuote = { source: 'rule', ref: out.number, quote: out.text.slice(0, 20) };
  });
  afterAll(() => {
    db?.close();
    if (before === undefined) delete process.env['EDGE_GOLDEN_BATCHES_DIR']; else process.env['EDGE_GOLDEN_BATCHES_DIR'] = before;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes batches of batch_size pairs, each with three pass directories and one packet', () => {
    const batches = Math.ceil(policy.golden.round_size / policy.golden.batch_size);
    expect(passDirs).toHaveLength(batches * 3);
    expect(manifest.pairs).toHaveLength(policy.golden.batch_size);
    const second = readFileSync(join(passDirs[1]!, 'packet.md'), 'utf8');
    expect(second).toBe(packet);
    expect(passDirs[0]).toMatch(/round-1[\\/]batch-001[\\/]pass-1$/);
  });

  it('the packet has the instructions, the pairs, the redacted clauses with indices, the characteristics, the atoms and the CR content', () => {
    expect(packet).toContain(LABEL_INSTRUCTIONS);
    expect(packet).toMatch(/Power\/toughness: /);
    expect(packet).toContain('# Pairs\nP01: supply card S = K01, demand card D = K02');
    for (const c of manifest.cards) {
      expect(packet).toContain(`## ${c.key}\nMana value: `);
      for (const cl of c.clauses) expect(packet).toContain(`- clause ${cl} (`);
      for (const a of c.atoms) expect(packet).toContain(`- atom ${a}: `);
    }
    expect(packet).toMatch(/Type line: /);
    expect(packet).toMatch(/Color identity: /);
    const cr = packet.slice(packet.indexOf('# Comprehensive Rules'));
    expect(cr).toContain('kernel');
    expect(cr).toContain('intrinsic classes');
    expect(Buffer.byteLength(packet, 'utf8')).toBeLessThanOrEqual(policy.packet_budget_bytes);
  });

  it('the card part and the instructions contain no pool card name and no own short name', () => {
    const cardPart = packet.slice(0, packet.indexOf('# Comprehensive Rules'));
    const names = redactionNames(db);
    const own = manifest.cards.flatMap((c) => ownShortNames(db, c.oracle_id));
    expect(redactWithMap(cardPart, names, own).redactions.map((r) => r.name)).toEqual([]);
  });

  it('the packet does not depend on roles, rules or other golden labels', () => {
    db.exec("UPDATE edge_golden_pairs SET label = 'synergy' WHERE round = 1 AND id NOT IN (SELECT value FROM json_each((SELECT pair_ids FROM edge_golden_batches WHERE round = 1 AND batch_index = 1)))");
    const pairs = manifest.pairs.map((p) => {
      const row = db.prepare('SELECT id, supply_oracle, demand_oracle FROM edge_golden_pairs WHERE id = ?').get(p.pair_id) as { id: number; supply_oracle: string; demand_oracle: string };
      return row;
    });
    const again = buildLabelPacket(db, labelContext(db), packet.split('\n')[0]!, pairs);
    expect(again.markdown).toBe(packet);
    db.exec("UPDATE edge_golden_pairs SET label = NULL WHERE round = 1");
    expect(packet).not.toMatch(/rule_hash|Stage A|"role"/);
  });

  it('votes, quote checks and oracle hashes: accept on two agreeing passes, dispute otherwise, never accept on a failed quote', () => {
    const k = manifest.pairs.map((p) => p.key);
    const supplyCard = (i: number) => manifest.cards.find((c) => c.key === manifest.pairs[i]!.supply)!;
    const demandCard = (i: number) => manifest.cards.find((c) => c.key === manifest.pairs[i]!.demand)!;
    const clause = (c: LabelManifest['cards'][number]) => {
      const [f, n] = c.clauses[0]!.split('.').map(Number);
      return { face_index: f!, clause_index: n!, atom_id: c.atoms[0] ?? null };
    };
    const syn = (i: number, quote = goodQuote) => ({ label: 'synergy', supply: clause(supplyCard(i)), demand: clause(demandCard(i)), cr_chain: [quote] });
    const none = { label: 'none', supply: null, demand: null, cr_chain: [] };
    const char = (i: number, c: string) => ({ label: 'synergy', supply: { characteristic: c }, demand: clause(demandCard(i)), cr_chain: [goodQuote] });
    const anti = (i: number) => ({ ...syn(i), label: 'anti' });
    const bad = { ...goodQuote, quote: `${goodQuote.quote} NOT IN THE RULE` };
    const answers: Array<Record<string, unknown>> = [{}, {}, {}];
    const set = (i: number, a: unknown[]) => a.forEach((x, p) => { answers[p]![k[i]!] = x; });
    set(0, [syn(0), syn(0), none]);                                   // accepted synergy, 2 votes
    set(1, [syn(1), anti(1), none]);                                  // disputed
    set(2, [syn(2, bad), syn(2, bad), syn(2)]);                       // failed quotes: disputed
    set(3, [char(3, 'type_line'), char(3, 'type_line'), char(3, 'mana_value')]); // accepted characteristic
    set(4, [char(4, 'type_line'), char(4, 'mana_value'), none]);      // characteristics disagree
    set(5, [syn(5, outsideQuote), syn(5, outsideQuote), none]);       // quote not in the packet
    for (let i = 6; i < k.length; i++) set(i, [none, none, none]);
    for (let p = 0; p < 3; p++) writeFileSync(join(passDirs[p]!, 'response.json'), JSON.stringify({ pairs: answers[p] }));
    for (const d of passDirs.slice(3)) {
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) as LabelManifest;
      writeFileSync(join(d, 'response.json'), JSON.stringify({ pairs: Object.fromEntries(m.pairs.map((p) => [p.key, none])) }));
    }

    const t = submitLabelRound(db, 1);
    expect(t.disputed).toBe(4);
    expect(t.accepted).toBe(policy.golden.round_size - 4);
    const row = (i: number) => db.prepare('SELECT * FROM edge_golden_pairs WHERE id = ?').get(manifest.pairs[i]!.pair_id) as Record<string, unknown>;
    expect(row(0)).toMatchObject({ status: 'accepted', label: 'synergy', votes: 2, supply_atom_id: supplyCard(0).atoms[0] ?? null });
    expect(JSON.parse(row(0)['cr_chain_json'] as string)).toEqual([goodQuote]);
    expect(row(1)).toMatchObject({ status: 'disputed', label: null });
    expect(row(2)).toMatchObject({ status: 'disputed', label: null });
    expect(row(3)).toMatchObject({ status: 'accepted', label: 'synergy', supply_atom_id: null });
    expect(JSON.parse(row(3)['supply_clause'] as string)).toEqual({ characteristic: 'type_line' });
    expect(row(4)).toMatchObject({ status: 'disputed' });
    expect(row(5)).toMatchObject({ status: 'disputed' });
    const faults = db.prepare('SELECT fault FROM edge_golden_votes WHERE pair_id = ? ORDER BY pass_index').all(manifest.pairs[5]!.pair_id) as Array<{ fault: string | null }>;
    expect(faults[0]!.fault).toMatch(/not_in_packet/);
    expect(row(6)).toMatchObject({ status: 'accepted', label: 'none', votes: 3 });
    expect(() => submitLabelRound(db, 1)).toThrow(/already submitted/);

    const hashes = JSON.parse(row(0)['oracle_hashes'] as string) as string[];
    expect(hashes[0]).toBe((db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(row(0)['supply_oracle'] as string) as { oracle_hash: string }).oracle_hash);
  });

  it('retireStalePairs marks a pair stale when one of its texts changes', () => {
    const p = db.prepare("SELECT id, demand_oracle FROM edge_golden_pairs WHERE status = 'accepted' ORDER BY id LIMIT 1").get() as { id: number; demand_oracle: string };
    const old = (db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(p.demand_oracle) as { oracle_hash: string }).oracle_hash;
    db.prepare('UPDATE cards SET oracle_hash = ? WHERE oracle_id = ?').run('changed', p.demand_oracle);
    expect(retireStalePairs(db)).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?').get(p.id) as { status: string }).status).toBe('stale');
    db.prepare('UPDATE cards SET oracle_hash = ? WHERE oracle_id = ?').run(old, p.demand_oracle);
  });

  it('round 2: an unreadable response stops the submit; a pair that went stale after the prepare is skipped', () => {
    persistRound(db, 2, sampleRound(db, 2, policy, { slice: loadSlice(db) }));
    const dirs = prepareLabelRound(db, 2, policy);
    const none = { label: 'none', supply: null, demand: null, cr_chain: [] };
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) as LabelManifest;
      writeFileSync(join(d, 'response.json'), JSON.stringify({ pairs: Object.fromEntries(m.pairs.map((p) => [p.key, none])) }));
    }
    writeFileSync(join(dirs[0]!, 'response.json'), '```json\n{}\n```');
    expect(() => submitLabelRound(db, 2)).toThrow(/not JSON with a "pairs" object/);
    const m = JSON.parse(readFileSync(join(dirs[0]!, 'manifest.json'), 'utf8')) as LabelManifest;
    writeFileSync(join(dirs[0]!, 'response.json'), JSON.stringify({ pairs: Object.fromEntries(m.pairs.map((p) => [p.key, none])) }));

    const stalePair = m.pairs[0]!.pair_id;
    const card = (db.prepare('SELECT supply_oracle FROM edge_golden_pairs WHERE id = ?').get(stalePair) as { supply_oracle: string }).supply_oracle;
    const old = (db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(card) as { oracle_hash: string }).oracle_hash;
    db.prepare('UPDATE cards SET oracle_hash = ? WHERE oracle_id = ?').run('changed', card);
    retireStalePairs(db);
    const t = submitLabelRound(db, 2);
    expect(t.stale).toBeGreaterThanOrEqual(1);
    expect(t.accepted + t.disputed + t.stale).toBe(policy.golden.round_size);
    expect(db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?').get(stalePair)).toMatchObject({ status: 'stale' });
    db.prepare('UPDATE cards SET oracle_hash = ? WHERE oracle_id = ?').run(old, card);
  });

  it('resetLabelRound puts a round back to sampled, keeps the old pass directories, and permits a new prepare', () => {
    const r = resetLabelRound(db, 2);
    expect(r.pairs).toBeGreaterThan(0);
    expect(r.archived).toMatch(/round-2-reset-/);
    expect(existsSync(join(r.archived!, 'batch-001', 'pass-1', 'response.json'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM edge_golden_pairs WHERE round = 2 AND status NOT IN ('sampled','stale')").get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM edge_golden_batches WHERE round = 2').get()).toMatchObject({ n: 0 });
    // A batch over the packet budget splits until each part fits; one pair stays alone.
    const dirs = prepareLabelRound(db, 2, { ...policy, packet_budget_bytes: 1 });
    expect(dirs).toHaveLength(r.pairs * 3);
    expect(existsSync(join(dirs[0]!, 'response.json'))).toBe(false);
    db.exec("INSERT INTO edge_golden_owner_sample (sample_no, pair_id, prior_status, prior_label, sampled_at) SELECT 99, id, 'accepted', NULL, 't' FROM edge_golden_pairs WHERE round = 1 LIMIT 1");
    expect(() => resetLabelRound(db, 1)).toThrow(/owner sample/);
  });

  it('the isolated reviewer: blind packets, agree / label_differs / invalid, and a label difference disputes the pair', () => {
    db.exec('DELETE FROM edge_golden_owner_sample');
    const sampled = new Set(selectOwnerSample(db, policy));
    const dirs = prepareReview(db, policy);
    expect(dirs.length).toBeGreaterThan(0);
    type Row = { label: string; supply_clause: string | null; demand_clause: string | null; supply_atom_id: number | null; demand_atom_id: number | null };
    const row = db.prepare('SELECT label, supply_clause, demand_clause, supply_atom_id, demand_atom_id FROM edge_golden_pairs WHERE id = ?');
    let first: number | null = null;
    let n = 0;
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) as LabelManifest & { refs: string[] };
      const packetText = readFileSync(join(d, 'packet.md'), 'utf8');
      expect(packetText).toContain(LABEL_INSTRUCTIONS);
      const ref = m.refs.find((r) => !r.startsWith('glossary:'))!;
      const text = (db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?').get(m.corpus_id, ref) as { text: string }).text;
      const quote = { source: 'rule', ref, quote: text.slice(0, 20) };
      const pairs: Record<string, unknown> = {};
      for (const p of m.pairs) {
        expect(sampled.has(p.pair_id)).toBe(true);
        const r = row.get(p.pair_id) as Row;
        const ref2 = (c: string | null, atom: number | null) => {
          const v = c ? JSON.parse(c) as Record<string, unknown> : null;
          return v === null ? null : 'characteristic' in v ? v : { ...v, atom_id: atom };
        };
        const copy = { label: r.label, supply: ref2(r.supply_clause, r.supply_atom_id), demand: ref2(r.demand_clause, r.demand_atom_id), cr_chain: r.label === 'none' ? [] : [quote] };
        const card = (k: string) => m.cards.find((c) => c.key === k)!;
        const clause = (k: string) => { const [f, c] = card(k).clauses[0]!.split('.').map(Number); return { face_index: f!, clause_index: c!, atom_id: null }; };
        if (n === 0) {
          first = p.pair_id;
          pairs[p.key] = r.label === 'none'
            ? { label: 'synergy', supply: { characteristic: 'type_line' }, demand: clause(p.demand), cr_chain: [quote] }
            : { label: 'none', supply: null, demand: null, cr_chain: [] };
        } else if (n === 1) {
          pairs[p.key] = { label: 'maybe' };
        } else {
          pairs[p.key] = copy;
        }
        n++;
      }
      writeFileSync(join(d, 'response.json'), JSON.stringify({ pairs }));
    }
    const t = submitReview(db);
    expect(t).toMatchObject({ label_differs: 1, invalid: 1, skipped: 0 });
    expect(t.agree + t.clause_differs).toBe(n - 2);
    expect(db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?').get(first!)).toMatchObject({ status: 'disputed' });
    expect(reviewAgreement(db)).toMatchObject({ reviewed: n, label_differs: 1, invalid: 1 });
    expect(() => submitReview(db)).toThrow(/already reviewed/);
  });
});

describe('answerFault (spec sec. 11.3)', () => {
  it('a none answer with a CR chain does not vote: its quotes are not checked (review finding M4)', () => {
    const card = { key: 'K01', oracle_id: 'x', oracle_hash: 'h', clauses: ['0.0'], atoms: [] };
    const none = { label: 'none', supply: null, demand: null, cr_chain: [{ source: 'rule', ref: '1', quote: 'q' }] };
    const r = answerFault(null as unknown as DatabaseSync, 0, none, { supply: card, demand: card }, new Set());
    expect(r.fault).toMatch(/empty CR chain/);
    const ok = answerFault(null as unknown as DatabaseSync, 0, { ...none, cr_chain: [] }, { supply: card, demand: card }, new Set());
    expect(ok.fault).toBeNull();
  });
});

describe('votePair (spec sec. 11.3)', () => {
  const ans = (label: 'synergy' | 'none', s: number) => ({
    label, supply: label === 'none' ? null : { face_index: 0, clause_index: s, atom_id: null },
    demand: label === 'none' ? null : { face_index: 0, clause_index: 0, atom_id: 7 }, cr_chain: [],
  });
  const pass = (i: number, a: ReturnType<typeof ans> | null, fault: string | null = null): PassAnswer => ({ pass_index: i, answer: a, fault });

  it('needs two passes with the same label and the same two clauses', () => {
    expect(votePair([pass(1, ans('synergy', 1)), pass(2, ans('synergy', 2)), pass(3, ans('none', 0))]).status).toBe('disputed');
    const v = votePair([pass(1, ans('synergy', 1)), pass(2, ans('synergy', 1)), pass(3, ans('none', 0))]);
    expect(v).toMatchObject({ status: 'accepted', votes: 2, demand_atom_id: 7 });
  });

  it('a pass with a fault does not vote', () => {
    expect(votePair([pass(1, ans('synergy', 1)), pass(2, ans('synergy', 1), 'quote: not_verbatim'), pass(3, null, 'missing')]).status).toBe('disputed');
  });
});

describe('selectOwnerSample (spec sec. 11.4)', () => {
  it('gives 20 pairs: the disputed pairs to 8, each stratum with labelled pairs, and the label minimums', () => {
    const db = openDb(':memory:');
    const strata = ['demand_type', 'shared_term', 'interaction', 'param_gap', 'unrecorded_restriction', 'random'];
    const labels = ['none', 'none', 'none', 'synergy', 'none', 'anti'];
    const ins = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, status, oracle_hashes, created_at)
                            VALUES (?, ?, ?, 1, ?, ?, '[]', 't')`);
    for (let i = 0; i < 12; i++) ins.run(`s${i}`, `d${i}`, strata[i % 6]!, null, 'disputed');
    for (let i = 0; i < 60; i++) ins.run(`a${i}`, `b${i}`, strata[i % 6]!, labels[Math.floor(i / 6) % 6]!, 'accepted');
    const ids = selectOwnerSample(db, loadGraphPolicy());
    const rows = db.prepare(`SELECT p.stratum, p.status, p.label FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id`)
      .all() as Array<{ stratum: string; status: string; label: string | null }>;
    expect(ids).toHaveLength(20);
    expect(rows.filter((r) => r.status === 'disputed')).toHaveLength(8);
    expect(new Set(rows.map((r) => r.stratum))).toEqual(new Set(strata));
    expect(rows.filter((r) => r.label === 'synergy').length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.label === 'anti').length).toBeGreaterThanOrEqual(3);
    expect(rows.filter((r) => r.label === 'none').length).toBeGreaterThanOrEqual(3);
    expect(() => selectOwnerSample(db, loadGraphPolicy())).toThrow(/without a verdict/);
  });

  it('never goes above 20 pairs or 8 disputed pairs; it names a stratum with disputed pairs only (review finding M6)', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, status, oracle_hashes, created_at)
                            VALUES (?, ?, ?, 1, ?, ?, '[]', 't')`);
    for (let i = 0; i < 50; i++) ins.run(`i${i}`, `j${i}`, 'interaction', null, 'disputed');
    ins.run('p', 'q', 'param_gap', null, 'disputed');
    ins.run('u', 'v', 'unrecorded_restriction', null, 'disputed');
    const labels = ['synergy', 'anti', 'none'];
    for (let i = 0; i < 30; i++) ins.run(`a${i}`, `b${i}`, ['demand_type', 'shared_term', 'random'][i % 3]!, labels[Math.floor(i / 3) % 3]!, 'accepted');
    const ids = selectOwnerSample(db, loadGraphPolicy());
    const rows = db.prepare('SELECT p.status FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id').all() as Array<{ status: string }>;
    expect(ids.length).toBeLessThanOrEqual(20);
    expect(rows.filter((r) => r.status === 'disputed').length).toBeLessThanOrEqual(8);
    const gaps = ownerSampleGaps(db);
    for (const g of gaps) expect(['interaction', 'param_gap', 'unrecorded_restriction']).toContain(g);
  });
});
