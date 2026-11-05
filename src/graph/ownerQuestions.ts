/**
 * The high-help questions for the owner (owner request 2026-10-19), on the "Your decisions" page.
 * They come from the score of the newest build (docs/phase-3-score-build-11.md):
 * - `reading`: how the extractor reads a text pattern. Each question comes from a golden pair that
 *   lost its atom, or from a gap in the run 22 batch notes (docs/slice-br-v15-results.md sec. 3).
 * - `type_role`: a type whose Stage A role blocks a golden synergy pair from Stage B.
 * - `wrong_link`: a golden pair where a confirmed edge of the build does not agree with the label.
 *
 * `npm run owner-questions -- --make` writes the file; the page reads it. The code makes no
 * decision: the patterns are text matches and the proposals come from the golden set and the batch
 * notes. An answer changes nothing else; a later step applies the answers.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { BuildIndex } from './buildIndex.js';
import { deriverOnlyScore } from './deriverScore.js';
import { cardOf, edgeReasons, type LinkCheckCard, type LinkCheckReason } from './linkCheck.js';
import { mergeEdges } from './merge.js';
import { fullScore } from './score.js';
import { setRules } from './ruleSet.js';

export const QUESTIONS_PATH = 'docs/owner-questions/questions.json';

export interface Choice { choice: string; label: string; hint: string }

const YES_NO: Choice[] = [
  { choice: 'yes', label: 'Yes', hint: 'Always read this text so.' },
  { choice: 'no', label: 'No', hint: 'Do not read this text so.' },
  { choice: 'depends', label: 'Only sometimes', hint: 'Write in the note when it is so.' },
  { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
];

interface ReadingDef {
  id: string;
  /** The card words, as the owner sees them. */
  words: string;
  pattern: RegExp;
  /** The types that the question is about. */
  types: string[];
  question: string;
  /** Where the question comes from. */
  source: string;
  choices?: Choice[];
}

/** The reading questions. Each one names its source; none is a fact of Magic. */
export const READING_DEFS: readonly ReadingDef[] = [
  {
    id: 'each_creature_damage', words: 'deals N damage to each creature',
    pattern: /deals (?:\d+|X) damage to each (?:other )?creature/,
    types: ['INTERACTION.SWEEPER'],
    question: 'When a card deals damage to each creature, must the app also read it as "Mass removal"?',
    source: 'Golden pair 111 lost its link: on that card, the app reads this text only as "Deals damage". The run 22 batch notes also name this gap.',
  },
  {
    id: 'sacrifice_trigger', words: 'Whenever you sacrifice a …',
    pattern: /[Ww]henever you sacrifice (?:a|an|another|one or more)\b/,
    types: ['CARES_ABOUT.PERMANENT_DIES'],
    question: 'When a card says "Whenever you sacrifice a …", must the app read it as "Cares about a permanent dying"?',
    source: 'Golden pair 137 lost its link, because the app reads this trigger differently now.',
  },
  {
    id: 'granted_sacrifice', words: '… you control have "… sacrifice a …"',
    pattern: /(?:have|has|gain|gains) "[^"]*[Ss]acrifice (?:a|an|another)\b/,
    types: ['ENABLES.SACRIFICE_OUTLET'],
    question: 'When a card gives other permanents an ability that sacrifices, must the app read the card itself as a "Sacrifice outlet"?',
    source: 'Golden pair 141 lost its link. The run 22 batch notes also name this gap.',
  },
  {
    id: 'descended', words: 'if you descended this turn',
    pattern: /descended/,
    types: ['CARES_ABOUT.POPULATED_GRAVEYARD'],
    question: 'When a card checks "if you descended this turn", must the app read it as "Requires a populated graveyard"?',
    source: 'Golden pairs 111 and 152 lost their link. The app has no reading for this text now.',
  },
  {
    id: 'role_attached', words: 'create a … Role token attached to target creature',
    pattern: /create an? [A-Z][\w-]*(?: [A-Z][\w-]*)* Role token attached to/,
    types: ['ENABLES.ATTACH'],
    question: 'When a card creates a Role token attached to a creature, must the app read it as "Attach"?',
    source: 'Golden pair 23 lost its link: the old reading of that card had "Attach", and the new reading does not.',
  },
  {
    id: 'food_token', words: 'create a Food token',
    pattern: /create (?:a|an|one|two|three|X) Food tokens?/,
    types: ['PRODUCES.SACRIFICE_FODDER'],
    question: 'When a card creates a Food token, must the app read it as "Creates a permanent intended to be sacrificed"?',
    source: 'Golden pair 91 lost this reading: the old reading of that card had it, and the new reading does not.',
  },
  {
    id: 'damage_target_creature', words: 'deals N damage to target creature',
    pattern: /deals (?:\d+|X) damage to target creature/,
    types: ['INTERACTION.TARGETED_REMOVAL'],
    question: 'When a card deals damage to a target creature, must the app also read it as "Targeted removal"?',
    source: 'The run 22 batch notes: some batches add "Targeted removal" to this text, and some do not.',
  },
  {
    id: 'target_player_life', words: 'Target player loses N life',
    pattern: /[Tt]arget player loses (?:\d+|X) life/,
    types: ['PRODUCES.LIFE_LOSS'],
    question: 'When a card says "Target player loses N life", how must the app read it?',
    source: 'The run 22 batch notes: the batches do not agree on this text. Some give both life-loss readings, and some give none.',
    choices: [
      { choice: 'opponent', label: 'Opponent loses life', hint: 'Read it only as "Opponent loses life".' },
      { choice: 'both', label: 'Both', hint: 'Read it as "Opponent loses life" and as "You lose life".' },
      { choice: 'none', label: 'Neither', hint: 'Give it no life-loss reading.' },
      { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
    ],
  },
];

