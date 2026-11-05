import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion } from '../atoms/schema.js';
import { loadPacketPolicy, type PacketPolicy } from '../rules/relevance.js';
import {
  contentRefs, emptyContent, isCoverageGap, loadRowStore, mergeContent, renderContent, set5CrContent,
  typeCrContent, typeEntries, withKernel, type CrContent, type RowStore, type TypeEntry,
} from './crContent.js';
import { INTRINSIC_KINDS, permittedIntrinsicValues, type IntrinsicKind, type Scope } from './intrinsic.js';
import { loadGraphPolicy, type GraphPolicy } from './policy.js';

/**
 * The deriver instructions and answer formats (plan Task 3 Step 5, D14). They state only the
 * procedure and the answer format: no Magic examples, no hints about which types connect, no
 * rules of play. The role and rule definitions are the words of spec sec. 5.1 and 5.3. The owner
 * examines these texts before the first run of each stage. The link test of PAIR_INSTRUCTIONS is
 * the owner decision of 2026-10-18 (spec rev. 17 sec. 5.9, docs/phase-3-link-definition-decision.md);
 * it is procedure, with no card examples.
 */
export const ROLE_INSTRUCTIONS = `You derive the roles and the resource effects of atom types. Use ONLY the text in this packet. Do not use anything that you remember about the game or about a card.

An atom type is a kind of fact that a card text can state. Each entry in "Atom types" gives the family, the type key, the label, the params and the CR rules that the evidence of the type cites.

Do these steps for each type in "Atom types":
1. Read the entry of the type and the CR text for it. The "[for: ...]" lines in "Comprehensive Rules" show which types need each rule.
2. Give the role of the type:
   - supply: an atom of this type makes an object, an event or a value that a different atom can watch or use.
   - demand: an atom of this type watches or uses an object, an event or a value.
   - both: supply and demand.
   - none: neither of the two.
3. For the role demand or both, give a demand note: one sentence that states what the type watches or uses.
4. Give the resource effects: each resource of the "Resources" list that an atom of this type changes. For each effect, give the sign (+ when the atom increases the resource, - when it decreases it) and the kind (cost when the change is a cost that a player pays, value when the change is a result). If the type changes a resource that is not in the list, give the resource "other" with a note that names the resource. If the type changes no resource, give no effect.
5. Give the evidence of the role, and the evidence of each resource effect: one or more items of CR text from this packet. The role none also needs evidence: the CR text from which you decided the role. Copy each quote character for character.
6. Give an item for each type. Only when the CR text in this packet is not sufficient to decide any role, also the role none, do not give an item for the type. Then report the CR text that you need in missing_rules.

Derive each type alone. The role of one type has no effect on the role of a different type.`;

