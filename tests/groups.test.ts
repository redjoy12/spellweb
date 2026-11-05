import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, DB_PATH } from '../src/db/client.js';
import { loadTextTests, isTriggered, stripGroupText, activatedCost, timingLimitType } from '../src/graph/textTests.js';
import { groupsForCard, splitGroups, costResidue, persistGroups, GroupConflictError, groupAtomSha, type AbilityGroup } from '../src/graph/groups.js';
import { atomInfo, type GroupInfo } from '../src/graph/buildIndex.js';
import { scopeCards } from '../src/graph/intrinsic.js';
import { realDb, maybe } from './helpers/realDb.js';

const t = loadTextTests();

interface Atom { id: number; face_index: number; family: string; type_key: string; span_start: number; span_end: number; span_ambiguous: number }
interface Seen { g: AbilityGroup; text: string; stripped: string; atoms: Atom[] }

describe('splitGroups', () => {
  it('gives one group per non-empty paragraph, in face offsets', () => {
    const face = 'One.\nTwo two.\n\nThree.';
    expect(splitGroups(face).map((s) => face.slice(s.start, s.end))).toEqual(['One.', 'Two two.', 'Three.']);
    expect(splitGroups('')).toEqual([]);
  });
});

// Synthetic strings: text mechanics only.
describe('costResidue', () => {
  const run = (face: string, atoms: Array<{ span_start: number; span_end: number }>) => {
    const s = stripGroupText(face, 0, t);
    return costResidue(face, activatedCost(s, t)!, atoms, s, t);
  };
  it('is false for a cost of symbols, commas and spaces only', () => {
    expect(run('{2}, {T}: Do y.', [])).toBe(false);
  });
  it('is true when other text stays, and false when cost atom spans cover it', () => {
    expect(run('{1}, Do x: Do y.', [])).toBe(true);
    expect(run('{1}, Do x: Do y.', [{ span_start: 5, span_end: 9 }])).toBe(false);
  });
});

