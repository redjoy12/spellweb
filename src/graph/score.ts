/**
 * The full score of a graph build and the trace bars (Phase 3 spec rev. 10 sec. 12.2, plan
 * Task 5 and D9), and the `top_weight` golden pairs (sec. 11.2).
 *
 * The score uses only golden pairs with status `accepted`, `owner_accepted` or `owner_corrected`.
 * A `synergy` or `anti` pair is found (plan D9) when the build has a merged edge of the same
 * polarity whose supply span overlaps the supply clause span and whose demand atom span overlaps
 * the demand clause span. A pair with a characteristic supply is found when the build has a class
 * edge of the same polarity to a demand atom that overlaps the demand clause, the supply card is a
 * member of that class, and the class kind agrees with the characteristic (`KINDS_FOR`).
 *
 * A pair that is not found gets one miss class:
 * - extraction: the label has a null atom for a clause (or the atom is not in the build). A
 *   characteristic supply has no atom, so it is never the cause of an extraction miss;
 * - rule: both atoms are present, but no accepted rule of the polarity connects their types (for a
 *   characteristic: no intrinsic rule of the demand type whose kind agrees and whose class has the
 *   supply card; `power_toughness` has no kind, so it is always a rule miss);
 * - param: a rule connects the types, but the build makes no edge: a predicate fails or the grade
 *   is `rejected`.
 *
 * A requeue gives a card new atom IDs, so a chain atom can be absent from a newer build. The miss
 * class then uses the build atom of the same card, face, family, type_key, params and span, if
 * there is one, and the miss records it as `requeue` ("matched after requeue"). The found test
 * uses spans only, so it does not need this fall-back.
 *
 * Precision: for each scored pair, the build card pairs supply -> demand of each polarity. A card
 * pair is correct when the label agrees with its polarity (`synergy` for `+`, `anti` for `-`).
 * `confirmed_precision` uses the card pairs with a `confirmed` edge, `all_precision` all of them.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex, type IndexAtom } from './buildIndex.js';
import { KINDS_FOR, isClassMember, type Characteristic } from './intrinsic.js';
import { predicateHolds, resolveParams, supplyHolds } from './match.js';
import { cardPairs, mergeEdges, type MergedEdge } from './merge.js';
import { canonicalJson } from './policy.js';
import { checkEvidence, type Evidence } from './quotes.js';
import { carrySource, sourceBatches } from './ruleCarry.js';
import { isIntrinsic, type IntrinsicSide } from './ruleSchema.js';
import { getRuleSet, setRoles, setRules, type StoredRule } from './ruleSet.js';
import type { PairCandidate } from './goldenSelect.js';
import { V16_REMOVED } from '../atoms/schemaV16.js';
import { V17_REMOVED } from '../atoms/schemaV17.js';
import { V18_REMOVED } from '../atoms/schemaV18.js';
import { draw } from '../util/draw.js';

export type MissClass = 'extraction' | 'rule' | 'param';
/** A chain atom that is not in the build, and the equal build atom that the score uses for it. */
export interface RequeueMatch { side: 'supply' | 'demand'; golden_atom_id: number; build_atom_id: number }
export interface Miss {
  pair_id: number; class: MissClass; label: 'synergy' | 'anti'; detail: string;
  /** Set when a chain atom was matched after requeue. */
  requeue?: RequeueMatch[];
}
type AtomOf = (id: number, side: RequeueMatch['side']) => { atom: IndexAtom; requeue?: RequeueMatch } | null;

/** One scored golden pair and what the build has for it. */
export interface PairResult {
  pair_id: number; stratum: string; label: 'synergy' | 'anti' | 'none'; characteristic: Characteristic | null;
  /** For synergy and anti: true when the build has the edge (D9). Null for none. */
  found: boolean | null;
  /** The polarities of the build card pairs supply -> demand, and the ones with a confirmed edge. */
  card_pairs: Array<'+' | '-'>; confirmed: Array<'+' | '-'>;
  /** The type pairs `polarity SUPPLY -> DEMAND` of the confirmed edges of the card pairs, sorted. */
  confirmed_types: string[];
}