export const PAIR_INSTRUCTIONS = `You derive edge rules. Use ONLY the text in this packet. Do not use anything that you remember about the game or about a card.

An edge rule connects a supply side to the demand type of this batch:
- polarity "+" (synergy): the supply side gives what the demand type watches or uses.
- polarity "-" (anti-synergy): the supply side removes or prevents what the demand type needs.

The link test. A rule with polarity "+" is permitted only when the supply side makes the event, the object or the value that the demand type watches or uses happen more often, for the same player. Before you write a "+" rule, do these five tests. Write the rule only when the supply side passes test 1 and fails none of the tests 2, 3, 4 and 5:
1. Payoff or enabler. The supply side passes when one of these is true:
   - payoff: the demand type watches an event or counts objects, and the supply side makes that event happen or makes those objects;
   - enabler: the demand type uses an object or a value in a cost or in its effect, and the supply side gives that object or value.
2. Definition. The supply side fails when the only CR text that connects the two sides states that one side is a kind, a part, an instance or a way of the other side.
3. Generic resource. The supply side fails when the only thing that it gives is mana, cards in a player's hand or life, and the demand type only pays or uses that resource in a cost or in its effect. A demand type that watches an event or counts objects is not in this test.
4. Direction. The demand type watches or uses objects or a player of its own controller. Then the supply side fails when one of these is true:
   - it acts only on objects or players that an opponent of its controller controls;
   - it acts on a target or targets that its controller chooses. A chosen target is for an opponent of the controller.
   The supply side does not fail this test when it acts on all objects of a kind, or on each player, because then it also acts on the objects of its own controller. When the params of the two types can show the controller or the target, use where predicates or param_links, so that the rule applies only when the two sides are for the same player.
5. Count. This test applies when the demand type needs a count of two or more objects, cards or events (for example "N or more"). The supply side fails when the count needs objects that the player must already have, for example permanents that must already be on the battlefield. A rule must not suppose a game state. The supply side does not fail when it makes the units of the count itself, for example when it creates them or moves them from a library. A demand that changes by the same amount for each object ("for each") is not in this test.
The five tests do not apply to polarity "-".

The demand type is in "Demand type". A supply side is a type from "Supply candidates", or an intrinsic class: one kind from "Intrinsic class kinds and permitted values" with one of its values. An intrinsic class is a fact that comes from the characteristics of a card, not from its text.

Do these steps:
1. Read the entry of the demand type and the CR text for it. The "[for: ...]" lines in "Comprehensive Rules" show which types need each rule.
2. For each supply candidate and each intrinsic class, find out from the CR text in this packet if the supply side gives what the demand type watches or uses, or if it removes or prevents it.
3. For each connection that the CR text in this packet supports, write one rule:
   - where: the predicates on the params of that side. Use only the params and the values of that type in this packet. Give [] when the rule applies to all atoms of the type. An intrinsic class has no params, so it has no where.
   - param_links: pairs of a supply param and a demand param whose values must agree. The supply param is a param of the supply type, and the demand param is a param of the demand type. The two params must permit one or more equal values. An intrinsic class has no param_links.
   - implications: a value that the supply always has for a demand param. Give an implication only when a quote in this packet states that the supply always has that value. Each implication has its own evidence.
   - evidence: one or more items of CR text from this packet that connect the supply side to the demand type. Copy each quote character for character.
4. Do not write a rule when the CR text in this packet does not connect the two sides. Do not write a "+" rule when the supply side does not pass the link test.
5. If you need CR text that is not in this packet, report it in missing_rules. Do not use text from memory.

Derive each supply side alone. A rule for one supply side has no effect on a rule for a different supply side.`;

const EVIDENCE_FORMAT = `EVIDENCE is {"source": "rule", "ref": "R", "quote": "Q"} or {"source": "glossary", "ref": "T", "quote": "Q"}. R is a rule number as this packet shows it. T is a glossary term as this packet shows it. R and T are JSON strings. Q is copied from the text of that rule or glossary entry.
MISSING is {"needed": "N", "rationale": "W"}: N names the CR text that you need, and W states why you need it.`;

export const ROLE_ANSWER_FORMAT = `Write ONE file, response.json, in the directory of this packet. Write it one time. It contains only this JSON object, with no commentary and no code fence:

{"roles": [ROLE, ...], "missing_rules": [MISSING, ...]}

ROLE is {"family": "F", "type_key": "K", "role": "supply" | "demand" | "both" | "none", "demand_note": "N", "resources": [EFFECT, ...], "evidence": [EVIDENCE, ...]}.
- F and K are the family and the type key from "Atom types".
- Give "demand_note" only for the role demand or both.
- EFFECT is {"resource": "R", "sign": "+" | "-", "kind": "cost" | "value", "evidence": [EVIDENCE, ...]}. R is a name from "Resources". When R is "other", add "note": "the name of the resource".
${EVIDENCE_FORMAT}

Give one ROLE for each type in "Atom types", except a type that you report in missing_rules. Give [] for "missing_rules" when you need no other CR text. Use no other fields.`;