maybe('ability groups on the real BR slice', () => {
  let seen: Seen[];
  let byCard: Map<string, ReturnType<typeof groupsForCard>>;

  beforeAll(() => {
    seen = [];
    byCard = new Map();
    const atomsQ = realDb.prepare(
      'SELECT id, face_index, family, type_key, span_start, span_end, span_ambiguous FROM atoms WHERE oracle_id = ? AND is_current = 1',
    );
    const faceQ = realDb.prepare('SELECT oracle_text FROM card_faces WHERE oracle_id = ? AND face_index = ?');
    for (const id of scopeCards(realDb, 'BR')) {
      const atoms = atomsQ.all(id) as unknown as Atom[];
      if (atoms.length === 0) continue;
      const r = groupsForCard(realDb, id, t);
      byCard.set(id, r);
      for (const g of r.groups) {
        const face = (faceQ.get(id, g.face_index) as { oracle_text: string }).oracle_text;
        const text = face.slice(g.span_start, g.span_end);
        seen.push({ g, text, stripped: stripGroupText(text, g.span_start, t).text,
          atoms: atoms.filter((a) => a.face_index === g.face_index && r.atomGroup.get(a.id) === g.group_index) });
      }
    }
  });

  it('gives every slice card with atoms one or more groups, and a deterministic result', () => {
    for (const r of byCard.values()) expect(r.groups.length).toBeGreaterThan(0);
    const [id, first] = [...byCard.entries()][0]!;
    expect(groupsForCard(realDb, id, t)).toEqual(first);
  });

  it('a face with three paragraphs gives three groups, and each atom is in the group of its span', () => {
    const row = realDb.prepare(
      `SELECT f.oracle_id, f.face_index, f.oracle_text FROM card_faces f
        WHERE (length(f.oracle_text) - length(replace(f.oracle_text, char(10), ''))) = 2
          AND f.oracle_text NOT LIKE '%' || char(10) || char(10) || '%'
          AND EXISTS (SELECT 1 FROM atoms a WHERE a.oracle_id = f.oracle_id AND a.face_index = f.face_index AND a.is_current = 1)
        ORDER BY f.oracle_id LIMIT 1`,
    ).get() as { oracle_id: string; face_index: number; oracle_text: string };
    const r = groupsForCard(realDb, row.oracle_id, t);
    const groups = r.groups.filter((g) => g.face_index === row.face_index);
    expect(groups).toHaveLength(3);
    const atoms = realDb.prepare('SELECT id, span_start, span_end, span_ambiguous FROM atoms WHERE oracle_id = ? AND face_index = ? AND is_current = 1')
      .all(row.oracle_id, row.face_index) as Array<{ id: number; span_start: number; span_end: number; span_ambiguous: number }>;
    for (const a of atoms) {
      const g = groups[r.atomGroup.get(a.id)!]!;
      expect(a.span_start).toBeGreaterThanOrEqual(g.span_start);
      if (!a.span_ambiguous) expect(a.span_end).toBeLessThanOrEqual(g.span_end);
    }
  });

  it('an atom with span_ambiguous = 1 goes into the group of its span start, and is counted', () => {
    const a = realDb.prepare(
      'SELECT id, oracle_id, face_index, span_start FROM atoms WHERE span_ambiguous = 1 AND is_current = 1 ORDER BY id LIMIT 1',
    ).get() as { id: number; oracle_id: string; face_index: number; span_start: number } | undefined;
    expect(a).toBeDefined();
    if (!a) return;
    const r = groupsForCard(realDb, a.oracle_id, t);
    expect(r.ambiguous).toBeGreaterThan(0);
    const g = r.groups.find((x) => x.face_index === a.face_index && x.group_index === r.atomGroup.get(a.id))!;
    expect(a.span_start).toBeGreaterThanOrEqual(g.span_start);
    expect(a.span_start).toBeLessThanOrEqual(g.span_end);
  });

  it('fact 6, case 1: a group with two or more CARES_ABOUT atoms takes its kind from the text, not the atoms', () => {
    const cases = seen.filter((s) => s.atoms.filter((a) => a.family === 'CARES_ABOUT').length >= 2);
    expect(cases.length).toBeGreaterThan(0);
    // The same card with no atoms at all gives the same kind to each group.
    for (const s of cases) {
      const bare = groupsForCard(realDb, s.g.oracle_id, t, []).groups
        .find((g) => g.face_index === s.g.face_index && g.group_index === s.g.group_index)!;
      expect(bare.kind).toBe(s.g.kind);
    }
    expect(new Set(cases.map((s) => s.g.kind)).size).toBeGreaterThan(1);
  });

  it('fact 6, case 2: a group with a CARES_ABOUT atom whose text does not start with a trigger word is not triggered', () => {
    const cases = seen.filter((s) => s.atoms.some((a) => a.family === 'CARES_ABOUT') && !isTriggered(s.stripped, t));
    expect(cases.length).toBeGreaterThan(0);
    for (const s of cases) expect(s.g.kind).not.toBe('triggered');
  });

  it('fact 6, case 3: a group that starts with a trigger word and has no CARES_ABOUT atom is triggered', () => {
    const cases = seen.filter((s) => isTriggered(s.stripped, t) && !s.atoms.some((a) => a.family === 'CARES_ABOUT'));
    expect(cases.length).toBeGreaterThan(0);
    for (const s of cases) expect(s.g.kind).toBe('triggered');
  });

  it('reads each face of a multi-face card from card_faces', () => {
    const row = realDb.prepare(
      `SELECT a.oracle_id FROM atoms a WHERE a.is_current = 1 AND a.face_index = 1 ORDER BY a.oracle_id LIMIT 1`,
    ).get() as { oracle_id: string } | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    const r = groupsForCard(realDb, row.oracle_id, t);
    const faces = realDb.prepare('SELECT face_index, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
      .all(row.oracle_id) as Array<{ face_index: number; oracle_text: string }>;
    expect(new Set(r.groups.map((g) => g.face_index))).toEqual(new Set(faces.filter((f) => f.oracle_text.trim()).map((f) => f.face_index)));
    for (const g of r.groups) {
      const face = faces.find((f) => f.face_index === g.face_index)!;
      expect(g.span_end).toBeLessThanOrEqual(face.oracle_text.length);
      expect(splitGroups(face.oracle_text)[g.group_index]).toEqual({ start: g.span_start, end: g.span_end });
    }
  });

  it('an activated group gets the mana count, the tap flag and the cost atoms inside the cost text', () => {
    const act = seen.filter((s) => s.g.kind === 'activated');
    expect(act.length).toBeGreaterThan(0);
    for (const s of act) {
      const c = activatedCost(stripGroupText(s.text, s.g.span_start, t), t)!;
      expect(s.g.cost).not.toBeNull();
      expect(s.g.cost!.tap).toBe(c.cost.includes('{T}'));
      const inside = s.atoms.filter((a) => a.span_start >= c.faceStart && a.span_end <= c.faceEnd).map((a) => a.id);
      expect(s.g.cost!.atom_ids).toEqual(inside);
    }
    for (const s of seen.filter((x) => x.g.kind !== 'activated')) expect(s.g.cost).toBeNull();
  });

  it('a {T} cost with no other unknown symbol has a known mana count; a hybrid cost is unknown and counted', () => {
    const tapKnown = seen.find((s) => s.g.kind === 'activated' && s.g.cost!.tap
      && !/\{[^}]*\/[^}]*\}|\{X\}/.test(activatedCost(stripGroupText(s.text, s.g.span_start, t), t)!.cost));
    expect(tapKnown?.g.cost!.mana).toEqual(expect.any(Number));
    const hybrid = seen.filter((s) => s.g.kind === 'activated'
      && /\{[^}]*\/[^}]*\}/.test(activatedCost(stripGroupText(s.text, s.g.span_start, t), t)!.cost));
    expect(hybrid.length).toBeGreaterThan(0);
    for (const s of hybrid) expect(s.g.cost!.mana).toBe('unknown');
    const counted = [...byCard.values()].reduce((n, r) => n + r.effects.hybrid_cost, 0);
    expect(counted).toBe(hybrid.length);
  });

  it('cost_unparsed is true when cost text stays, false for a cost of symbols, commas and spaces only', () => {
    const act = seen.filter((s) => s.g.kind === 'activated');
    const costOf = (s: Seen) => activatedCost(stripGroupText(s.text, s.g.span_start, t), t)!.cost;
    const symbolsOnly = act.filter((s) => costOf(s).replace(/\{[^}]*\}/g, '').replace(/[, ]/g, '') === '' && s.g.cost!.atom_ids.length === 0);
    expect(symbolsOnly.length).toBeGreaterThan(0);
    for (const s of symbolsOnly) expect(s.g.cost_unparsed).toBe(false);
    const withText = act.filter((s) => s.g.cost!.atom_ids.length === 0 && costOf(s).replace(/\{[^}]*\}/g, '').replace(/[, ]/g, '') !== '');
    expect(withText.length).toBeGreaterThan(0);
    for (const s of withText) expect(s.g.cost_unparsed).toBe(true);
  });

  it('per_turn_limit is true when the cost has {T} or the group has a timing_limit atom', () => {
    const timing = timingLimitType(t);
    for (const s of seen) {
      const expected = (s.g.cost?.tap ?? false) || s.atoms.some((a) => a.family === timing.family && a.type_key === timing.type_key);
      expect(s.g.per_turn_limit).toBe(expected);
    }
    expect(seen.some((s) => s.g.per_turn_limit && !s.g.cost?.tap)).toBe(true);
  });

  it('unknown_limit is true when the text has the word "turn" and per_turn_limit is false', () => {
    for (const s of seen) expect(s.g.unknown_limit).toBe(/\bturn\b/i.test(s.stripped) && !s.g.per_turn_limit);
    expect(seen.some((s) => s.g.unknown_limit)).toBe(true);
  });

  it('a group with a colon only inside quotation marks is not activated', () => {
    const cases = seen.filter((s) => /"[^"]*:[^"]*"/.test(s.stripped) && !/:/.test(s.stripped.replace(/"[^"]*"/g, '')));
    expect(cases.length).toBeGreaterThan(0);
    for (const s of cases) expect(s.g.kind).not.toBe('activated');
  });
});