export interface FullScore {
  /** A share, or null when the denominator is 0. */
  synergy_recall: number | null; anti_recall: number | null;
  confirmed_precision: number | null; all_precision: number | null;
  misses: Miss[];
  counts: Record<string, number>;
  pairs: PairResult[];
}

const SCORED = "('accepted','owner_accepted','owner_corrected')";
const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;
const overlaps = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[1] && b[0] < a[1];
const share = (n: number, d: number) => (d === 0 ? null : n / d);

interface GoldenRow {
  id: number; supply_oracle: string; demand_oracle: string; stratum: string; label: 'synergy' | 'anti' | 'none';
  supply_clause: string | null; demand_clause: string | null; supply_atom_id: number | null; demand_atom_id: number | null;
}
type ClauseJson = { face_index: number; clause_index: number } | { characteristic: Characteristic };

/** The full score of a stored build. */
export function fullScore(db: DatabaseSync, buildId: number, index: BuildIndex = BuildIndex.load(db, buildId)): FullScore {
  const b = db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(buildId) as { rule_set_id: number } | undefined;
  if (!b) throw new Error(`no graph build ${buildId}`);
  return scoreIndex(db, index, setRules(db, b.rule_set_id, 'accepted'));
}

/** The full score over an index. `rules` are the accepted rules of the index. */
export function scoreIndex(db: DatabaseSync, index: BuildIndex, rules: readonly StoredRule[]): FullScore {
  const pairs = db.prepare(
    `SELECT id, supply_oracle, demand_oracle, stratum, label, supply_clause, demand_clause, supply_atom_id, demand_atom_id
       FROM edge_golden_pairs WHERE status IN ${SCORED} ORDER BY id`,
  ).all() as unknown as GoldenRow[];
  const clauseSpan = db.prepare('SELECT span_start, span_end FROM clauses WHERE oracle_id = ? AND face_index = ? AND clause_index = ?');
  const spanOf = (oracle: string, c: { face_index: number; clause_index: number }): [number, number] | null => {
    const r = clauseSpan.get(oracle, c.face_index, c.clause_index) as { span_start: number; span_end: number } | undefined;
    return r ? [r.span_start, r.span_end] : null;
  };
  const supplyEdges = new Map<string, MergedEdge[]>();
  const classEdges = new Map<string, MergedEdge[]>();
  const outOf = (oracle: string) => {
    let e = supplyEdges.get(oracle);
    if (!e) { e = mergeEdges(index.cardAtomEdges(oracle).supply, index.ctx); supplyEdges.set(oracle, e); }
    return e;
  };
  const classesInto = (oracle: string) => {
    let e = classEdges.get(oracle);
    if (!e) { e = mergeEdges(index.cardAtomEdges(oracle).classes, index.ctx); classEdges.set(oracle, e); }
    return e;
  };
  const atomRow = db.prepare('SELECT oracle_id, face_index, family, type_key, params_json, span_start, span_end FROM atoms WHERE id = ?');
  const atomOf: AtomOf = (id, side) => {
    const a = index.atoms.get(id);
    if (a) return { atom: a };
    const r = atomRow.get(id) as { oracle_id: string; face_index: number; family: string; type_key: string; params_json: string;
      span_start: number; span_end: number } | undefined;
    if (!r) return null;
    const params = canonicalJson(JSON.parse(r.params_json));
    const twin = index.atomsOfCard(r.oracle_id).find((b) => b.face_index === r.face_index && b.family === r.family
      && b.type_key === r.type_key && b.span_start === r.span_start && b.span_end === r.span_end && canonicalJson(b.params) === params);
    return twin ? { atom: twin, requeue: { side, golden_atom_id: id, build_atom_id: twin.id } } : null;
  };
  const demandIn = (e: MergedEdge, face: number, span: [number, number]) => {
    const d = index.atoms.get(e.demand_atom_id)!;
    return d.face_index === face && overlaps(d.span, span);
  };

  const counts: Record<string, number> = {
    scored: 0, synergy: 0, synergy_found: 0, anti: 0, anti_found: 0, none: 0, characteristic: 0, characteristic_found: 0,
    miss_extraction: 0, miss_rule: 0, miss_param: 0, requeue_matched: 0, confirmed_items: 0, confirmed_correct: 0, all_items: 0, all_correct: 0,
  };
  const misses: Miss[] = [];
  const results: PairResult[] = [];

  for (const p of pairs) {
    counts['scored']!++;
    // Precision: the card pairs supply -> demand of each polarity.
    const toDemand = outOf(p.supply_oracle).filter((e) => e.demand_oracle === p.demand_oracle);
    const cardPol = (['+', '-'] as const).filter((pol) => toDemand.some((e) => e.polarity === pol));
    const confirmedPol = cardPol.filter((pol) => toDemand.some((e) => e.polarity === pol && e.grade === 'confirmed'));
    const confirmedTypes = [...new Set(toDemand.filter((e) => e.grade === 'confirmed').map((e) => {
      const sid = e.atom_ids.find((id) => id !== e.demand_atom_id)!;
      return `${e.polarity} ${typeId(index.atoms.get(sid)!)} -> ${typeId(index.atoms.get(e.demand_atom_id)!)}`;
    }))].sort();
    const agrees = (pol: '+' | '-') => (pol === '+' ? p.label === 'synergy' : p.label === 'anti');
    for (const pol of cardPol) { counts['all_items']!++; if (agrees(pol)) counts['all_correct']!++; }
    for (const pol of confirmedPol) { counts['confirmed_items']!++; if (agrees(pol)) counts['confirmed_correct']!++; }

    const sc = p.supply_clause ? JSON.parse(p.supply_clause) as ClauseJson : null;
    const ch = sc && 'characteristic' in sc ? sc.characteristic : null;
    const result: PairResult = {
      pair_id: p.id, stratum: p.stratum, label: p.label, characteristic: ch, found: null, card_pairs: cardPol, confirmed: confirmedPol,
      confirmed_types: confirmedTypes,
    };
    results.push(result);
    if (p.label === 'none') { counts['none']!++; continue; }
    counts[p.label]!++;
    if (ch) counts['characteristic']!++;
    const pol = p.label === 'synergy' ? '+' : '-';
    const dc = p.demand_clause ? JSON.parse(p.demand_clause) as { face_index: number; clause_index: number } : null;
    const dSpan = dc ? spanOf(p.demand_oracle, dc) : null;

    let found = false;
    if (dc && dSpan) {
      if (ch) {
        const kinds = KINDS_FOR[ch] as readonly string[];
        found = classesInto(p.demand_oracle).some((e) => {
          if (e.polarity !== pol || !demandIn(e, dc.face_index, dSpan)) return false;
          const cls = index.classes.get(e.class_id!);
          return !!cls && kinds.includes(cls.intrinsic) && cls.members.includes(p.supply_oracle);
        });
      } else if (sc && !('characteristic' in sc)) {
        const sSpan = spanOf(p.supply_oracle, sc);
        found = !!sSpan && toDemand.some((e) => {
          if (e.polarity !== pol || !e.supply_span || !demandIn(e, dc.face_index, dSpan)) return false;
          const s = index.atoms.get(e.atom_ids.find((id) => id !== e.demand_atom_id)!)!;
          return s.face_index === sc.face_index && overlaps(e.supply_span, sSpan);
        });
      }
    }
    result.found = found;
    if (found) {
      counts[`${p.label}_found`]!++;
      if (ch) counts['characteristic_found']!++;
      continue;
    }
    const miss = classify(db, index, rules, p, ch, pol, atomOf);
    counts[`miss_${miss.class}`]!++;
    if (miss.requeue) counts['requeue_matched']!++;
    misses.push({ pair_id: p.id, label: p.label, ...miss });
  }

  return {
    synergy_recall: share(counts['synergy_found']!, counts['synergy']!),
    anti_recall: share(counts['anti_found']!, counts['anti']!),
    confirmed_precision: share(counts['confirmed_correct']!, counts['confirmed_items']!),
    all_precision: share(counts['all_correct']!, counts['all_items']!),
    misses, counts, pairs: results,
  };
}

