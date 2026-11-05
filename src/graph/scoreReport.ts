/**
 * The score report of a graph build (Phase 3 plan Task 5 Step 4): the full score, the
 * deriver-only score, the trace bars, the miss classes and the top gap rows, each measure with
 * its bar of spec rev. 10 sec. 12.2. The text is ASD-STE100 (CLAUDE.md writing rule).
 */
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex } from './buildIndex.js';
import { deriverOnlyScore, type DeriverScore } from './deriverScore.js';
import { edgeTrace, fullScore, quoteTrace, type FullScore, type Tally } from './score.js';
import { setRules } from './ruleSet.js';

export interface ScoreData {
  build: { id: number; scope: string; rule_set_id: number; rule_set_version: number; built_at: string };
  full: FullScore;
  deriver: DeriverScore;
  quotes: ReturnType<typeof quoteTrace>;
  edges: { explicit: Tally; class: Tally };
  gaps: Array<{ gap_kind: string; type_key: string; param: string; count: number }>;
  golden: Array<{ status: string; label: string | null; stratum: string; n: number }>;
}

export function scoreData(db: DatabaseSync, buildId: number): ScoreData {
  const b = db.prepare(
    `SELECT g.id, g.scope, g.rule_set_id, s.version, g.built_at FROM graph_builds g JOIN edge_rule_sets s ON s.id = g.rule_set_id WHERE g.id = ?`,
  ).get(buildId) as { id: number; scope: string; rule_set_id: number; version: number; built_at: string } | undefined;
  if (!b) throw new Error(`no graph build ${buildId}`);
  const index = BuildIndex.load(db, buildId);
  return {
    build: { id: b.id, scope: b.scope, rule_set_id: b.rule_set_id, rule_set_version: b.version, built_at: b.built_at },
    full: fullScore(db, buildId, index),
    deriver: deriverOnlyScore(db, b.rule_set_id),
    quotes: quoteTrace(db, b.rule_set_id),
    edges: edgeTrace(index, setRules(db, b.rule_set_id, 'accepted')),
    gaps: db.prepare('SELECT gap_kind, type_key, param, count FROM graph_gaps WHERE build_id = ? ORDER BY count DESC, gap_kind, type_key, param LIMIT 10')
      .all(buildId) as ScoreData['gaps'],
    golden: db.prepare('SELECT status, label, stratum, COUNT(*) n FROM edge_golden_pairs GROUP BY status, label, stratum ORDER BY status, label, stratum')
      .all() as ScoreData['golden'],
  };
}

const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (x: number | null) => (x === null ? 'n/a' : PERCENT.format(x));
const frac = (n: number, d: number) => `${n} of ${d}`;
const verdict = (x: number | null, bar: number) => (x === null ? 'not measured (no pairs)' : x >= bar ? 'met' : 'not met');
const tallyPct = (t: Tally) => (t.total === 0 ? null : t.ok / t.total);