export const PAIR_ANSWER_FORMAT = `Write ONE file, response.json, in the directory of this packet. Write it one time. It contains only this JSON object, with no commentary and no code fence:

{"rules": [RULE, ...], "missing_rules": [MISSING, ...]}

RULE is {"polarity": "+" | "-", "supply": SUPPLY, "demand": {"family": "F", "type_key": "K", "where": [PREDICATE, ...]}, "param_links": [{"supply": "P", "demand": "P"}, ...], "implications": [{"demand_param": "P", "value": V, "evidence": [EVIDENCE, ...]}, ...], "evidence": [EVIDENCE, ...]}.
- The demand of each rule is the demand type of this batch.
- SUPPLY is {"family": "F", "type_key": "K", "where": [PREDICATE, ...]} for a supply candidate, or {"intrinsic": "KIND", "value": VALUE} for an intrinsic class, with no other field. KIND and VALUE come from "Intrinsic class kinds and permitted values". A mana_value VALUE is a JSON number. The other values are JSON strings.
- P is a param name from the params of that type. V is a value that the params of that type permit.
- PREDICATE is {"param": "P", "op": OP, "value": V}. OP is one of:
  - "eq": for a param that is not an array: the param value is equal to V.
  - "in": for a param that is not an array: the param value is one of the values in V. V is a JSON array.
  - "overlaps": for an array param: the param array and V have one or more values in common. V is a JSON array.
  - "disjoint": for an array param: the param array and V have no value in common. V is a JSON array.
${EVIDENCE_FORMAT}

Give [] for "rules" when the CR text in this packet supports no rule. Give [] for "missing_rules" when you need no other CR text. Use no other fields.`;

export interface PacketContext {
  corpusId: number;
  schemaVersion: number;
  scope: Scope;
  termPolicy: PacketPolicy;
  graph: GraphPolicy;
}

/** The current corpus and schema, the BR slice and the policy files, unless given. */
export function packetContext(db: DatabaseSync, over: Partial<PacketContext> = {}): PacketContext {
  const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined;
  if (!corpus && over.corpusId === undefined) throw new Error('no current rules corpus - run `npm run sync:rules` first');
  return {
    corpusId: over.corpusId ?? corpus!.id,
    schemaVersion: over.schemaVersion ?? currentSchemaVersion(db),
    scope: over.scope ?? 'BR',
    termPolicy: over.termPolicy ?? loadPacketPolicy(),
    graph: over.graph ?? loadGraphPolicy(),
  };
}

export interface PacketChunk {
  stage: 'roles' | 'pairs';
  batch_key: string;
  chunk: number;
  /** Stage A: the types of the chunk. Stage B: the demand type, then the supply candidates of
   *  the chunk - the demand type can also be one of them. */
  types: string[];
  bytes: number;
  markdown: string;
  /** Plan D16: the exact rule numbers of the rows shown, plus 'glossary:<term>' for each glossary term shown. */
  refs: string[];
}

/** A type's id in packets and batch keys: FAMILY.TYPE_KEY. */
export function typeId(t: { family: string; type_key: string }): string {
  return `${t.family}.${t.type_key}`;
}

/** One compact type entry (spec sec. 5.2): family, type key, label, params schema, evidence references. */
export function renderTypeEntry(e: TypeEntry): string {
  const props = (e.params_schema as { properties?: Record<string, unknown> }).properties ?? {};
  const params = Object.keys(props).length ? ` params: ${JSON.stringify(props)}` : '';
  const evidence = e.evidence_ref.length ? ` evidence: ${e.evidence_ref.map((r) => `CR ${r}`).join(', ')}` : '';
  return `${e.family} ${e.type_key} - ${e.label}${params}${evidence}`;
}

/** Everything a packet needs, read from the database one time for each context. */
interface PacketData {
  store: RowStore;
  ids: string[];
  entries: Map<string, TypeEntry>;
  content: Map<string, CrContent>;
  kernel: CrContent;
  set5: CrContent;
  values: Record<IntrinsicKind, Array<string | number>>;
  classValues: string;
  resources: readonly string[];
  batchRules: GraphPolicy['batch_part_rules'];
}

const dataCache = new WeakMap<PacketContext, PacketData>();

function packetData(db: DatabaseSync, ctx: PacketContext): PacketData {
  const hit = dataCache.get(ctx);
  if (hit) return hit;
  const list = typeEntries(db, ctx.schemaVersion);
  const values = permittedIntrinsicValues(db, ctx.corpusId, ctx.scope);
  const data: PacketData = {
    store: loadRowStore(db, ctx.corpusId),
    ids: list.map(typeId),
    entries: new Map(list.map((e) => [typeId(e), e])),
    content: new Map(list.map((e) => [typeId(e), typeCrContent(db, ctx.corpusId, ctx.schemaVersion, e, ctx.termPolicy)])),
    kernel: withKernel(db, ctx.corpusId, emptyContent()),
    set5: set5CrContent(db, ctx.corpusId),
    values,
    classValues: INTRINSIC_KINDS.map((k) => `${k}: ${values[k].join(', ')}`).join('\n'),
    resources: ctx.graph.resources,
    batchRules: ctx.graph.batch_part_rules,
  };
  dataCache.set(ctx, data);
  return data;
}

