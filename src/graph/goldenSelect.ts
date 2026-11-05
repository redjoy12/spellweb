/**
 * The mechanical selection of the edge golden set (spec rev. 6 sec. 11.2, plan Task 2).
 *
 * Every stratum reads atoms, schema data or CR text only. The session that runs this code never
 * selects, labels or changes a pair (spec sec. 11.1): the CLI selects, isolated labelers label.
 *
 * In this file "card A" is the supply side of a pair and "card B" the demand side.
 */
import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion } from '../atoms/schema.js';
import { loadPacketPolicy, matchTerms, type PacketPolicy } from '../rules/relevance.js';
import { draw } from '../util/draw.js';
import { scopeCards, type Scope } from './intrinsic.js';
import type { GraphPolicy } from './policy.js';
import { crSubtypeLists } from './subtypes.js';

export type Stratum = 'demand_type' | 'shared_term' | 'interaction' | 'param_gap'
                    | 'unrecorded_restriction' | 'random' | 'top_weight' | 'correction';
export interface PairCandidate {
  supply_oracle: string;
  demand_oracle: string;
  stratum: Stratum;
  /** What the stratum selected on: a type id, a term key or a subtype. Not stored. */
  basis?: string;
}

/** The strata that `sampleRound` draws from, in the order of its rotation. */
export const SAMPLED_STRATA = [
  'demand_type', 'shared_term', 'interaction', 'param_gap', 'unrecorded_restriction', 'random',
] as const satisfies readonly Stratum[];
/** The pair statuses that the score and the targets count (spec sec. 12.2). */
export const LABELLED_STATUSES = ['accepted', 'owner_accepted', 'owner_corrected'] as const;

/** spec sec. 11.2: "each other type with 20 or more slice atoms". */
export const DEMAND_TYPE_MIN_ATOMS = 20;

export interface SliceAtom {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string;
  params: Record<string, unknown>; quote: string;
}

/** The slice cards that have current atoms, and the facts the strata read. */
export interface SliceData {
  /** The scope cards with current atoms: the strata that read atoms draw from these. */
  cards: string[];
  /** All cards of the scope, with or without atoms: `random` and the share base of `shared_term`. */
  scope: string[];
  atoms: Map<string, SliceAtom[]>;
  /** FAMILY.TYPE_KEY -> the cards with an atom of that type. */
  byType: Map<string, string[]>;
  typeAtoms: Map<string, number>;
  caresAboutTypes: string[];
  /** spec sec. 11.2 `param_gap`: the types with no params in the current schema. */
  noParamTypes: Set<string>;
}

