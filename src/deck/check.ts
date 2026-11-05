/**
 * The checks of a deck (Phase 4 design sec. 8). A failed legality check stops the build: the
 * build returns no deck. A goal, mana or graph health check gives a warning.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DeckCard, SpellSlot } from './assemble.js';
import { coloursFit, type Goal } from './goal.js';
import type { BuiltCards } from './manaBase.js';
import { COLOURS } from './manaBase.js';
import type { PairTable } from './pairs.js';
import type { DeckPolicy } from './policy.js';

export type WarningKind = 'quota' | 'mana' | 'no_link' | 'anti_link';
export interface DeckWarning { kind: WarningKind; text: string; cards: string[] }

/** A deck that a legality check refuses. */
export class LegalityError extends Error {}

interface LegalRow { oracle_id: string; name: string; type_line: string; color_identity: string; arena_id: number | null; rotated: number }

/** Design sec. 8, legality. It throws at the first failed check. */
export function checkLegal(db: DatabaseSync, d: Pick<BuiltCards, 'spells' | 'mana'>, goal: Goal, p: DeckPolicy): void {
  const slots = [...d.spells, ...d.mana.lands];
  const total = slots.reduce((s, x) => s + x.copies, 0);
  if (total !== p.deck_size) throw new LegalityError(`the deck has ${total} cards, not ${p.deck_size}`);
  const rows = new Map((db.prepare(
    `SELECT c.oracle_id, c.name, c.type_line, c.color_identity, c.arena_id, c.rotated FROM cards c
      JOIN json_each(?) j ON j.value = c.oracle_id`,
  ).all(JSON.stringify(slots.map((s) => s.oracle_id))) as unknown as LegalRow[]).map((r) => [r.oracle_id, r]));
  for (const s of slots) {
    const c = rows.get(s.oracle_id);
    if (!c) throw new LegalityError(`no card with ID ${s.oracle_id}`);
    if (c.rotated !== 0) throw new LegalityError(`${c.name} is rotated`);
    if (c.arena_id === null) throw new LegalityError(`${c.name} is not on Arena`);
    if (s.copies > p.max_copies && !c.type_line.startsWith('Basic Land')) throw new LegalityError(`the deck has ${s.copies} copies of ${c.name}`);
    if (!coloursFit(JSON.parse(c.color_identity) as string[], goal.colours)) throw new LegalityError(`${c.name} is outside the colours ${goal.colours}`);
  }
}

const copiesOf = (spells: readonly SpellSlot[], cards: ReadonlyMap<string, DeckCard>, holds: (c: DeckCard) => boolean) =>
  spells.reduce((s, x) => s + (holds(cards.get(x.oracle_id)!) ? x.copies : 0), 0);

/** Design sec. 8: the goal, mana and graph health warnings, in the order of the table. */
export function deckWarnings(d: BuiltCards, cards: ReadonlyMap<string, DeckCard>, goal: Goal, t: PairTable, p: DeckPolicy): DeckWarning[] {
  const out: DeckWarning[] = [];
  const quota = (label: string, min: number, holds: (c: DeckCard) => boolean) => {
    const n = copiesOf(d.spells, cards, holds);
    if (n < min) out.push({ kind: 'quota', text: `The deck has ${n} ${label} cards, and the goal asks for ${min}.`, cards: [] });
  };
  quota('interaction', p.quotas.interaction[goal.interaction], (c) => c.interaction);
  quota('creature', goal.min_creatures, (c) => c.creature);
  for (const c of COLOURS) {
    if (d.mana.sources[c] < d.mana.needs[c]) {
      out.push({ kind: 'mana', text: `Colour ${c} has ${d.mana.sources[c]} sources, and the spells need ${d.mana.needs[c]}.`, cards: [] });
    }
  }
  if (!d.stable) out.push({ kind: 'mana', text: `The land count did not become stable in ${d.loops} loops, so the deck keeps ${d.mana.land_count} lands.`, cards: [] });
  const ids = d.spells.map((s) => s.oracle_id);
  const name = (id: string) => cards.get(id)!.name;
  for (const a of ids) {
    if (!ids.some((b) => b !== a && t.linked.get(a)?.has(b))) {
      out.push({ kind: 'no_link', text: `${name(a)} has no link to the deck.`, cards: [a] });
    }
  }
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      if (t.anti.get(a)?.has(b)) out.push({ kind: 'anti_link', text: `${name(a)} and ${name(b)} have a "bad together" link.`, cards: [a, b] });
    }
  }
  return out;
}
