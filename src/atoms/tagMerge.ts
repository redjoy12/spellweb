/**
 * Tag merge proposals (owner request 2026-10-23): pairs of atom types that share the same text
 * almost always, and that the stored CR text proves are one meaning. The proposals file holds the
 * semantic check (written by hand from the CR text); this module adds the counts and examples from
 * the current atoms. The owner approves or refuses each merge on the "Your decisions" page.
 * An answer changes nothing else: a later schema step applies the approved merges.
 *
 * Round 2 (owner request 2026-10-24, tag check round 2 step B, problem P3): the pairs that the owner
 * notes name, and one more pair of the same kind, on the v16 atoms. Each item also gives the
 * evidence for two meanings, the measured effect on the links (on a database copy) and, when a pair
 * has more than one way to merge, its own answers. The round 1 items and answers stay.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { latestLabels } from './schema.js';
import { loadTagDescriptions } from './tagDescribe.js';

export const TAG_MERGE_PATH = 'docs/tag-merge/proposals.json';
/**
 * The items as the owner saw them, from the v15 atoms. The v16 move (spec sec. 21) made those atoms
 * not current, so the page reads this snapshot when it exists (`npm run schema-v16 -- --merge-snapshot`).
 */
export const TAG_MERGE_ITEMS_PATH = 'docs/tag-merge/items.json';
/** Round 2: the proposals, with the measured effects (docs/tag-merge-round-2.md). */
export const TAG_MERGE_ROUND2_PATH = 'docs/tag-merge/round-2.json';
/**
 * The round 2 items as the owner saw them, from the v16 atoms. Run 25 (spec sec. 22) made many of
 * those atoms not current, so the page reads this snapshot when it exists
 * (`npm run schema-v17 -- --merge-snapshot`).
 */
export const TAG_MERGE_ROUND2_ITEMS_PATH = 'docs/tag-merge/round-2-items.json';
export const TAG_MERGE_CHOICES = ['merge', 'keep_both', 'unsure'] as const;

interface Proposal { a: string; b: string; relation: 'same' | 'part_of'; evidence: string[]; why: string; change: string; contrast?: boolean }
export interface TagMergeChoice { choice: string; label: string; hint: string }
/** One measured case on a database copy: the change, and the card pairs and golden pairs it changes. */
export interface TagMergeEffect { change: string; synergy_added: number; synergy_lost: number; anti_change: number; golden: string }
interface Round2Proposal {
  a: string; b: string; relation: 'same' | 'part_of' | 'open';
  /** A group of items that the owner answers together, for example one standard for power and toughness. */
  group?: string;
  question: string;
  one_meaning: string[]; two_meanings: string[];
  evidence: string[]; why: string; change: string;
  effects: TagMergeEffect[];
  choices?: TagMergeChoice[];
  /** The lists of examples with only one of the two types. */
  show?: Array<'a_only' | 'b_only'>;
}
export interface TagMergeSide { type: string; label: string | null; atoms: number; rules: number; description?: string }
export interface TagMergeExample { name: string; quote: string }
export interface TagMergeItem {
  key: string;
  /** Absent on round 1 items. */
  round?: number;
  relation: 'same' | 'part_of' | 'open';
  a: TagMergeSide; b: TagMergeSide;
  /** Texts (card + span) with both types, and texts with type A. */
  together: number;
  evidence: Array<{ ref: string; text: string }>;
  why: string; change: string;
  examples: TagMergeExample[];
  /** For a `contrast` proposal: texts with type B only. */
  b_only?: TagMergeExample[];
  /** Round 2: texts with type A only. */
  a_only?: TagMergeExample[];
  group?: string;
  question?: string;
  one_meaning?: string[]; two_meanings?: string[];
  effects?: TagMergeEffect[];
  /** The answers of this item, when they are not TAG_MERGE_CHOICES. */
  choices?: TagMergeChoice[];
}

export function tagMergeItems(db: DatabaseSync, corpusId: number, setId: number | null, path: string = TAG_MERGE_PATH,
  snapshot: string | null = TAG_MERGE_ITEMS_PATH, round2: string | null = TAG_MERGE_ROUND2_PATH,
  snapshot2: string | null = TAG_MERGE_ROUND2_ITEMS_PATH): TagMergeItem[] {
  const first = snapshot && existsSync(snapshot) ? JSON.parse(readFileSync(snapshot, 'utf8')) as TagMergeItem[] : roundOne(db, corpusId, setId, path);
  const second = snapshot2 && existsSync(snapshot2) ? JSON.parse(readFileSync(snapshot2, 'utf8')) as TagMergeItem[]
    : round2 && existsSync(round2) ? roundTwo(db, corpusId, setId, round2) : [];
  // A snapshot keeps its counts. The names are the current labels (spec sec. 23 items B4, B5).
  const labels = latestLabels(db);
  const named = (s: TagMergeSide): TagMergeSide => ({ ...s, label: labels.get(s.type) ?? s.label });
  return [...first, ...second].map((i) => ({ ...i, a: named(i.a), b: named(i.b) }));
}

