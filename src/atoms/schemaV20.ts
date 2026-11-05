/**
 * Schema v20 (spec sec. 25, plan 2026-11-01-schema-v20, docs/set-8-review.md sec. 3.1).
 *
 * One overlay over the v19 vocabulary. PRODUCES.DAMAGE gets two details, so that a rule can separate
 * "to target creature" from "to each opponent":
 * - D1: `recipient` (creature, opponent, you, player, any).
 * - D2: `targeted`, the same name as on PRODUCES.DESTROY and PRODUCES.EXILE, for the crime of CR 700.13.
 * No stored atom moves. A new reading gives the details (plan Task 4).
 */
import type { AtomTypeDef } from './schema.js';
import { obj } from './schemaV15.js';
import { DAMAGE } from './schemaV18.js';

export const V20_MARK = 'v20 (spec sec. 25):';

/** Spec sec. 25.5: set 8 has these rules out of its builds. They cannot test the new details, and a Stage B pass replaces them. */
export const V20_REPLACED: readonly string[] = ['ER-3173', 'ER-3199'];

/**
 * Spec sec. 25.8 (round 5, docs/schema-v20-results.md sec. 12.1): the owner answered "no" on all 10
 * pairs into "If that creature would die this turn, exile it instead." The same run gave
 * CARES_ABOUT.PERMANENT_DIES to some of these texts and not to others, so this test is by the words.
 * "Would die, exile it instead" lasts longer, and "would die, instead exile it and you gain 2 life"
 * gives more. No owner answer tests those texts, so they do not match.
 */
const WOULD_DIE_RIDER = /would die this turn, exile it instead\.?\s*$/;
export const isWouldDieRider = (a: { family: string; type_key: string; quote: string }): boolean =>
  a.family === 'CARES_ABOUT' && a.type_key === 'PERMANENT_DIES' && WOULD_DIE_RIDER.test(a.quote);

const RECIPIENT = {
  enum: ['creature', 'opponent', 'you', 'player', 'any'],
  description:
    'What can receive the damage. creature: the clause can hit a creature and cannot hit a player ("target creature", "each creature", "target creature or planeswalker", "that creature", "itself"). ' +
    'opponent: the clause can hit only an opponent ("each opponent", "target opponent", "defending player", "that player" or "them" after "an opponent"). ' +
    'you: the clause can hit only you ("deals 1 damage to you"). ' +
    'player: the clause can hit a player who can be you or an opponent, and cannot hit a creature ("target player", "each player", "that player" or "them" after "a player", "that creature\'s controller", "target player or planeswalker"). ' +
    'any: the clause can hit a creature and can also hit a player ("any target", "any other target", "one or two targets", "a permanent or player", "each opponent and each creature they control").',
};
const TARGETED = {
  type: 'boolean',
  description: 'true when a target of the spell or ability gets the damage: the clause uses the word "target" ("any target", "target opponent"), or it says "that creature" or "that player" for a target that the same spell or ability names (CR 115.1). false when it does not ("each opponent", "defending player", "that player" after "Whenever an opponent casts a spell").',
};

const V20_EVIDENCE = { source: 'D1, D2. docs/set-8-review.md sec. 3.1: a rule on this type cannot separate a creature from a player. CR 120.1 "Objects can deal damage to battles, creatures, planeswalkers, and players." CR 115.1 "The targets are object(s) and/or player(s) the spell or ability will affect." CR 700.13: a crime needs a target.' };

/** Applies the v20 overlay to a v19 vocabulary. A second run is a no-op. */
export function applyV20(types: readonly AtomTypeDef[]): AtomTypeDef[] {
  if (!types.some((t) => `${t.family}.${t.type_key}` === DAMAGE)) throw new Error('v20 D1: the vocabulary has no PRODUCES.DAMAGE');
  return types.map((t) => {
    if (`${t.family}.${t.type_key}` !== DAMAGE) return t;
    const own = (t.params_schema as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      ...t,
      params_schema: obj({ ...own, recipient: RECIPIENT, targeted: TARGETED }),
      evidence: t.evidence.includes(V20_MARK) ? t.evidence : `${t.evidence} | ${V20_MARK} ${V20_EVIDENCE.source}`,
    };
  });
}
