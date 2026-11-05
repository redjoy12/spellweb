/**
 * The votes of the edge-rule deriver (Phase 3 spec sec. 5.3, plan Task 3). Each batch runs in
 * three fresh passes. Only valid items (sec. 5.4) vote: the caller validates first.
 *
 * - Stage A: a role, or a resource effect, is accepted when two or more passes give it. Effects
 *   agree by exact resource, sign and kind. A type with no majority role gets the role `none`
 *   and is disputed. The demand note is free text and has no vote: the accepted role keeps the
 *   note of each pass that gave it.
 * - Stage B: a rule is accepted when two or more passes give the same `rule_hash`.
 * - An accepted item keeps the union of its verified quotes from all passes that gave it.
 */
import { canonicalJson } from './policy.js';
import type { Evidence } from './quotes.js';
import {
  canonicalRule, ruleHash, unionEvidence, type EdgeRuleItem, type ResourceEffect, type Role, type RoleItem,
} from './ruleSchema.js';

export const MAJORITY = 2;

export type VotedRole = RoleItem & { votes: number; demand_notes: string[] };
export type VotedRule = EdgeRuleItem & { votes: number; rule_hash: string };

const effectKey = (r: ResourceEffect) => `${r.resource}|${r.sign}|${r.kind}`;

/**
 * Votes each type that a pass gives. `passes[k]` is the valid items of pass k. A pass that gives
 * a type two times votes one time, with its first item. The order of the result follows the
 * first pass that gives each type.
 */
export function voteRoles(passes: RoleItem[][]): { accepted: VotedRole[]; disputed: VotedRole[] } {
  const byType = new Map<string, RoleItem[]>();
  for (const items of passes) {
    const seen = new Set<string>();
    for (const it of items) {
      const id = `${it.family}.${it.type_key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      byType.set(id, [...(byType.get(id) ?? []), it]);
    }
  }
  const accepted: VotedRole[] = [];
  const disputed: VotedRole[] = [];
  for (const items of byType.values()) {
    const counts = new Map<Role, RoleItem[]>();
    for (const it of items) counts.set(it.role, [...(counts.get(it.role) ?? []), it]);
    const [role, givers] = [...counts].sort((a, b) => b[1].length - a[1].length)[0]!;
    const won = givers.length >= MAJORITY;

    // Resource effects vote on their own, over all passes that give the type.
    const effects = new Map<string, ResourceEffect[]>();
    for (const it of items) {
      const seen = new Set<string>();
      for (const r of it.resources) {
        const k = effectKey(r);
        if (seen.has(k)) continue;
        seen.add(k);
        effects.set(k, [...(effects.get(k) ?? []), r]);
      }
    }
    const resources: ResourceEffect[] = [...effects.values()]
      .filter((rs) => rs.length >= MAJORITY)
      .map((rs) => {
        const notes = [...new Set(rs.map((r) => r.note?.trim()).filter((n): n is string => !!n))];
        return {
          resource: rs[0]!.resource, sign: rs[0]!.sign, kind: rs[0]!.kind,
          ...(notes.length ? { note: notes.join('\n') } : {}),
          evidence: unionEvidence(...rs.map((r) => r.evidence)),
        };
      });

    const base = { family: items[0]!.family, type_key: items[0]!.type_key, resources };
    if (won) {
      const notes = givers.map((g) => g.demand_note?.trim()).filter((n): n is string => !!n);
      accepted.push({
        ...base, role, votes: givers.length, demand_notes: notes,
        ...(notes.length ? { demand_note: notes.join('\n') } : {}),
        evidence: unionEvidence(...givers.map((g) => g.evidence)),
      });
    } else {
      disputed.push({ ...base, role: 'none', votes: givers.length, demand_notes: [], evidence: [] });
    }
  }
  return { accepted, disputed };
}

/**
 * Votes each rule by its `rule_hash`. A pass that gives the same hash two times votes one time.
 * The kept rule is the canonical form with the union of the evidence of all passes that gave it,
 * and the union of the evidence of each implication.
 */
export function voteRules(passes: EdgeRuleItem[][]): { accepted: VotedRule[]; disputed: VotedRule[] } {
  const byHash = new Map<string, EdgeRuleItem[]>();
  for (const items of passes) {
    const seen = new Set<string>();
    for (const it of items) {
      const h = ruleHash(it);
      if (seen.has(h)) continue;
      seen.add(h);
      byHash.set(h, [...(byHash.get(h) ?? []), it]);
    }
  }
  const accepted: VotedRule[] = [];
  const disputed: VotedRule[] = [];
  for (const [hash, items] of byHash) {
    const out: VotedRule = { ...mergeRule(items), votes: items.length, rule_hash: hash };
    (items.length >= MAJORITY ? accepted : disputed).push(out);
  }
  return { accepted, disputed };
}

/** Items with one hash -> one item: the canonical content, with all their verified quotes. */
export function mergeRule(items: EdgeRuleItem[]): EdgeRuleItem {
  const c = canonicalRule(items[0]!);
  const implKey = (i: { demand_param: string; value: unknown }) => canonicalJson([i.demand_param, i.value]);
  const implEvidence = new Map<string, Evidence[][]>();
  for (const it of items) {
    for (const i of it.implications) implEvidence.set(implKey(i), [...(implEvidence.get(implKey(i)) ?? []), i.evidence]);
  }
  return {
    ...c,
    implications: c.implications.map((i) => ({ ...i, evidence: unionEvidence(...(implEvidence.get(implKey(i)) ?? [])) })),
    evidence: unionEvidence(...items.map((i) => i.evidence)),
  };
}