const SET5_LABEL = 'intrinsic classes';

/**
 * Assembles one packet. Parts, in order (plan Task 0 Step 8): instructions, type entries, the
 * resource list (Stage A) or the class kinds with their permitted values (Stage B), the CR
 * content rendered once with each rule labelled by what needs it, the answer format.
 */
/**
 * The CR content of `all` types, rendered once with each rule labelled by the types that need
 * it, plus the kernel (and set 5 for Stage B), with the exact references shown.
 */
function renderCr(
  d: PacketData, stage: PacketChunk['stage'], all: string[], labelTypes: string[] = all,
): { text: string; refs: string[]; content: CrContent } {
  const parts = [...new Set(all)].map((t) => d.content.get(t)!);
  const content = mergeContent(d.kernel, ...parts, ...(stage === 'pairs' ? [d.set5] : []));

  const ruleTypes = new Map<string, string[]>();
  const termTypes = new Map<string, string[]>();
  for (const t of new Set(labelTypes)) {
    const c = d.content.get(t)!;
    for (const n of c.rules.keys()) ruleTypes.set(n, [...(ruleTypes.get(n) ?? []), t]);
    for (const g of c.glossary.keys()) termTypes.set(g, [...(termTypes.get(g) ?? []), t]);
  }
  const withSet5 = (labels: string[], inSet5: boolean) =>
    (stage === 'pairs' && inSet5 ? [...labels, SET5_LABEL] : labels).join(', ');
  // A kernel rule keeps the labels of the types that need it (review finding 2).
  const labelOf = (n: string) =>
    withSet5([...(ruleTypes.get(n) ?? []).sort(), ...(d.kernel.rules.has(n) ? ['kernel'] : [])], d.set5.rules.has(n));
  const glossaryLabelOf = (g: string) => withSet5((termTypes.get(g) ?? []).sort(), d.set5.glossary.has(g));
  return { text: renderContent(d.store, content, labelOf, glossaryLabelOf), refs: contentRefs(d.store, content), content };
}

function assemble(
  d: PacketData, stage: PacketChunk['stage'], batchKey: string, chunk: number,
  demand: string | null, typeIds: string[],
): PacketChunk {
  const all = demand ? [demand, ...typeIds] : typeIds;
  const cr = renderCr(d, stage, all);
  const entry = (t: string) => renderTypeEntry(d.entries.get(t)!);
  const typesPart = stage === 'roles'
    ? `# Atom types\n${typeIds.map(entry).join('\n')}`
    : `# Demand type\n${entry(demand!)}\n\n# Supply candidates\n${typeIds.map(entry).join('\n')}`;

  const markdown = [
    `# Edge-rule packet - ${stage === 'roles' ? 'Stage A (roles and resources)' : 'Stage B (pairs)'} - ${batchKey}, chunk ${chunk}`,
    `# Instructions\n${stage === 'roles' ? ROLE_INSTRUCTIONS : PAIR_INSTRUCTIONS}`,
    typesPart,
    stage === 'roles' ? `# Resources\n${d.resources.join(', ')}` : null,
    stage === 'pairs' ? `# Intrinsic class kinds and permitted values\n${d.classValues}` : null,
    `# Comprehensive Rules\n${cr.text}`,
    `# Answer format\n${stage === 'roles' ? ROLE_ANSWER_FORMAT : PAIR_ANSWER_FORMAT}`,
  ].filter((p) => p !== null).join('\n\n') + '\n';

  return { stage, batch_key: batchKey, chunk, types: all, bytes: Buffer.byteLength(markdown, 'utf8'), markdown, refs: cr.refs };
}

/**
 * Splits `ids` into consecutive chunks, each the longest run that fits the budget. A packet
 * only grows when a type is added, so a binary search finds each run.
 */