const typeId = (a: { family: string; type_key: string }) => `${a.family}.${a.type_key}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function loadSlice(db: DatabaseSync, scope: Scope = 'BR'): SliceData {
  const scoped = scopeCards(db, scope);
  const inScope = new Set(scoped);
  const rows = (db.prepare(
    `SELECT id, oracle_id, face_index, family, type_key, params_json, quote
       FROM atoms WHERE is_current = 1 ORDER BY oracle_id, id`,
  ).all() as Array<Omit<SliceAtom, 'params'> & { params_json: string }>).filter((r) => inScope.has(r.oracle_id));

  const atoms = new Map<string, SliceAtom[]>();
  const byType = new Map<string, Set<string>>();
  const typeAtoms = new Map<string, number>();
  for (const { params_json, ...r } of rows) {
    const a: SliceAtom = { ...r, params: JSON.parse(params_json) as Record<string, unknown> };
    atoms.set(a.oracle_id, [...(atoms.get(a.oracle_id) ?? []), a]);
    const t = typeId(a);
    byType.set(t, (byType.get(t) ?? new Set()).add(a.oracle_id));
    typeAtoms.set(t, (typeAtoms.get(t) ?? 0) + 1);
  }

  const schema = currentSchemaVersion(db);
  const types = db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ? ORDER BY family, type_key')
    .all(schema) as Array<{ family: string; type_key: string; params_schema: string }>;
  const noParams = (s: string) => Object.keys((JSON.parse(s) as { properties?: object }).properties ?? {}).length === 0;
  return {
    cards: [...atoms.keys()].sort(),
    scope: [...scoped].sort(),
    atoms,
    byType: new Map([...byType].map(([t, s]) => [t, [...s].sort()])),
    typeAtoms,
    caresAboutTypes: types.filter((t) => t.family === 'CARES_ABOUT').map(typeId),
    noParamTypes: new Set(types.filter((t) => noParams(t.params_schema)).map(typeId)),
  };
}

/** The item of `list` with the smallest draw for (seed, salt). Null for an empty list. */
function pick<T extends string>(list: readonly T[], seed: number, salt: string, not?: string): T | null {
  let best: T | null = null;
  let bestDraw = 2;
  for (const x of list) {
    if (x === not) continue;
    const d = draw(seed, `${salt}:${x}`);
    if (d < bestDraw) { best = x; bestDraw = d; }
  }
  return best;
}

const byDraw = <T extends string>(list: readonly T[], seed: number, salt: string): T[] =>
  [...list].sort((a, b) => draw(seed, `${salt}:${a}`) - draw(seed, `${salt}:${b}`));

const cardsWhere = (d: SliceData, test: (a: SliceAtom) => boolean): string[] =>
  d.cards.filter((c) => d.atoms.get(c)!.some(test));

/** The most attempts a stratum makes. Each attempt draws new cards for each of its keys. */
const MAX_ATTEMPTS = 40;

/**
 * A stratum as an ordered list of attempts: each attempt gives one pair for each key of the
 * stratum (a type, a term, a subtype), in a new draw. The first attempt gives one pair for each key.
 */
function* attempts(
  stratum: Stratum, seed: number, keys: string[],
  pair: (key: string, salt: string, turn: number) => { a: string | null; b: string | null },
): Generator<PairCandidate> {
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      // `turn` counts the keys that the stratum has offered: n * keys + i.
      const { a, b } = pair(key, `${stratum}:${n}:${key}`, n * keys.length + i);
      if (a && b && a !== b) yield { supply_oracle: a, demand_oracle: b, stratum, basis: key };
    }
  }
}

/** Cards with one or more PRODUCES or ENABLES atoms: card A of `demand_type`. */
function producers(d: SliceData): string[] {
  return cardsWhere(d, (a) => a.family === 'PRODUCES' || a.family === 'ENABLES');
}

/** The fixed seed of the `demand_type` key order. The order is the same in all rounds. */
const KEY_ORDER_SEED = 0;

/**
 * spec sec. 11.2 `demand_type`: one pair for each CARES_ABOUT type of the schema that has slice
 * atoms, and for each other type with `DEMAND_TYPE_MIN_ATOMS` or more slice atoms. Card B has an
 * atom of the type; card A has a PRODUCES or ENABLES atom.
 *
 * Owner decision 2026-10-11 (review finding M3): one fixed key order for all rounds, the
 * CARES_ABOUT types first, then the other types, each in draw order. Each round continues the
 * order where the earlier rounds stopped (`offset`). The cap does not hold all keys at the share
 * of one round, so the keys late in the order can stay without a pair.
 */
export function demandTypeKeys(d: SliceData): string[] {
  const ca = byDraw(d.caresAboutTypes.filter((t) => d.byType.has(t)), KEY_ORDER_SEED, 'ca');
  const caSet = new Set(d.caresAboutTypes);
  const other = byDraw([...d.typeAtoms].filter(([t, n]) => !caSet.has(t) && n >= DEMAND_TYPE_MIN_ATOMS).map(([t]) => t), KEY_ORDER_SEED, 'other');
  return [...ca, ...other];
}

function demandType(d: SliceData, seed: number, offset: number): Generator<PairCandidate> {
  const supply = producers(d);
  const keys = demandTypeKeys(d);
  const start = keys.length ? offset % keys.length : 0;
  return attempts('demand_type', seed, [...keys.slice(start), ...keys.slice(0, start)], (type, salt) => {
    const b = pick(d.byType.get(type)!, seed, `${salt}:B`);
    return { b, a: pick(supply, seed, `${salt}:A`, b ?? undefined) };
  });
}

/**
 * The rule_term_index terms (term keys) that the Phase 2 term matcher finds in the atom quotes of
 * each card. Read one time for each distinct quote.
 */
export function cardTerms(db: DatabaseSync, d: SliceData, corpusId: number, termPolicy: PacketPolicy): Map<string, Set<string>> {
  const byQuote = new Map<string, string[]>();
  const out = new Map<string, Set<string>>();
  for (const c of d.cards) {
    const terms = new Set<string>();
    for (const a of d.atoms.get(c)!) {
      if (a.quote === '') continue;
      let hit = byQuote.get(a.quote);
      if (!hit) {
        hit = [...new Set(matchTerms(db, corpusId, a.quote, termPolicy).map((m) => m.term_key))];
        byQuote.set(a.quote, hit);
      }
      for (const t of hit) terms.add(t);
    }
    out.set(c, terms);
  }
  return out;
}

/**
 * spec sec. 11.2 `shared_term`: the terms that two or more cards have and that not more than
 * `shared_term_max_share` of the slice cards have. Term key -> its cards.
 */
export function sharedTerms(d: SliceData, terms: Map<string, Set<string>>, maxShare: number): Map<string, string[]> {
  const cards = new Map<string, string[]>();
  for (const c of d.cards) for (const t of terms.get(c) ?? []) cards.set(t, [...(cards.get(t) ?? []), c]);
  const limit = maxShare * d.scope.length;
  return new Map([...cards].filter(([, cs]) => cs.length >= 2 && cs.length <= limit).sort(([a], [b]) => a.localeCompare(b)));
}

function sharedTerm(shared: Map<string, string[]>, seed: number): Generator<PairCandidate> {
  return attempts('shared_term', seed, byDraw([...shared.keys()], seed, 'terms'), (term, salt) => {
    const cs = shared.get(term)!;
    const a = pick(cs, seed, `${salt}:A`);
    return { a, b: pick(cs, seed, `${salt}:B`, a ?? undefined) };
  });
}

/** A stratum with one key: each attempt draws a card A and a card B from two lists. */
function twoLists(stratum: Stratum, seed: number, as: string[], bs: string[]): Generator<PairCandidate> {
  return attempts(stratum, seed, [stratum], (_k, salt) => {
    const b = pick(bs, seed, `${salt}:B`);
    return { b, a: pick(as, seed, `${salt}:A`, b ?? undefined) };
  });
}

/** spec sec. 11.2 `interaction`: card A has an INTERACTION atom, card B a CARES_ABOUT atom. */
function interaction(d: SliceData, seed: number): Generator<PairCandidate> {
  return twoLists('interaction', seed, cardsWhere(d, (a) => a.family === 'INTERACTION'), cardsWhere(d, (a) => a.family === 'CARES_ABOUT'));
}

/**
 * spec sec. 11.2 `param_gap`: card B has a demand atom with params; card A has an atom of a type
 * with no params in the schema.
 *
 * Plan D11: before Task 3 there are no Stage A roles, so the "demand atom" here is a CARES_ABOUT
 * atom. Spec sec. 4.4 also counts the types with the role `demand` or `both`; the selection
 * cannot see them until Stage A has run. This is a deliberate change, and the owner knows it.
 */
function paramGap(d: SliceData, seed: number): Generator<PairCandidate> {
  return twoLists('param_gap', seed,
    cardsWhere(d, (a) => d.noParamTypes.has(typeId(a))),
    cardsWhere(d, (a) => a.family === 'CARES_ABOUT' && Object.keys(a.params).length > 0));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * spec sec. 11.2 `unrecorded_restriction`: subtype -> the cards B with a CARES_ABOUT quote that
 * contains the subtype as whole words (the subtype parser of spec sec. 11.2 gives the list).
 */
export function restrictionCards(db: DatabaseSync, d: SliceData, corpusId: number): Map<string, string[]> {
  const subtypes = [...new Set([...crSubtypeLists(db, corpusId).values()].flat())].sort();
  const quotes = d.cards.map((c) => ({
    c, text: d.atoms.get(c)!.filter((a) => a.family === 'CARES_ABOUT').map((a) => a.quote).join('\n'),
  })).filter((q) => q.text !== '');
  const out = new Map<string, string[]>();
  for (const s of subtypes) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`, 'u');
    const cs = quotes.filter((q) => re.test(q.text)).map((q) => q.c);
    if (cs.length > 0) out.set(s, cs);
  }
  return out;
}

