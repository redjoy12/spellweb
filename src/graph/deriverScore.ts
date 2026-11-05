/**
 * The deriver-only score (Phase 3 spec rev. 6 sec. 12.2, plan D7 and Task 3 Step 10): the model
 * validation of the edge-rule deriver. It compares the golden type pairs with the accepted rules
 * of a set directly. It does not use an edge build.
 *
 * The score uses the golden pairs with status `accepted`, `owner_accepted` or `owner_corrected`:
 * - a `synergy` or `anti` pair with both atom IDs is found when an accepted rule of the same
 *   polarity connects the type of the supply atom to the type of the demand atom;
 * - a pair with a characteristic supply and a demand atom ID is found when an accepted intrinsic
 *   rule of the same polarity has the demand type, its class kind agrees with the characteristic
 *   (`KINDS_FOR`), and the supply card is a member of the class (`isClassMember`).
 * Other synergy and anti pairs (an atom ID is null) are extraction misses of the full score
 * (sec. 12.2); they are not in this score.
 *
 * Owner decision 2026-10-11 (option 1 after the Opus Stage A): the score also reports Stage B on
 * the pairs it can reach. A pair is reachable when its demand type has the accepted role `demand`
 * or `both` (so it gets a Stage B batch), and its supply is a characteristic with a class kind or
 * an atom type with the accepted role `supply` or `both` (a supply candidate). A pair that Stage A
 * blocks is listed with its reason. Both numbers go to the owner; the bar is the owner's decision.
 *
 * For a `none` pair the labels have no atoms. The measure counts a `none` pair when an accepted
 * rule of either polarity connects a current atom type of the supply card to a current atom type
 * of the demand card, or an intrinsic rule for a demand atom type has the supply card as member.
 */
import type { DatabaseSync } from 'node:sqlite';
import { KINDS_FOR, isClassMember, type Characteristic } from './intrinsic.js';
import { isIntrinsic, type IntrinsicSide } from './ruleSchema.js';
import { getRuleSet, setRules, type StoredRule } from './ruleSet.js';
import { typesOf as kindTypes } from '../atoms/schemaV16.js';

export interface DeriverScore {
  recall: number;
  found: number;
  total: number;
  none_with_rule: number;
  none_total: number;
  misses: Array<{ pair_id: number; supply_type: string; demand_type: string }>;
  /** The pairs of each kind in the denominator, and the found ones. */
  by_kind: { atoms: { found: number; total: number }; characteristic: { found: number; total: number } };
  /** Synergy and anti pairs that the score leaves out: an atom ID is null (extraction class). */
  excluded: number;
  /** Stage B on the pairs that the Stage A roles let it reach, and the pairs Stage A blocks. */
  reachable: { found: number; total: number; recall: number; blocked: Array<{ pair_id: number; reason: string }> };
}

const SCORED = "('accepted','owner_accepted','owner_corrected')";

interface GoldenRow {
  id: number; supply_oracle: string; demand_oracle: string; label: 'synergy' | 'anti' | 'none';
  supply_clause: string | null; supply_type: string | null; demand_type: string | null;
}

const typeOf = (r: StoredRule) => (isIntrinsic(r.supply) ? null : `${r.supply.family}.${r.supply.type_key}`);
const demandOf = (r: StoredRule) => `${r.demand.family}.${r.demand.type_key}`;