function splitToFit(ids: string[], budget: number, make: (sub: string[], chunk: number) => PacketChunk): PacketChunk[] {
  const out: PacketChunk[] = [];
  for (let i = 0; i < ids.length;) {
    let lo = 1;
    let hi = ids.length - i;
    let best: { chunk: PacketChunk; n: number } | null = null;
    let first = true;
    while (lo <= hi) {
      const mid = first ? hi : Math.floor((lo + hi) / 2);    // try the whole rest first
      first = false;
      const c = make(ids.slice(i, i + mid), out.length);
      if (c.bytes <= budget) { best = { chunk: c, n: mid }; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) throw new Error(`the type ${ids[i]} alone makes a packet larger than ${budget} bytes`);
    out.push(best.chunk);
    i += best.n;
  }
  return out;
}

/**
 * spec sec. 5.2, Stage A: all types in one packet if it fits. If not, one batch for each family,
 * and a family that is too large splits into consecutive groups of type keys. Each chunk has
 * the full kernel and the CR content of its own types. `exclude` leaves types out: the
 * coverage gaps, which a gap blocks (spec sec. 5.2).
 */
export function planRolePackets(db: DatabaseSync, ctx: PacketContext, exclude: ReadonlySet<string> = new Set()): PacketChunk[] {
  const d = packetData(db, ctx);
  const budget = ctx.graph.packet_budget_bytes;
  const ids = d.ids.filter((t) => !exclude.has(t));
  const whole = assemble(d, 'roles', 'all', 0, null, ids);
  if (whole.bytes <= budget) return [whole];
  const families = [...new Set(ids.map((t) => d.entries.get(t)!.family))];
  return families.flatMap((f) =>
    splitToFit(ids.filter((t) => d.entries.get(t)!.family === f), budget, (sub, k) => assemble(d, 'roles', f, k, null, sub)));
}

/**
 * spec sec. 5.2-5.3, Stage B: one batch for a demand type. The supply candidates split into
 * chunks; each chunk has the kernel, the full CR content of the demand type, the class kinds
 * with their permitted values, and set 5 one time.
 */
export function planPairPackets(
  db: DatabaseSync, ctx: PacketContext, demand: { family: string; type_key: string }, supply: string[],
): PacketChunk[] {
  const d = packetData(db, ctx);
  const id = typeId(demand);
  if (!d.entries.has(id)) throw new Error(`schema v${ctx.schemaVersion} has no type ${id}`);
  const unknown = supply.filter((s) => !d.entries.has(s));
  if (unknown.length) throw new Error(`unknown supply types: ${unknown.join(', ')}`);
  return splitToFit(supply, ctx.graph.packet_budget_bytes, (sub, k) => assemble(d, 'pairs', id, k, id, sub));
}

// ---- two-part Stage B packets (spec rev. 10 sec. 5.2) -------------------------------------------

/**
 * A fixed part of the Stage B packets of a set: the class kinds with their permitted values, and
 * the kernel, set 5 and the CR content of `types`. Each rule is labelled by the `labelTypes` that
 * need it, as a single-part packet labels it by its demand type and its candidates. The generated
 * agents carry a fixed part in their system prompt (`pairFixed.ts`), so the prompt cache keeps
 * one copy for all passes of all batches.
 */
export interface SharedPart {
  /** The supply types whose CR content the part has (a deriver group), or all types (debaters). */
  types: string[];
  /** The "Comprehensive Rules" part. */
  markdown: string;
  /** The "Intrinsic class kinds and permitted values" part. A deriver batch part shows it after
   *  the supply candidates, where a single-part packet shows it (A/B finding of 2026-10-13). */
  classes: string;
  refs: string[];
  bytes: number;
  content: CrContent;
}

export function planSharedPart(
  db: DatabaseSync, ctx: PacketContext, types: Iterable<string>, labelTypes: Iterable<string> = types,
): SharedPart {
  const d = packetData(db, ctx);
  const want = new Set(types);
  const labels = new Set([...want, ...labelTypes]);
  const unknown = [...labels].filter((t) => !d.entries.has(t));
  if (unknown.length) throw new Error(`unknown types: ${unknown.join(', ')}`);
  const ids = d.ids.filter((t) => want.has(t));
  const cr = renderCr(d, 'pairs', ids, d.ids.filter((t) => labels.has(t)));
  const markdown = `# Comprehensive Rules\n${cr.text}`;
  const classes = `# Intrinsic class kinds and permitted values\n${d.classValues}`;
  return { types: ids, markdown, classes, refs: cr.refs, bytes: Buffer.byteLength(markdown, 'utf8'), content: cr.content };
}

/**
 * The deriver groups of a set: the supply types in consecutive groups, so that each fixed part
 * fits `budget` and the largest part is as small as possible. Each fixed part labels its rules
 * by its group and by all `demand` types. The group count is the least count that fits.
 */
export function planSupplyGroups(
  db: DatabaseSync, ctx: PacketContext, supply: string[], demand: string[], budget: number,
): SharedPart[] {
  const d = packetData(db, ctx);
  const ids = d.ids.filter((t) => supply.includes(t));
  const part = (sub: string[]) => planSharedPart(db, ctx, sub, demand);
  // Greedy groups of at most `limit` bytes; a part only grows when a type is added.
  const greedy = (limit: number): SharedPart[] | null => {
    const out: SharedPart[] = [];
    for (let i = 0; i < ids.length;) {
      let lo = 1;
      let hi = ids.length - i;
      let best: SharedPart | null = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const p = part(ids.slice(i, i + mid));
        if (p.bytes <= limit) { best = p; lo = mid + 1; } else hi = mid - 1;
      }
      if (!best) return null;
      out.push(best);
      i += best.types.length;
    }
    return out;
  };
  const first = greedy(budget);
  if (!first) throw new Error(`a supply type alone makes a fixed part larger than ${budget} bytes`);
  if (first.length <= 1) return first;
  // Balance: the least limit (to 1 KB) that still gives the same group count.
  let lo = Math.max(...first.map((p) => p.bytes)) / first.length;
  let hi = budget;
  let best = first;
  while (hi - lo > 1024) {
    const mid = Math.floor((lo + hi) / 2);
    const g = greedy(mid);
    if (g && g.length <= first.length) { best = g; hi = mid; } else lo = mid;
  }
  return best;
}

