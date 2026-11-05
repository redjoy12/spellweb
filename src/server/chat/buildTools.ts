/**
 * The tools of a build session (build chat design sec. 7). Each result is short text, because each
 * turn pays for it. `set_draft` writes the form on the page; only the owner builds the deck.
 * `try_draft` runs the search on the draft and stores nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadAtomSchema } from '../../atoms/schema.js';
import { deckCards, type DeckCard } from '../../deck/assemble.js';
import { LegalityError } from '../../deck/check.js';
import { makeDeck } from '../../deck/deck.js';
import { checkGoal, GoalError, INTERACTION_LEVELS, COLOUR_CHOICES } from '../../deck/goal.js';
import { deckLinkKinds, linkKind } from '../../deck/justify.js';
import type { PairTable } from '../../deck/pairs.js';
import type { DeckPolicy } from '../../deck/policy.js';
import type { BuildIndex } from '../../graph/buildIndex.js';
import { toFtsQuery } from '../routes/cards.js';
import { draftChanges, draftText, namesOf, type BuildChatRow, type Draft } from './build.js';
import { cardByName, type ToolResult } from './tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const TAG_DESCRIPTIONS = resolve(here, '../../../config/tag-descriptions.json');

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const NAMES = { type: 'array', items: { type: 'string' } };

export const BUILD_TOOLS = [
  { name: 'draft', description: 'Gives the goal form on the page now, and the brief.', inputSchema: NO_INPUT },
  {
    name: 'find_cards',
    description: 'Searches the spells of the colours of the form. Gives the card text and the count of links to the seed and "must have" cards. All words must match, so use 1 or 2 words.',
    inputSchema: {
      type: 'object',
      properties: {
        words: { type: 'string', description: 'Words of the card name, type or text' },
        type: { type: 'string', description: 'A part of the type line, for example Creature or Vampire' },
        mana_value_min: { type: 'number' },
        mana_value_max: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'card_detail',
    description: 'Gives the text and the tags of one card, and its links to the seed and "must have" cards.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'list_tags',
    description: 'Gives the tags of the spells in the colours of the form, with the count of cards. With words, it gives only the tags whose name or description has all the words, with the description.',
    inputSchema: { type: 'object', properties: { words: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'set_draft',
    description: 'Changes fields of the form on the page. Give only the fields that change. A list field replaces the whole list. Card names must be exact. The owner sees the change and builds the deck.',
    inputSchema: {
      type: 'object',
      properties: {
        colours: { type: 'string', enum: [...COLOUR_CHOICES] },
        target_turn: { type: 'integer', minimum: 4, maximum: 8, description: 'A spell with a higher mana value stays out, unless it is a seed or a "must have" card' },
        interaction: { type: 'string', enum: [...INTERACTION_LEVELS], description: 'none 0, some 6, heavy 12 interaction copies' },
        min_creatures: { type: 'integer', minimum: 0, maximum: 30, description: 'Creature copies' },
        seeds: { ...NAMES, description: 'At most 4 spells. The search builds the deck around them, and their links count 3 times.' },
        pinned: { ...NAMES, description: '"Must have" cards: at most 8 spells. Each is in the deck, with no extra link weight.' },
        excluded: { ...NAMES, description: '"Never" cards: the search does not use them.' },
        excluded_tags: { type: 'array', items: { type: 'string' }, description: '"Never" tags, as FAMILY.TYPE_KEY: a card with such a tag stays out, unless it is a seed or a "must have" card.' },
        brief: { type: 'string', description: 'The plan of the deck in words, for the deck chat after the build. The search does not read it.' },
      },
      additionalProperties: false,
    },
  },
  { name: 'try_draft', description: 'Runs the search on the form now and gives the deck: the spells, the lands, the warnings and the main link kinds. It stores no deck.', inputSchema: NO_INPUT },
  {
    name: 'ask',
    description: 'Shows 2 to 4 short answer buttons under your reply, for your question. The owner can also type a free answer.',
    inputSchema: {
      type: 'object',
      properties: { answers: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Each answer at most 60 characters' } },
      required: ['answers'],
      additionalProperties: false,
    },
  },
];

const FindZ = z.object({ words: z.string().optional(), type: z.string().optional(), mana_value_min: z.number().optional(), mana_value_max: z.number().optional() }).strict();
const DetailZ = z.object({ name: z.string().min(1) }).strict();
const TagsZ = z.object({ words: z.string().optional() }).strict();
const SetZ = z.object({
  colours: z.enum(COLOUR_CHOICES).optional(),
  target_turn: z.number().int().optional(),
  interaction: z.enum(INTERACTION_LEVELS).optional(),
  min_creatures: z.number().int().optional(),
  seeds: z.array(z.string()).optional(),
  pinned: z.array(z.string()).optional(),
  excluded: z.array(z.string()).optional(),
  excluded_tags: z.array(z.string()).optional(),
  brief: z.string().optional(),
}).strict();
const AskZ = z.object({ answers: z.array(z.string().trim().min(1).max(60)).min(2).max(4) }).strict();

export interface BuildToolContext {
  db: DatabaseSync;
  findLimit: number;
  policy(): DeckPolicy;
  talk(): BuildChatRow;
  /** Writes the draft and the brief. */
  save(draft: Draft, brief: string): void;
  /** The newest build, its index and its pair table with the weak answers. The first call loads the table. */
  graph(): { buildId: number; idx: BuildIndex; table: PairTable };
  step(text: string): void;
  ask(answers: string[]): void;
}