export function deriverOnlyScore(db: DatabaseSync, setId: number): DeriverScore {
  const rules = setRules(db, setId, 'accepted');
  // sec. 21 item M3: on a v16 set a keyword kind is also ACTIVATE, as in the build.
  const v16 = (getRuleSet(db, setId)?.schema_version ?? 0) >= 16;
  const as = (t: string) => (v16 ? kindTypes(t) : [t]);
  const typed = new Set(rules.filter((r) => !isIntrinsic(r.supply)).map((r) => `${r.polarity}|${typeOf(r)}|${demandOf(r)}`));
  const intrinsic = rules.filter((r) => isIntrinsic(r.supply));

  const pairs = db.prepare(
    `SELECT p.id, p.supply_oracle, p.demand_oracle, p.label, p.supply_clause,
            sa.family || '.' || sa.type_key supply_type, da.family || '.' || da.type_key demand_type
       FROM edge_golden_pairs p
       LEFT JOIN atoms sa ON sa.id = p.supply_atom_id
       LEFT JOIN atoms da ON da.id = p.demand_atom_id
      WHERE p.status IN ${SCORED} ORDER BY p.id`,
  ).all() as unknown as GoldenRow[];

  const classHit = (polarity: string | null, demandType: string, kinds: readonly string[], supplyOracle: string) =>
    intrinsic.some((r) => (polarity === null || r.polarity === polarity) && as(demandType).includes(demandOf(r))
      && kinds.includes((r.supply as IntrinsicSide).intrinsic)
      && isClassMember(db, supplyOracle, r.supply as IntrinsicSide));

  const out: DeriverScore = {
    recall: 0, found: 0, total: 0, none_with_rule: 0, none_total: 0, misses: [],
    by_kind: { atoms: { found: 0, total: 0 }, characteristic: { found: 0, total: 0 } }, excluded: 0,
    reachable: { found: 0, total: 0, recall: 0, blocked: [] },
  };
  const roles = new Map((db.prepare(
    "SELECT family || '.' || type_key t, role FROM edge_type_roles WHERE set_id = ? AND status = 'accepted'",
  ).all(setId) as Array<{ t: string; role: string }>).map((r) => [r.t, r.role]));
  const roleOf = (t: string) => roles.get(t) ?? 'no accepted role';
  const hasRole = (t: string, want: readonly string[]) => as(t).some((x) => want.includes(roleOf(x)));
  /** Why Stage A blocks a pair from Stage B, or null when Stage B can reach it. */
  const blockedBy = (supply: string | null, demand: string, ch: Characteristic | undefined): string | null => {
    if (!hasRole(demand, ['demand', 'both'])) return `demand ${demand} has the role ${roleOf(demand)}`;
    if (ch) return KINDS_FOR[ch].length ? null : `no class kind agrees with ${ch}`;
    return hasRole(supply!, ['supply', 'both']) ? null : `supply ${supply} has the role ${roleOf(supply!)}`;
  };
  const tally = (pairId: number, ok: boolean, reason: string | null) => {
    if (reason) { out.reachable.blocked.push({ pair_id: pairId, reason }); return; }
    out.reachable.total++;
    if (ok) out.reachable.found++;
  };
  const atomTypes = db.prepare("SELECT DISTINCT family || '.' || type_key t FROM atoms WHERE oracle_id = ? AND is_current = 1");
  const typesOf = (oracle: string) => (atomTypes.all(oracle) as Array<{ t: string }>).flatMap((r) => as(r.t));
  const typedHit = (polarity: string, s: string, d: string) => as(s).some((x) => as(d).some((y) => typed.has(`${polarity}|${x}|${y}`)));

  for (const p of pairs) {
    if (p.label === 'none') {
      out.none_total++;
      const supply = typesOf(p.supply_oracle);
      const demand = typesOf(p.demand_oracle);
      const hit = supply.some((s) => demand.some((d) => typed.has(`+|${s}|${d}`) || typed.has(`-|${s}|${d}`)))
        || demand.some((d) => classHit(null, d, ['card_type', 'subtype', 'mana_value', 'color_identity'], p.supply_oracle));
      if (hit) out.none_with_rule++;
      continue;
    }
    const polarity = p.label === 'synergy' ? '+' : '-';
    const clause = p.supply_clause ? JSON.parse(p.supply_clause) as { characteristic?: Characteristic } : null;
    if (clause?.characteristic && p.demand_type) {
      const ok = classHit(polarity, p.demand_type, KINDS_FOR[clause.characteristic], p.supply_oracle);
      tally(p.id, ok, blockedBy(null, p.demand_type, clause.characteristic));
      out.by_kind.characteristic.total++;
      if (ok) out.by_kind.characteristic.found++;
      else out.misses.push({ pair_id: p.id, supply_type: `characteristic:${clause.characteristic}`, demand_type: p.demand_type });
    } else if (p.supply_type && p.demand_type) {
      const ok = typedHit(polarity, p.supply_type, p.demand_type);
      tally(p.id, ok, blockedBy(p.supply_type, p.demand_type, undefined));
      out.by_kind.atoms.total++;
      if (ok) out.by_kind.atoms.found++;
      else out.misses.push({ pair_id: p.id, supply_type: p.supply_type, demand_type: p.demand_type });
    } else {
      out.excluded++;
    }
  }
  out.found = out.by_kind.atoms.found + out.by_kind.characteristic.found;
  out.total = out.by_kind.atoms.total + out.by_kind.characteristic.total;
  out.recall = out.total === 0 ? 0 : out.found / out.total;
  out.reachable.recall = out.reachable.total === 0 ? 0 : out.reachable.found / out.reachable.total;
  return out;
}