/** The first line of each batch part, so that a reader can tell it from a single-part packet. */
export const BATCH_PART_TITLE = '# Edge-rule packet, batch part';
/** The heading of the CR text of a batch part. */
export const BATCH_CR_HEADING = '# Comprehensive Rules (batch part)';

/** The type entries of a debate batch part: the demand type, then the supply candidates. */
export function renderBatchTypes(db: DatabaseSync, schemaVersion: number, demand: string, supply: string[]): string {
  const entries = new Map(typeEntries(db, schemaVersion).map((e) => [typeId(e), e]));
  const entry = (t: string) => {
    const e = entries.get(t);
    if (!e) throw new Error(`schema v${schemaVersion} has no type ${t}`);
    return renderTypeEntry(e);
  };
  return `# Demand type\n${entry(demand)}\n\n# Supply candidates\n${supply.map(entry).join('\n')}`;
}

/**
 * The CR content of the demand type that the fixed part does not have, labelled by the demand
 * type. A single-part packet shows this content because it has the demand type. Each policy rule
 * that a candidate of this part needs (`batch_part_rules`) is here too, labelled by those candidates.
 */
function demandExtra(d: PacketData, demand: string, supply: readonly string[], shared: SharedPart): { text: string; refs: string[] } {
  const c = d.content.get(demand)!;
  const rest: CrContent = {
    rules: new Map([...c.rules].filter(([n]) => !shared.content.rules.has(n) && d.store.rows.has(n))),
    glossary: new Map([...c.glossary].filter(([g]) => !shared.content.glossary.has(g))),
  };
  const neededBy = new Map<string, string[]>();
  for (const { rule, types } of d.batchRules) {
    const need = types.filter((t) => supply.includes(t));
    if (need.length === 0 || shared.content.rules.has(rule) || !d.store.rows.has(rule)) continue;
    rest.rules.set(rule, new Set(['type_evidence']));
    neededBy.set(rule, need);
  }
  if (rest.rules.size === 0 && rest.glossary.size === 0) return { text: '', refs: [] };
  return { text: renderContent(d.store, rest, (n) => neededBy.get(n)?.join(', ') ?? demand, () => demand), refs: contentRefs(d.store, rest) };
}

