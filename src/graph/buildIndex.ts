/**
 * The in-memory index of one graph build (Phase 3 spec sec. 7.1, plan D10): the build atoms with
 * their groups, the accepted rules of the build's set, the class nodes and an index on
 * `FAMILY.TYPE_KEY`. It calculates edges on request and stores none.
 *
 * The build (build.ts) runs the same index over every card, so the stored degree and the edges
 * that the explorer calculates for one card always agree.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentCorpusId } from '../atoms/golden.js';
import { groupAtomSha, pickAtomSet, type GroupKind } from './groups.js';
import { intrinsicClasses, namedSubtypeClasses, namedSubtypeId, scopeCards, type IntrinsicClass, type Scope } from './intrinsic.js';
import { matchRule, sideHolds, supplyHolds, type AtomLite } from './match.js';
import { cardPairs, mergeEdges, type AtomEdge, type AtomPlace, type MergeContext, type MergedEdge } from './merge.js';
import { loadGraphPolicy, type GraphPolicy } from './policy.js';
import { isIntrinsic, sideId } from './ruleSchema.js';
import { getRuleSet, type StoredRule } from './ruleSet.js';
import { buildRules } from './subsume.js';
import { crCardTypes } from './crContent.js';
import { linkGateBlocks, namedSubtype } from './linkRuleV2.js';
import { newObjectTypes, OBJECT_GATE_VERSION, objectFactsOf, objectGateBlocks, selfNames, typeLineSubtypes, typeLineTypes, typeVocab, type ObjectFacts, type TypeVocab } from './objectGate.js';
import { subtypeListSentences } from './subtypes.js';
import { countManaSymbols, loadTextTests, manaLetters } from './textTests.js';
import { ruleSpecificity } from './weights.js';
import { isActivateKind, typesOf } from '../atoms/schemaV16.js';
import { V17_UNGRADED } from '../atoms/schemaV17.js';
import { V18_UNGRADED } from '../atoms/schemaV18.js';
import { ACTIVATE_COST_PARAMS } from '../atoms/schemaV15.js';

/**
 * `cost_mana`: the mana that the atom's ability costs (spec rev. 12 sec. 7.6). For an atom of an
 * `activated` group it is the `cost_mana` of the group; for other atoms it is the `mana_symbols`
 * count of the atom quote. Absent when the build cannot count it (it then counts as unknown).
 */
export type IndexAtom = AtomLite & AtomPlace & {
  cost_mana?: number | 'unknown';
  /** spec rev. 14 sec. 7.8: the objects that an `ENABLES.DOUBLE` quote names; absent on other atoms. */
  double_objects?: DoubleObject[];
  /** spec rev. 16 sec. 7.9: the object facts of the quote; absent when no test decides. */
  object_facts?: ObjectFacts;
};

/**
 * spec rev. 12 sec. 7.6, owner decision (fix request 2, report 1): a mana supply helps an
 * "Activate" demand only when the activation cost of that demand contains mana. The supply is the
 * `MANA_PRODUCTION` type or a basic land type class (CR 305.6 and CR 205.3i, quoted in the
 * evidence of those rules).
 */
const GATE_DEMAND = 'ENABLES.ACTIVATE';
const GATE_SUPPLY_TYPE = 'PRODUCES.MANA_PRODUCTION';
const GATE_SUPPLY_SUBTYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

/** True when the rule is a mana supply to an "Activate" demand (sec. 7.6). */
export function isManaCostGated(r: StoredRule): boolean {
  if (r.polarity !== '+' || typeId(r.demand) !== GATE_DEMAND) return false;
  if (isIntrinsic(r.supply)) return r.supply.intrinsic === 'subtype' && GATE_SUPPLY_SUBTYPES.has(String(r.supply.value));
  return typeId(r.supply) === GATE_SUPPLY_TYPE;
}

/** True when the demand atom's cost contains mana, or the build cannot count it (sec. 7.6). */
export function costHasMana(d: { cost_mana?: number | 'unknown' }): boolean {
  return d.cost_mana === undefined || d.cost_mana === 'unknown' || d.cost_mana > 0;
}

/**
 * spec rev. 14 sec. 7.8, owner decision (fix request 5, docs/fix-requests/5-er-1774.md): a rule
 * into "Double" helps a demand atom only when the atom doubles a thing that the rule's CR 701.10
 * evidence names. `ENABLES.DOUBLE` has no params (a v15 item), so the gate reads the nouns of the
 * CR 701.10 subrules: a-c power and toughness, d life total, e counters, f mana, g damage.
 */
