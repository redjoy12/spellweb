/**
 * The tools of a deck session (deck chat design sec. 4, game review design sec. 3). Each result is
 * short text, because each turn pays for it. `propose_swap` checks a swap and shows the swap box. It
 * does not change the deck: only the "Swap" and "Undo" buttons do that.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { deckCards } from '../../deck/assemble.js';
import { LegalityError } from '../../deck/check.js';
import { storedGoal } from '../../deck/goal.js';
import { weakPairKeys } from '../../deck/deck.js';
import { deckLinksText, LinkChangeError, PROPOSE_SCHEMA, ProposeZ, proposeLinkChange } from '../../deck/linkChanges.js';
import { linkKind, type DeckView } from '../../deck/justify.js';
import type { BuildIndex } from '../../graph/buildIndex.js';
import type { PairTable } from '../../deck/pairs.js';
import { SwapError, type Swap, type SwapCard } from '../../deck/swap.js';
import { deckGames, gamesText } from '../../games/counts.js';
import { toFtsQuery } from '../routes/cards.js';
import { commentsOf, swapLine } from './store.js';

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const CARD_LIST = {
  type: 'array',
  items: { type: 'object', properties: { name: { type: 'string' }, copies: { type: 'integer', minimum: 1 } }, required: ['name', 'copies'], additionalProperties: false },
};

export const CHAT_TOOLS = [
  { name: 'deck_state', description: 'Gives this deck: the cards, the copies, the card text, the colour sources, the warnings and the owner comments.', inputSchema: NO_INPUT },
  {
    name: 'find_cards',
    description: 'Searches the cards that this deck can use. Gives the card text and the count of links to this deck. All words must match, so use 1 or 2 words.',
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
    description: 'Gives the text, the tags and the links to this deck of one card.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'propose_swap',
    description: 'Checks a swap and shows a swap box to the owner under your reply. It does not change the deck. Name only the cards that change.',
    inputSchema: {
      type: 'object',
      properties: { out: CARD_LIST, in: CARD_LIST, reason: { type: 'string', description: 'One short sentence' } },
      required: ['out', 'in', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'deck_links',
    description: 'Gives all links between the spells of this deck on the newest build, not only the top 3 of the deck page: the cards, the sign, the grade, the weight, the kind, the words of each card, the rules and the marks (weak, owner link, false link report, open suggestion). Lands are not in the links.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'propose_link_change',
    description: 'Writes one link suggestion to the Decisions page, for the owner to approve or reject. It does not change a link. It checks the suggestion and gives the reason for a refusal.',
    inputSchema: PROPOSE_SCHEMA,
  },
  { name: 'list_games', description: 'Gives the games of this deck on Arena, with their results, and the counts of each card over those games.', inputSchema: NO_INPUT },
  {
    name: 'game_log',
    description: 'Gives one game of this deck as a list of turns: the hand of the owner, the plays of both players, the life totals and the board.',
    inputSchema: { type: 'object', properties: { game_id: { type: 'integer', description: 'The number of the game, from list_games' } }, required: ['game_id'], additionalProperties: false },
  },
];

const FindZ = z.object({ words: z.string().optional(), type: z.string().optional(), mana_value_min: z.number().optional(), mana_value_max: z.number().optional() }).strict();
const DetailZ = z.object({ name: z.string().min(1) }).strict();
const CardsZ = z.array(z.object({ name: z.string().min(1), copies: z.number().int().positive() }).strict());
const SwapZ = z.object({ out: CardsZ, in: CardsZ, reason: z.string() }).strict();
const GameZ = z.object({ game_id: z.number().int() }).strict();

export interface ToolContext {
  db: DatabaseSync;
  deckId: number;
  findLimit: number;
  /** The most suggestions of one link check (link review design sec. 4). */
  linkCheckMax?: number;
  /** The deck as it is now. */
  deck(): DeckView;
  /** The index and the pair table of the newest build. The first call loads the table. */
  graph(): { idx: BuildIndex; table: PairTable };
  /** The deck after a swap, or a `SwapError` or a `LegalityError`. */
  trySwap(swap: Swap): void;
  step(text: string): void;
  offerSwap(swap: Swap, reason: string): void;
}

export interface ToolResult { text: string; isError?: true }

interface FaceRow { oracle_id: string; card_name: string; name: string; mana_cost: string | null; type_line: string; oracle_text: string; power: string | null; toughness: string | null }

/** The text of each card, with the name in `[[ ]]`, as the reply must write it. */
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