function roundOne(db: DatabaseSync, corpusId: number, setId: number | null, path: string): TagMergeItem[] {
  if (!existsSync(path)) return [];
  const { proposals } = JSON.parse(readFileSync(path, 'utf8')) as { proposals: Proposal[] };
  const q = queries(db, corpusId, setId, 15);
  return proposals.map((p) => {
    const shared = q.both(p.a, p.b);
    return {
      key: `merge:${p.a}>${p.b}`, relation: p.relation, a: q.side(p.a), b: q.side(p.b), together: shared.length,
      evidence: q.evidence(p.evidence), why: p.why, change: p.change,
      examples: spread(shared, 3),
      ...(p.contrast ? { b_only: spread(q.only(p.b, p.a), 3) } : {}),
    };
  });
}

function roundTwo(db: DatabaseSync, corpusId: number, setId: number | null, path: string): TagMergeItem[] {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { schema_version: number; proposals: Round2Proposal[] };
  const q = queries(db, corpusId, setId, file.schema_version);
  const d = loadTagDescriptions();
  const described = (s: TagMergeSide): TagMergeSide => {
    const x = d?.schema_version === file.schema_version ? d.types[s.type]?.description : undefined;
    return x ? { ...s, description: x } : s;
  };
  return file.proposals.map((p) => {
    const shared = q.both(p.a, p.b);
    return {
      key: `merge2:${p.a}>${p.b}`, round: 2, relation: p.relation, a: described(q.side(p.a)), b: described(q.side(p.b)), together: shared.length,
      evidence: q.evidence(p.evidence), why: p.why, change: p.change,
      examples: spread(shared, 3),
      ...(p.show?.includes('a_only') ? { a_only: spread(q.only(p.a, p.b), 3) } : {}),
      ...(p.show?.includes('b_only') ? { b_only: spread(q.only(p.b, p.a), 3) } : {}),
      ...(p.group ? { group: p.group } : {}),
      question: p.question, one_meaning: p.one_meaning, two_meanings: p.two_meanings, effects: p.effects,
      ...(p.choices ? { choices: p.choices } : {}),
    };
  });
}

/** The counts and examples of one schema version. */
function queries(db: DatabaseSync, corpusId: number, setId: number | null, schema: number) {
  const split = (t: string) => t.split('.') as [string, string];
  const label = db.prepare('SELECT label FROM atom_types WHERE schema_version = ? AND family = ? AND type_key = ?');
  // Texts (card face + span), not atoms: one text can hold two atoms of one type.
  const count = db.prepare(`SELECT COUNT(DISTINCT oracle_id || '|' || face_index || '|' || span_start || '|' || span_end) n FROM atoms
    WHERE is_current = 1 AND schema_version = ? AND family = ? AND type_key = ?`);
  const rules = setId === null ? [] : (db.prepare("SELECT supply_json, demand_json FROM edge_rules WHERE set_id = ? AND status = 'accepted'").all(setId) as Array<{ supply_json: string; demand_json: string }>);
  const rulesOf = (t: string) => rules.filter((r) => [r.supply_json, r.demand_json].some((s) => {
    const x = JSON.parse(s) as { family?: string; type_key?: string };
    return `${x.family}.${x.type_key}` === t;
  })).length;
  // Texts with type A (x) and with or without type B (y) on the same card face and span.
  const pairSql = (withB: boolean) => `
    SELECT c.name, x.quote FROM atoms x JOIN cards c ON c.oracle_id = x.oracle_id
    WHERE x.is_current = 1 AND x.schema_version = ${schema} AND x.family = ? AND x.type_key = ?
      AND ${withB ? '' : 'NOT'} EXISTS (SELECT 1 FROM atoms y WHERE y.oracle_id = x.oracle_id AND y.face_index = x.face_index
        AND y.span_start = x.span_start AND y.span_end = x.span_end AND y.is_current = 1 AND y.schema_version = ${schema}
        AND y.family = ? AND y.type_key = ?)
    GROUP BY x.oracle_id, x.face_index, x.span_start, x.span_end ORDER BY x.oracle_id`;
  const both = db.prepare(pairSql(true));
  const without = db.prepare(pairSql(false));
  const ruleText = db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?');
  return {
    side: (t: string): TagMergeSide => {
      const [f, k] = split(t);
      return { type: t, label: (label.get(schema, f, k) as { label: string } | undefined)?.label ?? null, atoms: (count.get(schema, f, k) as { n: number }).n, rules: rulesOf(t) };
    },
    both: (a: string, b: string) => both.all(...split(a), ...split(b)) as unknown as TagMergeExample[],
    only: (a: string, b: string) => without.all(...split(a), ...split(b)) as unknown as TagMergeExample[],
    evidence: (refs: string[]) => refs.map((ref) => ({ ref, text: (ruleText.get(corpusId, ref) as { text: string } | undefined)?.text ?? '' })),
  };
}

/** Up to n items, spread evenly over the list (the list is in a fixed order). */
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]!);
}
