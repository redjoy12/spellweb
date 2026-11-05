/**
 * The effect of one event trigger tag on a build (plan 2026-10-31-schema-v17 Task 18 step 3). It
 * reads two builds in memory and writes nothing.
 *
 * Unit of the tag rows: a directed card pair A -> B with a `+` edge into the tag, explicit or class,
 * as plan section 9.1 counts it. A pair is new when the base build has no `+` link in that direction
 * (docs/schema-v19-results.md sec. 9.6). A pair with two supply types is in two rows, and once in `all`.
 *
 * Unit of the compare: docs/schema-v17-results.md sec. 13.2: explicit edges, in either direction,
 * with no self pair.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from './buildIndex.js';
import { pairKey, pairRecords } from './linkRuleRound2.js';
import { mergeEdges } from './merge.js';
import { buildPairs, type BuildPairs } from './pairCompare.js';

/** The supply type of a class edge: it has no supply atom. */
export const INTRINSIC = 'INTRINSIC';

export interface TagPair { types: Set<string>; rules: Set<string>; confirmed: boolean }

export interface TagPairs { plus: Map<string, TagPair>; minus: Set<string> }

/** The pairs of `tagPairs` for each demand type of the build. */
export function allTagPairs(index: BuildIndex): Map<string, TagPairs> {
  const tags = new Map<string, TagPairs>();
  const typeOf = (id: number) => { const a = index.atoms.get(id)!; return `${a.family}.${a.type_key}`; };
  for (const c of index.cards()) {
    const ae = index.cardAtomEdges(c);
    for (const e of [...mergeEdges(ae.supply, index.ctx), ...mergeEdges(ae.classes, index.ctx)]) {
      const tag = typeOf(e.demand_atom_id);
      const { plus, minus } = tags.get(tag) ?? tags.set(tag, { plus: new Map(), minus: new Set() }).get(tag)!;
      const supplies = e.class_id === null ? [e.supply_oracle!] : [...index.classes.get(e.class_id)!.members];
      const types = e.class_id === null ? e.atom_ids.filter((id) => id !== e.demand_atom_id).map(typeOf) : [INTRINSIC];
      for (const s of supplies) {
        if (s === e.demand_oracle) continue;
        const k = pairKey(s, e.demand_oracle);
        if (e.polarity === '-') { minus.add(k); continue; }
        const p = plus.get(k) ?? plus.set(k, { types: new Set(), rules: new Set(), confirmed: false }).get(k)!;
        for (const t of types) p.types.add(t);
        for (const r of e.rule_hashes) p.rules.add(r);
        p.confirmed ||= e.grade === 'confirmed';
      }
    }
  }
  return tags;
}

/** The `+` pairs of a tag, and the `-` pairs of the tag, with the keys of `pairKey`. A self pair is not a pair. */
export function tagPairs(index: BuildIndex, tag: string): TagPairs {
  return allTagPairs(index).get(tag) ?? { plus: new Map(), minus: new Set() };
}

/** The unordered pairs of `supply|demand` keys, with no self pair. */
function unordered(keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const [a, b] = k.split('|') as [string, string];
    if (a !== b) out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return out;
}

export interface SetChange { before: number; after: number; added: number; lost: number }

function change(a: ReadonlySet<string>, b: ReadonlySet<string>): SetChange {
  return { before: a.size, after: b.size, added: [...b].filter((k) => !a.has(k)).length, lost: [...a].filter((k) => !b.has(k)).length };
}

/** The three rows of docs/schema-v17-results.md sec. 13.2. */
export function compareBuilds(a: BuildPairs, b: BuildPairs): { link: SetChange; confirmed: SetChange; bad: SetChange } {
  const confirmed = (p: BuildPairs) => unordered([...p.plus].filter(([, v]) => v.grade === 'confirmed').map(([k]) => k));
  return {
    link: change(unordered(a.plus.keys()), unordered(b.plus.keys())),
    confirmed: change(confirmed(a), confirmed(b)),
    bad: change(unordered(a.minus.keys()), unordered(b.minus.keys())),
  };
}

export interface TagRow { supply: string; rules: string[]; pairs: number; confirmed: number; new_pairs: number }
export interface TagMeasure {
  tag: string; base: number; build: number; demand_cards: number; rows: TagRow[];
  all: { pairs: number; confirmed: number; new_pairs: number; minus_pairs: number };
  compare: ReturnType<typeof compareBuilds>;
}

/** The rule ids of a build, by rule hash. */
function ruleIds(db: DatabaseSync, buildId: number): Map<string, string> {
  return new Map((db.prepare(
    'SELECT r.rule_hash, r.rule_id FROM edge_rules r JOIN graph_builds b ON b.rule_set_id = r.set_id WHERE b.id = ?',
  ).all(buildId) as Array<{ rule_hash: string; rule_id: string }>).map((r) => [r.rule_hash, r.rule_id]));
}

