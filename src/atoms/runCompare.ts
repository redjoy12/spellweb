/**
 * Compares a new reading of some cards with the atoms that it replaced (plan schema v17 Task 4,
 * docs/schema-v17-results.md). Read only.
 *
 * Two atoms match when they are on the same face, have the same type and their spans overlap.
 * Each atom matches once, the largest overlap first. Param agreement looks only at the params that
 * the earlier atom has, so a param that is new in this schema does not count for or against it.
 * An earlier atom of a removed type is kept when any new atom of the type that keeps its fact
 * overlaps it. The earlier atom on that text and the removed atom can share one new atom.
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadGoldenSet, matchAtoms } from './golden.js';

export interface CompareAtom {
  oracle_id: string; name: string; face_index: number; family: string; type_key: string;
  span_start: number; span_end: number; quote: string; params: Record<string, unknown>;
}
export interface ParamCount { type: string; param: string; agree: number; total: number }
export interface LostAtom { name: string; face_index: number; type: string; quote: string; types_on_span: string[] }
export interface RunCompare {
  cards: number; before: number; after: number; matched: number; moved: number;
  params: { agree: number; total: number; by: ParamCount[] };
  /** Matched atoms where every param of the earlier atom agrees. */
  atoms_all_agree: number;
  lost: LostAtom[];
  added: Array<{ name: string; face_index: number; type: string; quote: string }>;
}

const typeOf = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;
const overlap = (a: CompareAtom, b: CompareAtom) => Math.min(a.span_end, b.span_end) - Math.max(a.span_start, b.span_start);
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x);

export function compareAtoms(before: readonly CompareAtom[], after: readonly CompareAtom[], removed: ReadonlyMap<string, string>): RunCompare {
  const byCard = <T extends CompareAtom>(l: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const a of l) (m.get(a.oracle_id) ?? m.set(a.oracle_id, []).get(a.oracle_id)!).push(a);
    return m;
  };
  const oldBy = byCard(before);
  const newBy = byCard(after);
  const res: RunCompare = {
    cards: new Set([...oldBy.keys(), ...newBy.keys()]).size, before: before.length, after: after.length, matched: 0, moved: 0,
    params: { agree: 0, total: 0, by: [] }, atoms_all_agree: 0, lost: [], added: [],
  };
  const counts = new Map<string, ParamCount>();

  for (const id of new Set([...oldBy.keys(), ...newBy.keys()])) {
    const olds = oldBy.get(id) ?? [];
    const news = newBy.get(id) ?? [];
    const pairs = olds.flatMap((o, i) => news.flatMap((n, j) =>
      o.face_index === n.face_index && typeOf(o) === typeOf(n) && overlap(o, n) > 0 ? [{ i, j, size: overlap(o, n) }] : []));
    pairs.sort((a, b) => b.size - a.size || a.i - b.i || a.j - b.j);
    const usedOld = new Set<number>();
    const usedNew = new Set<number>();
    for (const p of pairs) {
      if (usedOld.has(p.i) || usedNew.has(p.j)) continue;
      usedOld.add(p.i);
      usedNew.add(p.j);
      res.matched++;
      const o = olds[p.i]!;
      const n = news[p.j]!;
      let all = true;
      for (const [param, want] of Object.entries(o.params)) {
        const key = `${typeOf(o)}|${param}`;
        const c = counts.get(key) ?? { type: typeOf(o), param, agree: 0, total: 0 };
        c.total++;
        res.params.total++;
        if (canon(want) === canon(n.params[param])) { c.agree++; res.params.agree++; } else all = false;
        counts.set(key, c);
      }
      if (all) res.atoms_all_agree++;
    }
    olds.forEach((o, i) => {
      if (usedOld.has(i)) return;
      const keeper = removed.get(typeOf(o));
      if (keeper && news.some((n) => n.face_index === o.face_index && typeOf(n) === keeper && overlap(o, n) > 0)) { res.moved++; return; }
      res.lost.push({
        name: o.name, face_index: o.face_index, type: typeOf(o), quote: o.quote,
        types_on_span: [...new Set(news.filter((n) => n.face_index === o.face_index && overlap(o, n) > 0).map(typeOf))].sort(),
      });
    });
    news.forEach((n, j) => {
      if (!usedNew.has(j)) res.added.push({ name: n.name, face_index: n.face_index, type: typeOf(n), quote: n.quote });
    });
  }
  res.params.by = [...counts.values()].sort((a, b) => a.type.localeCompare(b.type) || a.param.localeCompare(b.param));
  return res;
}

export interface GoldenCompare {
  cards: number; atoms: number; matched: number;
  /** Golden atoms with no run atom, and run atoms with no golden atom (complete golden cards only). */
  misses: Array<{ name: string; type: string; quote: string; run_types_on_span: string[] }>;
  extras: Array<{ name: string; type: string; quote: string }>;
  params: { agree: number; total: number };
  /** Each golden atom of the focus types: whether a run atom matches it and every golden param agrees. */
  focus: Array<{ name: string; type: string; quote: string; matched: boolean; agree: boolean; diffs: string[] }>;
  diffs: Array<{ name: string; type: string; quote: string; diff: string }>;
}

/**
 * The golden cards of a run against its atoms, with the golden matcher face by face. The packet
 * check does this for a golden run only. Params count on golden atoms at v15 or later, as there.
 */