interface FaceRow { oracle_id: string; card_name: string; name: string; mana_cost: string | null; type_line: string; oracle_text: string; power: string | null; toughness: string | null }

/** The text of each card, with the name in `[[ ]]`. */
function cardTexts(db: DatabaseSync, ids: readonly string[]): Map<string, string> {
  const rows = db.prepare(
    `SELECT f.oracle_id, c.name AS card_name, f.name, f.mana_cost, f.type_line, f.oracle_text, f.power, f.toughness
       FROM card_faces f JOIN cards c ON c.oracle_id = f.oracle_id JOIN json_each(?) j ON j.value = f.oracle_id
      ORDER BY f.oracle_id, f.face_index`,
  ).all(JSON.stringify(ids)) as unknown as FaceRow[];
  const out = new Map<string, string>();
  for (const f of rows) {
    const body = f.power !== null ? ` ${f.power}/${f.toughness}` : '';
    const head = `${f.mana_cost ? `${f.mana_cost} ` : ''}${f.type_line}${body}`;
    const text = f.oracle_text.replace(/\n/g, ' / ');
    const line = f.name === f.card_name ? `[[${f.card_name}]] ${head}: ${text}` : `  Face ${f.name}: ${head}: ${text}`;
    const before = out.get(f.oracle_id);
    out.set(f.oracle_id, before ? `${before}\n${line}` : f.name === f.card_name ? line : `[[${f.card_name}]]\n${line}`);
  }
  return out;
}

/** The seed and "must have" cards of the draft: the cards that `find_cards` and `card_detail` count links to. */
const anchorsOf = (d: Draft) => [...d.seeds, ...d.pinned];

/** The spells that the draft can use: the colours, not excluded, and no "never" tag. The target turn does not apply here. */
function spellPool(c: BuildToolContext, d: Draft): DeckCard[] {
  const { idx } = c.graph();
  const excluded = new Set(d.excluded);
  const never = new Set(d.excluded_tags);
  return deckCards(c.db, idx, d.colours).filter((x) => !x.land && !excluded.has(x.oracle_id) && !x.tags.some((t) => never.has(t)));
}

