/**
 * Schema v18 (spec sec. 23, owner answers of 2026-10-31, docs/owner-answers-2026-10-31.md).
 *
 * One overlay over the v17 vocabulary. No model reads a card: src/atoms/migrateV18.ts moves the
 * stored atoms and src/graph/ruleCarry.ts moves the rules, so no card pair changes.
 * - B1: INTERACTION.TARGETED_REMOVAL gets `removal_type`, and the Destroy and Exile details `object`
 *   and `from_zone`. A targeted Destroy atom merges into it. A targeted Exile atom merges into it
 *   only when the text has both tags. PRODUCES.DESTROY and PRODUCES.EXILE stay for the other texts.
 * - B2: COMBAT.ANTHEM is removed. COMBAT.STAT_CHANGE gets `scope` and keeps the set details.
 * - B3: PRODUCES.OPPONENT_LIFE_LOSS and PRODUCES.SELF_LIFE_LOSS are removed. The new type
 *   PRODUCES.LIFE_LOSS records the player in `player`.
 * - B4: COMBAT.POWER and COMBAT.TOUGHNESS get new labels. The two types stay.
 * - B5: PRODUCES.COUNTER_PRODUCTION gets a new label, and `counter_type` holds the counter name.
 */
import type { Predicate } from '../graph/ruleSchema.js';
import type { AtomTypeDef } from './schema.js';
import { OBJECT, obj } from './schemaV15.js';

export const V18_MARK = 'v18 (spec sec. 23):';

export const REMOVAL = 'INTERACTION.TARGETED_REMOVAL';
export const DESTROY = 'PRODUCES.DESTROY';
export const EXILE = 'PRODUCES.EXILE';
export const ANTHEM = 'COMBAT.ANTHEM';
export const STAT_CHANGE = 'COMBAT.STAT_CHANGE';
export const LIFE_LOSS = 'PRODUCES.LIFE_LOSS';
export const OPPONENT_LOSS = 'PRODUCES.OPPONENT_LIFE_LOSS';
export const SELF_LOSS = 'PRODUCES.SELF_LIFE_LOSS';
export const COUNTERS = 'PRODUCES.COUNTER_PRODUCTION';
export const DAMAGE = 'PRODUCES.DAMAGE';

/**
 * B2, B3: the removed types, each with the type that keeps its fact and the limit that its rules
 * take there. `STAT_CHANGE` is listed too: its own rules take the limit `scope` = `one`.
 */
export const V18_REMOVED: ReadonlyArray<{ type: string; into: string; item: string; source: string; where: Predicate[] }> = [
  {
    type: ANTHEM, into: STAT_CHANGE, item: 'B2',
    source: 'Owner answer 2026-10-31 on merge 4: merge, with a detail for the type, the target or both.',
    where: [{ param: 'scope', op: 'eq', value: 'set' }],
  },
  {
    type: OPPONENT_LOSS, into: LIFE_LOSS, item: 'B3',
    source: 'Owner note 2026-10-31 on the reading `target_player_life`: one tag, with a detail for who.',
    where: [{ param: 'player', op: 'in', value: ['opponent', 'target', 'each'] }],
  },
  {
    type: SELF_LOSS, into: LIFE_LOSS, item: 'B3',
    source: 'Owner note 2026-10-31 on the reading `target_player_life`: one tag, with a detail for who.',
    where: [{ param: 'player', op: 'in', value: ['you', 'target', 'each'] }],
  },
];

/** B2: a type that stays and whose own rules take a limit, so that they do not reach the moved atoms. */
export const V18_LIMITED: ReadonlyArray<{ type: string; into: string; where: Predicate[] }> = [
  { type: STAT_CHANGE, into: STAT_CHANGE, where: [{ param: 'scope', op: 'eq', value: 'one' }] },
];

/**
 * B1: a type that stays for the texts with no target. Its rules also go to the removal type, with
 * a limit on `removal_type`. A rule that tests `targeted` eq false stays only on the source type.
 * A rule that tests `targeted` eq true moves: the source type no longer has such an atom.
 */
export const V18_SPLIT: ReadonlyArray<{ type: string; into: string; item: string; where: Predicate[] }> = [
  { type: DESTROY, into: REMOVAL, item: 'B1', where: [{ param: 'removal_type', op: 'eq', value: 'destroy' }] },
  { type: EXILE, into: REMOVAL, item: 'B1', where: [{ param: 'removal_type', op: 'eq', value: 'exile' }] },
];

