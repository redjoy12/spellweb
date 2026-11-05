/**
 * Schema v17 (spec sec. 22, owner answers of 2026-10-31, docs/owner-answers-2026-10-31.md).
 *
 * One overlay over the v16 vocabulary:
 * - S1: PRODUCES.SACRIFICE gets `cost_type`, the param of the outlet tag.
 * - S2: PRODUCES.SACRIFICE gets `decision` (cost, choice, forced).
 * - S3: ENABLES.SACRIFICE_OUTLET is removed. PRODUCES.SACRIFICE keeps the fact; its rules move with
 *   a limit on `actor` and `object` (plan Task 5).
 * - R1: CARES_ABOUT.PERMANENT_DIES gets `cause`, for "Whenever you sacrifice a ...".
 * - R2: no vocabulary change. A Role token text also gets ENABLES.ATTACH (`instructionsFor`).
 * - R3: PRODUCES.SACRIFICE_FODDER gets `token_type`. A Food token text gets this type (`instructionsFor`).
 * - R4: the new demand CARES_ABOUT.DESCENDED (CR 700.11). It is not POPULATED_GRAVEYARD.
 */
import type { Predicate } from '../graph/ruleSchema.js';
import type { AtomTypeDef } from './schema.js';
import { obj } from './schemaV15.js';

export const V17_MARK = 'v17 (spec sec. 22):';

/** S3: the removed type, the type that keeps its fact, and the limit that its rules take there. */
export const V17_REMOVED: ReadonlyArray<{ type: string; into: string; item: string; source: string; where: Predicate[] }> = [
  {
    type: 'ENABLES.SACRIFICE_OUTLET', into: 'PRODUCES.SACRIFICE', item: 'S3',
    source: 'CR 701.21a. Owner answer 2026-10-31: merge, with the limit, after the cost and the choice are on the Sacrifice tag.',
    where: [{ param: 'actor', op: 'eq', value: 'you' }, { param: 'object', op: 'in', value: ['other', 'any'] }],
  },
];

/**
 * Spec sec. 22.5: the v17 params that no rule links or tests. Sec. 7.2 resolves each to `unresolved`,
 * so they stay out of the grade until a rule uses them. A `where` predicate still tests them.
 */
export const V17_UNGRADED: Readonly<Record<string, readonly string[]>> = {
  'PRODUCES.SACRIFICE': ['cost_type', 'decision'],
  'CARES_ABOUT.PERMANENT_DIES': ['cause'],
};

export const DESCENDED = 'CARES_ABOUT.DESCENDED';

/** R4: no pass voted this role (spec sec. 22.5). The evidence is the CR 700.11 text of the schema row. */
export const DESCENDED_ROLE = {
  type: DESCENDED,
  demand_note: 'Watches the event in which a permanent card is put into a player\'s graveyard from anywhere this turn.',
  evidence: [{ source: 'rule', ref: '700.11', quote: 'This means that a permanent card has been put into that player\'s graveyard from anywhere this turn.' }], // i2-ok: the rule that the owner note names
} as const;

/** R4. `review_promoted`: an owner note gave the type, and neither the concept spec nor CR 701 and 702 list it. */
const DESCENDED_TYPE: AtomTypeDef = {
  family: 'CARES_ABOUT',
  type_key: 'DESCENDED',
  label: 'Cares about a permanent card put into your graveyard this turn',
  params_schema: obj({}),
  provenance: 'review_promoted',
  evidence: 'v17 (spec sec. 22): R4. Promoted under sec. 4.3 by the owner note of 2026-10-31 (reading `descended`): an event in the turn, not a populated graveyard. CR 700.11 "Some cards refer to whether a player has "descended this turn." This means that a permanent card has been put into that player\'s graveyard from anywhere this turn."',
};