export function compareGolden(db: DatabaseSync, runId: number, focusTypes: ReadonlySet<string>): GoldenCompare {
  type Run = { face_index: number; family: string; type_key: string; span_start: number; span_end: number; quote: string; params_json: string };
  const nameOf = db.prepare('SELECT name FROM cards WHERE oracle_id = ?');
  const atomsOf = db.prepare('SELECT face_index, family, type_key, span_start, span_end, quote, params_json FROM atoms WHERE run_id = ? AND oracle_id = ? AND consensus = 1 ORDER BY face_index, span_start');
  const res: GoldenCompare = { cards: 0, atoms: 0, matched: 0, misses: [], extras: [], params: { agree: 0, total: 0 }, focus: [], diffs: [] };
  for (const gc of loadGoldenSet(db)) {
    const run = atomsOf.all(runId, gc.oracle_id) as unknown as Run[];
    if (run.length === 0) continue;
    const name = (nameOf.get(gc.oracle_id) as { name: string }).name;
    res.cards++;
    res.atoms += gc.atoms.length;
    const matchedRun = new Set<number>();
    const runOf = new Map<number, number>();
    for (const face of new Set([...run, ...gc.atoms].map((a) => a.face_index))) {
      const rs = run.flatMap((a, i) => (a.face_index === face ? [{ a, i }] : []));
      const gs = gc.atoms.flatMap((a, j) => (a.face_index === face ? [{ a, j }] : []));
      for (const [i, j] of matchAtoms(rs.map((x) => x.a), gs.map((x) => x.a)).pairs) {
        matchedRun.add(rs[i]!.i);
        runOf.set(gs[j]!.j, rs[i]!.i);
      }
    }
    res.matched += runOf.size;
    gc.atoms.forEach((g, j) => {
      const type = typeOf(g);
      const i = runOf.get(j);
      const got = i === undefined ? null : JSON.parse(run[i]!.params_json) as Record<string, unknown>;
      const diffs: string[] = [];
      if (got && g.schema_version >= 15) {
        for (const [param, want] of Object.entries(g.params)) {
          res.params.total++;
          if (canon(want) === canon(got[param])) res.params.agree++;
          else diffs.push(`${param}: golden ${canon(want)}, run ${canon(got[param])}`);
        }
      }
      if (!got) {
        res.misses.push({ name, type, quote: g.quote, run_types_on_span: [...new Set(run
          .filter((r) => r.face_index === g.face_index && Math.min(r.span_end, g.span_end) > Math.max(r.span_start, g.span_start)).map(typeOf))].sort() });
      }
      for (const diff of diffs) res.diffs.push({ name, type, quote: g.quote, diff });
      if (focusTypes.has(type)) res.focus.push({ name, type, quote: g.quote, matched: !!got, agree: !!got && diffs.length === 0, diffs });
    });
    if (gc.complete) run.forEach((r, i) => { if (!matchedRun.has(i)) res.extras.push({ name, type: typeOf(r), quote: r.quote }); });
  }
  return res;
}

/** The compare as a Markdown block: disagreements by param, then each lost atom. */
export function renderCompare(c: RunCompare): string {
  const pct = (a: number, b: number) => (b === 0 ? 'n/a' : (a / b).toLocaleString('en', { style: 'percent', minimumFractionDigits: 1 }));
  const countBy = (l: ReadonlyArray<{ type: string }>) => {
    const m = new Map<string, number>();
    for (const x of l) m.set(x.type, (m.get(x.type) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    '| Measure | Result |', '|---|---|',
    `| Cards | ${c.cards} |`,
    `| Atoms before, after | ${c.before}, ${c.after} |`,
    `| Atoms that match | ${c.matched} |`,
    `| Atoms of a removed type that a new atom keeps | ${c.moved} |`,
    `| Atoms lost, atoms added | ${c.lost.length}, ${c.added.length} |`,
    `| Params that agree on matched atoms | ${pct(c.params.agree, c.params.total)} (${c.params.agree} of ${c.params.total}) |`,
    `| Matched atoms where all params agree | ${pct(c.atoms_all_agree, c.matched)} (${c.atoms_all_agree} of ${c.matched}) |`,
    '',
    '**Params that do not always agree.**', '',
    '| Type | Param | Agree | Total |', '|---|---|---|---|',
    ...c.params.by.filter((p) => p.agree < p.total).sort((a, b) => (b.total - b.agree) - (a.total - a.agree))
      .map((p) => `| \`${p.type}\` | \`${p.param}\` | ${p.agree} | ${p.total} |`),
    '',
    '**Lost atoms by type.**', '',
    '| Type | Lost |', '|---|---|',
    ...countBy(c.lost).map(([t, n]) => `| \`${t}\` | ${n} |`),
    '',
    '**Added atoms by type.**', '',
    '| Type | Added |', '|---|---|',
    ...countBy(c.added).map(([t, n]) => `| \`${t}\` | ${n} |`),
    '',
    '**Each lost atom.** The last column gives the types of the new atoms on the same text.', '',
    '| Card | Face | Lost type | Quote | New types on the text |', '|---|---|---|---|---|',
    ...[...c.lost].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      .map((l) => `| ${cell(l.name)} | ${l.face_index} | \`${l.type}\` | ${cell(l.quote.slice(0, 90))} | ${l.types_on_span.map((t) => `\`${t}\``).join(', ') || 'none'} |`),
  ].join('\n') + '\n';
}
