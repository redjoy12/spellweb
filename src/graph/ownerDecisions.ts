/**
 * The decisions that wait for the owner (owner request 2026-10-18), on one page:
 * - `cr_text`: two CR sentences with nearly the same words (tier `fuzzy`, src/rules/crDuplicates.ts).
 *   Does the second sentence state the same thing as the main one?
 * - `rule_conflict`: two or more accepted rules of one type pair that disagree and do not
 *   subsume each other (docs/phase-3-duplicate-reasons.md sec. 7). Keep both, or one?
 * - `supply_twin`: two supply types with the same rules for each demand type (sec. 8). Are they
 *   one type (a schema v15 candidate)?
 * - `link_check`: a real linked card pair of a build (spec rev. 17 sec. 5.9, src/graph/linkCheck.ts).
 *   Do the two cards work together?
 * - `tag_check`: a real card with its current atoms (src/atoms/tagCheck.ts, owner request 2026-10-21).
 *   Are the tags of the card correct?
 * - `tag_merge`: two atom types that the CR text proves are one meaning (src/atoms/tagMerge.ts,
 *   owner request 2026-10-23). Merge them? Round 2 (2026-10-24) adds pairs that seem to be one
 *   meaning, with the evidence both ways and the measured effect on the links.
 * - `reading`, `type_role`, `wrong_link`: the high-help questions of src/graph/ownerQuestions.ts
 *   (owner request 2026-10-19). How must the app read a text, can a type work in both directions,
 *   and do two cards of a disputed golden pair work together?
 * - `golden_check`: an accepted golden synergy pair (src/graph/goldenCheck.ts, owner request
 *   2026-10-24). Is it a real link under the owner's link rule?
 * - `link_rule`: one card pair that the app links now, for link rule version 2
 *   (src/graph/linkRuleQuestions.ts, owner request 2026-10-31). Is the link real?
 *
 * The page records an answer in `owner_decisions`. An answer changes nothing else: a later step
 * applies the answers. The code makes no decision itself; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentCorpusId } from '../atoms/golden.js';
import { crDuplicates, textKey } from '../rules/crDuplicates.js';
import { statSync, existsSync } from 'node:fs';
import { loadVerdicts, VERDICTS_PATH, type VerdictEntry } from './crDebate.js';
import { conflictGroups, twinPairs } from './duplicateRules.js';
import { LINK_CHECK_CHOICES, LINK_CHECK_PATH, loadLinkCheckSample, type LinkCheckItem } from './linkCheck.js';
import { loadOwnerQuestions, QUESTIONS_PATH, ROLE_CHOICES, WRONG_LINK_CHOICES, type ReadingItem, type RoleItem, type WrongLinkItem } from './ownerQuestions.js';
import { loadTagCheckSample, TAG_CHECK_CHOICES, TAG_CHECK_PATH, withDescriptions, type TagCheckItem } from '../atoms/tagCheck.js';
import { TAG_MERGE_CHOICES, TAG_MERGE_ITEMS_PATH, TAG_MERGE_PATH, TAG_MERGE_ROUND2_ITEMS_PATH, TAG_MERGE_ROUND2_PATH, tagMergeItems, type TagMergeItem } from '../atoms/tagMerge.js';
import { locateEvidence } from './evidenceRefs.js';
import { LINK_RULE_CHOICES, linkRuleItems, type LinkRuleItem } from './linkRuleQuestions.js';
import { GOLDEN_CHECK_CHOICES, goldenCheckItems, type GoldenCheckItem } from './goldenCheck.js';
import { isIntrinsic } from './ruleSchema.js';
import { currentRuleSet, getRuleSet, setRules, type StoredRule } from './ruleSet.js';
import { subsumedRules } from './subsume.js';

export type DecisionKind = 'cr_text' | 'rule_conflict' | 'supply_twin' | 'link_check' | 'reading' | 'type_role' | 'wrong_link' | 'tag_check' | 'tag_merge' | 'golden_check' | 'link_rule';
export const DECISION_KINDS: readonly DecisionKind[] = ['cr_text', 'rule_conflict', 'supply_twin', 'link_check', 'reading', 'type_role', 'wrong_link', 'tag_check', 'tag_merge', 'golden_check', 'link_rule'];

export interface CrTextItem {
  key: string;
  main: { source: 'rule' | 'glossary'; ref: string; text: string };
  member: { source: 'rule' | 'glossary'; ref: string; text: string };
  /** The quotes of the accepted rules and roles that cite the member sentence. */
  quotes: number;
  /** The debate verdict (data/cr-debate/verdicts.json), when the pair was debated. */
  debate?: Pick<VerdictEntry, 'verdict' | 'round' | 'votes'>;
}
export interface ConflictItem {
  key: string;
  polarity: '+' | '-';
  supply: string;
  demand: string;
  differs: string[];
  rules: StoredRule[];
}
export interface TwinItem { key: string; types: [string, string]; rules: [number, number]; demands: string[] }
export interface Decision { kind: DecisionKind; item_key: string; choice: string; note: string; decided_at: string }