export type DoubleObject = 'power' | 'toughness' | 'life' | 'counters' | 'mana' | 'damage';
const DOUBLE_DEMAND = 'ENABLES.DOUBLE';
const DOUBLE_SUBRULES: Record<string, DoubleObject[]> = {
  '701.10a': ['power', 'toughness'], '701.10b': ['power', 'toughness'], '701.10c': ['power', 'toughness'], // i2-ok: sec. 7.8 table, owner decision (fix request 5)
  '701.10d': ['life'], '701.10e': ['counters'], '701.10f': ['mana'], '701.10g': ['damage'], // i2-ok: sec. 7.8 table, owner decision (fix request 5)
};
const DOUBLE_NOUNS: Array<[DoubleObject, RegExp]> = [
  ['power', /\bpower\b/i], ['toughness', /\btoughness\b/i], ['life', /\blife\b/i],
  ['counters', /\bcounters?\b/i], ['mana', /\bmana\b/i], ['damage', /\bdamage\b/i],
];

/** The objects that a "Double" atom quote names (sec. 7.8); empty when it names none (unknown). */
export function doubleObjectsOfQuote(quote: string): DoubleObject[] {
  return DOUBLE_NOUNS.filter(([, re]) => re.test(quote)).map(([o]) => o);
}

/**
 * The objects of a + rule into `ENABLES.DOUBLE` from its CR 701.10 evidence (sec. 7.8); null when
 * the gate does not apply (another rule, or no 701.10 subrule in the evidence).
 */
export function doubleObjectsOfRule(r: StoredRule): Set<DoubleObject> | null {
  if (r.polarity !== '+' || typeId(r.demand) !== DOUBLE_DEMAND) return null;
  const out = new Set<DoubleObject>();
  for (const e of r.evidence) for (const o of DOUBLE_SUBRULES[e.ref] ?? []) out.add(o);
  return out.size ? out : null;
}

/** True when the gate keeps the edge of rule `r` into the demand atom `d` (sec. 7.8). */
export function doubleObjectsAgree(r: StoredRule, d: { double_objects?: readonly DoubleObject[] }): boolean {
  const ruleObjects = doubleObjectsOfRule(r);
  if (!ruleObjects || !d.double_objects?.length) return true;
  return d.double_objects.some((o) => ruleObjects.has(o));
}

/** `FAMILY.TYPE_KEY` of an atom or a rule side. */
const typeId = (x: { family: string; type_key: string }) => `${x.family}.${x.type_key}`;

/** The SHA of an atom ID set: the sorted IDs, comma-joined. */
export function atomSetSha(ids: Iterable<number>): string {
  return createHash('sha256').update([...ids].sort((a, b) => a - b).join(','), 'utf8').digest('hex');
}

/** The current atom IDs of the scope cards, sorted. */
export function currentScopeAtoms(db: DatabaseSync, scope: Scope): number[] {
  return (db.prepare(
    'SELECT a.id FROM atoms a JOIN json_each(?) j ON j.value = a.oracle_id WHERE a.is_current = 1 ORDER BY a.id',
  ).all(JSON.stringify(scopeCards(db, scope))) as Array<{ id: number }>).map((r) => r.id);
}

/** The stored facts of one ability group that holds atoms (spec sec. 4.5 and 9.4); the key is `IndexAtom.group`. */
export interface GroupInfo {
  key: string; oracle_id: string; kind: GroupKind;
  per_turn_limit: boolean; unknown_limit: boolean; cost_unparsed: boolean;
  /** The `mana_symbols` count of the activation cost; null when the group is not `activated`. */
  cost_mana: number | 'unknown' | null;
}

/**
 * The atoms with their params, card mana value and ability group. The group comes from the
 * stored `ability_groups` rows of the atom's oracle hash, `testsVersion` and the card's atoms in
 * `atomIds` (`pickAtomSet`): the last group of
 * the face that starts at or before the atom's span start (spec sec. 4.1). A card without
 * stored groups throws; `npm run graph -- --build` writes them first. `groupsOut` receives the
 * facts of each group that holds an atom.
 */
