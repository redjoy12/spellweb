/**
 * One-effect groups (card rate plan Task 2). A group holds the spells with one reward atom, less
 * its size and cost params. A card is in one group for each distinct reward atom, because
 * `role_gap` of the report reads "the best group" of a card. The rule reads the accepted roles and
 * resources of the rule set of a build, and the params of each atom. It has no model and no card
 * list. It changes no table.
 *
 * Two keys exist. `groupKey` is the key of Task 2. `kindKey` adds the kind of the ability that holds
 * the atom (plan sec. 2.1), and Tasks 3 and 4 use it.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isLand } from '../deck/goal.js';

export interface RewardCard { oracle_id: string; name: string; cmc: number }
export type AbilityKind = 'triggered' | 'activated' | 'other';
export interface RewardAtom {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string; params: Record<string, unknown>; quote: string;
  /** The stored `ability_groups.kind` of the atom. Null: the build has no stored group for the card. */
  kind?: AbilityKind | null;
  /** Where the quote starts on its face. */
  span_start?: number;
}
export interface TypeRole {
  family: string; type_key: string; role: 'supply' | 'demand' | 'both' | 'none'; status: 'accepted' | 'disputed';
  resources: ReadonlyArray<{ kind: 'cost' | 'value' }>;
}
export interface GroupInput { spells: RewardCard[]; atoms: RewardAtom[]; roles: TypeRole[] }

export interface GroupMember extends RewardCard { atoms: RewardAtom[] }
export interface RewardGroup {
  key: string; type: string; params: Record<string, unknown>;
  /** One row for each card, in `oracle_id` order. */
  members: GroupMember[];
  /** The distinct mana values, low to high. */
  mana_values: number[];
  /** Two or more mana values, so a cost compare is possible. Two values need two cards. */
  spread: boolean;
}
export type AtomTest = (a: RewardAtom) => boolean;

/** The size of a reward. Report table "Reward: size": a bigger number is more of the same reward. */
export const SIZE_PARAMS: readonly string[] = ['amount'];
/** What a card pays. Report table "Cost: activated ability" and "Cost: other". */
export const COST_PARAMS: readonly string[] = ['cost_mana', 'cost_tap', 'cost_type', 'decision'];
/** The param and value that say the atom takes from you: your life, your cards, your permanents, or the card itself. */
const SELF_LOSS: Readonly<Record<string, readonly [string, string]>> = {
  'PRODUCES.LIFE_LOSS': ['player', 'you'],
  'PRODUCES.SACRIFICE': ['actor', 'you'],
  'PRODUCES.DISCARD': ['actor', 'you'],
  'PRODUCES.EXILE': ['object', 'self'],
};
const LEFT_OUT = new Set([...SIZE_PARAMS, ...COST_PARAMS]);

const typeName = (t: { family: string; type_key: string }) => `${t.family}.${t.type_key}`;
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** An accepted role with a supply side. A `both` type also supplies, and `CARES_ABOUT` is a trigger, whatever its role. */
export const isSupplyType = (r: TypeRole): boolean =>
  r.status === 'accepted' && (r.role === 'supply' || r.role === 'both') && r.family !== 'CARES_ABOUT';

/** A supply type that the accepted resource map gives a change of kind `value`. A type with only costs gives nothing. */
export const isRewardType = (r: TypeRole): boolean => isSupplyType(r) && r.resources.some((x) => x.kind === 'value');

/** The atom pays for something, or it takes from you (`SELF_LOSS`). */
export function isCostAtom(a: Pick<RewardAtom, 'family' | 'type_key' | 'params'>): boolean {
  if (a.params['decision'] === 'cost') return true;
  const self = SELF_LOSS[typeName(a)];
  return self !== undefined && a.params[self[0]] === self[1];
}

/** The atoms of the types that pass `test`. */
export function typeTest(roles: readonly TypeRole[], test: (r: TypeRole) => boolean): AtomTest {
  const types = new Set(roles.filter(test).map(typeName));
  return (a) => types.has(typeName(a));
}

/** The reward rule of Task 2 (results "Task 2"): a reward type, and not a cost. */
export function rewardTest(roles: readonly TypeRole[]): AtomTest {
  const reward = typeTest(roles, isRewardType);
  return (a) => reward(a) && !isCostAtom(a);
}

/** The params of the key: no size, no cost, no empty value. Keys and arrays are in sorted order. */
export function keyParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept = Object.entries(params).filter(([k, v]) => !LEFT_OUT.has(k) && !isEmpty(v));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(kept.map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v]));
}