export interface ReadingExample { name: string; image: string | null; line: string; match: string; now: string[] }
export interface ReadingItem {
  key: string; words: string; types: string[]; question: string; source: string; choices: Choice[];
  /** The slice cards with the pattern, and for each type the cards that have it on the match now. */
  cards: number; with_type: Record<string, number>;
  /** The types on the matches now, with the card count, most first. */
  now: Array<{ type: string; cards: number }>;
  examples: ReadingExample[];
}

export interface RolePair { pair_id: number; supply: LinkCheckCard; demand: LinkCheckCard; supply_quote: string; demand_quote: string }
export interface RoleItem {
  key: string; type: string;
  /** The accepted role now, and the direction that the golden pairs need. */
  role: string; needs: 'supply' | 'demand';
  atoms: number; examples: Array<{ name: string; quote: string }>;
  pairs: RolePair[];
}
export const ROLE_CHOICES = ['both', 'keep', 'unsure'] as const;

export interface WrongLinkItem {
  key: string; pair_id: number;
  /** The golden label. The page does not show it, so that it does not steer the answer. */
  label: string;
  polarities: Array<'+' | '-'>;
  supply: LinkCheckCard; demand: LinkCheckCard;
  reasons: LinkCheckReason[];
}
export const WRONG_LINK_CHOICES = ['link', 'weak_link', 'no_link', 'anti', 'unsure'] as const;

export interface OwnerQuestions {
  build: number; rule_set: number; made_at: string;
  reading: ReadingItem[]; type_role: RoleItem[]; wrong_link: WrongLinkItem[];
}

const typeOf = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

function readingItems(db: DatabaseSync): ReadingItem[] {
  const faces = db.prepare(
    `SELECT f.oracle_id, f.face_index, f.oracle_text, c.name, COALESCE(c.image_normal, f.image_normal) image
       FROM card_faces f JOIN cards c ON c.oracle_id = f.oracle_id
      WHERE f.oracle_id IN (SELECT DISTINCT oracle_id FROM atoms WHERE is_current = 1 AND consensus = 1)
      ORDER BY c.name, f.face_index`,
  ).all() as Array<{ oracle_id: string; face_index: number; oracle_text: string; name: string; image: string | null }>;
  const atomsOn = db.prepare(
    `SELECT DISTINCT family, type_key FROM atoms WHERE oracle_id = ? AND face_index = ? AND is_current = 1 AND consensus = 1
        AND span_start < ? AND span_end > ?`,
  );
  return READING_DEFS.map((d) => {
    const hits: Array<ReadingExample & { oracle: string }> = [];
    for (const f of faces) {
      const m = d.pattern.exec(f.oracle_text);
      if (!m || hits.some((h) => h.oracle === f.oracle_id)) continue;
      const start = f.oracle_text.lastIndexOf('\n', m.index) + 1;
      const endAt = f.oracle_text.indexOf('\n', m.index);
      const now = (atomsOn.all(f.oracle_id, f.face_index, m.index + m[0].length, m.index) as Array<{ family: string; type_key: string }>).map(typeOf).sort();
      hits.push({ oracle: f.oracle_id, name: f.name, image: f.image, line: f.oracle_text.slice(start, endAt < 0 ? undefined : endAt), match: m[0], now });
    }
    const withType = Object.fromEntries(d.types.map((t) => [t, hits.filter((h) => h.now.includes(t)).length]));
    const tally = new Map<string, number>();
    for (const h of hits) for (const t of h.now) tally.set(t, (tally.get(t) ?? 0) + 1);
    // Show the cards without the types first: they show the gap. Then one card with a type, if any.
    const without = hits.filter((h) => !d.types.some((t) => h.now.includes(t)));
    const withAny = hits.filter((h) => d.types.some((t) => h.now.includes(t)));
    const examples = [...without.slice(0, withAny.length ? 3 : 4), ...withAny.slice(0, 1)].map(({ oracle: _, ...e }) => e);
    return {
      key: d.id, words: d.words, types: d.types, question: d.question, source: d.source,
      choices: d.choices ?? YES_NO, cards: hits.length, with_type: withType,
      now: [...tally].map(([type, cards]) => ({ type, cards })).sort((a, b) => b.cards - a.cards || (a.type < b.type ? -1 : 1)),
      examples,
    };
  }).filter((i) => i.cards > 0);
}