/**
 * The batch part of one demand type for one deriver group: the demand type, the CR content of
 * the demand type that the fixed part does not have, and the candidates of the group. The refs
 * are the refs of the fixed part and of that CR content: the deriver sees both.
 */
export function planPairBatchPart(
  db: DatabaseSync, ctx: PacketContext, demand: string, supply: string[], shared: SharedPart, group: number,
): PacketChunk {
  const d = packetData(db, ctx);
  if (!d.entries.has(demand)) throw new Error(`schema v${ctx.schemaVersion} has no type ${demand}`);
  const unknown = supply.filter((s) => !d.entries.has(s));
  if (unknown.length) throw new Error(`unknown supply types: ${unknown.join(', ')}`);
  const extra = demandExtra(d, demand, supply, shared);
  // The order of a single-part packet: demand type, supply candidates, class kinds, CR text.
  const markdown = [
    `${BATCH_PART_TITLE} - Stage B (pairs) - ${demand}, group ${group}`,
    `# Demand type\n${renderTypeEntry(d.entries.get(demand)!)}`,
    `# Supply candidates\n${supply.map((t) => renderTypeEntry(d.entries.get(t)!)).join('\n')}`,
    shared.classes,
    extra.text ? `${BATCH_CR_HEADING}\n${extra.text}` : null,
  ].filter((p) => p !== null).join('\n\n') + '\n';
  return {
    stage: 'pairs', batch_key: demand, chunk: group, types: [demand, ...supply],
    bytes: Buffer.byteLength(markdown, 'utf8'), markdown, refs: [...new Set([...shared.refs, ...extra.refs])].sort(),
  };
}

export interface MeasureReport {
  roles: PacketChunk[];
  /** The lower bound of plan D6: one batch for each CARES_ABOUT type. Markdown kept. */
  pairsLower: PacketChunk[];
  /** The spec bound of sec. 16 (CARES_ABOUT plus ENABLES) and the full bound (all types).
   *  The batches outside the lower bound carry sizes and refs only: their markdown is ''. */
  pairsSpec: PacketChunk[];
  pairsFull: PacketChunk[];
  set5Bytes: number;
  /** The class values of the scope, as each Stage B chunk carries them. */
  values: Record<IntrinsicKind, Array<string | number>>;
  gaps: Array<{ family: string; type_key: string }>;
  runs: { lower: number; spec: number; full: number };
}

/**
 * plan Task 0 and D6: Stage B is measured before Stage A has given roles, so the demand types
 * are not known. Each batch here takes all types as supply candidates.
 */
export function measurePackets(
  db: DatabaseSync, ctx: PacketContext, onBatch?: (done: number, total: number) => void,
): MeasureReport {
  const d = packetData(db, ctx);
  const roles = planRolePackets(db, ctx);
  const family = (t: string) => d.entries.get(t)!.family;
  const full: PacketChunk[] = [];
  d.ids.forEach((t, i) => {
    const keep = family(t) === 'CARES_ABOUT';
    for (const c of planPairPackets(db, ctx, d.entries.get(t)!, d.ids)) full.push(keep ? c : { ...c, markdown: '' });
    onBatch?.(i + 1, d.ids.length);
  });
  const pairsLower = full.filter((c) => family(c.batch_key) === 'CARES_ABOUT');
  const pairsSpec = full.filter((c) => ['CARES_ABOUT', 'ENABLES'].includes(family(c.batch_key)));
  const set5 = renderContent(d.store, d.set5, () => '', () => '');
  return {
    roles, pairsLower, pairsSpec, pairsFull: full,
    set5Bytes: Buffer.byteLength(`${d.classValues}\n${set5}`, 'utf8'),
    values: d.values,
    gaps: d.ids.filter((t) => isCoverageGap(d.content.get(t)!)).map((t) => { const e = d.entries.get(t)!; return { family: e.family, type_key: e.type_key }; }),
    runs: {
      lower: 3 * (roles.length + pairsLower.length),
      spec: 3 * (roles.length + pairsSpec.length),
      full: 3 * (roles.length + full.length),
    },
  };
}