export function groupKey(a: Pick<RewardAtom, 'family' | 'type_key' | 'params'>): string {
  return `${typeName(a)} ${JSON.stringify(keyParams(a.params))}`;
}

/** The key of Tasks 3 and 4 (plan sec. 2.1): `groupKey` and the kind of the ability. */
export function kindKey(a: Pick<RewardAtom, 'family' | 'type_key' | 'params' | 'kind'>): string {
  return `${groupKey(a)} ${a.kind ?? 'no_kind'}`;
}

/** The groups of the spells, the largest first, then by key. Atoms of a card that is not a spell stay out. */
export function makeGroups(input: GroupInput, test: AtomTest = rewardTest(input.roles), keyOf: (a: RewardAtom) => string = groupKey): RewardGroup[] {
  const spells = new Map(input.spells.map((c) => [c.oracle_id, c]));
  const found = new Map<string, Omit<RewardGroup, 'members' | 'mana_values' | 'spread'> & { byCard: Map<string, GroupMember> }>();
  for (const a of input.atoms) {
    const card = spells.get(a.oracle_id);
    if (!card || !test(a)) continue;
    const key = keyOf(a);
    let g = found.get(key);
    if (!g) { g = { key, type: typeName(a), params: keyParams(a.params), byCard: new Map() }; found.set(key, g); }
    let m = g.byCard.get(card.oracle_id);
    if (!m) { m = { ...card, atoms: [] }; g.byCard.set(card.oracle_id, m); }
    m.atoms.push(a);
  }
  const groups = [...found.values()].map(({ byCard, ...g }): RewardGroup => {
    const members = [...byCard.values()].sort((a, b) => (a.oracle_id < b.oracle_id ? -1 : 1));
    const mana_values = [...new Set(members.map((m) => m.cmc))].sort((a, b) => a - b);
    return { ...g, members, mana_values, spread: mana_values.length >= 2 };
  });
  return groups.sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
}

/** The words of a quote, as the report compares them: no reminder text, `~` for the card name, `N` for each number. */
export function maskedWords(quote: string, cardName: string): string {
  let s = quote.replace(/\s*\([^)]*\)/g, '');
  for (const part of cardName.split(' // ')) s = s.split(part).join('~');
  return s.replace(/\d+/g, 'N').replace(/\bX\b/g, 'N').replace(/\s+/g, ' ').trim();
}

export interface Wording { words: string; cards: number }

/** The wordings of a group, the most common first. A card counts once for each distinct wording. */
export function wordings(g: RewardGroup): Wording[] {
  const n = new Map<string, number>();
  for (const m of g.members) {
    for (const w of new Set(m.atoms.map((a) => maskedWords(a.quote, m.name)))) n.set(w, (n.get(w) ?? 0) + 1);
  }
  return [...n].map(([words, cards]) => ({ words, cards })).sort((a, b) => b.cards - a.cards || (a.words < b.words ? -1 : 1));
}

export interface GroupCounts {
  spells: number; groups: number; groups_of_2: number; spread_groups: number;
  spells_in_any: number; spells_in_2: number; spells_in_spread: number;
  /** Mean spread groups of a spell that is in one. */
  mean_groups: number;
  /** Spread groups with one wording for all cards. */
  same_words: number;
  /** Spells by the size of their smallest spread group. */
  narrowest: { '2-9': number; '10-49': number; '50+': number };
}

export function groupCounts(groups: readonly RewardGroup[], spells: number): GroupCounts {
  const of2 = groups.filter((g) => g.members.length >= 2);
  const spread = groups.filter((g) => g.spread);
  const cardsOf = (list: readonly RewardGroup[]) => new Set(list.flatMap((g) => g.members.map((m) => m.oracle_id))).size;
  const smallest = new Map<string, number>();
  for (const g of spread) {
    for (const m of g.members) smallest.set(m.oracle_id, Math.min(smallest.get(m.oracle_id) ?? Infinity, g.members.length));
  }
  const narrowest = { '2-9': 0, '10-49': 0, '50+': 0 };
  for (const n of smallest.values()) narrowest[n < 10 ? '2-9' : n < 50 ? '10-49' : '50+']++;
  return {
    spells, groups: groups.length, groups_of_2: of2.length, spread_groups: spread.length,
    spells_in_any: cardsOf(groups), spells_in_2: cardsOf(of2), spells_in_spread: smallest.size,
    mean_groups: smallest.size ? spread.reduce((s, g) => s + g.members.length, 0) / smallest.size : 0,
    same_words: spread.filter((g) => wordings(g).length === 1).length,
    narrowest,
  };
}