/** The slice cards with the subtype in the part of a face type line after the long dash. */
function subtypeMembers(db: DatabaseSync, d: SliceData, subtype: string): string[] {
  const re = new RegExp(`—.*(?<![\\p{L}\\p{N}])${esc(subtype)}(?![\\p{L}\\p{N}])`, 'u');
  const lines = db.prepare('SELECT type_line FROM card_faces WHERE oracle_id = ?');
  return d.cards.filter((c) => (lines.all(c) as Array<{ type_line: string }>).some((f) => re.test(f.type_line)));
}

/**
 * The spec gives no rule for card A of `unrecorded_restriction`. The selection alternates two
 * mechanical rules, turn by turn: in even turns card A has the subtype on its type line, and in odd
 * turns card A is a card with a PRODUCES or ENABLES atom. Thus the stratum has pairs where the
 * restriction holds and pairs where it does not hold.
 */
function unrecordedRestriction(db: DatabaseSync, d: SliceData, corpusId: number, seed: number): Generator<PairCandidate> {
  const byStype = restrictionCards(db, d, corpusId);
  const supply = producers(d);
  const members = new Map<string, string[]>();
  const membersOf = (s: string) => members.get(s) ?? members.set(s, subtypeMembers(db, d, s)).get(s)!;
  return attempts('unrecorded_restriction', seed, byDraw([...byStype.keys()], seed, 'subtypes'), (s, salt, turn) => {
    const b = pick(byStype.get(s)!, seed, `${salt}:B`);
    const even = turn % 2 === 0;
    return { b, a: pick(even ? membersOf(s) : supply, seed, `${salt}:A`, b ?? undefined) };
  });
}