export function atomInfo(db: DatabaseSync, atomIds: readonly number[], testsVersion: number,
  groupsOut?: Map<string, GroupInfo>): Map<number, IndexAtom> {
  const rows = db.prepare(
    `SELECT a.id, a.oracle_id, a.face_index, a.family, a.type_key, a.params_json, a.span_start, a.span_end, a.oracle_hash, a.quote, c.cmc, c.name, c.type_line, c.colors,
            COALESCE(f.toughness, c.toughness) AS toughness
       FROM atoms a JOIN json_each(?) j ON j.value = a.id JOIN cards c ON c.oracle_id = a.oracle_id
       LEFT JOIN card_faces f ON f.oracle_id = a.oracle_id AND f.face_index = a.face_index ORDER BY a.id`,
  ).all(JSON.stringify(atomIds)) as Array<{
    id: number; oracle_id: string; face_index: number; family: string; type_key: string; params_json: string;
    span_start: number; span_end: number; oracle_hash: string; quote: string; cmc: number; name: string; type_line: string; colors: string;
    toughness: string | null;
  }>;
  // sec. 7.9: the names by which each card refers to itself (the card name and its face names).
  // sec. 7.9 G4 and G16: the names, the card types and the subtypes of each card (all faces), with the CR type vocabulary.
  const faceRows = db.prepare('SELECT name, type_line FROM card_faces WHERE oracle_id = ?');
  const vocab = crTypeVocab(db, currentCorpusId(db));
  const cardOf = new Map<string, { names: string[]; types: string[]; subtypes: string[] }>();
  const card = (oracle: string, name: string, typeLine: string) => {
    let c = cardOf.get(oracle);
    if (!c) {
      const faces = faceRows.all(oracle) as Array<{ name: string; type_line: string | null }>;
      const lines = [typeLine, ...faces.map((f) => f.type_line ?? '')];
      c = {
        names: selfNames([name, ...faces.map((f) => f.name)]),
        types: typeLineTypes(lines, vocab),
        subtypes: typeLineSubtypes(lines, vocab),
      };
      cardOf.set(oracle, c);
    }
    return c;
  };
  // sec. 7.6: the quote count needs the text tests of the build's version; another version gives no count.
  const tests = loadTextTests();
  const letters = tests.tests_version === testsVersion ? manaLetters(db, currentCorpusId(db), tests) : null;
  const groupsOf = db.prepare(
    `SELECT face_index, group_index, span_start, kind, cost_json, cost_unparsed, per_turn_limit, unknown_limit, atom_sha FROM ability_groups
      WHERE oracle_id = ? AND oracle_hash = ? AND tests_version = ? AND atom_sha IN (?, '') ORDER BY face_index, group_index`,
  );
  type StoredGroup = { face_index: number; group_index: number; span_start: number; kind: GroupKind;
    cost_json: string | null; cost_unparsed: number; per_turn_limit: number; unknown_limit: number; atom_sha: string };
  // The groups of a card come from its atoms in this set (plan Task 8: the atom set is in the group key).
  const idsOfCard = new Map<string, number[]>();
  for (const r of rows) {
    const l = idsOfCard.get(r.oracle_id);
    if (l) l.push(r.id); else idsOfCard.set(r.oracle_id, [r.id]);
  }
  const shaOfCard = new Map([...idsOfCard].map(([id, ids]) => [id, groupAtomSha(ids)]));
  const cache = new Map<string, StoredGroup[]>();
  const out = new Map<number, IndexAtom>();
  for (const r of rows) {
    const ck = `${r.oracle_id}|${r.oracle_hash}`;
    let groups = cache.get(ck);
    if (!groups) {
      groups = pickAtomSet(groupsOf.all(r.oracle_id, r.oracle_hash, testsVersion, shaOfCard.get(r.oracle_id)!) as unknown as StoredGroup[],
        shaOfCard.get(r.oracle_id)!);
      cache.set(ck, groups);
    }
    let g: StoredGroup | undefined;
    for (const x of groups) if (x.face_index === r.face_index && x.span_start <= r.span_start) g = x;
    g ??= groups.find((x) => x.face_index === r.face_index);
    if (!g) throw new Error(`card ${r.oracle_id} face ${r.face_index} has no stored ability groups for tests v${testsVersion}`);
    const group = `${r.oracle_id}#${r.face_index}#${g.group_index}`;
    const groupMana = g.cost_json === null ? null : (JSON.parse(g.cost_json) as { mana: number | 'unknown' }).mana;
    if (groupsOut && !groupsOut.has(group)) {
      groupsOut.set(group, {
        key: group, oracle_id: r.oracle_id, kind: g.kind, per_turn_limit: g.per_turn_limit === 1, unknown_limit: g.unknown_limit === 1,
        cost_unparsed: g.cost_unparsed === 1,
        cost_mana: groupMana,
      });
    }
    const costMana = g.kind === 'activated' && groupMana !== null ? groupMana
      : letters ? countManaSymbols(r.quote, letters, tests) : undefined;
    out.set(r.id, {
      id: r.id, oracle_id: r.oracle_id, face_index: r.face_index, family: r.family, type_key: r.type_key,
      params: JSON.parse(r.params_json) as Record<string, unknown>, span_start: r.span_start, span_end: r.span_end,
      group, kind: g.kind,
      span: [r.span_start, r.span_end], mv: r.cmc,
      ...(costMana === undefined ? {} : { cost_mana: costMana }),
      ...(`${r.family}.${r.type_key}` === DOUBLE_DEMAND ? { double_objects: doubleObjectsOfQuote(r.quote) } : {}),
    });
    const params = out.get(r.id)!.params;
    const c = card(r.oracle_id, r.name, r.type_line);
    const facts = objectFactsOf({ family: r.family, type_key: r.type_key, params }, r.quote, c.names, c.types, vocab, JSON.parse(r.colors) as string[], r.toughness, c.subtypes);
    if (Object.keys(facts).length) out.get(r.id)!.object_facts = facts;
  }
  if (out.size !== atomIds.length) throw new Error(`${atomIds.length - out.size} atoms of the set are not in the database`);
  return out;
}