export interface DecisionPage {
  rule_set: number | null;
  corpus: number;
  items: {
    cr_text: CrTextItem[]; rule_conflict: ConflictItem[]; supply_twin: TwinItem[]; link_check: LinkCheckItem[];
    reading: ReadingItem[]; type_role: RoleItem[]; wrong_link: WrongLinkItem[]; tag_check: TagCheckItem[]; tag_merge: TagMergeItem[]; golden_check: GoldenCheckItem[]; link_rule: LinkRuleItem[];
  };
  decisions: Decision[];
  /** Items that wait for the owner on other pages. */
  elsewhere: { review_atom: number; review_edge_rules: number; edge_reports: number; fix_requests: number };
}

const typeOf = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

/** The items of each kind, with no decisions. Cached for each database, corpus and rule set. */
const cache = new WeakMap<DatabaseSync, Map<string, DecisionPage['items']>>();

function buildItems(db: DatabaseSync, corpusId: number, setId: number | null): DecisionPage['items'] {
  const d = crDuplicates(db, corpusId);
  const accepted = setId === null ? [] : setRules(db, setId, 'accepted');
  // The citations of each fuzzy member sentence, in the accepted rules and roles of the set.
  const fuzzy = new Map<string, number>();
  for (const g of d.groups) for (const m of g.members) if (m.tier === 'fuzzy') fuzzy.set(m.key, 0);
  if (setId !== null && getRuleSet(db, setId)?.corpus_id === corpusId) {
    const lists = accepted.flatMap((r) => [r.evidence, ...r.implications.map((i) => i.evidence)]);
    for (const e of lists.flat()) {
      const r = locateEvidence(db, corpusId, e);
      if (!r) continue;
      for (const s of d.byText.get(textKey(r.source, r.ref)) ?? []) {
        if (s.start < r.end && r.start < s.end && fuzzy.has(s.key)) fuzzy.set(s.key, fuzzy.get(s.key)! + 1);
      }
    }
  }
  const verdicts = loadVerdicts();
  const debated = verdicts?.corpus === corpusId ? verdicts.items : {};
  const crText: CrTextItem[] = d.groups.flatMap((g) => g.members.filter((m) => m.tier === 'fuzzy').map((m) => {
    const key = `c${corpusId}:${m.key}>${g.main.key}`;
    const v = debated[key];
    return {
      key,
      main: { source: g.main.source, ref: g.main.ref, text: g.main.text },
      member: { source: m.source, ref: m.ref, text: m.text },
      quotes: fuzzy.get(m.key) ?? 0,
      ...(v ? { debate: { verdict: v.verdict, round: v.round, votes: v.votes } } : {}),
    };
  }));
  crText.sort((a, b) => b.quotes - a.quotes);

  const sub = setId === null ? new Map() : subsumedRules(db, setId, accepted);
  const conflicts: ConflictItem[] = conflictGroups(accepted, sub).map((c) => {
    const [polarity, supply, demand] = c.type_pair.split('|') as ['+' | '-', string, string];
    return { key: `s${setId}:${c.rules.map((r) => r.rule_hash).sort().join(',')}`, polarity, supply, demand, differs: c.differs, rules: c.rules };
  });

  const twins: TwinItem[] = twinPairs(accepted).filter((t) => t.jaccard === 1).map((t) => {
    const demandsOf = (type: string) => new Set(t.rules.filter((r) => !isIntrinsic(r.supply) && typeOf(r.supply) === type).map((r) => typeOf(r.demand)));
    const [a, b] = [demandsOf(t.supply_types[0]), demandsOf(t.supply_types[1])];
    return { key: `s${setId}:${t.supply_types.join('+')}`, types: t.supply_types, rules: [t.a_rules, t.b_rules], demands: [...a].filter((x) => b.has(x)).sort() };
  });
  const q = loadOwnerQuestions();
  return {
    cr_text: crText, rule_conflict: conflicts, supply_twin: twins, link_check: loadLinkCheckSample()?.items ?? [],
    reading: q?.reading ?? [], type_role: q?.type_role ?? [], wrong_link: q?.wrong_link ?? [],
    tag_check: withDescriptions(db, loadTagCheckSample()?.items ?? []), tag_merge: tagMergeItems(db, corpusId, setId),
    golden_check: [], link_rule: [],
  };
}