/** B5: a predicate value that named `other`. The name of a counter takes its place in the atoms. */
export const COUNTER_OTHER: { type: string; param: string; old: string; named: readonly string[] } = {
  type: COUNTERS, param: 'counter_type', old: 'other', named: ['+1/+1', '-1/-1'],
};

/**
 * The params that no moved rule resolves through a link or an implication. Spec sec. 7.2 would
 * resolve each to `unresolved`, so they stay out of the grade. A `where` predicate still tests them.
 */
export const V18_UNGRADED: Readonly<Record<string, readonly string[]>> = {
  [REMOVAL]: ['removal_type', 'object', 'from_zone'],
  [STAT_CHANGE]: ['scope'],
  [LIFE_LOSS]: ['player'],
};

/** The role of the new type: both removed types have the role `supply`. */
export const LIFE_LOSS_ROLE = { type: LIFE_LOSS, sources: [OPPONENT_LOSS, SELF_LOSS] } as const;

/** B2: the demand rules of ANTHEM move to STAT_CHANGE, so the role of STAT_CHANGE takes `both`. */
export const STAT_CHANGE_ROLE = { type: STAT_CHANGE, source: ANTHEM } as const;

/** The types of B1-B3 whose atoms move to another type, each with the type that keeps the fact (for the golden reanchor). */
export const V18_MOVED: ReadonlyArray<{ type: string; into: string }> = [
  ...V18_REMOVED.map((r) => ({ type: r.type, into: r.into })),
  ...V18_SPLIT.map((s) => ({ type: s.type, into: s.into })),
];

const REMOVAL_TYPE = {
  enum: ['destroy', 'exile', 'damage', 'minus', 'other'],
  description: 'What the text does to the target. destroy: the text destroys it. exile: the text exiles it. damage: the text deals damage to it. minus: the text gives it a -N/-N change or -1/-1 counters. other: any other action.',
};
const SCOPE = {
  enum: ['one', 'set'],
  description: 'one: the change is on one creature ("this creature", "target creature", "enchanted creature", "equipped creature"). set: the change is on a set of creatures ("Creatures you control get +1/+1."). The set details subject_type, subject_filter and controller are for scope set only.',
};
const PLAYER = {
  enum: ['you', 'opponent', 'target', 'each'],
  description: 'The player who loses life. you: "you lose N life". opponent: the clause names an opponent ("each opponent", "target opponent", "that opponent"). target: "target player". each: "each player", or a clause that can be any player.',
};
const COUNTER_NAME = {
  type: 'string',
  description: 'The name of the counter, as written ("+1/+1", "-1/-1", "stun", "double strike"). "other" when the clause names no counter.',
};

const LIFE_LOSS_LABEL = 'Player loses life';

/** B3. `review_promoted`: an owner note gave the type, and neither the concept spec nor CR 701 and 702 list it. */
const lifeLossType = (amount: unknown): AtomTypeDef => ({
  family: 'PRODUCES',
  type_key: 'LIFE_LOSS',
  label: LIFE_LOSS_LABEL,
  params_schema: obj({ amount, player: PLAYER }),
  provenance: 'review_promoted',
  evidence: `${V18_MARK} B3. Promoted under sec. 4.3 by the owner note of 2026-10-31 (reading \`target_player_life\`): one tag "player loses life", with a detail for who. It takes the place of the two types of concept spec sec. 4.1, PRODUCES: 'opponent life loss', and of the v9 type for "you lose life".`,
});

/** B4, B5: the new labels of the types that stay. */
const V18_LABELS: Record<string, { label: string; item: string; source: string }> = {
  'COMBAT.POWER': { label: 'Checks power', item: 'B4', source: 'Owner answer 2026-10-31 on merge 5: keep both, with new labels.' },
  'COMBAT.TOUGHNESS': { label: 'Checks toughness', item: 'B4', source: 'Owner answer 2026-10-31 on merge 5: keep both, with new labels.' },
  [COUNTERS]: { label: 'Puts counters', item: 'B5', source: 'Owner answer 2026-10-31 on merge 7: a new label, and the counter name.' },
};