/** sec. 7.9 G4: the type vocabulary of a corpus: the glossary card types and the CR subtype lists. */
export function crTypeVocab(db: DatabaseSync, corpusId: number): TypeVocab {
  return typeVocab(crCardTypes(db, corpusId).keys(), subtypeListSentences(db, corpusId));
}

/** The class nodes of an index. From version 2 of the link gate (sec. 7.10) also the named subtype classes. */
export function indexClasses(db: DatabaseSync, scope: Scope, rules: ReadonlyArray<StoredRule>, atoms: ReadonlyMap<number, IndexAtom>, linkGate: number): IntrinsicClass[] {
  const classes = intrinsicClasses(db, scope, rules).filter((c) => c.members.length > 0);
  if (linkGate < 2) return classes;
  const subtypes = new Set([...atoms.values()].flatMap((a) => namedSubtype(a) ?? []));
  return [...classes, ...namedSubtypeClasses(db, scope, classes, subtypes)];
}

/** sec. 7.9: the data of the object gate for one schema version and the current corpus. */
export function objectGateData(db: DatabaseSync, schemaVersion: number, version: number = OBJECT_GATE_VERSION):
  { newObjectTypes: Set<string>; vocab: TypeVocab; version: number } {
  return { newObjectTypes: schemaNewObjectTypes(db, schemaVersion), vocab: crTypeVocab(db, currentCorpusId(db)), version };
}

/** sec. 7.9: the new-object supply types of one schema version, from the labels and evidence of its types. */
export function schemaNewObjectTypes(db: DatabaseSync, schemaVersion: number): Set<string> {
  return newObjectTypes(db.prepare('SELECT family, type_key, label, evidence FROM atom_types WHERE schema_version = ?')
    .all(schemaVersion) as Array<{ family: string; type_key: string; label: string; evidence: string | null }>);
}

/** The param names of each `FAMILY.TYPE_KEY` in one schema version. */
export function demandParamLists(db: DatabaseSync, schemaVersion: number): Map<string, string[]> {
  const rows = db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?')
    .all(schemaVersion) as Array<{ family: string; type_key: string; params_schema: string }>;
  // sec. 21 item M3: a keyword kind carries the ACTIVATE cost params only for the ACTIVATE rules.
  // As the demand of its own rules it has no params, as before v16.
  // sec. 22.5 and 23.4: the params that no rule links stay out of the grade.
  const own = (r: { family: string; type_key: string }, keys: string[]) => {
    const kept = schemaVersion >= 16 && isActivateKind(typeId(r)) ? keys.filter((k) => !(k in ACTIVATE_COST_PARAMS)) : keys;
    const graded = schemaVersion >= 17 ? kept.filter((k) => !V17_UNGRADED[typeId(r)]?.includes(k)) : kept;
    return schemaVersion >= 18 ? graded.filter((k) => !V18_UNGRADED[typeId(r)]?.includes(k)) : graded;
  };
  return new Map(rows.map((r) => [typeId(r),
    own(r, Object.keys((JSON.parse(r.params_schema) as { properties?: Record<string, unknown> }).properties ?? {}))]));
}

