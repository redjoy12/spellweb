/**
 * The owner pairs for link rule version 2 (owner request 2026-10-31, docs/link-rule-v2-draft.md
 * sec. 5), on the "Your decisions" page as kind `link_rule`.
 *
 * The owner rejected rule questions with many pairs: "the questions are vague and include alot of
 * card pairs as a single question". So each item is now one card pair, with the two full card texts
 * and no test name, label or reason, so nothing steers the owner.
 *
 * The pairs are in docs/link-rule-v2-questions.json (`npm run link-rule-measure -- --sample`). The
 * file gives each pair a kind (src/graph/linkRuleV2.ts). The page never gets the kind. An answer
 * changes nothing: `npm run link-rule-measure -- --tally` counts the answers of each kind.
 *
 * Round 2 (plan 2026-10-31-schema-v17 Task 7) has its own file and the key prefix `lr2:`. Round 3
 * (Task 17) has its own file and the key prefix `lr3:`, and round 4 (Task 18) the same with `lr4:`.
 * Round 5 (docs/schema-v20-results.md sec. 12) is the same with `lr5:`, and it has also pairs that
 * are not links now. Round 6 (sec. 16) is the same with `lr6:`, on golden pairs with the label `none`.
 * The page shows all rounds, so the earlier answers stay, and the owner can change them.
 *
 * A follow-up (key prefix `lrf:`) asks the owner why on one earlier answer, with its question text
 * and at most one earlier pair for the contrast. No tally reads it: a changed answer goes to the key
 * of its round by hand, as in docs/schema-v17-results.md sec. 15.3.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { GOLDEN_CHECK_CHOICES } from './goldenCheck.js';
import { cardOf, type LinkCheckCard } from './linkCheck.js';
import type { LinkPair } from './linkRuleV2.js';

export interface LinkRuleItem {
  key: string; supply: LinkCheckCard; demand: LinkCheckCard;
  /** Only on a follow-up: the question, and the earlier pair that shows the contrast. */
  ask?: string;
  compare?: { supply: LinkCheckCard; demand: LinkCheckCard; answer: string };
}

export type LinkRuleRound = 1 | 2 | 3 | 4 | 5 | 6;

/** `golden_pair`: only in round 6, the golden pair that the question asks about again. */
export interface LinkRuleSample { source: string; build: number; seed: number; made_at: string; pools?: Record<string, number>; pairs: Array<LinkPair<string> & { key: string; golden_pair?: number }> }

/** The sample files, one for each round. Data files: their pair IDs are not rule numbers. */
export const LINK_RULE_QUESTIONS_PATH = 'docs/link-rule-v2-questions.json';
export const LINK_RULE_ROUND_2_PATH = 'docs/link-rule-round-2-questions.json';
export const LINK_RULE_ROUND_3_PATH = 'docs/link-rule-round-3-questions.json';
export const LINK_RULE_ROUND_4_PATH = 'docs/link-rule-round-4-questions.json';
export const LINK_RULE_ROUND_5_PATH = 'docs/link-rule-round-5-questions.json';
export const LINK_RULE_ROUND_6_PATH = 'docs/link-rule-round-6-questions.json';
export const LINK_RULE_FOLLOW_UP_PATH = 'docs/link-rule-follow-up-questions.json';
const PATHS: Record<LinkRuleRound, string> = { 1: LINK_RULE_QUESTIONS_PATH, 2: LINK_RULE_ROUND_2_PATH, 3: LINK_RULE_ROUND_3_PATH, 4: LINK_RULE_ROUND_4_PATH, 5: LINK_RULE_ROUND_5_PATH, 6: LINK_RULE_ROUND_6_PATH };

/** `other`: the owner writes the answer in the note. */
export const LINK_RULE_CHOICES = [...GOLDEN_CHECK_CHOICES, 'other'] as const;

export const linkRuleKey = (supply: string, demand: string, round: LinkRuleRound = 1) => `lr${round}:${supply}>${demand}`;

export function loadLinkRuleSample(round: LinkRuleRound = 1): LinkRuleSample | null {
  return existsSync(PATHS[round]) ? JSON.parse(readFileSync(PATHS[round], 'utf8')) as LinkRuleSample : null;
}

interface FollowUp { key: string; supply: string; demand: string; ask: string; compare?: { supply: string; demand: string; answer: string } }

function followUpItems(db: DatabaseSync): LinkRuleItem[] {
  if (!existsSync(LINK_RULE_FOLLOW_UP_PATH)) return [];
  return (JSON.parse(readFileSync(LINK_RULE_FOLLOW_UP_PATH, 'utf8')) as { items: FollowUp[] }).items.map((f) => ({
    key: f.key, supply: cardOf(db, f.supply), demand: cardOf(db, f.demand), ask: f.ask,
    ...(f.compare ? { compare: { supply: cardOf(db, f.compare.supply), demand: cardOf(db, f.compare.demand), answer: f.compare.answer } } : {}),
  }));
}

export function linkRuleItems(db: DatabaseSync): LinkRuleItem[] {
  return [...([1, 2, 3, 4, 5, 6] as const).flatMap((round) => (loadLinkRuleSample(round)?.pairs ?? [])
    .map((p) => ({ key: p.key, supply: cardOf(db, p.supply), demand: cardOf(db, p.demand) }))), ...followUpItems(db)];
}