/** spec sec. 11.2 `random`: two cards of the slice, with or without atoms. */
function random(d: SliceData, seed: number): Generator<PairCandidate> {
  return twoLists('random', seed, d.scope, d.scope);
}

export interface SampleContext {
  corpusId: number;
  scope: Scope;
  termPolicy: PacketPolicy;
}

function sampleContext(db: DatabaseSync, over: Partial<SampleContext> = {}): SampleContext {
  const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined;
  if (!corpus && over.corpusId === undefined) throw new Error('no current rules corpus');
  return { corpusId: over.corpusId ?? corpus!.id, scope: over.scope ?? 'BR', termPolicy: over.termPolicy ?? loadPacketPolicy() };
}

/** The generators of the six sampled strata for one round seed. */
export function strata(
  db: DatabaseSync, d: SliceData, seed: number, policy: GraphPolicy, ctx: SampleContext, demandOffset = 0,
): Record<(typeof SAMPLED_STRATA)[number], Generator<PairCandidate>> {
  const shared = sharedTerms(d, cardTerms(db, d, ctx.corpusId, ctx.termPolicy), policy.golden.shared_term_max_share);
  return {
    demand_type: demandType(d, seed, demandOffset),
    shared_term: sharedTerm(shared, seed),
    interaction: interaction(d, seed),
    param_gap: paramGap(d, seed),
    unrecorded_restriction: unrecordedRestriction(db, d, ctx.corpusId, seed),
    random: random(d, seed),
  };
}

/**
 * spec sec. 11.2: the `round_size` pairs of a round. The seed is the round number, so the same
 * round gives the same pairs. The strata take turns, one pair each, in `SAMPLED_STRATA` order.
 * `demand_type` continues its key order after the demand_type pairs of the earlier rounds.
 * A pair of two cards that an earlier round has (in either direction) or that this round has
 * already is skipped. A stratum with no more pairs drops out of the turns.
 */
export function sampleRound(
  db: DatabaseSync, round: number, policy: GraphPolicy, over: Partial<SampleContext> & { slice?: SliceData } = {},
): PairCandidate[] {
  if (!Number.isInteger(round) || round < 1) throw new Error(`a round is a whole number 1 or more, not ${round}`);
  const ctx = sampleContext(db, over);
  const d = over.slice ?? loadSlice(db, ctx.scope);
  const used = new Set((db.prepare('SELECT supply_oracle, demand_oracle FROM edge_golden_pairs WHERE round < ?')
    .all(round) as Array<{ supply_oracle: string; demand_oracle: string }>).map((p) => pairKey(p.supply_oracle, p.demand_oracle)));
  const offset = (db.prepare("SELECT COUNT(*) n FROM edge_golden_pairs WHERE round < ? AND stratum = 'demand_type'")
    .get(round) as { n: number }).n;
  const gens = strata(db, d, round, policy, ctx, offset);
  let live = SAMPLED_STRATA.map((s) => gens[s]);
  const out: PairCandidate[] = [];
  while (out.length < policy.golden.round_size && live.length > 0) {
    const next: typeof live = [];
    for (const g of live) {
      if (out.length >= policy.golden.round_size) { next.push(g); continue; }
      let r = g.next();
      while (!r.done && used.has(pairKey(r.value.supply_oracle, r.value.demand_oracle))) r = g.next();
      if (r.done) continue;
      used.add(pairKey(r.value.supply_oracle, r.value.demand_oracle));
      out.push(r.value);
      next.push(g);
    }
    live = next;
  }
  return out;
}