export interface IndexData {
  atoms: Map<number, IndexAtom>;
  rules: StoredRule[];
  classes: IntrinsicClass[];
  /** The param lists of the rule set's schema version (spec sec. 7.2). */
  params: Map<string, string[]>;
  policy: GraphPolicy;
  /** The facts of each group (the cycle graph, spec sec. 9); empty when the caller gives none. */
  groups?: Map<string, GroupInfo>;
  /** spec rev. 12 sec. 7.6: apply the mana cost gate. Builds before revision 12 do not. */
  manaCostGate?: boolean;
  /** spec rev. 14 sec. 7.8: apply the "Double" object gate. Builds before revision 14 do not. */
  doubleObjectGate?: boolean;
  /** spec rev. 16 sec. 7.9: apply the object gate with these new-object supply types. Builds before revision 16 do not. */
  objectGate?: { newObjectTypes: ReadonlySet<string>; vocab?: TypeVocab; version?: number };
  /** spec rev. 21 sec. 7.10: the version of the link gate (`LINK_GATE_VERSION`); off when absent. */
  linkGate?: number;
  /** spec rev. 19 sec. 7.2: the grade version (`GRADE_VERSION`); 1 when absent. */
  gradeVersion?: number;
  /** spec sec. 21 item M3: a keyword activated ability also has the type ACTIVATE. Sets on schema v16 and later. */
  activateKinds?: boolean;
}

/** One atom edge with the names of its partial params (for the gap report). */
export type IndexedAtomEdge = AtomEdge & { partial: string[] };

export interface CardEdges { out: MergedEdge[]; in: MergedEdge[]; classes: MergedEdge[]; anti: MergedEdge[] }

export class BuildIndex {
  readonly atoms: Map<number, IndexAtom>;
  readonly classes: Map<string, IntrinsicClass>;
  readonly policy: GraphPolicy;
  readonly groups: Map<string, GroupInfo>;
  readonly manaCostGate: boolean;
  readonly doubleObjectGate: boolean;
  /** sec. 7.9: the new-object supply types of the object gate; null when the build does not apply it. */
  readonly objectGate: ReadonlySet<string> | null;
  private readonly objectVocab: TypeVocab | null;
  /** sec. 7.9: the version of the object gate (`OBJECT_GATE_VERSION`); 0 when the build does not apply it. */
  readonly objectGateVersion: number;
  /** sec. 7.10: the version of the link gate; 0 when the build does not apply it. */
  readonly linkGateVersion: number;
  /** sec. 7.2: the grade version of the build (1 for builds before revision 19). */
  readonly gradeVersion: number;
  /** sec. 21 item M3: a keyword activated ability also has the type ACTIVATE. */
  readonly activateKinds: boolean;
  /** The build that `load` read; null for an index made from data. */
  build: { id: number; scope: Scope; atom_set_sha: string } | null = null;
  private readonly byType = new Map<string, IndexAtom[]>();
  private readonly byCard = new Map<string, IndexAtom[]>();
  private readonly bySupply = new Map<string, StoredRule[]>();
  private readonly byDemand = new Map<string, StoredRule[]>();
  private readonly classByDemand = new Map<string, StoredRule[]>();
  private readonly byHash = new Map<string, StoredRule>();
  private readonly params: Map<string, string[]>;
  readonly ctx: MergeContext;