/** The card with this name: the whole name, or the name of a face. Apostrophes can be curved. */
export function cardByName(db: DatabaseSync, raw: string): { oracle_id: string; name: string } | null {
  const name = raw.trim().replace(/’/g, "'");
  return (db.prepare('SELECT oracle_id, name FROM cards WHERE name = ? COLLATE NOCASE ORDER BY rotated LIMIT 1').get(name)
    ?? db.prepare('SELECT c.oracle_id, c.name FROM card_faces f JOIN cards c USING (oracle_id) WHERE f.name = ? COLLATE NOCASE ORDER BY c.rotated LIMIT 1').get(name)) as { oracle_id: string; name: string } | undefined ?? null;
}

function deckState(c: ToolContext): ToolResult {
  const d = c.deck();
  const g = storedGoal(d.goal);
  const comments = new Map(commentsOf(c.db, c.deckId).map((x) => [x.oracle_id, x.text]));
  const texts = cardTexts(c.db, d.cards.map((x) => x.oracle_id));
  const spells = d.cards.filter((x) => x.role !== 'land');
  const lands = d.cards.filter((x) => x.role === 'land');
  const copies = (l: typeof d.cards) => l.reduce((s, x) => s + x.copies, 0);
  const row = (x: DeckView['cards'][number]) => {
    const note = comments.get(x.oracle_id);
    const links = x.role === 'land' ? '' : `, ${x.deck_links} links to this deck`;
    return `${x.copies}x (${x.role}${links}) ${texts.get(x.oracle_id) ?? `[[${x.name}]]`}${note ? `\n  Owner comment: ${note}` : ''}`;
  };
  const sources = [...g.colours].map((k) => `${k} ${d.mana.sources[k as 'B' | 'R']} of ${d.mana.needs[k as 'B' | 'R']} needed`).join(', ');
  return {
    text: [
      `Deck ${c.deckId}. Colours ${g.colours}, target turn ${g.target_turn}, interaction ${g.interaction}, at least ${g.min_creatures} creatures.`,
      `${copies(spells) + copies(lands)} cards: ${copies(spells)} spells and ${copies(lands)} lands. Colour sources: ${sources}.`,
      '', 'Spells', ...spells.map(row),
      '', 'Lands', ...lands.map(row),
      '', 'Warnings', ...(d.warnings.length > 0 ? d.warnings.map((w) => `- ${w.text}`) : ['None']),
    ].join('\n'),
  };
}

function findCards(c: ToolContext, input: unknown): ToolResult {
  const q = FindZ.parse(input);
  const { idx, table } = c.graph();
  const d = c.deck();
  const g = storedGoal(d.goal);
  const inDeck = new Map(d.cards.map((x) => [x.oracle_id, x.copies]));
  const spellIds = d.cards.filter((x) => x.role !== 'land').map((x) => x.oracle_id);
  const excluded = new Set(g.excluded);
  let pool = deckCards(c.db, idx, g.colours).filter((x) => !excluded.has(x.oracle_id));
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
  const links = (id: string) => spellIds.filter((b) => b !== id && table.linked.get(id)?.has(b)).length;
  const ranked = pool.map((x) => ({ ...x, n: links(x.oracle_id) })).sort((a, b) => b.n - a.n || a.cmc - b.cmc || (a.name < b.name ? -1 : 1));
  const top = ranked.slice(0, c.findLimit);
  c.step(`Searched the cards: ${[q.words, q.type].filter(Boolean).join(', ') || 'by mana value'}.`);
  if (top.length === 0) return { text: 'No card matches. Use fewer words.' };
  const texts = cardTexts(c.db, top.map((x) => x.oracle_id));
  return {
    text: [
      `${ranked.length} cards match. Here are ${top.length}, the most links to this deck first.`,
      ...top.map((x) => `${x.n} links${inDeck.has(x.oracle_id) ? `, ${inDeck.get(x.oracle_id)} in the deck` : ''}: ${texts.get(x.oracle_id) ?? `[[${x.name}]]`}`),
    ].join('\n'),
  };
}

function cardDetail(c: ToolContext, input: unknown): ToolResult {
  const { name } = DetailZ.parse(input);
  const card = cardByName(c.db, name);
  if (!card) return { text: `No card has the name ${name}. Use find_cards.`, isError: true };
  const { idx, table } = c.graph();
  const d = c.deck();
  c.step(`Read the card [[${card.name}]].`);
  const id = card.oracle_id;
  const tags = [...new Set(idx.atomsOfCard(id).map((a) => `${a.family}.${a.type_key}`))];
  const links = d.cards.filter((x) => x.role !== 'land' && x.oracle_id !== id).flatMap((x) => {
    const give = table.pos.get(id)?.get(x.oracle_id);
    const need = table.pos.get(x.oracle_id)?.get(id);
    const anti = table.anti.get(id)?.has(x.oracle_id);
    return [
      ...(give ? [`- Helps [[${x.name}]] (${give.grade}): ${linkKind(idx, give)}`] : []),
      ...(need ? [`- Gets help from [[${x.name}]] (${need.grade}): ${linkKind(idx, need)}`] : []),
      ...(anti ? [`- Bad together with [[${x.name}]]`] : []),
    ];
  });
  return {
    text: [
      cardTexts(c.db, [id]).get(id) ?? `[[${card.name}]]`,
      `Tags: ${tags.join(', ') || 'none'}`,
      `Links to this deck: ${links.length === 0 ? 'none' : ''}`,
      ...links,
    ].join('\n'),
  };
}