/** Applies the v18 overlay to a v17 vocabulary. A second run is a no-op. */
export function applyV18(types: readonly AtomTypeDef[], opts: { requireAll?: boolean } = {}): AtomTypeDef[] {
  const removed = new Set(V18_REMOVED.map((r) => r.type));
  const byId = new Map(types.map((t) => [`${t.family}.${t.type_key}`, t]));
  const propsOf = (id: string) => (byId.get(id)?.params_schema as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {};
  const note = (t: AtomTypeDef, text: string) => (t.evidence.includes(V18_MARK) ? t.evidence : `${t.evidence} | ${V18_MARK} ${text}`);
  const seen = new Set<string>();
  const out = types.filter((t) => !removed.has(`${t.family}.${t.type_key}`) && `${t.family}.${t.type_key}` !== LIFE_LOSS).map((t) => {
    const id = `${t.family}.${t.type_key}`;
    const own = (t.params_schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    const required = (t.params_schema as { required?: string[] }).required ?? [];
    if (id === REMOVAL) {
      seen.add(id);
      const from_zone = own['from_zone'] ?? propsOf(EXILE)['from_zone'];
      if (!from_zone) throw new Error('v18 B1: PRODUCES.EXILE has no from_zone');
      return {
        ...t,
        params_schema: obj({ ...own, removal_type: REMOVAL_TYPE, object: OBJECT, from_zone }, [...new Set([...required, 'removal_type'])]),
        evidence: note(t, 'B1. Owner answer 2026-10-31 on merge 3: one removal tag, with a detail for the kind of removal. `object` and `from_zone` come from the Destroy and Exile tags that merge into it.'),
      };
    }
    if (id === STAT_CHANGE) {
      seen.add(id);
      const set = (name: string) => {
        const p = own[name] ?? propsOf(ANTHEM)[name];
        if (!p) throw new Error(`v18 B2: COMBAT.ANTHEM has no ${name}`);
        return p;
      };
      return {
        ...t,
        label: 'Power/toughness change (one creature or a set of creatures)',
        params_schema: obj({ ...own, scope: SCOPE, subject_type: set('subject_type'), subject_filter: set('subject_filter'), controller: set('controller') }, [...new Set([...required, 'scope'])]),
        evidence: note(t, 'B2. Owner answer 2026-10-31 on merge 4: COMBAT.ANTHEM merges into this type, with `scope`. The set details stay.'),
      };
    }
    const named = V18_LABELS[id];
    if (named) {
      seen.add(id);
      return {
        ...t,
        label: named.label,
        ...(id === COUNTERS ? { params_schema: obj({ ...own, counter_type: COUNTER_NAME }, required.length ? required : undefined) } : {}),
        evidence: note(t, `${named.item}. ${named.source}`),
      };
    }
    return t;
  });
  if (opts.requireAll) {
    const missing = [REMOVAL, STAT_CHANGE, ...Object.keys(V18_LABELS)].filter((k) => !seen.has(k));
    if (missing.length) throw new Error(`v18 items name types that are not in the vocabulary: ${missing.join(', ')}`);
  }
  // A promoted type comes back from the database: the type stays the same on a second run.
  const amount = propsOf(LIFE_LOSS)['amount'] ?? propsOf(OPPONENT_LOSS)['amount'];
  if (!amount) {
    if (opts.requireAll) throw new Error('v18 B3: PRODUCES.OPPONENT_LIFE_LOSS has no amount');
    return out;
  }
  return [...out, lifeLossType(amount)];
}

const QUANTITY = String.raw`(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+|that many)`;
const NOT_A_NAME = new Set(['no', 'its', 'their', 'those', 'these', 'the', 'that', 'this', 'any', 'all', 'each', 'more', 'had', 'has', 'have', 'with', 'of', 'on', 'or', 'and', 'other', 'additional']);

/**
 * B5: the counter names of a text, from the words before "counter", as written. Null when the text
 * names none. A number form ("+1/+1") never is a name here, because those atoms have the value.
 */
export function counterNames(quote: string): string | null {
  const found = [...quote.matchAll(new RegExp(String.raw`\b${QUANTITY}\s+([a-z]+(?: [a-z]+)?) counters?\b`, 'gi'))].map((m) => m[1]!.toLowerCase());
  const names = found.length ? found : [...quote.matchAll(/\b([a-z]+) counters?\b/gi)].map((m) => m[1]!.toLowerCase());
  const kept = [...new Set(names.filter((n) => !NOT_A_NAME.has(n.split(' ').at(-1)!)))];
  return kept.length ? kept.join(', ') : null;
}
