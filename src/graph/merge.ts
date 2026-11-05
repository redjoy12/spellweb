/**
 * Merged edges and card pairs (Phase 3 spec sec. 7.3). Two rules can give two atom edges for one
 * supply clause; the merge makes them one edge with all their rules and atoms as evidence.
 *
 * Merge key: (polarity, supply group key, supply span start, supply span end, demand atom ID);
 * for a class edge, (polarity, class ID, demand atom ID). The merged grade is the best grade of
 * the parts. The output is sorted by key, and the rule hashes and atom IDs of each edge are
 * sorted, so the same atom edges in any order give the same merged edges.
 */
import type { GroupKind } from './groups.js';
import type { Grade } from './match.js';
import type { GraphPolicy } from './policy.js';
import { classWeight, weightOf, type WeightParts } from './weights.js';

export interface AtomEdge {
  rule_hash: string; polarity: '+' | '-'; supply_atom_id: number | null; class_id: string | null;
  demand_atom_id: number; grade: Exclude<Grade, 'rejected'>; unresolved: string[];
}

export interface MergedEdge {
  key: string; polarity: '+' | '-'; supply_oracle: string | null; class_id: string | null;
  supply_group: string | null; supply_span: [number, number] | null; demand_atom_id: number; demand_oracle: string;
  grade: Exclude<Grade, 'rejected'>;
  /** The params that are not resolved in the best part (sec. 7.2); empty when confirmed. */
  unresolved: string[];
  rule_hashes: string[]; atom_ids: number[]; weight: WeightParts;
}

/** What the merge needs to know about an atom: its card, its group (key and kind), its span, the card's mana value. */
export interface AtomPlace { oracle_id: string; group: string; kind: GroupKind; span: [number, number]; mv: number }

export interface MergeContext {
  atom(id: number): AtomPlace;
  classSize(classId: string): number;
  /** spec rev. 16 sec. 7.4: the specificity part of a typed rule; 1 when absent. */
  ruleSize?(ruleHash: string): number;
  policy: GraphPolicy;
}

/** True when part `a` is better than part `b`: the better grade, then fewer unresolved params, then their names. */
function better(a: AtomEdge, b: AtomEdge): boolean {
  if (a.grade !== b.grade) return a.grade === 'confirmed';
  if (a.unresolved.length !== b.unresolved.length) return a.unresolved.length < b.unresolved.length;
  return a.unresolved.join(',') < b.unresolved.join(',');
}

export function mergeKey(e: AtomEdge, ctx: MergeContext): string {
  if (e.class_id !== null) return `${e.polarity}|${e.class_id}|${e.demand_atom_id}`;
  const s = ctx.atom(e.supply_atom_id!);
  return `${e.polarity}|${s.group}|${s.span[0]}|${s.span[1]}|${e.demand_atom_id}`;
}

/** The parts of a merged-edge key (the inverse of mergeKey). The group key is `oracle#face#group`. */
export type ParsedMergeKey =
  | { polarity: '+' | '-'; class_id: null; supply_oracle: string; face_index: number; group: string; span: [number, number]; demand_atom_id: number }
  | { polarity: '+' | '-'; class_id: string; demand_atom_id: number };

export function parseMergeKey(key: string): ParsedMergeKey | null {
  const parts = key.split('|');
  const polarity = parts[0];
  if ((polarity !== '+' && polarity !== '-') || parts.length < 3) return null;
  const demand = Number(parts[parts.length - 1]);
  if (!Number.isInteger(demand)) return null;
  const group = /^(.+)#(\d+)#(\d+)$/.exec(parts[1]!);
  if (parts.length === 5 && group) {
    const span: [number, number] = [Number(parts[2]), Number(parts[3])];
    if (!span.every(Number.isInteger)) return null;
    return { polarity, class_id: null, supply_oracle: group[1]!, face_index: Number(group[2]), group: parts[1]!, span, demand_atom_id: demand };
  }
  return { polarity, class_id: parts.slice(1, -1).join('|'), demand_atom_id: demand };
}

export function mergeEdges(edges: AtomEdge[], ctx: MergeContext): MergedEdge[] {
  const groups = new Map<string, AtomEdge[]>();
  for (const e of edges) {
    const k = mergeKey(e, ctx);
    const g = groups.get(k);
    if (g) g.push(e); else groups.set(k, [e]);
  }
  const out: MergedEdge[] = [];
  for (const [key, parts] of groups) {
    const best = parts.reduce((a, b) => (better(b, a) ? b : a));
    const first = parts[0]!;
    const demand = ctx.atom(first.demand_atom_id);
    const supplyIds = [...new Set(parts.map((p) => p.supply_atom_id).filter((x): x is number => x !== null))].sort((a, b) => a - b);
    const ruleHashes = [...new Set(parts.map((p) => p.rule_hash))].sort();
    let weight: WeightParts;
    let supply: AtomPlace | null = null;
    if (first.class_id !== null) {
      weight = classWeight(best.grade, ctx.classSize(first.class_id), ctx.policy);
    } else {
      supply = ctx.atom(supplyIds[0]!);
      // rev. 16: the size part is the best specificity of the parts with the best grade.
      const size = ctx.ruleSize
        ? Math.max(...parts.filter((p) => p.grade === best.grade).map((p) => ctx.ruleSize!(p.rule_hash))) : 1;
      weight = weightOf(best.grade, supply.kind, supply.mv, ctx.policy, size);
    }
    out.push({
      key, polarity: first.polarity, supply_oracle: supply?.oracle_id ?? null, class_id: first.class_id,
      supply_group: supply?.group ?? null, supply_span: supply ? [supply.span[0], supply.span[1]] : null,
      demand_atom_id: first.demand_atom_id, demand_oracle: demand.oracle_id,
      grade: best.grade, unresolved: [...best.unresolved],
      rule_hashes: ruleHashes, atom_ids: [...supplyIds, first.demand_atom_id].sort((a, b) => a - b), weight,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * sec. 7.3 item 6: the card pairs of explicit merged edges, keyed `supply|demand`. The weight
 * of a pair is the highest weight of its edges. A card can supply its own demand: the pair
 * `A|A`. Class edges have no supply card and make no pair. The caller selects the polarity.
 */
export function cardPairs(edges: MergedEdge[]): Map<string, { weight: number; edges: MergedEdge[] }> {
  const out = new Map<string, { weight: number; edges: MergedEdge[] }>();
  for (const e of edges) {
    if (e.supply_oracle === null) continue;
    const k = `${e.supply_oracle}|${e.demand_oracle}`;
    const p = out.get(k);
    if (p) { p.edges.push(e); p.weight = Math.max(p.weight, e.weight.total); } else out.set(k, { weight: e.weight.total, edges: [e] });
  }
  return out;
}
