import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BRIEF_INSTRUCTIONS, FixRequestError, createFixRequest, listFixRequests, markFixRequest, openReportCounts, reasonKey,
  reportGroups, sessionNames, slug,
} from '../src/graph/fixRequests.js';
import { fixtureWithClauses } from './helpers/fixture.js';

// Owner request 2026-10-18: the reports grouped by reason and the fix requests, on an in-memory
// database. No build index here (indexOf gives null), so the groups have no link counts.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SIDE = (t: string) => JSON.stringify({ family: 'PRODUCES', type_key: t, where: [] });

function setup(): { db: DatabaseSync; dir: string; buildId: number } {
  const db = fixtureWithClauses('Draw a card. You gain 2 life.');
  const setId = Number(db.prepare(
    "INSERT INTO edge_rule_sets (version, schema_version, corpus_id, packet_sha, model, status, created_at) VALUES (1, 1, 1, 's', 'm', 'accepted', 't')",
  ).run().lastInsertRowid);
  const rule = db.prepare(
    `INSERT INTO edge_rules (set_id, rule_hash, rule_id, polarity, supply_json, demand_json, param_links, implications, evidence_json, votes, status)
     VALUES (?, ?, ?, '+', ?, ?, '[]', '[]', ?, 3, 'accepted')`,
  );
  rule.run(setId, 'h1', 'ER-0001', SIDE('MANA_PRODUCTION'), JSON.stringify({ family: 'ENABLES', type_key: 'ACTIVATE', where: [] }),
    JSON.stringify([{ source: 'rule', ref: '106.1', quote: 'a quote from the packet' }]));
  rule.run(setId, 'h2', 'ER-0002', SIDE('TOKEN'), SIDE('TOKEN'), '[]');
  const buildId = Number(db.prepare(
    `INSERT INTO graph_builds (build_key, rule_set_id, schema_version, corpus_id, pool_snapshot_id, tests_version, atom_set_sha, scope, built_at, counts_json)
     VALUES ('k', ?, 1, 1, 1, 1, 'a', 'BR', 't', '{}')`,
  ).run(setId).lastInsertRowid);
  const report = db.prepare(
    `INSERT INTO edge_reports (build_id, edge_key, supply_oracle, demand_oracle, rule_hashes, note, status, created_at)
     VALUES (?, ?, 'o', 'o', ?, ?, ?, 't')`,
  );
  report.run(buildId, 'e1', '["h1"]', 'first note', 'open');
  report.run(buildId, 'e2', '["h1"]', 'second note', 'open');
  report.run(buildId, 'e3', '["h2","h1"]', 'two rules', 'open');
  report.run(buildId, 'e4', '["h2"]', 'old', 'stale');
  const dir = mkdtempSync(join(tmpdir(), 'fix-requests-'));
  dirs.push(dir);
  return { db, dir, buildId };
}

const none = () => null;

describe('reports grouped by reason', () => {
  it('groups the open reports by their sorted rule hashes, the most reports first', () => {
    const { db } = setup();
    const r = reportGroups(db, none);
    expect(r.groups.map((g) => [g.key, g.report_count])).toEqual([['h1', 2], ['h1,h2', 1]]);
    const g = r.groups[0]!;
    expect(g.reports.map((x) => x.note)).toEqual(['first note', 'second note']);
    expect(g.rules[0]).toMatchObject({ rule_id: 'ER-0001', technical: '+ PRODUCES.MANA_PRODUCTION -> ENABLES.ACTIVATE' });
    expect(g.sentence).toContain('A card that gives "');
    expect(g.links).toBeNull();
    expect(reportGroups(db, none, 'closed').groups.map((x) => x.key)).toEqual(['h2']);
    expect(openReportCounts(db)).toEqual({ h1: 2, 'h1,h2': 1 });
    expect(reasonKey(['h2', 'h1', 'h2'])).toBe('h1,h2');
  });
});

