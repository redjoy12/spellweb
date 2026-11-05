/**
 * The reasons of a deck (Phase 4 design sec. 9): the role of each card and its top links, with the
 * two quotes, the grade and the rule ID. The links come from the pair table, so each reason is a
 * link that the search read.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from '../graph/buildIndex.js';
import type { DeckWarning } from './check.js';
import type { MadeDeck } from './deck.js';
import { arenaText, type ExportCard } from './exportArena.js';
import type { Goal } from './goal.js';
import type { ManaBase } from './manaBase.js';
import { OWNER_KEY, type PairLink, type PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';
import type { CardRate } from './rates.js';

const typeId = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;

/** The supply atoms of a link: its atom IDs without one copy of the demand atom. */
function supplyAtoms(l: Pick<PairLink, 'atom_ids' | 'demand_atom_id'>): number[] {
  const ids = [...l.atom_ids];
  ids.splice(ids.indexOf(l.demand_atom_id), 1);
  return ids;
}

/** The kind of a link: the types of its supply atoms, then the type of its demand atom. */
export function linkKind(idx: BuildIndex, l: PairLink): string {
  if (l.key.startsWith(OWNER_KEY)) return 'owner link';
  const supply = [...new Set(supplyAtoms(l).map((id) => typeId(idx.atoms.get(id)!)))].sort();
  return `${supply.join(' + ')} -> ${typeId(idx.atoms.get(l.demand_atom_id)!)}`;
}