export function measureTag(db: DatabaseSync, base: BuildIndex, after: BuildIndex, tag: string, ids: { base: number; build: number }): TagMeasure {
  const { plus, minus } = tagPairs(after, tag);
  const linked = pairRecords(base);
  const names = ruleIds(db, ids.build);
  const fresh = (k: string) => !linked.has(k);
  const rows = [...new Set([...plus.values()].flatMap((p) => [...p.types]))].sort().map((supply) => {
    const mine = [...plus].filter(([, p]) => p.types.has(supply));
    return {
      supply,
      rules: [...new Set(mine.flatMap(([, p]) => [...p.rules]))].map((h) => names.get(h) ?? h).sort(),
      pairs: mine.length, confirmed: mine.filter(([, p]) => p.confirmed).length, new_pairs: mine.filter(([k]) => fresh(k)).length,
    };
  });
  return {
    tag, base: ids.base, build: ids.build,
    demand_cards: new Set([...plus.keys()].map((k) => k.split('>')[1])).size, rows,
    all: { pairs: plus.size, confirmed: [...plus.values()].filter((p) => p.confirmed).length, new_pairs: [...plus.keys()].filter(fresh).length, minus_pairs: minus.size },
    compare: compareBuilds(buildPairs(base), buildPairs(after)),
  };
}

/** The supply type of each rule of a build, by rule hash. An intrinsic rule has none. */
function ruleSupply(db: DatabaseSync, buildId: number): Map<string, string> {
  return new Map((db.prepare(
    `SELECT r.rule_hash, json_extract(r.supply_json, '$.family') || '.' || json_extract(r.supply_json, '$.type_key') supply
       FROM edge_rules r JOIN graph_builds b ON b.rule_set_id = r.set_id WHERE b.id = ?`,
  ).all(buildId) as Array<{ rule_hash: string; supply: string | null }>).flatMap((r) => (r.supply ? [[r.rule_hash, r.supply] as const] : [])));
}

/**
 * One row of `explainBuilds`, with the unit of the tag rows. `link_new`: no `+` link in that direction
 * in the base build. `reach_new`: the base build has no such row for the pair. `lost`: the row of a
 * base pair that has no `+` link in that direction now. A pair with two rows counts in each.
 */
export interface ChangeRow { key: string; pairs: number; reach_new: number; link_new: number; lost: number }

/** All `+` pairs of a build, by the keys that `keysOf` gives each pair. */
function rowPairs(tags: ReadonlyMap<string, TagPairs>, keysOf: (tag: string, pair: TagPair, pairKey: string) => string[]): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  for (const [tag, { plus }] of tags) {
    for (const [k, p] of plus) {
      for (const key of keysOf(tag, p, k)) (rows.get(key) ?? rows.set(key, new Set()).get(key)!).add(k);
    }
  }
  return rows;
}

function changeRows(a: ReadonlyMap<string, Set<string>>, b: ReadonlyMap<string, Set<string>>, linkedA: ReadonlySet<string>, linkedB: ReadonlySet<string>): ChangeRow[] {
  return [...new Set([...a.keys(), ...b.keys()])].map((key) => {
    const was = a.get(key) ?? new Set<string>();
    const now = b.get(key) ?? new Set<string>();
    return {
      key, pairs: now.size, reach_new: [...now].filter((k) => !was.has(k)).length, link_new: [...now].filter((k) => !linkedA.has(k)).length,
      lost: [...was].filter((k) => !linkedB.has(k)).length,
    };
  }).sort((x, y) => (y.link_new + y.lost) - (x.link_new + x.lost) || y.reach_new - x.reach_new || x.key.localeCompare(y.key));
}

/**
 * Explains two builds of plan 2026-11-01-schema-v20 Task 7: each supply type into each demand type,
 * and each rule, by rule id. `only` limits the rule rows to rows of one supply type, and `demandCard`
 * limits them to pairs into one card. It reads the two builds in memory and writes nothing.
 */
export function explainBuilds(
  db: DatabaseSync, base: BuildIndex, after: BuildIndex, ids: { base: number; build: number }, opts: { only?: string; demandCard?: string } = {},
): { compare: ReturnType<typeof compareBuilds>; links: ChangeRow[]; rules: ChangeRow[]; minus: ChangeRow[] } {
  const a = allTagPairs(base);
  const b = allTagPairs(after);
  const minusOf = (t: ReadonlyMap<string, TagPairs>) => new Map([...t].map(([tag, p]) => [tag, p.minus]));
  const minusAll = (t: ReadonlyMap<string, TagPairs>) => new Set([...t.values()].flatMap((x) => [...x.minus]));
  const linked = (t: ReadonlyMap<string, TagPairs>) => new Set([...t.values()].flatMap((x) => [...x.plus.keys()]));
  const [linkedA, linkedB] = [linked(a), linked(b)];
  const linkKeys = (tag: string, p: TagPair) => [...p.types].map((t) => `${t} -> ${tag}`);
  const namesOf = new Map([...ruleIds(db, ids.base), ...ruleIds(db, ids.build)]);
  // A merged edge lists the rules of all its atoms, so `only` reads the supply side of the rule, not the types of the pair.
  const supplyOf = new Map([...ruleSupply(db, ids.base), ...ruleSupply(db, ids.build)]);
  const ruleKeys = (tag: string, p: TagPair, k: string) => (
    opts.demandCard && k.split('>')[1] !== opts.demandCard ? []
      : [...p.rules].filter((r) => !opts.only || supplyOf.get(r) === opts.only).map((r) => `${namesOf.get(r) ?? r} -> ${tag}`)
  );
  return {
    compare: compareBuilds(buildPairs(base), buildPairs(after)),
    links: changeRows(rowPairs(a, linkKeys), rowPairs(b, linkKeys), linkedA, linkedB),
    rules: changeRows(rowPairs(a, ruleKeys), rowPairs(b, ruleKeys), linkedA, linkedB),
    minus: changeRows(minusOf(a), minusOf(b), minusAll(a), minusAll(b)),
  };
}