export function renderScoreReport(d: ScoreData, date: string): string {
  const c = d.full.counts;
  const q = d.quotes;
  const quoteAll: Tally = { ok: q.rules.ok + q.roles.ok + q.golden.ok, total: q.rules.total + q.roles.total + q.golden.total };
  const out: string[] = [];
  const row = (...cells: Array<string | number>) => out.push(`| ${cells.join(' | ')} |`);

  out.push(`# Phase 3 — Score of build ${d.build.id}`, '');
  out.push(`**Date:** ${date}`);
  out.push('**Language:** ASD-STE100 (Simplified Technical English).');
  out.push('**Plan:** `docs/superpowers/plans/2026-10-10-phase-3-synergy-graph.md`, Task 5 Step 4.');
  out.push('**Spec:** `docs/superpowers/specs/2026-10-10-phase-3-synergy-graph-design.md` rev. 10, §11.2 and §12.2.');
  out.push(`**Build:** ${d.build.id}, scope ${d.build.scope}, edge-rule set ${d.build.rule_set_id} (v${d.build.rule_set_version}), built ${d.build.built_at}.`);
  out.push(`**Command:** \`npm run graph -- --score --build ${d.build.id} --report docs/phase-3-score-build-${d.build.id}.md\``, '');

  out.push('## 1. Golden set', '');
  out.push(`The score uses ${c['scored']} pairs with status \`accepted\`, \`owner_accepted\` or \`owner_corrected\`: `
    + `${c['synergy']} \`synergy\`, ${c['anti']} \`anti\` and ${c['none']} \`none\`. ${c['characteristic']} synergy or anti pairs have a characteristic supply.`, '');
  row('Status', 'Label', 'Stratum', 'Pairs');
  row('---', '---', '---', '---');
  for (const g of d.golden) row(g.status, g.label ?? '-', g.stratum, g.n);
  out.push('');

  out.push('## 2. Full score (spec §12.2)', '');
  row('Measure', 'Value', 'Provisional bar', 'Result');
  row('---', '---', '---', '---');
  row('Recall of `synergy` pairs, at any grade', `${pct(d.full.synergy_recall)} (${frac(c['synergy_found']!, c['synergy']!)})`, '≥ 90%', verdict(d.full.synergy_recall, 0.9));
  row('Precision of `confirmed` card pairs', `${pct(d.full.confirmed_precision)} (${frac(c['confirmed_correct']!, c['confirmed_items']!)})`, '≥ 90%', verdict(d.full.confirmed_precision, 0.9));
  row('Precision of all card pairs, `plausible` included', `${pct(d.full.all_precision)} (${frac(c['all_correct']!, c['all_items']!)})`, 'Measured and reported', 'reported');
  row('Recall of `anti` pairs', `${pct(d.full.anti_recall)} (${frac(c['anti_found']!, c['anti']!)})`, '≥ 80%', verdict(d.full.anti_recall, 0.8));
  out.push('');
  out.push(`Characteristic pairs: ${frac(c['characteristic_found']!, c['characteristic']!)} found.`, '');

  out.push('### 2.1 Results by stratum', '');
  row('Stratum', 'Pairs', 'Synergy found', 'Confirmed card pairs correct', 'All card pairs correct');
  row('---', '---', '---', '---', '---');
  const strata = [...new Set(d.full.pairs.map((p) => p.stratum))].sort();
  for (const s of strata) {
    const ps = d.full.pairs.filter((p) => p.stratum === s);
    const syn = ps.filter((p) => p.label === 'synergy');
    const agree = (p: (typeof ps)[number], pol: '+' | '-') => (pol === '+' ? p.label === 'synergy' : p.label === 'anti');
    const conf = ps.flatMap((p) => p.confirmed.map((pol) => agree(p, pol)));
    const all = ps.flatMap((p) => p.card_pairs.map((pol) => agree(p, pol)));
    row(s, ps.length, frac(syn.filter((p) => p.found).length, syn.length),
      frac(conf.filter(Boolean).length, conf.length), frac(all.filter(Boolean).length, all.length));
  }
  out.push('');

  out.push('### 2.2 Miss classes', '');
  row('Class', 'Misses');
  row('---', '---');
  row('extraction', c['miss_extraction']!);
  row('rule', c['miss_rule']!);
  row('param', c['miss_param']!);
  out.push('');
  out.push(`Misses with a chain atom that was matched after requeue: ${c['requeue_matched'] ?? 0}. A requeue gives a card new atom IDs. When a chain atom is not in the build, `
    + 'the miss class uses the build atom of the same card, face, family, type_key, params and span. The detail of such a miss names the two atom IDs.', '');
  if (d.full.misses.length) {
    const stratumOf = new Map(d.full.pairs.map((p) => [p.pair_id, p.stratum]));
    row('Pair', 'Stratum', 'Label', 'Class', 'Detail');
    row('---', '---', '---', '---', '---');
    for (const m of d.full.misses) row(m.pair_id, stratumOf.get(m.pair_id) ?? '-', m.label, m.class, m.detail.replace(/\|/g, '\\|'));
    out.push('');
  }

  out.push('### 2.3 Precision misses', '');
  const wrong = d.full.pairs.filter((p) => p.confirmed.some((pol) => (pol === '+' ? p.label !== 'synergy' : p.label !== 'anti')));
  out.push(`${wrong.length} labelled pairs have a \`confirmed\` card pair that the label does not agree with. These pairs give the precision misses.`, '');
  if (wrong.length) {
    row('Pair', 'Stratum', 'Label', 'Confirmed card pairs', 'Type pairs of the confirmed edges');
    row('---', '---', '---', '---', '---');
    for (const p of wrong) row(p.pair_id, p.stratum, p.label, p.confirmed.join(' '), p.confirmed_types.join('; '));
    out.push('');
    const byType = new Map<string, number>();
    for (const p of wrong) for (const t of p.confirmed_types) byType.set(t, (byType.get(t) ?? 0) + 1);
    out.push('The type pairs that occur in these pairs, with the number of pairs:', '');
    row('Type pair', 'Pairs');
    row('---', '---');
    for (const [t, n] of [...byType].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))) row(t, n);
    out.push('');
  }

  const ds = d.deriver;
  out.push('## 3. Deriver-only score (spec §12.2)', '');
  row('Measure', 'Value', 'Provisional bar', 'Result');
  row('---', '---', '---', '---');
  row('Recall of golden type pairs (`synergy` and `anti`)', `${pct(ds.recall)} (${frac(ds.found, ds.total)})`, '≥ 90%', verdict(ds.total ? ds.recall : null, 0.9));
  row('Recall on the pairs that Stage B can reach', `${pct(ds.reachable.total ? ds.reachable.recall : null)} (${frac(ds.reachable.found, ds.reachable.total)})`, 'Reported (owner decision 2026-10-11)', 'reported');
  row('`none` pairs with a rule that connects their types', `${pct(ds.none_total ? ds.none_with_rule / ds.none_total : null)} (${frac(ds.none_with_rule, ds.none_total)})`, 'Measured and reported', 'reported');
  out.push('');
  out.push(`Pairs with two atoms: ${frac(ds.by_kind.atoms.found, ds.by_kind.atoms.total)}. Pairs with a characteristic supply: `
    + `${frac(ds.by_kind.characteristic.found, ds.by_kind.characteristic.total)}. Left out (an atom is null): ${ds.excluded}. Pairs that Stage A blocks: ${ds.reachable.blocked.length}.`, '');
  if (ds.misses.length) {
    const blocked = new Map(ds.reachable.blocked.map((b) => [b.pair_id, b.reason]));
    row('Pair', 'Supply type', 'Demand type', 'Stage A block');
    row('---', '---', '---', '---');
    for (const m of ds.misses) row(m.pair_id, m.supply_type, m.demand_type, blocked.get(m.pair_id) ?? '-');
    out.push('');
  }

  out.push('## 4. Trace bars (spec §12.2)', '');
  row('Measure', 'Value', 'Bar', 'Result');
  row('---', '---', '---', '---');
  row('Evidence quotes that pass the check (§5.4), all', `${pct(tallyPct(quoteAll))} (${frac(quoteAll.ok, quoteAll.total)})`, pct(1), verdict(tallyPct(quoteAll), 1));
  row('- in accepted rules', `${pct(tallyPct(q.rules))} (${frac(q.rules.ok, q.rules.total)})`, pct(1), verdict(tallyPct(q.rules), 1));
  row('- in accepted roles', `${pct(tallyPct(q.roles))} (${frac(q.roles.ok, q.roles.total)})`, pct(1), verdict(tallyPct(q.roles), 1));
  row('- in golden chains', `${pct(tallyPct(q.golden))} (${frac(q.golden.ok, q.golden.total)})`, pct(1), verdict(tallyPct(q.golden), 1));
  row('Explicit edges with two atoms and rule evidence', `${pct(tallyPct(d.edges.explicit))} (${frac(d.edges.explicit.ok, d.edges.explicit.total)})`, pct(1), verdict(tallyPct(d.edges.explicit), 1));
  row('Class edges with one atom, one class and rule evidence', `${pct(tallyPct(d.edges.class))} (${frac(d.edges.class.ok, d.edges.class.total)})`, pct(1), verdict(tallyPct(d.edges.class), 1));
  out.push('');
  out.push('A rule quote is checked against the references of the Stage B batches of its demand type, and of each demand type that the same rule ID had in a source set. A role quote is checked against the Stage A batches that show the type, or a removed type that moved into it. A role with 0 votes has no Stage A batch, so its quote is checked against the Stage B batches of its type. A golden quote is checked against its label batch.', '');
  if (q.faults.length) {
    out.push(`${q.faults.length} quotes fail. The first 20:`, '');
    for (const f of q.faults.slice(0, 20)) out.push(`- ${f}`);
    out.push('');
  }

  out.push('## 5. Top gap rows (spec §13.3)', '');
  row('Count', 'Gap kind', 'Type', 'Param');
  row('---', '---', '---', '---');
  for (const g of d.gaps) row(g.count, g.gap_kind, g.type_key, g.param || '-');
  out.push('');
  return out.join('\n');
}