function findCards(c: BuildToolContext, input: unknown): ToolResult {
  const q = FindZ.parse(input);
  const d = c.talk().draft;
  const { table } = c.graph();
  let pool = spellPool(c, d);
  if (q.words?.trim()) {
    const fts = toFtsQuery(q.words);
    const hits = new Set(fts ? (c.db.prepare('SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?').all(fts) as Array<{ oracle_id: string }>).map((r) => r.oracle_id) : []);
    pool = pool.filter((x) => hits.has(x.oracle_id));
  }
  if (q.type?.trim()) {
    const t = q.type.trim().toLowerCase();
    pool = pool.filter((x) => x.type_line.toLowerCase().includes(t));
  }
  pool = pool.filter((x) => x.cmc >= (q.mana_value_min ?? 0) && x.cmc <= (q.mana_value_max ?? Infinity));
  const anchors = anchorsOf(d);
  const links = (id: string) => anchors.filter((b) => b !== id && table.linked.get(id)?.has(b)).length;
  const ranked = pool.map((x) => ({ ...x, n: links(x.oracle_id) })).sort((a, b) => b.n - a.n || a.cmc - b.cmc || (a.name < b.name ? -1 : 1));
  const top = ranked.slice(0, c.findLimit);
  c.step(`Searched the cards: ${[q.words, q.type].filter(Boolean).join(', ') || 'by mana value'}.`);
  if (top.length === 0) return { text: 'No card matches. Use fewer words.' };
  const texts = cardTexts(c.db, top.map((x) => x.oracle_id));
  return {
    text: [
      `${ranked.length} cards match. Here are ${top.length}${anchors.length > 0 ? ', the most links to the seed and "must have" cards first' : ''}.`,
      ...top.map((x) => `${anchors.length > 0 ? `${x.n} links: ` : ''}${texts.get(x.oracle_id) ?? `[[${x.name}]]`}`),
    ].join('\n'),
  };
}

function cardDetail(c: BuildToolContext, input: unknown): ToolResult {
  const { name } = DetailZ.parse(input);
  const card = cardByName(c.db, name);
  if (!card) return { text: `No card has the name ${name}. Use find_cards.`, isError: true };
  const { idx, table } = c.graph();
  const d = c.talk().draft;
  c.step(`Read the card [[${card.name}]].`);
  const id = card.oracle_id;
  const tags = [...new Set(idx.atomsOfCard(id).map((a) => `${a.family}.${a.type_key}`))];
  const names = namesOf(c.db, anchorsOf(d));
  const links = anchorsOf(d).filter((x) => x !== id).flatMap((x) => {
    const other = names.get(x)?.name ?? x;
    const give = table.pos.get(id)?.get(x);
    const need = table.pos.get(x)?.get(id);
    const anti = table.anti.get(id)?.has(x);
    return [
      ...(give ? [`- Helps [[${other}]] (${give.grade}): ${linkKind(idx, give)}`] : []),
      ...(need ? [`- Gets help from [[${other}]] (${need.grade}): ${linkKind(idx, need)}`] : []),
      ...(anti ? [`- Bad together with [[${other}]]`] : []),
    ];
  });
  return {
    text: [
      cardTexts(c.db, [id]).get(id) ?? `[[${card.name}]]`,
      `Tags: ${tags.join(', ') || 'none'}`,
      `Links to the seed and "must have" cards: ${links.length === 0 ? 'none' : ''}`,
      ...links,
    ].join('\n'),
  };
}

let describe: Map<string, string> | null = null;
/** The plain description of each tag (`config/tag-descriptions.json`), or the label of the atom schema. */
function tagDescriptions(): Map<string, string> {
  if (describe) return describe;
  const out = new Map(loadAtomSchema().types.map((t) => [`${t.family}.${t.type_key}`, t.label]));
  try {
    const file = JSON.parse(readFileSync(TAG_DESCRIPTIONS, 'utf8')) as { types: Record<string, { description?: string }> };
    for (const [k, v] of Object.entries(file.types)) if (v.description && out.has(k)) out.set(k, v.description);
  } catch { /* the labels stay */ }
  describe = out;
  return out;
}