/** The miss class of a pair that the build does not find (spec sec. 12.2). */
function classify(db: DatabaseSync, index: BuildIndex, rules: readonly StoredRule[], p: GoldenRow,
  ch: Characteristic | null, pol: '+' | '-', atomOf: AtomOf): Pick<Miss, 'class' | 'detail' | 'requeue'> {
  if (ch === 'power_toughness') return { class: 'rule', detail: 'no class kind agrees with power_toughness (a v15 candidate)' };
  const requeue: RequeueMatch[] = [];
  const done = (cls: MissClass, detail: string): Pick<Miss, 'class' | 'detail' | 'requeue'> => (requeue.length
    ? { class: cls, detail: `${detail} (${requeue.map((m) => `matched after requeue: ${m.side} atom ${m.golden_atom_id} -> ${m.build_atom_id}`).join('; ')})`, requeue }
    : { class: cls, detail });
  if (p.demand_atom_id === null) return done('extraction', 'the demand clause has no atom (null)');
  const dm = atomOf(p.demand_atom_id, 'demand');
  if (!dm) return done('extraction', `demand atom ${p.demand_atom_id} is not in the build`);
  if (dm.requeue) requeue.push(dm.requeue);
  const d = dm.atom;
  const dt = typeId(d);
  if (ch) {
    const kinds = KINDS_FOR[ch] as readonly string[];
    const hit = rules.filter((r) => isIntrinsic(r.supply) && r.polarity === pol && index.typesOf(d).includes(typeId(r.demand))
      && kinds.includes(r.supply.intrinsic) && isClassMember(db, p.supply_oracle, r.supply as IntrinsicSide));
    if (!hit.length) return done('rule', `no intrinsic rule ${pol} ${ch} -> ${dt} with the supply card as member`);
    return done('param', `${hit.map((r) => r.rule_id).join(', ')}: ${hit.map((r) => whyNoEdge(index, r, null, d)).join('; ')}`);
  }
  if (p.supply_atom_id === null) return done('extraction', 'the supply clause has no atom (null)');
  const sm = atomOf(p.supply_atom_id, 'supply');
  if (!sm) return done('extraction', `supply atom ${p.supply_atom_id} is not in the build`);
  if (sm.requeue) requeue.push(sm.requeue);
  const s = sm.atom;
  const st = typeId(s);
  const hit = rules.filter((r) => !isIntrinsic(r.supply) && r.polarity === pol && index.typesOf(s).includes(typeId(r.supply)) && index.typesOf(d).includes(typeId(r.demand)));
  if (!hit.length) return done('rule', `no rule ${pol} ${st} -> ${dt}`);
  return done('param', hit.map((r) => `${r.rule_id}: ${whyNoEdge(index, r, s, d)}`).join('; '));
}