const COST_TYPE = {
  enum: ['free', 'costed'],
  description:
    'free: the cost or the clause that has the sacrifice asks for nothing else ("Sacrifice a creature: ...", "Kicker—Sacrifice an artifact.", "you may sacrifice a creature", "Each opponent sacrifices a creature."). ' +
    'costed: it also asks for mana, the tap symbol or another payment ("{1}, Sacrifice a creature: ...", "{T}, Sacrifice a Treasure: ...", "you may pay {2} and sacrifice a creature"). ' +
    'The mana cost of the spell itself does not count.',
};
const DECISION = {
  enum: ['cost', 'choice', 'forced'],
  description: 'cost: the sacrifice pays for an ability or a spell. It is in an activation cost (the text before the colon, CR 602.1a), in a keyword cost ("Kicker—Sacrifice ...", "Equip—Sacrifice ...") or in an additional cost ("As an additional cost to cast this spell, sacrifice ..."). choice: the player may do it or not ("you may sacrifice ...", a clause with "unless", "discard a card or sacrifice a permanent"). forced: the text makes the player do it ("Sacrifice it at the beginning of the next end step.", "Each opponent sacrifices a creature.").',
};
const CAUSE = {
  enum: ['sacrifice', 'any'],
  description:
    'sacrifice: the clause says that the permanent is sacrificed ("Whenever you sacrifice a ..."). ' +
    'any: the clause says "dies" or "put into a graveyard from the battlefield", and names no cause.',
};
const TOKEN_TYPE = {
  type: 'string',
  description: 'The subtype of the token, as written ("Food"). "" when the clause names none.',
};

/** S1, S2, R1, R3: the params that each type gets, beside its v16 params. */
const V17_PARAMS: Record<string, { item: string; params: Record<string, unknown>; source: string }> = {
  'PRODUCES.SACRIFICE': {
    item: 'S1, S2',
    params: { cost_type: COST_TYPE, decision: DECISION },
    source: 'Owner note of 2026-10-31 on merge 1: "add the cost", and "by choice or was forced". cost_type comes from ENABLES.SACRIFICE_OUTLET (concept spec sec. 4.1, "free vs costed"). CR 602.1a.',
  },
  'CARES_ABOUT.PERMANENT_DIES': {
    item: 'R1',
    params: { cause: CAUSE },
    source: 'Owner answer of 2026-10-31 (reading `sacrifice_trigger`): yes. CR 701.21a: a sacrificed permanent goes from the battlefield to the graveyard; CR 700.4.',
  },
  'PRODUCES.SACRIFICE_FODDER': {
    item: 'R3',
    params: { token_type: TOKEN_TYPE },
    source: 'Owner note of 2026-10-31 (reading `food_token`): "it has to get the type as a detail".',
  },
};

/** Applies the v17 overlay to a v16 vocabulary. A second run is a no-op. */
export function applyV17(types: readonly AtomTypeDef[], opts: { requireAll?: boolean } = {}): AtomTypeDef[] {
  const removed = new Set(V17_REMOVED.map((r) => r.type));
  const seen = new Set<string>();
  const out = types.filter((t) => !removed.has(`${t.family}.${t.type_key}`)).map((t) => {
    const id = `${t.family}.${t.type_key}`;
    // A promoted type comes back from the database, with the evidence of its last publish.
    if (id === DESCENDED) return DESCENDED_TYPE;
    const add = V17_PARAMS[id];
    if (!add) return t;
    seen.add(id);
    const own = (t.params_schema as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      ...t,
      params_schema: obj({ ...own, ...add.params }),
      evidence: t.evidence.includes(V17_MARK) ? t.evidence : `${t.evidence} | ${V17_MARK} ${add.item}. ${add.source}`,
    };
  });
  if (opts.requireAll) {
    const missing = [...Object.keys(V17_PARAMS), ...removed].filter((k) => !seen.has(k) && !(removed.has(k) && types.some((t) => `${t.family}.${t.type_key}` === k)));
    if (missing.length) throw new Error(`v17 items name types that are not in the vocabulary: ${missing.join(', ')}`);
  }
  return out.some((t) => `${t.family}.${t.type_key}` === DESCENDED) ? out : [...out, DESCENDED_TYPE];
}
