/**
 * The goal form of a deck (Phase 4 design sec. 4). The form is a zod schema, stored with the deck.
 * `checkGoal` tests each card ID against the database (invariant I5).
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { loadAtomSchema } from '../atoms/schema.js';
import type { DeckPolicy } from './policy.js';

export const COLOUR_CHOICES = ['B', 'R', 'BR'] as const;
export type Colours = (typeof COLOUR_CHOICES)[number];
export const INTERACTION_LEVELS = ['none', 'some', 'heavy'] as const;
export type InteractionLevel = (typeof INTERACTION_LEVELS)[number];

const CardId = z.string().min(1);
/** A tag name, as `FAMILY.TYPE_KEY` (build chat design sec. 3). */
const TagKey = z.string().regex(/^[A-Z_]+\.[A-Z0-9_]+$/, 'a tag is FAMILY.TYPE_KEY');

/** Build chat design sec. 3: the most "must have" cards of one goal. */
export const MAX_PINNED = 8;

/** The form with its limits. A default comes from the policy, so `goalSchema` takes the policy. */
export const goalSchema = (p: DeckPolicy) => z.object({
  colours: z.enum(COLOUR_CHOICES),
  seeds: z.array(CardId).max(4).default([]),
  excluded: z.array(CardId).default([]),
  target_turn: z.number().int().min(4).max(8),
  interaction: z.enum(INTERACTION_LEVELS),
  min_creatures: z.number().int().min(0).max(30).default(p.quotas.min_creatures_default),
  use_rate: z.boolean().default(false),
  /** Build chat design sec. 3: cards that the deck must have. Each enters first, with no `seed_weight`. */
  pinned: z.array(CardId).max(MAX_PINNED).default([]),
  /** Tags that the deck must not have. A seed or a pinned card with such a tag stays. */
  excluded_tags: z.array(TagKey).default([]),
}).strict();

export type Goal = z.infer<ReturnType<typeof goalSchema>>;

/** The fields that an older stored deck can lack. Each reads as its empty value. */
type NewFields = 'use_rate' | 'pinned' | 'excluded_tags';

/** The goal of a stored deck. A deck from before the card rate or the build chat reads as off and empty. */
export const storedGoal = (g: Omit<Goal, NewFields> & Partial<Goal>): Goal => ({
  ...g, use_rate: g.use_rate ?? false, pinned: g.pinned ?? [], excluded_tags: g.excluded_tags ?? [],
});

let tagNames: Set<string> | null = null;
/** The tag names of the atom schema (`config/atom-schema.json`). */
export function knownTags(): ReadonlySet<string> {
  tagNames ??= new Set(loadAtomSchema().types.map((t) => `${t.family}.${t.type_key}`));
  return tagNames;
}

/** A goal that the form or the database refuses. The API gives this message to the owner. */
export class GoalError extends Error {}

/** True when the front face of a type line is a land: the words before " // ". */
export function isLand(typeLine: string): boolean {
  return /\bLand\b/.test(typeLine.split(' // ')[0]!);
}

/** True when each letter of a colour identity is in the form colours. */
export function coloursFit(identity: readonly string[], colours: Colours): boolean {
  return identity.every((c) => colours.includes(c));
}

interface GoalCard { oracle_id: string; name: string; type_line: string; color_identity: string; arena_id: number | null; rotated: number }

/** The parsed goal, or a `GoalError` that names the first fault. */
export function checkGoal(db: DatabaseSync, input: unknown, p: DeckPolicy): Goal {
  const parsed = goalSchema(p).safeParse(input);
  if (!parsed.success) {
    throw new GoalError(parsed.error.issues.map((i) => `${i.path.join('.') || 'goal'}: ${i.message}`).join('; '));
  }
  const goal = parsed.data;
  const ids = [...goal.seeds, ...goal.pinned, ...goal.excluded];
  const found = new Map((db.prepare(
    `SELECT c.oracle_id, c.name, c.type_line, c.color_identity, c.arena_id, c.rotated FROM cards c
      JOIN json_each(?) j ON j.value = c.oracle_id`,
  ).all(JSON.stringify(ids)) as unknown as GoalCard[]).map((c) => [c.oracle_id, c]));
  for (const id of ids) if (!found.has(id)) throw new GoalError(`no card with ID ${id}`);
  if (new Set(goal.seeds).size !== goal.seeds.length) throw new GoalError('a seed card is in the list two times');
  if (new Set(goal.pinned).size !== goal.pinned.length) throw new GoalError('a "must have" card is in the list two times');
  for (const id of goal.pinned) if (goal.seeds.includes(id)) throw new GoalError(`${found.get(id)!.name} is a seed card and a "must have" card`);
  for (const id of [...goal.seeds, ...goal.pinned]) {
    const c = found.get(id)!;
    if (goal.excluded.includes(id)) throw new GoalError(`${c.name} is a ${goal.seeds.includes(id) ? 'seed' : '"must have"'} card and an excluded card`);
    if (!coloursFit(JSON.parse(c.color_identity) as string[], goal.colours)) throw new GoalError(`${c.name} is outside the colours ${goal.colours}`);
    if (c.rotated !== 0) throw new GoalError(`${c.name} is rotated`);
    if (c.arena_id === null) throw new GoalError(`${c.name} is not on Arena`);
    if (isLand(c.type_line)) throw new GoalError(`${c.name} is a land: a seed card or a "must have" card must be a spell`);
  }
  const tags = knownTags();
  for (const t of goal.excluded_tags) if (!tags.has(t)) throw new GoalError(`no tag ${t}`);
  return goal;
}