function listTags(c: BuildToolContext, input: unknown): ToolResult {
  const { words } = TagsZ.parse(input);
  const d = c.talk().draft;
  const counts = new Map<string, number>();
  for (const x of spellPool(c, { ...d, excluded_tags: [] })) for (const t of x.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const desc = tagDescriptions();
  const want = (words ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = [...counts].filter(([t]) => want.every((w) => `${t} ${desc.get(t) ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  c.step(want.length > 0 ? `Read the tags: ${words}.` : 'Read the tags.');
  if (rows.length === 0) return { text: 'No tag matches. Use fewer words.' };
  return {
    text: [
      `${rows.length} tags on the spells of ${d.colours}. Each line: tag, count of spells${want.length > 0 ? ', description' : ''}.`,
      ...rows.map(([t, n]) => (want.length > 0 ? `${t} ${n}: ${desc.get(t) ?? ''}` : `${t} ${n}`)),
    ].join('\n'),
  };
}

function setDraft(c: BuildToolContext, input: unknown): ToolResult {
  const q = SetZ.parse(input);
  const talk = c.talk();
  const ids = (list: string[] | undefined, current: string[]): string[] | string => {
    if (!list) return current;
    const out: string[] = [];
    for (const n of list) {
      const card = cardByName(c.db, n);
      if (!card) return n;
      out.push(card.oracle_id);
    }
    return out;
  };
  const seeds = ids(q.seeds, talk.draft.seeds);
  const pinned = ids(q.pinned, talk.draft.pinned);
  const excluded = ids(q.excluded, talk.draft.excluded);
  for (const x of [seeds, pinned, excluded]) if (typeof x === 'string') return { text: `No card has the name ${x}. The form did not change.`, isError: true };
  const { brief, ...fields } = q;
  const next: Draft = {
    ...talk.draft, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    seeds: seeds as string[], pinned: pinned as string[], excluded: excluded as string[],
  };
  try {
    checkGoal(c.db, next, c.policy());
  } catch (err) {
    if (err instanceof GoalError) return { text: `The form refuses this: ${err.message}. The form did not change.`, isError: true };
    throw err;
  }
  const nextBrief = brief ?? talk.brief;
  const changes = draftChanges(c.db, talk.draft, next, talk.brief, nextBrief);
  c.save(next, nextBrief);
  c.step(changes.length === 0 ? 'Claude read the form. Nothing changed.' : `Claude changed the form: ${changes.join('; ')}.`);
  return { text: ['The form on the page now:', ...draftText(c.db, next, nextBrief)].join('\n') };
}

function tryDraft(c: BuildToolContext): ToolResult {
  const d = c.talk().draft;
  const { idx, table } = c.graph();
  c.step('Ran a test build of the form.');
  let deck: ReturnType<typeof makeDeck>;
  try {
    deck = makeDeck(c.db, idx, table, d, c.policy());
  } catch (err) {
    if (err instanceof GoalError || err instanceof LegalityError) return { text: `The search gives no deck: ${err.message}.`, isError: true };
    throw err;
  }
  const texts = cardTexts(c.db, deck.spells.map((s) => s.oracle_id));
  const spellCopies = deck.spells.reduce((n, s) => n + s.copies, 0);
  const lands = deck.mana.lands.map((l) => `${l.copies} [[${deck.cards.get(l.oracle_id)?.name ?? namesOf(c.db, [l.oracle_id]).get(l.oracle_id)?.name ?? l.oracle_id}]]`);
  return {
    text: [
      `Test deck: ${spellCopies} spell copies and ${deck.mana.land_count} lands. It is not stored.`,
      '', 'Spells (copies, role):',
      ...deck.spells.map((s) => `${s.copies}x (${s.role}) ${texts.get(s.oracle_id) ?? s.oracle_id}`),
      '', `Lands: ${lands.join(', ')}`,
      '', 'Warnings:', ...(deck.warnings.length > 0 ? deck.warnings.map((w) => `- ${w.text}`) : ['None']),
      '', 'Main link kinds (pairs):', ...deckLinkKinds(idx, table, deck.spells.map((s) => s.oracle_id)).slice(0, 6).map((k) => `- ${k.pairs} ${k.kind}`),
    ].join('\n'),
  };
}

export function callBuildTool(c: BuildToolContext, name: string, input: unknown): ToolResult {
  try {
    if (name === 'draft') {
      const t = c.talk();
      c.step('Read the form.');
      return { text: draftText(c.db, t.draft, t.brief).join('\n') };
    }
    if (name === 'find_cards') return findCards(c, input);
    if (name === 'card_detail') return cardDetail(c, input);
    if (name === 'list_tags') return listTags(c, input);
    if (name === 'set_draft') return setDraft(c, input);
    if (name === 'try_draft') return tryDraft(c);
    if (name === 'ask') {
      const { answers } = AskZ.parse(input);
      c.ask(answers);
      return { text: 'The answer buttons show under your reply. The owner can also type a free answer.' };
    }
    return { text: `No tool has the name ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `Bad input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
    throw err;
  }
}