// A scratch copy of the real database (for the CR lookups of the text tests), with one
// synthetic card: the text is synthetic, so the test checks text mechanics, not Magic facts.
maybe('cost atoms and persistGroups on a scratch copy', () => {
  let db: DatabaseSync;
  let atomId: number;
  const FACE = 'Alpha beta.\n{1}, Do x: Do y.';
  const costStart = FACE.indexOf('Do x');

  beforeAll(() => {
    const scratch = join(mkdtempSync(join(tmpdir(), 'groups-')), 'app.db');
    copyFileSync(DB_PATH, scratch);
    for (const ext of ['-wal', '-shm']) if (existsSync(DB_PATH + ext)) copyFileSync(DB_PATH + ext, scratch + ext);
    db = openDb(scratch);
    const model = db.prepare('SELECT * FROM cards ORDER BY oracle_id LIMIT 1').get() as Record<string, unknown>;
    const cols = Object.keys(model);
    db.prepare(`INSERT INTO cards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => (c === 'oracle_id' ? 'synthetic-groups' : c === 'oracle_hash' ? 'synthetic-hash' : model[c]) as never));
    db.prepare("INSERT INTO card_faces (oracle_id, face_index, name, type_line, oracle_text, colors) VALUES ('synthetic-groups', 0, 'S', 't', ?, '[]')")
      .run(FACE);
    const a = db.prepare('SELECT run_id, schema_version, family, type_key FROM atoms WHERE is_current = 1 ORDER BY id LIMIT 1').get() as
      { run_id: number; schema_version: number; family: string; type_key: string };
    atomId = Number(db.prepare(
      `INSERT INTO atoms (run_id, oracle_id, face_index, schema_version, family, type_key, params_json, span_start, span_end, quote,
                          rule_numbers, confidence, confidence_source, oracle_hash)
       VALUES (?, 'synthetic-groups', 0, ?, ?, ?, '{}', ?, ?, 'Do x', '[]', 1, 'model', 'synthetic-hash')`,
    ).run(a.run_id, a.schema_version, a.family, a.type_key, costStart, costStart + 'Do x'.length).lastInsertRowid);
  });

  it('an atom whose span is inside the cost text is a cost atom, and the cost is then parsed', () => {
    const r = groupsForCard(db, 'synthetic-groups', t);
    const g = r.groups.find((x) => x.group_index === 1)!;
    expect(g.kind).toBe('activated');
    expect(g.cost).toEqual({ mana: 1, tap: false, atom_ids: [atomId] });
    expect(g.cost_unparsed).toBe(false);
    const bare = groupsForCard(db, 'synthetic-groups', t, []).groups.find((x) => x.group_index === 1)!;
    expect(bare.cost).toEqual({ mana: 1, tap: false, atom_ids: [] });
    expect(bare.cost_unparsed).toBe(true);
  });

  it('persistGroups writes new rows once, and stops when a stored row differs', () => {
    const groups = groupsForCard(db, 'synthetic-groups', t).groups;
    expect(persistGroups(db, groups)).toBe(2);
    expect(persistGroups(db, groups)).toBe(0);
    const stored = db.prepare("SELECT group_index, kind, cost_json, cost_unparsed FROM ability_groups WHERE oracle_id = 'synthetic-groups' ORDER BY group_index").all();
    expect(stored).toEqual([
      { group_index: 0, kind: 'other', cost_json: null, cost_unparsed: 0 },
      { group_index: 1, kind: 'activated', cost_json: JSON.stringify({ mana: 1, tap: false, atom_ids: [atomId] }), cost_unparsed: 0 },
    ]);
    // The same text and tests_version with another atom set (a requeue): new rows, keyed by atom_sha.
    const changed = groupsForCard(db, 'synthetic-groups', t, []).groups;
    expect(changed[0]!.atom_sha).not.toBe(groups[0]!.atom_sha);
    expect(persistGroups(db, changed)).toBe(2);
    expect(groups[0]!.atom_sha).toBe(groupAtomSha([atomId]));
    // The same atom set with a different stored value: the code changed without a new tests_version.
    db.prepare("UPDATE ability_groups SET per_turn_limit = 1 WHERE oracle_id = 'synthetic-groups' AND atom_sha = ? AND group_index = 1")
      .run(groups[0]!.atom_sha);
    expect(() => persistGroups(db, groups)).toThrow(GroupConflictError);
    expect(() => persistGroups(db, groups)).toThrow(/per_turn_limit/);
    db.prepare("UPDATE ability_groups SET per_turn_limit = 0 WHERE oracle_id = 'synthetic-groups' AND atom_sha = ? AND group_index = 1")
      .run(groups[0]!.atom_sha);
  });

  it("atomInfo reads the rows of the atom set it gets, and the old rows (atom_sha '') when that set has none", () => {
    const info = () => {
      const out = new Map<string, GroupInfo>();
      atomInfo(db, [atomId], t.tests_version, out);
      return out.get('synthetic-groups#0#1')!;
    };
    // Both atom sets have rows (the test above): the bare set's cost is not parsed, this one's is.
    expect(info().cost_unparsed).toBe(false);
    db.prepare("UPDATE ability_groups SET atom_sha = '' WHERE oracle_id = 'synthetic-groups' AND atom_sha = ?").run(groupAtomSha([atomId]));
    expect(info().cost_unparsed).toBe(false);
    db.prepare("DELETE FROM ability_groups WHERE oracle_id = 'synthetic-groups' AND atom_sha = ''").run();
    expect(() => info()).toThrow(/no stored ability groups/);
  });
});