function roleItems(db: DatabaseSync, setId: number): RoleItem[] {
  const blocked = deriverOnlyScore(db, setId).reachable.blocked;
  const byType = new Map<string, { role: string; needs: 'supply' | 'demand'; pairs: number[] }>();
  for (const b of blocked) {
    const m = /^(supply|demand) (\S+) has the role (\w+)$/.exec(b.reason);
    if (!m) continue;
    const [, side, type, role] = m as unknown as [string, 'supply' | 'demand', string, string];
    const e = byType.get(type) ?? { role, needs: side, pairs: [] };
    e.pairs.push(b.pair_id);
    byType.set(type, e);
  }
  const pairRow = db.prepare(
    `SELECT p.supply_oracle, p.demand_oracle, sa.quote sq, da.quote dq FROM edge_golden_pairs p
       LEFT JOIN atoms sa ON sa.id = p.supply_atom_id LEFT JOIN atoms da ON da.id = p.demand_atom_id WHERE p.id = ?`,
  );
  const count = db.prepare('SELECT COUNT(*) n FROM atoms WHERE family = ? AND type_key = ? AND is_current = 1 AND consensus = 1');
  const examples = db.prepare(
    `SELECT c.name, a.quote FROM atoms a JOIN cards c ON c.oracle_id = a.oracle_id
      WHERE a.family = ? AND a.type_key = ? AND a.is_current = 1 AND a.consensus = 1
      GROUP BY a.oracle_id ORDER BY length(a.quote), c.name LIMIT 60`,
  );
  // Three short sentences (four words or more) that start with different words, so the examples show
  // different texts. A keyword alone ("Warp {4}") says little to a reader.
  const varied = (rows: Array<{ name: string; quote: string }>) => {
    const out: typeof rows = [];
    const starts = new Set<string>();
    const words = (q: string) => q.toLowerCase().split(/\s+/);
    for (const r of [...rows.filter((x) => words(x.quote).length >= 4), ...rows.filter((x) => words(x.quote).length < 4)]) {
      const start = words(r.quote)[0]!;
      if (starts.has(start)) continue;
      starts.add(start);
      out.push(r);
      if (out.length === 3) break;
    }
    return out;
  };
  return [...byType].sort((a, b) => b[1].pairs.length - a[1].pairs.length || (a[0] < b[0] ? -1 : 1)).map(([type, e]) => {
    const [family, key] = type.split('.') as [string, string];
    return {
      key: `role:${type}`, type, role: e.role, needs: e.needs,
      atoms: (count.get(family, key) as { n: number }).n,
      examples: varied(examples.all(family, key) as Array<{ name: string; quote: string }>),
      pairs: e.pairs.map((id) => {
        const r = pairRow.get(id) as { supply_oracle: string; demand_oracle: string; sq: string | null; dq: string | null };
        const supply = cardOf(db, r.supply_oracle);
        return { pair_id: id, supply, demand: cardOf(db, r.demand_oracle), supply_quote: r.sq ?? supply.type_line, demand_quote: r.dq ?? '' };
      }),
    };
  });
}

function wrongLinkItems(db: DatabaseSync, buildId: number, setId: number): WrongLinkItem[] {
  const index = BuildIndex.load(db, buildId);
  const score = fullScore(db, buildId, index);
  const rules = new Map(setRules(db, setId, 'all').map((r) => [r.rule_hash, r]));
  const row = db.prepare("SELECT supply_oracle, demand_oracle FROM edge_golden_pairs WHERE id = ? AND status = 'accepted'");
  const out: WrongLinkItem[] = [];
  for (const p of score.pairs) {
    const wrong = p.confirmed.filter((pol) => (pol === '+' ? p.label !== 'synergy' : p.label !== 'anti'));
    if (!wrong.length) continue;
    // Owner pairs (owner_accepted, owner_corrected) already have an owner answer.
    const r = row.get(p.pair_id) as { supply_oracle: string; demand_oracle: string } | undefined;
    if (!r) continue;
    const edges = mergeEdges(index.cardAtomEdges(r.supply_oracle).supply, index.ctx)
      .filter((e) => e.demand_oracle === r.demand_oracle && e.grade === 'confirmed')
      .sort((a, b) => b.weight.total - a.weight.total).slice(0, 3);
    out.push({
      key: `g${p.pair_id}`, pair_id: p.pair_id, label: p.label, polarities: p.confirmed,
      supply: cardOf(db, r.supply_oracle), demand: cardOf(db, r.demand_oracle), reasons: edgeReasons(db, edges, rules),
    });
  }
  return out;
}

/** Makes the questions of one build. Reads the database; writes nothing. */
export function makeOwnerQuestions(db: DatabaseSync, buildId: number): OwnerQuestions {
  const b = db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(buildId) as { rule_set_id: number } | undefined;
  if (!b) throw new Error(`no build ${buildId}`);
  return {
    build: buildId, rule_set: b.rule_set_id, made_at: new Date().toISOString(),
    reading: readingItems(db), type_role: roleItems(db, b.rule_set_id), wrong_link: wrongLinkItems(db, buildId, b.rule_set_id),
  };
}

export function loadOwnerQuestions(path: string = QUESTIONS_PATH): OwnerQuestions | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as OwnerQuestions : null;
}