function proposeSwap(c: ToolContext, input: unknown): ToolResult {
  const q = SwapZ.parse(input);
  c.step('Checked a swap.');
  const resolve = (list: typeof q.out): SwapCard[] | string => {
    const out: SwapCard[] = [];
    for (const x of list) {
      const card = cardByName(c.db, x.name);
      if (!card) return x.name;
      out.push({ oracle_id: card.oracle_id, name: card.name, copies: x.copies });
    }
    return out;
  };
  const out = resolve(q.out);
  const entering = resolve(q.in);
  if (typeof out === 'string' || typeof entering === 'string') return { text: `No card has the name ${typeof out === 'string' ? out : entering}. No swap box shows.`, isError: true };
  if (out.length === 0 || entering.length === 0) return { text: 'A swap needs at least one card out and one card in. No swap box shows.', isError: true };
  const swap: Swap = { out, in: entering };
  try {
    c.trySwap(swap);
  } catch (err) {
    if (err instanceof SwapError || err instanceof LegalityError) return { text: `This swap is not legal: ${err.message}. No swap box shows.`, isError: true };
    throw err;
  }
  c.offerSwap(swap, q.reason);
  return { text: `The swap box shows under your reply: ${swapLine(swap)}. The deck has not changed. The owner chooses.` };
}

function deckLinks(c: ToolContext): ToolResult {
  const { idx, table } = c.graph();
  c.step('Read the links of the deck.');
  return { text: deckLinksText(c.db, idx, table, c.deck(), c.deckId) };
}

function proposeLink(c: ToolContext, input: unknown): ToolResult {
  const q = ProposeZ.parse(input);
  const supply = cardByName(c.db, q.supply);
  const demand = cardByName(c.db, q.demand);
  if (!supply || !demand) return { text: `No card has the name ${supply ? q.demand : q.supply}. Nothing is written.`, isError: true };
  const { idx, table } = c.graph();
  try {
    const out = proposeLinkChange(c.db, { idx, table, view: c.deck(), deckId: c.deckId, max: c.linkCheckMax ?? 40, weakKeys: weakPairKeys(c.db) },
      { ...q, supply: supply.oracle_id, demand: demand.oracle_id });
    c.step(`Wrote link suggestion ${out.id}: ${q.kind}${q.change ? ` (${q.change})` : ''}, [[${supply.name}]] ${q.sign === '-' ? 'and' : '->'} [[${demand.name}]].`);
    return { text: out.text };
  } catch (err) {
    if (err instanceof LinkChangeError) return { text: `Not written: ${err.message}.`, isError: true };
    throw err;
  }
}

function gameLog(c: ToolContext, input: unknown): ToolResult {
  const { game_id } = GameZ.parse(input);
  const game = deckGames(c.db, c.deckId).games.find((g) => g.id === game_id);
  if (!game) return { text: `This deck has no game ${game_id}. Use list_games.`, isError: true };
  c.step(`Read game ${game_id}.`);
  return { text: game.lines.join('\n') };
}

export function callTool(c: ToolContext, name: string, input: unknown): ToolResult {
  try {
    if (name === 'deck_state') {
      c.step('Read the deck.');
      return deckState(c);
    }
    if (name === 'find_cards') return findCards(c, input);
    if (name === 'card_detail') return cardDetail(c, input);
    if (name === 'propose_swap') return proposeSwap(c, input);
    if (name === 'deck_links') return deckLinks(c);
    if (name === 'propose_link_change') return proposeLink(c, input);
    if (name === 'list_games') {
      c.step('Read the games.');
      return { text: gamesText(deckGames(c.db, c.deckId)) };
    }
    if (name === 'game_log') return gameLog(c, input);
    return { text: `No tool has the name ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `Bad input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
    throw err;
  }
}

/** Each `[[Name]]` of a reply, with its card, and the names that are not real cards. */
export function checkNames(db: DatabaseSync, reply: string): { cards: Record<string, string>; bad: string[] } {
  const cards: Record<string, string> = {};
  const bad: string[] = [];
  for (const [, name] of reply.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    const card = cardByName(db, name!);
    if (card) cards[name!] = card.oracle_id;
    else if (!bad.includes(name!)) bad.push(name!);
  }
  return { cards, bad };
}