/** The oracle hashes of the two texts of a pair, as `edge_golden_pairs.oracle_hashes` stores them. */
export function oracleHashes(db: DatabaseSync, supply: string, demand: string): string {
  const get = db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?');
  const h = (id: string) => (get.get(id) as { oracle_hash: string } | undefined)?.oracle_hash
    ?? (() => { throw new Error(`no card with oracle_id ${id}`); })();
  return JSON.stringify([h(supply), h(demand)]);
}

/** The round number after the last sampled round: 1 for an empty golden set. */
export function nextRound(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(MAX(round), 0) + 1 r FROM edge_golden_pairs').get() as { r: number }).r;
}

/** Writes a round as `sampled` pairs. A round is written one time only. Returns the pair ids. */
export function persistRound(db: DatabaseSync, round: number, pairs: PairCandidate[]): number[] {
  if (db.prepare('SELECT 1 FROM edge_golden_pairs WHERE round = ? LIMIT 1').get(round)) {
    throw new Error(`round ${round} is already sampled`);
  }
  const ins = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, status, oracle_hashes, created_at)
                          VALUES (?, ?, ?, ?, 'sampled', ?, ?)`);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const ids = pairs.map((p) => Number(ins.run(p.supply_oracle, p.demand_oracle, p.stratum, round,
      oracleHashes(db, p.supply_oracle, p.demand_oracle), now).lastInsertRowid));
    db.exec('COMMIT');
    return ids;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface TargetProgress {
  met: boolean;
  /** Pairs with a label vote result: accepted, disputed or owner-adjudicated (not stale). */
  labelled: number;
  counts: Record<string, number>;
  /** Each target and its count, for the status output and the page. */
  targets: Array<{ target: string; want: number; have: number }>;
}

/**
 * spec sec. 11.2: the counts of the labelled pairs against the targets. Only `accepted`,
 * `owner_accepted` and `owner_corrected` pairs count (spec sec. 12.2). A synergy label counts for a
 * CARES_ABOUT type when its demand atom has that type.
 */
export function targetProgress(db: DatabaseSync, policy: GraphPolicy): TargetProgress {
  const t = policy.golden.targets;
  const statuses = LABELLED_STATUSES.map((s) => `'${s}'`).join(',');
  const rows = db.prepare(
    `SELECT p.label, p.stratum, a.family, a.type_key FROM edge_golden_pairs p
       LEFT JOIN atoms a ON a.id = p.demand_atom_id
      WHERE p.status IN (${statuses})`,
  ).all() as Array<{ label: string; stratum: string; family: string | null; type_key: string | null }>;
  const counts: Record<string, number> = { synergy: 0, anti: 0, none: 0, param_gap: 0, unrecorded_restriction: 0 };
  const caTypes = (db.prepare("SELECT type_key FROM atom_types WHERE schema_version = ? AND family = 'CARES_ABOUT' ORDER BY type_key")
    .all(currentSchemaVersion(db)) as Array<{ type_key: string }>).map((r) => `synergy:CARES_ABOUT.${r.type_key}`);
  for (const k of caTypes) counts[k] = 0;
  for (const r of rows) {
    counts[r.label] = (counts[r.label] ?? 0) + 1;
    const polar = r.label === 'synergy' || r.label === 'anti';
    if (polar && (r.stratum === 'param_gap' || r.stratum === 'unrecorded_restriction')) counts[r.stratum]!++;
    if (r.label === 'synergy' && r.family === 'CARES_ABOUT') {
      const k = `synergy:CARES_ABOUT.${r.type_key}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const targets = [
    { target: 'synergy', want: t.synergy, have: counts['synergy']! },
    ...caTypes.map((k) => ({ target: k, want: t.synergy_per_cares_about, have: counts[k]! })),
    { target: 'anti', want: t.anti, have: counts['anti']! },
    { target: 'none', want: t.none, have: counts['none']! },
    { target: 'param_gap (synergy or anti)', want: t.param_gap, have: counts['param_gap']! },
    { target: 'unrecorded_restriction (synergy or anti)', want: t.unrecorded_restriction, have: counts['unrecorded_restriction']! },
  ];
  const labelled = (db.prepare(
    `SELECT COUNT(*) n FROM edge_golden_pairs WHERE status IN ('accepted','disputed','owner_accepted','owner_corrected')`,
  ).get() as { n: number }).n;
  return { met: targets.every((x) => x.have >= x.want), labelled, counts, targets };
}