/** Why a rule that connects the two types makes no edge that the score finds. */
function whyNoEdge(index: BuildIndex, r: StoredRule, s: IndexAtom | null, d: IndexAtom): string {
  if (s && !supplyHolds(r, s, index.activateKinds, index.gradeVersion)) return 'a supply predicate fails';
  if (!r.demand.where.every((w) => predicateHolds(w, d.params))) return 'a demand predicate fails';
  if (s && s.id === d.id) return 'the supply atom is the demand atom';
  if (!s) return 'the class edge does not reach the demand clause';
  const res = resolveParams(r, s, d, index.paramsOf(r.demand), index.gradeVersion);
  const bad = [...res].filter(([, v]) => v === 'disagrees').map(([k]) => k);
  if (bad.length) return `grade rejected: ${bad.join(', ')} disagrees`;
  return 'an edge exists, but its spans do not overlap the label clauses';
}

// ---- trace bars ---------------------------------------------------------------------------------

export interface Tally { ok: number; total: number }

/**
 * spec sec. 12.2 trace bars 2 and 3, over all merged edges of the index: an explicit edge has two
 * or more atoms (supply and demand) and rules with evidence; a class edge has one atom, one class
 * of the index and rules with evidence.
 */
export function edgeTrace(index: BuildIndex, rules: readonly StoredRule[]): { explicit: Tally; class: Tally } {
  const byHash = new Map(rules.map((r) => [r.rule_hash, r]));
  const evidenced = (e: MergedEdge) => e.rule_hashes.length > 0 && e.rule_hashes.every((h) => (byHash.get(h)?.evidence.length ?? 0) > 0);
  const out = { explicit: { ok: 0, total: 0 }, class: { ok: 0, total: 0 } };
  for (const c of index.cards()) {
    const ae = index.cardAtomEdges(c);
    for (const e of mergeEdges(ae.supply, index.ctx)) {
      out.explicit.total++;
      if (e.supply_oracle !== null && e.class_id === null && e.atom_ids.length >= 2 && evidenced(e)) out.explicit.ok++;
    }
    for (const e of mergeEdges(ae.classes, index.ctx)) {
      out.class.total++;
      if (e.supply_oracle === null && e.class_id !== null && index.classes.has(e.class_id) && e.atom_ids.length === 1 && evidenced(e)) out.class.ok++;
    }
  }
  return out;
}