export function decisionItems(db: DatabaseSync): { corpus: number; setId: number | null; items: DecisionPage['items'] } {
  const corpus = currentCorpusId(db);
  const setId = currentRuleSet(db)?.id ?? null;
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  // The verdict file, the samples and the questions can change: their times are in the cache key.
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const k = `${corpus}|${setId}|${mtime(VERDICTS_PATH)}|${mtime(LINK_CHECK_PATH)}|${mtime(QUESTIONS_PATH)}|${mtime(TAG_CHECK_PATH)}|${mtime(TAG_MERGE_PATH)}|${mtime(TAG_MERGE_ITEMS_PATH)}|${mtime(TAG_MERGE_ROUND2_PATH)}|${mtime(TAG_MERGE_ROUND2_ITEMS_PATH)}`;
  let items = m.get(k);
  if (!items) { items = buildItems(db, corpus, setId); m.set(k, items); }
  // The golden check follows the golden set and the answers, so it is not cached (one small query).
  // A `wrong_link` item shows the label and the reasons of its pair: hide it when the golden check
  // asks about the same pair, so that it does not steer that answer.
  const golden = goldenCheckItems(db);
  const asked = new Set(golden.map((g) => g.pair_id));
  return { corpus, setId, items: { ...items, golden_check: golden, link_rule: linkRuleItems(db), wrong_link: items.wrong_link.filter((w) => !asked.has(w.pair_id)) } };
}

export function listDecisions(db: DatabaseSync): Decision[] {
  return db.prepare('SELECT kind, item_key, choice, note, decided_at FROM owner_decisions ORDER BY decided_at').all() as unknown as Decision[];
}

export function decisionPage(db: DatabaseSync): DecisionPage {
  const { corpus, setId, items } = decisionItems(db);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    rule_set: setId, corpus, items, decisions: listDecisions(db),
    elsewhere: {
      review_atom: n("SELECT COUNT(*) n FROM review_queue WHERE domain = 'atom' AND status = 'pending'"),
      review_edge_rules: n("SELECT COUNT(*) n FROM review_queue WHERE domain = 'edge' AND severity = 'edge_rule_disagreement' AND status = 'pending'"),
      edge_reports: n("SELECT COUNT(*) n FROM edge_reports WHERE status = 'open'"),
      fix_requests: n("SELECT COUNT(*) n FROM fix_requests WHERE status IN ('queued','sent')"),
    },
  };
}

export class DecisionError extends Error {}

/** The answers that an item permits. */
export function choicesOf(kind: DecisionKind, item: CrTextItem | ConflictItem | TwinItem | LinkCheckItem | ReadingItem | RoleItem | WrongLinkItem | TagCheckItem | TagMergeItem | GoldenCheckItem | LinkRuleItem): string[] {
  if (kind === 'link_rule') return [...LINK_RULE_CHOICES];
  if (kind === 'golden_check') return [...GOLDEN_CHECK_CHOICES];
  if (kind === 'tag_merge') return (item as TagMergeItem).choices?.map((c) => c.choice) ?? [...TAG_MERGE_CHOICES];
  if (kind === 'tag_check') return [...TAG_CHECK_CHOICES];
  if (kind === 'link_check') return [...LINK_CHECK_CHOICES];
  if (kind === 'reading') return (item as ReadingItem).choices.map((c) => c.choice);
  if (kind === 'type_role') return [...ROLE_CHOICES];
  if (kind === 'wrong_link') return [...WRONG_LINK_CHOICES];
  if (kind === 'rule_conflict') return ['keep_both', ...(item as ConflictItem).rules.map((r) => `keep:${r.rule_id}`), 'unsure'];
  return ['same', 'different', 'unsure'];
}

/** Records (or replaces) the owner's answer for one item. The answer changes nothing else. */
export function saveDecision(db: DatabaseSync, d: { kind: string; item_key: string; choice: string; note?: string }): Decision {
  if (!DECISION_KINDS.includes(d.kind as DecisionKind)) throw new DecisionError(`unknown kind "${d.kind}"`);
  const kind = d.kind as DecisionKind;
  const item = (decisionItems(db).items[kind] as Array<{ key: string }>).find((x) => x.key === d.item_key);
  if (!item) throw new DecisionError(`no ${kind} item "${d.item_key}"`);
  const choices = choicesOf(kind, item as CrTextItem);
  if (!choices.includes(d.choice)) throw new DecisionError(`"${d.choice}" is not an answer for this item: use ${choices.join(', ')}`);
  const out: Decision = { kind, item_key: d.item_key, choice: d.choice, note: (d.note ?? '').trim(), decided_at: new Date().toISOString() };
  db.prepare('INSERT OR REPLACE INTO owner_decisions (kind, item_key, choice, note, decided_at) VALUES (?, ?, ?, ?, ?)')
    .run(out.kind, out.item_key, out.choice, out.note, out.decided_at);
  return out;
}

/** Removes the owner's answer for one item (the item is open again). */
export function clearDecision(db: DatabaseSync, kind: string, itemKey: string): boolean {
  return Number(db.prepare('DELETE FROM owner_decisions WHERE kind = ? AND item_key = ?').run(kind, itemKey).changes) > 0;
}