/** The link kinds of a deck by count of ordered card pairs, highest first. */
export function deckLinkKinds(idx: BuildIndex, t: PairTable, deck: readonly string[]): Array<{ kind: string; pairs: number }> {
  const inDeck = new Set(deck);
  const kinds = new Map<string, number>();
  for (const a of deck) {
    for (const [b, l] of t.pos.get(a) ?? []) {
      if (!inDeck.has(b)) continue;
      const k = linkKind(idx, l);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
  }
  return [...kinds].map(([kind, pairs]) => ({ kind, pairs })).sort((x, y) => y.pairs - x.pairs || (x.kind < y.kind ? -1 : 1));
}

export interface LinkView {
  /** The merged edge key: the false link button sends it to the report route. */
  edge_key: string;
  other: string;
  /** `gives`: this card is the supply. `needs`: this card is the demand. */
  direction: 'gives' | 'needs';
  grade: PairLink['grade']; weight: number;
  supply_quote: string; demand_quote: string; rule_ids: string[];
  /** The owner answered "Yes, but weak" on this pair. */
  weak?: true;
  /** The weak answer comes from the deck page, so the page can remove it (`marks.ts`). */
  weak_mark?: true;
  /** The newest false link report on this edge (`marks.ts`). */
  report?: { id: number; note: string };
  /** An owner link of an apply session (link review design sec. 8), with no rule. */
  owner_link?: number;
  /** The owner link is removed: a new deck does not have it (`marks.ts`). */
  owner_removed?: true;
}

export type CardRole = 'seed' | 'pin' | 'quota' | 'link' | 'swap' | 'land';

export interface DeckCardView {
  oracle_id: string; name: string; copies: number; role: CardRole; mana_value: number; mana_cost: string | null;
  type_line: string; image: string | null;
  /** The deck cards that this card links to; 0 for a land. */
  deck_links: number;
  links: LinkView[];
  /** The card rate of a spell, when the goal has `use_rate`. */
  rate?: CardRate;
}

export interface DeckView {
  build_id: number; goal: Goal; policy_sha: string;
  cards: DeckCardView[]; mana: Omit<ManaBase, 'lands'>; warnings: DeckWarning[]; loops: number; stable: boolean;
  export_text: string;
}

interface CardRow {
  oracle_id: string; name: string; layout: string; mana_cost: string | null; cmc: number; type_line: string;
  set_code: string; collector_number: string; image_normal: string | null; front_name: string;
}

/** The top links of a card to the deck: one for each other card, the highest weight first. */
function topLinks(id: string, deck: readonly string[], t: PairTable, limit: number): Array<{ other: string; link: PairLink; direction: LinkView['direction'] }> {
  const out = deck.flatMap((other) => {
    if (other === id) return [];
    const give = t.pos.get(id)?.get(other);
    const need = t.pos.get(other)?.get(id);
    const link = give && need ? (give.weight >= need.weight ? give : need) : give ?? need;
    return link ? [{ other, link, direction: link === give ? 'gives' as const : 'needs' as const }] : [];
  });
  return out.sort((a, b) => b.link.weight - a.link.weight || (a.link.key < b.link.key ? -1 : 1)).slice(0, limit);
}

/** Plan Task 6: the deck with the role and the top 3 links of each spell, and the import text. */
export function justifyDeck(db: DatabaseSync, idx: BuildIndex, t: PairTable, d: MadeDeck, buildId: number, policySha: string, p: DeckPolicy): DeckView {
  const ids = [...d.spells.map((s) => s.oracle_id), ...d.mana.lands.map((l) => l.oracle_id)];
  const spellIds = d.spells.map((s) => s.oracle_id);
  const rows = new Map((db.prepare(
    `SELECT c.oracle_id, c.name, c.layout, c.mana_cost, c.cmc, c.type_line, c.set_code, c.collector_number, c.image_normal,
            COALESCE((SELECT f.name FROM card_faces f WHERE f.oracle_id = c.oracle_id AND f.face_index = 0), c.name) AS front_name
       FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id`,
  ).all(JSON.stringify(ids)) as unknown as CardRow[]).map((r) => [r.oracle_id, r]));
  const tops = new Map(spellIds.map((id) => [id, topLinks(id, spellIds, t, 3)]));
  const atomIds = [...tops.values()].flatMap((x) => x.flatMap((l) => l.link.atom_ids));
  const quotes = new Map((db.prepare('SELECT a.id, a.quote FROM atoms a JOIN json_each(?) j ON j.value = a.id')
    .all(JSON.stringify([...new Set(atomIds)])) as Array<{ id: number; quote: string }>).map((r) => [r.id, r.quote]));
  const quoteOf = (atoms: readonly number[]) => [...new Set(atoms.map((a) => quotes.get(a) ?? ''))].join(' / ');
  const view = (id: string, copies: number, role: CardRole, links: LinkView[], deckLinks: number): DeckCardView => {
    const r = rows.get(id)!;
    const rate = role === 'land' ? undefined : d.cards.get(id)?.rate;
    return {
      oracle_id: id, name: r.name, copies, role, mana_value: r.cmc, mana_cost: r.mana_cost, type_line: r.type_line, image: r.image_normal,
      deck_links: deckLinks, links, ...(rate ? { rate } : {}),
    };
  };
  const cards = [
    ...d.spells.map((s) => view(s.oracle_id, s.copies, s.role, tops.get(s.oracle_id)!.map(({ other, link, direction }): LinkView => ({
      edge_key: link.key, other, direction, grade: link.grade, weight: link.weight, supply_quote: quoteOf(supplyAtoms(link)),
      demand_quote: quoteOf([link.demand_atom_id]), rule_ids: link.rule_hashes.map((h) => idx.ruleOf(h)?.rule_id ?? h.slice(0, 8)),
      ...(link.weak ? { weak: true as const } : {}),
      ...(link.key.startsWith(OWNER_KEY) ? { owner_link: Number(link.key.slice(OWNER_KEY.length)) } : {}),
    })), spellIds.filter((b) => b !== s.oracle_id && t.linked.get(s.oracle_id)?.has(b)).length)),
    ...d.mana.lands.map((l) => view(l.oracle_id, l.copies, 'land', [], 0)),
  ];
  const lines: ExportCard[] = cards.map((c) => {
    const r = rows.get(c.oracle_id)!;
    return { copies: c.copies, name: r.name, front_name: r.front_name, layout: r.layout, set_code: r.set_code, collector_number: r.collector_number };
  });
  const { lands: _lands, ...mana } = d.mana;
  return {
    build_id: buildId, goal: d.goal, policy_sha: policySha, cards, mana, warnings: d.warnings, loops: d.loops, stable: d.stable,
    export_text: arenaText(lines, p),
  };
}