/**
 * spec sec. 12.2 trace bar 1: each evidence quote passes the check of sec. 5.4 again, against the
 * references of the packets that showed it. A rule quote: the Stage B batches of its demand type,
 * and of each demand type that the same rule ID had in a source set (a moved rule). A role quote:
 * the Stage A batches that showed the type or a removed type that moved into it; for a role with
 * 0 votes (`giveDemandRole`, no Stage A batch), the Stage B batches of its type. A golden chain
 * quote: the label batch of the pair. The rules and roles are the accepted ones of the set; the
 * pairs are the scored ones.
 */
export function quoteTrace(db: DatabaseSync, setId: number): { rules: Tally; roles: Tally; golden: Tally; faults: string[] } {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  // A carried set (ruleCarry.ts): a copied quote was shown in a batch of its source set.
  const batches = sourceBatches(db, setId);
  const union = (pick: (b: (typeof batches)[number]) => boolean) =>
    new Set(batches.filter(pick).flatMap((b) => JSON.parse(b.refs_json) as string[]));
  const out = { rules: { ok: 0, total: 0 }, roles: { ok: 0, total: 0 }, golden: { ok: 0, total: 0 }, faults: [] as string[] };
  const check = (t: Tally, corpusId: number, ev: readonly Evidence[], refs: ReadonlySet<string>, where: string) => {
    for (const e of ev) {
      t.total++;
      const f = checkEvidence(db, corpusId, e, refs);
      if (f) out.faults.push(`${where}: ${f}: ${e.source} ${e.ref}`); else t.ok++;
    }
  };
  // A moved rule keeps its rule ID: the demand types of that ID in the source sets of the carry.
  const earlierDemands = new Map<string, Set<string>>();
  for (let s = carrySource(db, setId); s !== null; s = carrySource(db, s)) {
    for (const r of setRules(db, s, 'all')) {
      const l = earlierDemands.get(r.rule_id);
      if (l) l.add(typeId(r.demand)); else earlierDemands.set(r.rule_id, new Set([typeId(r.demand)]));
    }
  }
  const ruleRefs = new Map<string, Set<string>>();
  for (const r of setRules(db, setId, 'accepted')) {
    const demands = [...new Set([typeId(r.demand), ...(earlierDemands.get(r.rule_id) ?? [])])].sort();
    const k = demands.join(',');
    let refs = ruleRefs.get(k);
    if (!refs) { refs = union((b) => b.stage === 'pairs' && demands.includes(b.demand ?? '')); ruleRefs.set(k, refs); }
    check(out.rules, set.corpus_id, [...r.evidence, ...r.implications.flatMap((i) => i.evidence)], refs, `rule ${r.rule_id}`);
  }
  const removed = [...V16_REMOVED, ...V17_REMOVED, ...V18_REMOVED];
  for (const r of setRoles(db, setId).filter((x) => x.status === 'accepted')) {
    const t = typeId(r);
    const types = [t, ...removed.filter((x) => x.into === t).map((x) => x.type)];
    const refs = union((b) => (b.stage === 'roles' && (JSON.parse(b.types_json) as string[]).some((x) => types.includes(x)))
      || (r.votes === 0 && b.stage === 'pairs' && b.demand === t));
    check(out.roles, set.corpus_id, [...r.evidence, ...r.resources.flatMap((x) => x.evidence)], refs, `role ${t}`);
  }
  const pairs = db.prepare(`SELECT id, cr_chain_json FROM edge_golden_pairs WHERE status IN ${SCORED} ORDER BY id`)
    .all() as Array<{ id: number; cr_chain_json: string | null }>;
  const batchOf = db.prepare('SELECT b.corpus_id, b.refs_json FROM edge_golden_batches b, json_each(b.pair_ids) j WHERE j.value = ?');
  for (const p of pairs) {
    const chain = p.cr_chain_json ? JSON.parse(p.cr_chain_json) as Evidence[] : [];
    if (!chain.length) continue;
    const b = batchOf.get(p.id) as { corpus_id: number; refs_json: string } | undefined;
    if (!b) {
      out.golden.total += chain.length;
      out.faults.push(`pair ${p.id}: no label batch`);
      continue;
    }
    check(out.golden, b.corpus_id, chain, new Set(JSON.parse(b.refs_json) as string[]), `pair ${p.id}`);
  }
  return out;
}