/** `n` spread groups at equal steps down the size order, so the sample holds large and small groups. No random draw. */
export function sampleGroups(groups: readonly RewardGroup[], n: number): RewardGroup[] {
  const spread = groups.filter((g) => g.spread);
  const size = Math.min(n, spread.length);
  return Array.from({ length: size }, (_, i) => spread[Math.floor((i * spread.length) / size)]!);
}

interface StoredGroup { face_index: number; span_start: number; kind: AbilityKind; atom_sha: string }

/** The same rule as the build: the last group of the face that starts at or before the atom, or else the first group of the face. */
function kindAt(groups: readonly StoredGroup[], faceIndex: number, spanStart: number): AbilityKind | null {
  const face = groups.filter((g) => g.face_index === faceIndex);
  return (face.filter((g) => g.span_start <= spanStart).at(-1) ?? face[0])?.kind ?? null;
}

/**
 * The kind of each atom of a card. The stored rows of the card's atom set come first, and then the
 * rows from before migration 10. The sha is the `atom_sha` that the build wrote: the first 16 hex
 * characters of the SHA-256 of the sorted atom IDs.
 */
function cardKinds(rows: readonly StoredGroup[], atoms: ReadonlyArray<{ id: number; face_index: number; span_start: number }>): Map<number, AbilityKind | null> {
  const sha = createHash('sha256').update(atoms.map((a) => a.id).sort((a, b) => a - b).join(','), 'utf8').digest('hex').slice(0, 16);
  const own = rows.filter((r) => r.atom_sha === sha);
  const groups = own.length > 0 ? own : rows.filter((r) => r.atom_sha === '');
  return new Map(atoms.map((a) => [a.id, kindAt(groups, a.face_index, a.span_start)]));
}

/** The spells with atoms in a build, those atoms, and the roles of the rule set of the build. A card with no atom in the build stays out. */
export function loadGroupInput(db: DatabaseSync, buildId: number): GroupInput {
  const build = db.prepare('SELECT rule_set_id, tests_version FROM graph_builds WHERE id = ?').get(buildId) as { rule_set_id: number; tests_version: number } | undefined;
  if (!build) throw new Error(`there is no build ${buildId}`);
  const roles = (db.prepare('SELECT family, type_key, role, status, resources_json FROM edge_type_roles WHERE set_id = ?').all(build.rule_set_id) as unknown as
    Array<Omit<TypeRole, 'resources'> & { resources_json: string }>)
    .map(({ resources_json, ...r }) => ({ ...r, resources: JSON.parse(resources_json) as TypeRole['resources'] }));
  const rows = db.prepare(
    `SELECT a.id, a.oracle_id, a.face_index, a.family, a.type_key, a.params_json, a.quote, a.span_start, a.oracle_hash, c.name, c.cmc, c.type_line
       FROM graph_build_atoms g JOIN atoms a ON a.id = g.atom_id JOIN cards c ON c.oracle_id = a.oracle_id
      WHERE g.build_id = ? AND c.rotated = 0 AND c.arena_id IS NOT NULL ORDER BY a.id`,
  ).all(buildId) as unknown as Array<Omit<RewardAtom, 'params' | 'kind'> & RewardCard & { params_json: string; type_line: string; span_start: number; oracle_hash: string }>;
  const spellRows = rows.filter((r) => !isLand(r.type_line));
  const spells = new Map(spellRows.map((r) => [r.oracle_id, { oracle_id: r.oracle_id, name: r.name, cmc: r.cmc }]));
  const groupsOf = db.prepare(
    `SELECT face_index, span_start, kind, atom_sha FROM ability_groups
      WHERE oracle_id = ? AND oracle_hash = ? AND tests_version = ? ORDER BY face_index, group_index`,
  );
  const byCard = new Map<string, typeof spellRows>();
  for (const r of spellRows) byCard.set(r.oracle_id, [...(byCard.get(r.oracle_id) ?? []), r]);
  const kinds = new Map<number, AbilityKind | null>();
  for (const [oracle_id, own] of byCard) {
    const rows = groupsOf.all(oracle_id, own[0]!.oracle_hash, build.tests_version) as unknown as StoredGroup[];
    for (const [id, kind] of cardKinds(rows, own)) kinds.set(id, kind);
  }
  const atoms = spellRows.map((r): RewardAtom => ({
    id: r.id, oracle_id: r.oracle_id, face_index: r.face_index, family: r.family, type_key: r.type_key, params: JSON.parse(r.params_json) as Record<string, unknown>,
    quote: r.quote, kind: kinds.get(r.id) ?? null, span_start: r.span_start,
  }));
  return { spells: [...spells.values()], atoms, roles };
}