  constructor(d: IndexData) {
    this.atoms = d.atoms;
    this.policy = d.policy;
    this.params = d.params;
    this.groups = d.groups ?? new Map();
    this.manaCostGate = d.manaCostGate === true;
    this.doubleObjectGate = d.doubleObjectGate === true;
    this.objectGate = d.objectGate?.newObjectTypes ?? null;
    this.objectVocab = d.objectGate?.vocab ?? null;
    this.objectGateVersion = d.objectGate ? d.objectGate.version ?? OBJECT_GATE_VERSION : 0;
    this.linkGateVersion = d.linkGate ?? 0;
    this.gradeVersion = d.gradeVersion ?? 1;
    this.activateKinds = d.activateKinds === true;
    this.classes = new Map(d.classes.map((c) => [c.id, c]));
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const a of [...d.atoms.values()].sort((x, y) => x.id - y.id)) {
      for (const t of this.typesOf(a)) push(this.byType, t, a);
      push(this.byCard, a.oracle_id, a);
    }
    for (const r of d.rules) {
      this.byHash.set(r.rule_hash, r);
      if (isIntrinsic(r.supply)) push(this.classByDemand, typeId(r.demand), r);
      else {
        push(this.bySupply, typeId(r.supply), r);
        push(this.byDemand, typeId(r.demand), r);
      }
    }
    // rev. 16 sec. 7.4: the specificity part of each typed rule, from its supply and demand cards.
    const ruleSize = new Map<string, number>();
    if (d.policy.weights.specificity) {
      const cardsOf = (holds: (a: IndexAtom) => boolean, atoms: readonly IndexAtom[]) =>
        new Set(atoms.filter(holds).map((a) => a.oracle_id)).size;
      for (const r of d.rules) {
        if (isIntrinsic(r.supply)) continue;
        ruleSize.set(r.rule_hash, ruleSpecificity(cardsOf((a) => supplyHolds(r, a, this.activateKinds, this.gradeVersion), this.byType.get(typeId(r.supply)) ?? []),
          cardsOf((a) => sideHolds(r.demand, a, this.activateKinds), this.byType.get(typeId(r.demand)) ?? []), this.byCard.size));
      }
    }
    this.ctx = {
      atom: (id) => this.atoms.get(id)!,
      classSize: (id) => this.classes.get(id)!.members.length,
      ...(d.policy.weights.specificity ? { ruleSize: (h: string) => ruleSize.get(h) ?? 1 } : {}),
      policy: d.policy,
    };
  }

  /**
   * The index of a stored build: its atoms, the build rules of its set (or `rules`), its classes
   * and its weights.
   */
  static load(db: DatabaseSync, buildId: number, rules?: StoredRule[]): BuildIndex {
    const b = db.prepare('SELECT id, rule_set_id, scope, tests_version, atom_set_sha, counts_json FROM graph_builds WHERE id = ?')
      .get(buildId) as { id: number; rule_set_id: number; scope: Scope; tests_version: number; atom_set_sha: string; counts_json: string } | undefined;
    if (!b) throw new Error(`no graph build ${buildId}`);
    const ids = (db.prepare('SELECT atom_id FROM graph_build_atoms WHERE build_id = ? ORDER BY atom_id').all(buildId) as
      Array<{ atom_id: number }>).map((r) => r.atom_id);
    const counts = JSON.parse(b.counts_json) as { weights?: GraphPolicy['weights']; mana_cost_gate?: boolean;
      double_object_gate?: boolean; object_gate?: boolean | number; link_gate?: number; excluded_rules?: string[]; grade_version?: number };
    const policy = loadGraphPolicy();
    const idx = BuildIndex.fromAtoms(db, {
      atomIds: ids, ruleSetId: b.rule_set_id, scope: b.scope, testsVersion: b.tests_version,
      policy: counts.weights ? { ...policy, weights: counts.weights } : policy, rules,
      manaCostGate: counts.mana_cost_gate === true, doubleObjectGate: counts.double_object_gate === true,
      // sec. 7.9: `true` is version 1 (build 8); a number is the version.
      objectGate: counts.object_gate === true ? 1 : typeof counts.object_gate === 'number' ? counts.object_gate : 0,
      linkGate: counts.link_gate ?? 0,
      excludedRules: counts.excluded_rules, gradeVersion: counts.grade_version ?? 1,
    });
    idx.build = { id: b.id, scope: b.scope, atom_set_sha: b.atom_set_sha };
    return idx;
  }

  /**
   * An index over an atom set with the build rules of a set: the accepted rules that are not
   * subsumed (spec rev. 11 sec. 5.8, `buildRules`) and not in `excludedRules` (rev. 13 sec. 7.7:
   * the hashes that a stored build recorded).
   */
  static fromAtoms(db: DatabaseSync, o: { atomIds: readonly number[]; ruleSetId: number; scope: Scope; testsVersion: number;
    policy: GraphPolicy; rules?: StoredRule[]; manaCostGate?: boolean; doubleObjectGate?: boolean; objectGate?: number;
    linkGate?: number; excludedRules?: readonly string[]; gradeVersion?: number }): BuildIndex {
    const set = getRuleSet(db, o.ruleSetId);
    if (!set) throw new Error(`no edge-rule set ${o.ruleSetId}`);
    const rules = o.rules ?? buildRules(db, o.ruleSetId, new Set(o.excludedRules ?? []), o.gradeVersion ?? 1);
    const groups = new Map<string, GroupInfo>();
    const atoms = atomInfo(db, o.atomIds, o.testsVersion, groups);
    return new BuildIndex({
      atoms, rules, groups,
      classes: indexClasses(db, o.scope, rules, atoms, o.linkGate ?? 0),
      params: demandParamLists(db, set.schema_version), policy: o.policy, manaCostGate: o.manaCostGate,
      doubleObjectGate: o.doubleObjectGate, gradeVersion: o.gradeVersion ?? 1, activateKinds: set.schema_version >= 16,
      ...(o.objectGate ? { objectGate: objectGateData(db, set.schema_version, o.objectGate) } : {}),
      linkGate: o.linkGate ?? 0,
    });
  }

  /** The types that an atom has in this index: its own, and ACTIVATE for a keyword kind on v16 (sec. 21 M3). */
  typesOf(a: { family: string; type_key: string }): string[] {
    return this.activateKinds ? typesOf(typeId(a)) : [typeId(a)];
  }

  /** A rule of the index, by hash. */
  ruleOf(hash: string): StoredRule | undefined {
    return this.byHash.get(hash);
  }

  /** The atoms of one card, by ID. */
  atomsOfCard(oracleId: string): readonly IndexAtom[] {
    return this.byCard.get(oracleId) ?? [];
  }

  /** The cards that have atoms in the index, sorted. */
  cards(): string[] {
    return [...this.byCard.keys()].sort();
  }

  paramsOf(a: { family: string; type_key: string }): string[] {
    return this.params.get(typeId(a)) ?? [];
  }

  /** sec. 7.6 and 7.8: true when a gate removes the edge of rule `r` into the demand atom `d`. */
  private gated(r: StoredRule, d: IndexAtom): boolean {
    return (this.manaCostGate && isManaCostGated(r) && !costHasMana(d))
      || (this.doubleObjectGate && !doubleObjectsAgree(r, d));
  }

  /** sec. 7.9: true when the object gate removes the edge of rule `r` from supply `s` (null: a class) into `d`. */
  private objectBlocked(r: StoredRule, s: IndexAtom | null, d: IndexAtom): boolean {
    return this.objectGate !== null && objectGateBlocks(r, s, d, this.objectGate, this.objectVocab, this.objectGateVersion);
  }

  /** sec. 7.10: true when the link gate removes the `+` edge of rule `r` from supply `s` or class `c` into `d`. */
  private linkBlocked(r: StoredRule, s: IndexAtom | null, c: IntrinsicClass | null, d: IndexAtom): boolean {
    return this.linkGateVersion > 0 && r.polarity === '+' && linkGateBlocks({ supply: s, cls: c, demand: d }, this.linkGateVersion);
  }

  /** sec. 7.10 version 2: the members of card-type class `c` with the subtype that `d` names, or undefined. */
  private namedClass(c: IntrinsicClass, d: IndexAtom): IntrinsicClass | undefined {
    const subtype = this.linkGateVersion >= 2 && c.intrinsic === 'card_type' ? namedSubtype(d) : null;
    return subtype === null ? undefined : this.classes.get(namedSubtypeId(c.id, subtype));
  }

  /** The atom edges of the typed rules whose supply atom is `a`. */
  edgesFromSupply(a: IndexAtom): IndexedAtomEdge[] {
    const out: IndexedAtomEdge[] = [];
    for (const r of this.typesOf(a).flatMap((t) => this.bySupply.get(t) ?? [])) {
      if (!supplyHolds(r, a, this.activateKinds, this.gradeVersion)) continue;
      const params = this.paramsOf(r.demand);
      for (const d of this.byType.get(typeId(r.demand)) ?? []) {
        if (this.gated(r, d) || this.objectBlocked(r, a, d) || this.linkBlocked(r, a, null, d)) continue;
        const m = matchRule(r, a, d, params, this.gradeVersion, this.activateKinds);
        if (m) out.push({ rule_hash: r.rule_hash, polarity: r.polarity, supply_atom_id: a.id, class_id: null, demand_atom_id: d.id, ...m });
      }
    }
    return out;
  }

  /** The atom edges into the demand atom `d`: typed rules (all supply atoms) and class rules. */
  edgesToDemand(d: IndexAtom, which: 'typed' | 'class' | 'all' = 'all'): IndexedAtomEdge[] {
    const out: IndexedAtomEdge[] = [];
    if (which !== 'class') {
      for (const r of this.typesOf(d).flatMap((t) => this.byDemand.get(t) ?? [])) {
        if (isIntrinsic(r.supply) || this.gated(r, d)) continue;
        // The params of the rule's demand type: the atom's own type, or ACTIVATE for a keyword kind (sec. 21 M3).
        const params = this.paramsOf(r.demand);
        for (const s of this.byType.get(typeId(r.supply)) ?? []) {
          if (this.objectBlocked(r, s, d) || this.linkBlocked(r, s, null, d)) continue;
          const m = matchRule(r, s, d, params, this.gradeVersion, this.activateKinds);
          if (m) out.push({ rule_hash: r.rule_hash, polarity: r.polarity, supply_atom_id: s.id, class_id: null, demand_atom_id: d.id, ...m });
        }
      }
    }
    if (which !== 'typed') {
      for (const r of this.typesOf(d).flatMap((t) => this.classByDemand.get(t) ?? [])) {
        const c = this.classes.get(sideId(r.supply));
        if (!c || this.gated(r, d) || this.objectBlocked(r, null, d)) continue;
        // sec. 7.10: a removed class edge stays for the members with the subtype that the demand names.
        const kept = this.linkBlocked(r, null, c, d) ? this.namedClass(c, d) : c;
        if (!kept) continue;
        const m = matchRule(r, c, d, this.paramsOf(r.demand), this.gradeVersion, this.activateKinds);
        if (m) out.push({ rule_hash: r.rule_hash, polarity: r.polarity, supply_atom_id: null, class_id: kept.id, demand_atom_id: d.id, ...m });
      }
    }
    return out;
  }

  /** The atom edges of the card as supply (typed) and of its demand atoms to class nodes. */
  cardAtomEdges(oracleId: string): { supply: IndexedAtomEdge[]; classes: IndexedAtomEdge[] } {
    const atoms = this.byCard.get(oracleId) ?? [];
    return {
      supply: atoms.flatMap((a) => this.edgesFromSupply(a)),
      classes: atoms.flatMap((a) => this.edgesToDemand(a, 'class')),
    };
  }

  /**
   * spec sec. 13.1: the merged edges of one card. `out` and `in` are the explicit synergy edges
   * with the card as supply or demand; `classes` the synergy class edges into its demand atoms;
   * `anti` every anti-synergy edge with the card on either side, once each.
   */
  edgesForCard(oracleId: string): CardEdges {
    const atoms = this.byCard.get(oracleId) ?? [];
    const outM = mergeEdges(atoms.flatMap((a) => this.edgesFromSupply(a)), this.ctx);
    const inM = mergeEdges(atoms.flatMap((a) => this.edgesToDemand(a, 'typed')), this.ctx);
    const clsM = mergeEdges(atoms.flatMap((a) => this.edgesToDemand(a, 'class')), this.ctx);
    const anti = new Map<string, MergedEdge>();
    for (const e of [...outM, ...inM, ...clsM]) if (e.polarity === '-') anti.set(e.key, e);
    return {
      out: outM.filter((e) => e.polarity === '+'),
      in: inM.filter((e) => e.polarity === '+'),
      classes: clsM.filter((e) => e.polarity === '+'),
      anti: [...anti.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    };
  }

  /**
   * The degree of one card from its edges (spec sec. 7.5), by the rules of build.ts: distinct
   * neighbour cards through explicit synergy edges, the sum of the card-pair weights, the
   * synergy class edges, and the distinct cards on the other side of an anti-synergy edge.
   */
  degreeOf(oracleId: string): { out_degree: number; in_degree: number; out_weight: number; in_weight: number; class_edges: number; anti_degree: number } {
    const e = this.edgesForCard(oracleId);
    const outP = cardPairs(e.out);
    const inP = cardPairs(e.in);
    const anti = new Set<string>();
    for (const x of e.anti) {
      if (x.supply_oracle === null) continue;
      anti.add(x.supply_oracle === oracleId ? x.demand_oracle : x.supply_oracle);
    }
    // The build sums a float32 matrix row or column in oracle order; this sum uses the same values and order.
    const sum = (m: Map<string, { weight: number }>, side: 0 | 1) => [...m].map(([k, p]) => [k.split('|')[side]!, p.weight] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).reduce((s, [, w]) => s + Math.fround(w), 0);
    return {
      out_degree: outP.size, in_degree: inP.size, out_weight: sum(outP, 1), in_weight: sum(inP, 0),
      class_edges: e.classes.length, anti_degree: anti.size,
    };
  }

  /** spec sec. 7.1: true when the current atom set of the build's scope differs from the build's atom set. */
  isStale(db: DatabaseSync): boolean {
    if (!this.build) throw new Error('isStale needs an index that BuildIndex.load made');
    return atomSetSha(currentScopeAtoms(db, this.build.scope)) !== this.build.atom_set_sha;
  }
}