// ---- top_weight pairs ---------------------------------------------------------------------------

/**
 * spec sec. 11.2: the `n` card pairs (either polarity) with the highest weight. A pair has the
 * highest weight of its two polarities. Self pairs and pairs in `exclude` (keys `supply|demand`,
 * in either direction) are left out. Equal weights are ordered by a stable draw on the seed.
 */
export function topWeightPairs(index: BuildIndex, n: number, seed: number, exclude: ReadonlySet<string>): PairCandidate[] {
  type Cand = { k: string; s: string; d: string; w: number; r: number };
  const better = (a: Cand, b: Cand) => a.w > b.w || (a.w === b.w && (a.r < b.r || (a.r === b.r && a.k < b.k)));
  const best: Cand[] = [];
  for (const c of index.cards()) {
    const merged = mergeEdges(index.cardAtomEdges(c).supply, index.ctx);
    const pairs = new Map<string, number>();
    for (const pol of ['+', '-'] as const) {
      for (const [k, p] of cardPairs(merged.filter((e) => e.polarity === pol))) pairs.set(k, Math.max(pairs.get(k) ?? 0, p.weight));
    }
    for (const [k, w] of pairs) {
      const [s, d] = k.split('|') as [string, string];
      if (s === d || exclude.has(k) || exclude.has(`${d}|${s}`)) continue;
      const cand = { k, s, d, w, r: draw(seed, k) };
      if (best.length === n && !better(cand, best[n - 1]!)) continue;
      let i = best.length;
      while (i > 0 && better(cand, best[i - 1]!)) i--;
      best.splice(i, 0, cand);
      if (best.length > n) best.pop();
    }
  }
  return best.map((c) => ({ supply_oracle: c.s, demand_oracle: c.d, stratum: 'top_weight' }));
}

/** The `top_weight` pairs of a stored build: the seed is the build ID; all golden pairs are left out. */
export function samplePairsByWeight(db: DatabaseSync, buildId: number, n: number, index: BuildIndex = BuildIndex.load(db, buildId)): PairCandidate[] {
  const exclude = new Set((db.prepare('SELECT supply_oracle, demand_oracle FROM edge_golden_pairs').all() as
    Array<{ supply_oracle: string; demand_oracle: string }>).map((p) => `${p.supply_oracle}|${p.demand_oracle}`));
  return topWeightPairs(index, n, buildId, exclude);
}
