/**
 * Phase 3 plan Task 6 Step 5: measure the cycle limits (spec sec. 9.2: the length limit, K and
 * the budget are provisional). For a sample of cards (the highest degree, and a seeded random
 * set), run the engine search and the full search with each length limit and budget, and count
 * the time, the expansions, the `exact` mark, the kept cycles and the tiers.
 *
 * The measure also counts the cycles that go through a wide type pair of the precision
 * diagnosis (docs/phase-3-precision-diagnosis.md, option C1): a `+` type pair whose edges connect
 * more than 1% of the ordered card pairs of the scope, or whose demand type is one of the three
 * types of option A. The weights favour these edges (most of them are `confirmed`).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BalanceContext } from './balance.js';
import type { BuildIndex } from './buildIndex.js';
import { cardCycles, cycleGraphs, type CardCycles, type CycleGraphs, type Limits, type SearchOut } from './cardCycles.js';
import type { GroupEdge } from './cycleGraph.js';
import { scopeCards } from './intrinsic.js';
import { isIntrinsic } from './ruleSchema.js';

/** Option A of the precision diagnosis: the demand types whose rules it caps. */
export const OPTION_A_DEMAND = ['ENABLES.ACTIVATE', 'ENABLES.CAST', 'ENABLES.PLAY'];
/** Option B1 of the precision diagnosis: the share of ordered card pairs above which a type pair is wide. */
export const WIDE_SHARE = 0.01;

const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

/** The `+` type pairs of the build with their share of the ordered card pairs of the scope. */
export function typePairShares(db: DatabaseSync, index: BuildIndex): Map<string, number> {
  if (!index.build) throw new Error('typePairShares needs an index that BuildIndex.load made');
  const n = scopeCards(db, index.build.scope).length;
  const pairs = new Map<string, Set<string>>();
  for (const a of index.atoms.values()) {
    for (const e of index.edgesFromSupply(a)) {
      if (e.polarity !== '+') continue;
      const d = index.atoms.get(e.demand_atom_id)!;
      // The types of the rule: on v16 a keyword atom can make an ACTIVATE edge (spec sec. 21 M3).
      const r = index.ruleOf(e.rule_hash);
      const tp = r && !isIntrinsic(r.supply) ? `${typeId(r.supply)} -> ${typeId(r.demand)}` : `${typeId(a)} -> ${typeId(d)}`;
      let s = pairs.get(tp);
      if (!s) pairs.set(tp, (s = new Set()));
      s.add(`${a.oracle_id}|${d.oracle_id}`);
    }
  }
  return new Map([...pairs].map(([tp, s]) => [tp, s.size / (n * n)]));
}

export function wideTypePairs(shares: ReadonlyMap<string, number>): Set<string> {
  return new Set([...shares].filter(([tp, share]) => share > WIDE_SHARE || OPTION_A_DEMAND.includes(tp.split(' -> ')[1]!)).map(([tp]) => tp));
}

/**
 * The type pairs of one cycle edge: the types of the supply atoms at the merged key's span, to the
 * demand type. Atoms of other types can have the same span, so only the `+` type pairs that have
 * edges in the build (`shares`) count.
 */
export function edgeTypePairs(index: BuildIndex, e: GroupEdge, shares: ReadonlyMap<string, number>): string[] {
  const [, group, s, t] = e.merged_key.split('|');
  const d = index.atoms.get(e.demand_atom_id)!;
  const supply = index.atomsOfCard(group!.split('#')[0]!)
    .filter((a) => a.group === group && a.span[0] === Number(s) && a.span[1] === Number(t));
  return [...new Set(supply.flatMap((a) => index.typesOf(a).flatMap((x) => index.typesOf(d).map((y) => `${x} -> ${y}`))))]
    .filter((tp) => shares.has(tp)).sort();
}

export interface SampleCard { oracle_id: string; name: string; sample: 'top_degree' | 'random'; degree: number; groups: number }