describe('fix requests', () => {
  it('saves a queued request with all reports on the reason and writes the brief file', () => {
    const { db, dir, buildId } = setup();
    const r = createFixRequest(db, none, dir, { session_name: '  Fix Mana Links! ', rule_hashes: ['h1'], note: 'look at lands' });
    expect(r).toMatchObject({ session_name: 'Fix Mana Links!', rule_hashes: ['h1'], report_ids: [1, 2], build_id: buildId, status: 'queued', sent_at: null, rule_ids: ['ER-0001'] });
    expect(r.brief_path).toBe(join(dir, `${r.id}-fix-mana-links.md`));
    expect(existsSync(r.brief_path)).toBe(true);
    const md = readFileSync(r.brief_path, 'utf8');
    expect(md).toContain('**Language:** ASD-STE100');
    expect(md).toContain(BRIEF_INSTRUCTIONS);
    expect(md).toContain('### ER-0001');
    expect(md).toContain('Technical form: `+ PRODUCES.MANA_PRODUCTION -> ENABLES.ACTIVATE`');
    expect(md).toContain('CR 106.1: "a quote from the packet"');
    expect(md).toContain('> first note');
    expect(md).toContain('> second note');
    expect(md).toContain('> look at lands');
    expect(md).toContain(`/api/fix-requests/${r.id}/done`);
    expect(listFixRequests(db, { status: 'queued' }).map((x) => x.id)).toEqual([r.id]);
    expect(reportGroups(db, none).groups[0]!.fix_requests.map((x) => x.id)).toEqual([r.id]);
  });

  it('refuses a bad session name, no rule hashes and an unknown rule', () => {
    const { db, dir } = setup();
    const err = (f: () => unknown) => { try { f(); } catch (e) { return e as FixRequestError; } return null; };
    expect(err(() => createFixRequest(db, none, dir, { session_name: ' -- ', rule_hashes: ['h1'] }))?.kind).toBe('invalid');
    expect(err(() => createFixRequest(db, none, dir, { session_name: 'a', rule_hashes: [] }))?.kind).toBe('invalid');
    expect(err(() => createFixRequest(db, none, dir, { session_name: 'a', rule_hashes: ['nope'] }))?.kind).toBe('not_found');
    expect(err(() => createFixRequest(db, none, dir, { session_name: 'a', rule_hashes: ['h1'], build_id: 999 }))?.kind).toBe('not_found');
    expect(listFixRequests(db)).toEqual([]);
  });

  it('moves queued -> sent -> done; a repeated call changes nothing; a done request is not sent again', () => {
    const { db, dir } = setup();
    const r = createFixRequest(db, none, dir, { session_name: 'one', rule_hashes: ['h1', 'h2'] });
    expect(r.report_ids).toEqual([3]);
    const sent = markFixRequest(db, r.id, 'sent', new Date('2026-10-18T12:00:00Z'));
    expect(sent).toMatchObject({ status: 'sent', sent_at: '2026-10-18T12:00:00.000Z' });
    expect(markFixRequest(db, r.id, 'sent', new Date('2026-10-18T13:00:00Z')).sent_at).toBe('2026-10-18T12:00:00.000Z');
    expect(listFixRequests(db, { status: 'queued' })).toEqual([]);
    expect(markFixRequest(db, r.id, 'done').status).toBe('done');
    expect(() => markFixRequest(db, r.id, 'sent')).toThrow(/done, not queued/);
    expect(() => markFixRequest(db, 999, 'sent')).toThrow(/no fix request 999/);
  });

  it('suggests the session names of earlier requests, the last used first', () => {
    const { db, dir } = setup();
    createFixRequest(db, none, dir, { session_name: 'alpha', rule_hashes: ['h1'] });
    createFixRequest(db, none, dir, { session_name: 'beta', rule_hashes: ['h2'] });
    createFixRequest(db, none, dir, { session_name: 'alpha', rule_hashes: ['h2'] });
    expect(sessionNames(db)).toEqual(['alpha', 'beta']);
    expect(slug('Fix: Mana -> Activate (ER-0645)')).toBe('fix-mana-activate-er-0645');
    expect(slug('!!!')).toBe('session');
  });
});
