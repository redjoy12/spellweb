/**
 * The resource balance of one cycle (Phase 3 spec sec. 9.3, parent spec sec. 4.3): follow the
 * loop one time from start to end, and sum the change of each resource.
 *
 * Sources, as sec. 9.3 gives them: the Stage A resource map (accepted roles; an `other` resource
 * does not go into the tiers, sec. 5.3), the integer amounts in the atom params, the
 * `mana_symbols` count of activation costs, and for `MANA_PRODUCTION` the `mana_symbols` count of
 * the atom quote. An amount that is not an integer, or that the build cannot count, is unknown;
 * it makes the balance of its resource unknown.
 *
 * Project decisions (sec. 9.3 does not say how; recorded in docs/phase-3-cycle-measure.md):
 * - Each group of the cycle acts one time, with all its atoms, except the demand atom that the
 *   incoming cycle edge reaches. That atom is the event that the previous group supplies, and the
 *   supply atom of the previous group already counts it.
 * - In an `activated` group, the `mana_symbols` count of the cost is the `mana` cost of the
 *   group. It replaces the `mana` cost effects of the atoms of that group, so the cost counts once.
 * - The amount param of a type is its one param whose schema permits an integer. A type with no
 *   such param (or more than one) has unknown amounts, except `MANA_PRODUCTION`.
 * - A `MANA_PRODUCTION` quote with no mana symbol is unknown: the build cannot count it.
 * - A resource is consumed (`kind: 'cost'`) when one or more of its effects in the cycle is a
 *   cost. `value` is true when one or more of its effects is a value.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentCorpusId } from '../atoms/golden.js';
import type { BuildIndex } from './buildIndex.js';
import type { Cycle } from './cycles.js';
import { getRuleSet, setRoles, type StoredRole } from './ruleSet.js';
import { countManaSymbols, manaLetters, type TextTests } from './textTests.js';

export type Amount = number | 'unknown';

export interface Effect { resource: string; sign: '+' | '-'; kind: 'cost' | 'value' }
export interface BalanceAtom { id: number; type: string; amount: Amount }
export interface BalanceEntry { net: Amount; kind: 'cost' | 'value'; value: boolean }

export interface BalanceContext {
  /** The resource effects of each `FAMILY.TYPE_KEY` (resourceMap). */
  effects: ReadonlyMap<string, readonly Effect[]>;
  /** The atoms of a group with their amounts. */
  atoms(group: string): readonly BalanceAtom[];
  /** The `mana_symbols` count of the activation cost of a group; null when it is not `activated`. */
  costMana(group: string): Amount | null;
}

/** The resource of "mana by colour" (spec sec. 5.3 table). */
export const MANA = 'mana';
/** The resource that does not go into the tiers (spec sec. 5.3). */
const OTHER = 'other';
const MANA_PRODUCTION = 'PRODUCES.MANA_PRODUCTION';

/** spec sec. 5.3: the resource map - the effects of the accepted roles, without `other`. */
export function resourceMap(roles: readonly StoredRole[]): Map<string, Effect[]> {
  const out = new Map<string, Effect[]>();
  for (const r of roles) {
    if (r.status !== 'accepted') continue;
    const effects = r.resources.filter((e) => e.resource !== OTHER).map(({ resource, sign, kind }) => ({ resource, sign, kind }));
    if (effects.length > 0) out.set(`${r.family}.${r.type_key}`, effects);
  }
  return out;
}

/** The amount of one atom; `quoteMana` is the `mana_symbols` count of its quote (MANA_PRODUCTION only). */
export function atomAmount(a: { type: string; params: Record<string, unknown> }, amountParams: ReadonlyMap<string, string>,
  quoteMana: Amount | null): Amount {
  if (a.type === MANA_PRODUCTION) return typeof quoteMana === 'number' && quoteMana > 0 ? quoteMana : 'unknown';
  const p = amountParams.get(a.type);
  const v = p === undefined ? undefined : a.params[p];
  return typeof v === 'number' && Number.isInteger(v) ? v : 'unknown';
}

/** The one param of each type whose schema permits an integer. */
export function amountParams(db: DatabaseSync, schemaVersion: number): Map<string, string> {
  const rows = db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?')
    .all(schemaVersion) as Array<{ family: string; type_key: string; params_schema: string }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const props = (JSON.parse(r.params_schema) as { properties?: Record<string, { type?: string | string[] }> }).properties ?? {};
    const ints = Object.entries(props).filter(([, s]) => ([] as string[]).concat(s.type ?? []).includes('integer')).map(([k]) => k);
    if (ints.length === 1) out.set(`${r.family}.${r.type_key}`, ints[0]!);
  }
  return out;
}

export function cycleBalance(c: Cycle, ctx: BalanceContext): Map<string, BalanceEntry> {
  const out = new Map<string, BalanceEntry>();
  const add = (e: Effect, amount: Amount) => {
    const x = out.get(e.resource) ?? { net: 0, kind: 'value' as const, value: false };
    out.set(e.resource, {
      net: x.net === 'unknown' || amount === 'unknown' ? 'unknown' : x.net + (e.sign === '+' ? amount : -amount),
      kind: e.kind === 'cost' ? 'cost' : x.kind,
      value: x.value || e.kind === 'value',
    });
  };
  const n = c.groups.length;
  c.groups.forEach((group, i) => {
    const incoming = c.edges[(i - 1 + n) % n]!;
    const cost = ctx.costMana(group);
    if (cost !== null) add({ resource: MANA, sign: '-', kind: 'cost' }, cost);
    for (const a of ctx.atoms(group)) {
      if (a.id === incoming.demand_atom_id) continue;
      for (const e of ctx.effects.get(a.type) ?? []) {
        if (cost !== null && e.resource === MANA && e.kind === 'cost') continue;
        add(e, a.amount);
      }
    }
  });
  return out;
}

/** The balance context of a stored build: its rule set's resource map, its atoms and its groups. */
export function balanceContext(db: DatabaseSync, index: BuildIndex, tests: TextTests): BalanceContext {
  if (!index.build) throw new Error('balanceContext needs an index that BuildIndex.load made');
  const b = db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(index.build.id) as { rule_set_id: number };
  const set = getRuleSet(db, b.rule_set_id);
  if (!set) throw new Error(`no edge-rule set ${b.rule_set_id}`);
  const effects = resourceMap(setRoles(db, set.id));
  const params = amountParams(db, set.schema_version);
  const letters = manaLetters(db, currentCorpusId(db), tests);
  const quote = db.prepare('SELECT quote FROM atoms WHERE id = ?');
  const byGroup = new Map<string, BalanceAtom[]>();
  for (const a of [...index.atoms.values()].sort((x, y) => x.id - y.id)) {
    const type = `${a.family}.${a.type_key}`;
    const qm = type === MANA_PRODUCTION ? countManaSymbols((quote.get(a.id) as { quote: string }).quote, letters, tests) : null;
    const l = byGroup.get(a.group);
    const item = { id: a.id, type, amount: atomAmount({ type, params: a.params }, params, qm) };
    if (l) l.push(item); else byGroup.set(a.group, [item]);
  }
  return {
    effects,
    atoms: (g) => byGroup.get(g) ?? [],
    costMana: (g) => index.groups.get(g)?.cost_mana ?? null,
  };
}
