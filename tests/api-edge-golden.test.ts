import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { fixtureWithClauses, insertAtom } from './helpers/fixture.js';

// spec sec. 13.5 on a scratch database: two fixture cards, three fixture pairs. The rule rows of
// the fixture have the text "text of <number>", so quotes are mechanical.

function server() {
  const db = fixtureWithClauses('When Zorvath Quillmaker enters, draw a card. You gain 2 life.', { name: 'Zorvath Quillmaker' });
  fixtureWithClauses('Flying', { db, oracleId: 'p', name: 'Bastion Wyrmling' });
  const supplyAtom = insertAtom(db, { span_start: 0, span_end: 44 });
  const demandAtom = insertAtom(db, { oracle_id: 'p', family: 'COMBAT', type_key: 'FLYING' });
  const pair = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, supply_clause, demand_clause,
                             supply_atom_id, demand_atom_id, cr_chain_json, votes, status, oracle_hashes, created_at)
                           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '["h","h"]', 't')`);
  const chain = JSON.stringify([{ source: 'rule', ref: '700.1', quote: 'text of 700.1' }]);
  const accepted = Number(pair.run('o', 'p', 'random', 'synergy', '{"face_index":0,"clause_index":0}', '{"face_index":0,"clause_index":0}',
    supplyAtom, demandAtom, chain, 2, 'accepted').lastInsertRowid);
  const disputed = Number(pair.run('p', 'o', 'interaction', null, null, null, null, null, null, 1, 'disputed').lastInsertRowid);
  const sampled = Number(pair.run('o', 'p', 'param_gap', null, null, null, null, null, null, 0, 'sampled').lastInsertRowid);
  db.prepare(`INSERT INTO edge_golden_batches (round, batch_index, pair_ids, corpus_id, refs_json, packet_sha, packet_bytes, prepared_at)
              VALUES (1, 1, ?, 1, ?, 'x', 1, 't')`).run(JSON.stringify([accepted, disputed, sampled]), JSON.stringify(['700', '700.1', '118']));
  db.prepare('INSERT INTO edge_golden_votes (pair_id, pass_index, answer_json, fault) VALUES (?, 1, ?, NULL)')
    .run(accepted, JSON.stringify({ label: 'synergy' }));
  return { db, app: buildServer(db), ids: { accepted, disputed, sampled, supplyAtom, demandAtom } };
}

describe('edge golden routes', () => {
  it('lists pairs by status, with redacted texts and never a card name', async () => {
    const { app, ids } = server();
    const res = await app.inject({ url: '/api/edge-golden/pairs?status=accepted' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pairs: Array<{ id: number; passes: unknown[]; supply: { faces: Array<{ clauses: Array<{ text: string }> }> } }> };
    expect(body.pairs.map((p) => p.id)).toEqual([ids.accepted]);
    expect(body.pairs[0]!.supply.faces[0]!.clauses[0]!.text).toBe('When ~ enters, draw a card.');
    expect(body.pairs[0]!.passes).toHaveLength(1);
    expect(res.body).not.toContain('Zorvath');
    expect(res.body).not.toContain('Bastion Wyrmling');
    expect((await app.inject({ url: '/api/edge-golden/pairs' })).json().pairs).toHaveLength(3);
    expect((await app.inject({ url: '/api/edge-golden/pairs?status=bogus' })).statusCode).toBe(400);
  });

  it('gives the counts against each target and the agreement rate', async () => {
    const { app } = server();
    const body = (await app.inject({ url: '/api/edge-golden/progress' })).json();
    expect(body).toMatchObject({ labelled: 2, cap: 300, met: false, owner_correction_limit: 4 });
    expect(body.targets.find((t: { target: string }) => t.target === 'synergy')).toEqual({ target: 'synergy', want: 40, have: 1 });
    expect(body.agreement).toMatchObject({ sampled: 0, rate: null });
  });

  it('an accept sets owner_accepted; a correction sets owner_corrected with the note, the label and the clauses', async () => {
    const { app, db, ids } = server();
    expect((await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.accepted}/verdict`, payload: { accept: true } })).json()).toEqual({ ok: true });
    expect(db.prepare('SELECT status, label FROM edge_golden_pairs WHERE id = ?').get(ids.accepted)).toMatchObject({ status: 'owner_accepted', label: 'synergy' });

    const correction = {
      accept: false, label: 'anti', note: 'the owner reads clause 0.1',
      supply_clause: { face_index: 0, clause_index: 0 }, demand_clause: { face_index: 0, clause_index: 0 },
      supply_atom_id: null, demand_atom_id: ids.supplyAtom,
      cr_chain: [{ source: 'rule', ref: '118', quote: 'text of 118' }],
    };
    const res = await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.disputed}/verdict`, payload: correction });
    expect(res.json()).toEqual({ ok: true });
    const row = db.prepare('SELECT * FROM edge_golden_pairs WHERE id = ?').get(ids.disputed) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'owner_corrected', label: 'anti', owner_note: 'the owner reads clause 0.1', demand_atom_id: ids.supplyAtom });
    expect(JSON.parse(row['supply_clause'] as string)).toEqual({ face_index: 0, clause_index: 0 });
    expect(JSON.parse(row['cr_chain_json'] as string)).toEqual(correction.cr_chain);
  });

  it('refuses a correction whose CR chain quote fails the check with 400, and a disputed accept with 400', async () => {
    const { app, db, ids } = server();
    const base = { accept: false, label: 'synergy', note: 'n', supply_clause: { face_index: 0, clause_index: 0 }, demand_clause: { face_index: 0, clause_index: 0 } };
    const notVerbatim = await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.disputed}/verdict`,
      payload: { ...base, cr_chain: [{ source: 'rule', ref: '700.1', quote: 'not the text' }] } });
    expect(notVerbatim.statusCode).toBe(400);
    expect(notVerbatim.json().error).toMatch(/not_verbatim/);
    const notInPacket = await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.disputed}/verdict`,
      payload: { ...base, cr_chain: [{ source: 'rule', ref: '603.1', quote: 'text of 603.1' }] } });
    expect(notInPacket.statusCode).toBe(400);
    expect(notInPacket.json().error).toMatch(/not_in_packet/);
    expect((await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.disputed}/verdict`, payload: { accept: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.sampled}/verdict`, payload: { accept: true } })).statusCode).toBe(400);
    expect(db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?').get(ids.disputed)).toMatchObject({ status: 'disputed' });
  });

  it('refuses a body of the wrong shape with 400, and an accept on a corrected pair with 400', async () => {
    const { app, ids } = server();
    const url = `/api/edge-golden/pairs/${ids.disputed}/verdict`;
    for (const payload of [
      { accept: false, label: 'synergy', note: 'n', supply_clause: 'x', demand_clause: { face_index: 0, clause_index: 0 } },
      { accept: false, label: 'synergy', note: 'n', supply_clause: {}, demand_clause: { face_index: 0, clause_index: 0 } },
      { accept: false, label: 'synergy', note: 'n', cr_chain: [{ source: 'rule' }] },
      { accept: false, label: 'maybe', note: 'n' },
    ]) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    }
    const fix = { accept: false, label: 'none', note: 'the owner reads none' };
    expect((await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.accepted}/verdict`, payload: fix })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/edge-golden/pairs/${ids.accepted}/verdict`, payload: { accept: true } })).statusCode).toBe(400);
  });

  it('gives 404 for a verdict on an unknown pair', async () => {
    const { app } = server();
    expect((await app.inject({ method: 'POST', url: '/api/edge-golden/pairs/999/verdict', payload: { accept: true } })).statusCode).toBe(404);
  });
});