/** mulberry32: a seeded generator, so that the random sample is the same in each run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `n / 2` cards with the highest degree (out + in), then `n / 2` random cards of the others (seed 1). */
export function sampleCards(db: DatabaseSync, index: BuildIndex, n: number): SampleCard[] {
  const buildId = index.build!.id;
  const rows = db.prepare(
    `SELECT d.oracle_id, c.name, d.out_degree + d.in_degree degree FROM card_degree d JOIN cards c USING (oracle_id)
      WHERE d.build_id = ? ORDER BY degree DESC, d.oracle_id`,
  ).all(buildId) as Array<{ oracle_id: string; name: string; degree: number }>;
  const withAtoms = rows.filter((r) => index.atomsOfCard(r.oracle_id).length > 0);
  const top = withAtoms.slice(0, Math.ceil(n / 2));
  const rest = withAtoms.slice(top.length).sort((a, b) => (a.oracle_id < b.oracle_id ? -1 : 1));
  const r = rng(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  const groups = (id: string) => new Set(index.atomsOfCard(id).map((a) => a.group)).size;
  return [
    ...top.map((c) => ({ ...c, sample: 'top_degree' as const, groups: groups(c.oracle_id) })),
    ...rest.slice(0, n - top.length).map((c) => ({ ...c, sample: 'random' as const, groups: groups(c.oracle_id) })),
  ];
}

export interface MeasureRow { card: SampleCard; limits: Limits; result: CardCycles }

export function runMeasure(index: BuildIndex, balance: BalanceContext, cards: SampleCard[], configs: Limits[],
  onRow?: (r: MeasureRow) => void): MeasureRow[] {
  const graphs: CycleGraphs = cycleGraphs(index);
  // Fill the out-edge caches first (length 3), so that the first config does not pay for them alone.
  for (const c of cards) cardCycles(index, graphs, balance, c.oracle_id, { maxLength: 3, topK: 50, budget: 50_000 });
  const out: MeasureRow[] = [];
  for (const limits of configs) {
    for (const card of cards) {
      const row = { card, limits, result: cardCycles(index, graphs, balance, card.oracle_id, limits) };
      out.push(row);
      onRow?.(row);
    }
  }
  return out;
}

// ---- report ---------------------------------------------------------------------------------

const PER_CENT = 100; // i2-ok: a percent factor, not a rule number
const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((PER_CENT * a) / b).toFixed(1)}%`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });
const cfgName = (l: Limits) => `L${l.maxLength} K${l.topK} B${fmt(l.budget)}`;
const tiers = (s: SearchOut) => [3, 2, 1].map((t) => s.cycles.filter((c) => c.tier === t).length).join('/');

/** The total kept cycles of a search: the full list without the engine cycles, plus the engine list. */
function summary(rows: MeasureRow[], which: 'engine' | 'full') {
  const s = rows.map((r) => r.result[which]);
  const ms = s.map((x) => x.ms);
  return {
    exact: s.filter((x) => x.exact).length,
    kept_k: s.filter((x) => x.kept_k).length,
    median_ms: median(ms), max_ms: Math.max(...ms), sum_ms: ms.reduce((a, b) => a + b, 0),
    median_exp: median(s.map((x) => x.expansions)), max_exp: Math.max(...s.map((x) => x.expansions)),
    cycles: s.reduce((a, x) => a + x.cycles.length, 0),
    tier: [3, 2, 1].map((t) => s.reduce((a, x) => a + x.cycles.filter((c) => c.tier === t).length, 0)),
    unresolved: s.reduce((a, x) => a + x.cycles.filter((c) => c.unresolved.length > 0).length, 0),
    no_cycle: s.filter((x) => x.cycles.length === 0).length,
  };
}

export interface WideCount { cycles: number; wide: number; top1: number; top1_wide: number; tp: Map<string, number>; tp_wide_edges: number; edges: number }

export function wideCount(index: BuildIndex, wide: ReadonlySet<string>, shares: ReadonlyMap<string, number>, rows: MeasureRow[],
  which: 'engine' | 'full'): WideCount {
  const out: WideCount = { cycles: 0, wide: 0, top1: 0, top1_wide: 0, tp: new Map(), tp_wide_edges: 0, edges: 0 };
  for (const r of rows) {
    const list = r.result[which].cycles;
    list.forEach((c, i) => {
      let has = false;
      for (const e of c.edges) {
        const tps = edgeTypePairs(index, e, shares);
        out.edges++;
        if (tps.some((t) => wide.has(t))) { has = true; out.tp_wide_edges++; }
        for (const t of tps) out.tp.set(t, (out.tp.get(t) ?? 0) + 1);
      }
      out.cycles++;
      if (has) out.wide++;
      if (i === 0) { out.top1++; if (has) out.top1_wide++; }
    });
  }
  return out;
}

export function renderMeasure(o: {
  buildId: number; date: string; rows: MeasureRow[]; configs: Limits[]; selected: Limits; index: BuildIndex;
  wide: ReadonlySet<string>; shares: ReadonlyMap<string, number>;
}): string {
  const { rows, configs, selected, index, wide, shares } = o;
  const L: string[] = [];
  const cards = [...new Map(rows.map((r) => [r.card.oracle_id, r.card])).values()];
  L.push('# Phase 3 — Cycle limits measure', '', '**Language:** ASD-STE100', '');
  L.push(`Build ${o.buildId}. Date ${o.date}. Written by \`npm run graph -- --cycles --build ${o.buildId} --measure ${cards.length}\` (plan Task 6 Step 5), except §5, which is written by hand.`, '');
  L.push('## 1. Method', '');
  L.push(`- Cards: the ${cards.filter((c) => c.sample === 'top_degree').length} cards with the highest degree (out + in), and ${cards.filter((c) => c.sample === 'random').length} random cards of the other cards (seed 1).`);
  L.push('- For each card, the request does two searches (spec §9.2): the engine search (groups of the kind `triggered` or `activated`) and the full search (all groups).');
  L.push('- The grades are `confirmed` and `plausible` (the default of §9.1).');
  L.push(`- Configs (L = length limit, K = cycles kept by each search, B = budget in expansions): ${configs.map(cfgName).join('; ')}.`);
  L.push('- The time is the search and the tier calculation of one card on one CPU core. The out-edges of a group are calculated one time and kept. A warm-up run (length 3, budget 50,000) fills most of them first, so the times do not include most of the first calculation.', '');

  L.push('## 2. Summary for each config', '');
  L.push('`exact`: the count of the searches that did not reach the budget. `kept K`: the searches that kept K cycles. Tiers: the kept cycles of tier 3 / 2 / 1. The full rows count the full-only list: the cycles of the full search that are not in the engine list.', '');
  L.push('| Config | Search | exact | kept K | no cycle | median ms | max ms | total s | median exp. | max exp. | cycles | tiers 3/2/1 | unresolved |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const cfg of configs) {
    const rs = rows.filter((r) => r.limits === cfg);
    for (const w of ['engine', 'full'] as const) {
      const s = summary(rs, w);
      L.push(`| ${cfgName(cfg)} | ${w} | ${s.exact} | ${s.kept_k} | ${s.no_cycle} | ${s.median_ms.toFixed(1)} | ${s.max_ms.toFixed(0)} | ${(s.sum_ms / 1000).toFixed(1)} | ${fmt(s.median_exp)} | ${fmt(s.max_exp)} | ${s.cycles} | ${s.tier.join('/')} | ${s.unresolved} |`);
    }
  }
  L.push('');
  L.push(`Each row has ${cards.length} searches.`, '');
  L.push('Note: the full search keeps its own top K. Then the request removes the cycles that are also in the engine list. Thus a "no cycle" full row can have a full top K that the engine list contains.', '');


  L.push(`## 3. Each card, config ${cfgName(selected)}`, '');
  L.push('| Card | Sample | Degree | Groups | Engine ms | Engine exp. | Engine exact | Engine kept | Engine tiers 3/2/1 | Full ms | Full exp. | Full exact | Full kept | Full-only tiers 3/2/1 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.limits === selected)) {
    const e = r.result.engine;
    const f = r.result.full;
    L.push(`| ${r.card.name.replace(/\|/g, '/')} | ${r.card.sample} | ${r.card.degree} | ${r.card.groups} | ${e.ms.toFixed(1)} | ${fmt(e.expansions)} | ${e.exact ? 'yes' : 'no'} | ${e.cycles.length} | ${tiers(e)} | ${f.ms.toFixed(1)} | ${fmt(f.expansions)} | ${f.exact ? 'yes' : 'no'} | ${f.cycles.length} | ${tiers(f)} |`);
  }
  L.push('');

  L.push(`## 4. Cycles through the wide type pairs, config ${cfgName(selected)}`, '');
  L.push(`A wide type pair is a \`+\` type pair of option C1 of docs/phase-3-precision-diagnosis.md: its edges connect more than ${PER_CENT * WIDE_SHARE}% of the ordered card pairs, or its demand type is ${OPTION_A_DEMAND.map((t) => `\`${t}\``).join(', ')}. The build has ${wide.size} such \`+\` type pairs of ${shares.size}. The weights favour these edges, because most of them are \`confirmed\` (weight 1.0 for the grade, 0.5 for \`plausible\`).`, '');
  L.push('| Search | Kept cycles | With a wide edge | Top cycle of each card | Top cycle with a wide edge | Edges | Wide edges |');
  L.push('|---|---|---|---|---|---|---|');
  const sel = rows.filter((x) => x.limits === selected);
  const wc = { engine: wideCount(index, wide, shares, sel, 'engine'), full: wideCount(index, wide, shares, sel, 'full') };
  for (const w of ['engine', 'full'] as const) {
    const c = wc[w];
    L.push(`| ${w}${w === 'full' ? ' (full-only list)' : ''} | ${c.cycles} | ${c.wide} (${pct(c.wide, c.cycles)}) | ${c.top1} | ${c.top1_wide} (${pct(c.top1_wide, c.top1)}) | ${c.edges} | ${c.tp_wide_edges} (${pct(c.tp_wide_edges, c.edges)}) |`);
  }
  L.push('');
  L.push('The 15 type pairs that occur most often on the edges of the kept cycles (engine and full-only lists together):', '');
  L.push('| Type pair | Edges | Wide | Share of card pairs |', '|---|---|---|---|');
  const all = new Map<string, number>();
  for (const c of [wc.engine, wc.full]) for (const [t, n] of c.tp) all.set(t, (all.get(t) ?? 0) + n);
  for (const [t, n] of [...all].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15)) {
    L.push(`| \`+ ${t}\` | ${n} | ${wide.has(t) ? 'yes' : 'no'} | ${(PER_CENT * (shares.get(t) ?? 0)).toFixed(2)}% |`);
  }
  L.push('');
  return L.join('\n');
}
