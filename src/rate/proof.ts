/**
 * Proof classes of the card rate (card rate plan Task 3). A pair of cards in one group gets one
 * class. `dominated_in_pool` is a proof: only it can support a hard cut. A pair class reads the two
 * whole cards, so a pair in two groups has one class. A card also gets one class, because the rate
 * formula reads it. A field that the rules cannot read fails the proof: it never gets a default.
 * The links come in as `LinkSource`, so this file calls nothing in `src/graph`. It changes no table.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cardFields, compareSpeed, readBuildCards, type AtomFields, type RateFace, type Speed, type TargetLimit } from './fields.js';
import { isCostAtom, kindKey, typeTest, type AtomTest, type GroupInput, type RewardAtom, type RewardGroup, type TypeRole } from './groups.js';

export type PairClass = 'dominated_in_pool' | 'conditional' | 'not_comparable';
export type CardClassName = 'conditional' | 'dominated_in_pool' | 'plain';

export interface ProofFace extends RateFace { mana_cost: string | null; power: string | null; toughness: string | null }
export interface ProofCard {
  oracle_id: string; name: string; layout: string; color_identity: string[]; faces: ProofFace[];
  atoms: RewardAtom[]; fields: Map<number, AtomFields>; speed: Speed[];
}

/** The links of one card in a build. */
export interface LinkFacts {
  /** The cards with a `+` pair from this card, and the cards with a `+` pair into this card. */
  out: ReadonlySet<string>; in: ReadonlySet<string>;
  /** The cards with a `-` pair with this card. */
  anti: ReadonlySet<string>;
  /** The classes with a `+` edge into a demand atom of this card. */
  class_in: ReadonlySet<string>;
  /** The classes that hold this card and have a `+` edge into a demand atom of any card. */
  class_of: ReadonlySet<string>;
}
export type LinkSource = (oracleId: string) => LinkFacts;

export interface ProofContext {
  cards: ReadonlyMap<string, ProofCard>;
  /** The reward rule of Task 2. A bigger size is better on a reward atom. */
  reward: AtomTest;
  /** A condition that the deck must supply. */
  condition: AtomTest;
  links: LinkSource;
}

export interface PairResult {
  /** The stronger card of a proof. On other classes: the lower `oracle_id`. */
  a: string; b: string;
  class: PairClass;
  reason: string;
  /** A proof, or a field check that passed before the link check: the fields where `a` is better. */
  gains: string[];
  /** The links that the weaker card has and `a` lacks, when the link check fails the proof. */
  link_gap: string[];
}

export interface CardClass { oracle_id: string; class: CardClassName; reason: string | null }

const NUMBER_WORD: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WORDS = Object.keys(NUMBER_WORD).join('|');
const NUMBER = new RegExp(`\\d+|\\bX\\b|\\b(?:${WORDS})\\b`, 'gi');

/** The target count of a quote. Null: the rule cannot read it. `up to two` is 0 to 2, and a quote with no word "target" is 0. */
export interface TargetCount { min: number; max: number }

/** What the words before one `target` say. Null: not a count that the rule can read. */
function countBefore(before: string): TargetCount | null {
  const tail = before.replace(/(?:other|another|additional)\s+$/, '');
  if (/\bany number of\s+$/.test(tail)) return null;
  if (/\b(?:that|the|its|new|each|or|and\/or|chosen|same)\s+$/.test(tail) && !new RegExp(`\\b(?:${WORDS}) or (?:${WORDS})\\s+$`).test(tail)) return null;
  const upTo = /\bup to (\w+)\s+$/.exec(tail);
  if (upTo) { const n = NUMBER_WORD[upTo[1]!] ?? (/^\d+$/.test(upTo[1]!) ? Number(upTo[1]) : null); return n === null ? null : { min: 0, max: n }; }
  const range = new RegExp(`\\b(${WORDS}) or (${WORDS})\\s+$`).exec(tail);
  if (range) return { min: NUMBER_WORD[range[1]!]!, max: NUMBER_WORD[range[2]!]! };
  if (/\bX\s+$/i.test(tail)) return null;
  const word = new RegExp(`\\b(${WORDS})\\s+$`).exec(tail);
  const digits = /\b(\d+)\s+$/.exec(tail);
  const n = word ? NUMBER_WORD[word[1]!]! : digits ? Number(digits[1]) : 1;
  return { min: n, max: n };
}

/** Each word "target" adds to the count. A verb ("that targets") and a word that points back ("that target") stay unread. */
export function targetCount(quote: string): TargetCount | null {
  const text = quote.replace(/\s*\([^)]*\)/g, '').toLowerCase();
  const total = { min: 0, max: 0 };
  for (const m of text.matchAll(/\btargets?\b/g)) {
    const c = countBefore(text.slice(0, m.index));
    if (!c) return null;
    total.min += c.min;
    total.max += c.max;
  }
  return total;
}

const sameCount = (a: TargetCount | null, b: TargetCount | null) => a !== null && b !== null && a.min === b.min && a.max === b.max;

/** The text of a card or quote as a proof reads it: no reminder text, `~` for the names, one space. Numbers stay. */
export function bareWords(text: string, names: readonly string[]): string {
  let s = text.replace(/\s*\([^)]*\)/g, '');
  for (const n of names) s = s.split(n).join('~');
  return s.replace(/\s+/g, ' ').trim();
}

/** The words with each number masked as `N`, number words too. */
export function maskNumbers(words: string): string {
  return words.replace(NUMBER, 'N');
}

/** The numbers of a text, in order. `X` stays a word, so it agrees only with `X`. */
function numbersOf(words: string): Array<number | string> {
  return (words.match(NUMBER) ?? []).map((n) => (/^\d+$/.test(n) ? Number(n) : NUMBER_WORD[n.toLowerCase()] ?? n));
}

const namesOf = (c: ProofCard) => [...c.name.split(' // '), ...c.faces.map((f) => f.name)];

interface Cost { generic: number; colours: Record<string, number> }

/** A face cost as numbers. Null: an `{X}`, a hybrid or another symbol that the rule cannot read. */
function parseCost(cost: string | null): Cost | null {
  const c: Cost = { generic: 0, colours: {} };
  for (const s of (cost ?? '').match(/\{[^}]+\}/g) ?? []) {
    const inner = s.slice(1, -1);
    if (/^\d+$/.test(inner)) c.generic += Number(inner);
    else if (/^[WUBRGC]$/.test(inner)) c.colours[inner] = (c.colours[inner] ?? 0) + 1;
    else return null;
  }
  return c;
}

const manaValue = (c: Cost) => c.generic + Object.values(c.colours).reduce((s, n) => s + n, 0);
const isSubset = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));

/** One step of a compare: 1 `a` is better, -1 `b` is better, 0 the same, null a trade or an unread part. */
type Order = 1 | 0 | -1 | null;

function merge(steps: readonly Order[]): Order {
  let result: Order = 0;
  for (const s of steps) {
    if (s === null) return null;
    if (s === 0) continue;
    if (result !== 0 && result !== s) return null;
    result = s;
  }
  return result;
}

const sign = (n: number): Order => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Cost of `a` against `b`: mana value, each coloured symbol and the colours. Two equal cost strings need no parse. */
export function costOrder(a: Pick<ProofCard, 'faces' | 'color_identity'>, b: Pick<ProofCard, 'faces' | 'color_identity'>): Order {
  if (a.faces.length !== b.faces.length) return null;
  const steps: Order[] = [];
  for (const [i, fa] of a.faces.entries()) {
    const fb = b.faces[i]!;
    if ((fa.mana_cost ?? '') === (fb.mana_cost ?? '')) continue;
    const x = parseCost(fa.mana_cost);
    const y = parseCost(fb.mana_cost);
    if (!x || !y) return null;
    steps.push(sign(manaValue(y) - manaValue(x)));
    for (const k of new Set([...Object.keys(x.colours), ...Object.keys(y.colours)])) steps.push(sign((y.colours[k] ?? 0) - (x.colours[k] ?? 0)));
  }
  const ca = a.color_identity;
  const cb = b.color_identity;
  steps.push(ca.length === cb.length && isSubset(ca, cb) ? 0 : isSubset(ca, cb) ? 1 : isSubset(cb, ca) ? -1 : null);
  return merge(steps);
}

/** Power and toughness of `a` against `b`. Two equal values need no parse, so `*` agrees only with `*`. */
export function bodyOrder(a: Pick<ProofCard, 'faces'>, b: Pick<ProofCard, 'faces'>): Order {
  const steps: Order[] = [];
  for (const [i, fa] of a.faces.entries()) {
    const fb = b.faces[i];
    if (!fb) return null;
    for (const [x, y] of [[fa.power, fb.power], [fa.toughness, fb.toughness]] as const) {
      if (x === y) continue;
      steps.push(x !== null && y !== null && /^\d+$/.test(x) && /^\d+$/.test(y) ? sign(Number(x) - Number(y)) : null);
    }
  }
  return merge(steps);
}

/** Speed of `a` against `b`, over the faces in order. Null: a null from `compareSpeed`, or each card wins on one face. */
export function speedOrder(a: Pick<ProofCard, 'speed'>, b: Pick<ProofCard, 'speed'>): Order {
  if (a.speed.length !== b.speed.length) return null;
  return merge(a.speed.map((s, i) => compareSpeed(s, b.speed[i]!)));
}

/** Target limit of `a` against `b` on one head: no limit is wider, and two number limits compare by value. Other words stay unread. */
export function limitOrder(x: TargetLimit | null, y: TargetLimit | null): Order {
  if (!x || !y || x.head !== y.head) return null;
  if (x.limit === y.limit) return 0;
  if (x.limit === null) return 1;
  if (y.limit === null) return -1;
  const [p, q] = [x.number, y.number];
  if (!p || !q || p.stat !== q.stat || p.bound !== q.bound) return null;
  if (x.limit.replace(/\d+/, 'N') !== y.limit.replace(/\d+/, 'N')) return null;
  return p.bound === 'max' ? sign(p.value - q.value) : sign(q.value - p.value);
}

/** 1: a bigger size is better. -1: a smaller size is better. Null: the rule does not know. */
function sizeDirection(a: RewardAtom, reward: AtomTest): 1 | -1 | null {
  if (isCostAtom(a)) return -1;
  return reward(a) ? 1 : null;
}

interface AtomStep { order: Order; gains: string[]; read: Array<[number, number]>; drop_b: string | null }

const AMOUNT = (a: RewardAtom) => (typeof a.params['amount'] === 'number' ? a.params['amount'] : null);

/** The size fields of one aligned atom pair, with the direction of each. */
function sizeSteps(x: RewardAtom, y: RewardAtom, fx: AtomFields, fy: AtomFields, reward: AtomTest): Array<{ name: string; order: Order; x: number | null; y: number | null }> {
  const more = sizeDirection(x, reward) === sizeDirection(y, reward) ? sizeDirection(x, reward) : null;
  const stat = (v: number | null) => (v === null ? null : Math.abs(v));
  const signed = x.params['sign'] === y.params['sign'] && ['+', '-'].includes(String(x.params['sign'])) || x.params['removal_type'] === 'minus';
  const rows: Array<[string, number | null, number | null, boolean]> = [
    ['amount', AMOUNT(x), AMOUNT(y), true],
    ['stat power', stat(fx.stat_power), stat(fy.stat_power), signed],
    ['stat toughness', stat(fx.stat_toughness), stat(fy.stat_toughness), signed],
    ['token power', fx.token_power, fy.token_power, true],
    ['token toughness', fx.token_toughness, fy.token_toughness, true],
    ['mana amount', fx.mana_amount, fy.mana_amount, true],
  ];
  return rows.filter(([, a, b]) => a !== null || b !== null).map(([name, a, b, known]) => ({
    name, x: a, y: b,
    order: a === null || b === null || !known ? null : a === b ? 0 : more === null ? null : (sign(a - b) === 1 ? more : more === 1 ? -1 : 1) as Order,
  }));
}

/** Each number that differs between two quotes is a size that a field read. */
function numbersRead(qx: string, qy: string, read: ReadonlyArray<[number, number]>): boolean {
  const nx = numbersOf(qx);
  const ny = numbersOf(qy);
  return nx.length === ny.length && nx.every((n, i) => n === ny[i] || read.some(([p, q]) => p === n && q === ny[i]));
}

/** One aligned atom pair. The same words give the same value of each field, so a null field then does no harm. */
function atomStep(x: RewardAtom, y: RewardAtom, a: ProofCard, b: ProofCard, reward: AtomTest): AtomStep {
  const qx = bareWords(x.quote, namesOf(a));
  const qy = bareWords(y.quote, namesOf(b));
  const none: AtomStep = { order: 0, gains: [], read: [], drop_b: null };
  if (qx === qy) return none;
  if (!sameCount(targetCount(x.quote), targetCount(y.quote))) return { ...none, order: null };
  const fx = a.fields.get(x.id)!;
  const fy = b.fields.get(y.id)!;
  const steps = sizeSteps(x, y, fx, fy, reward);
  const read = steps.flatMap((s) => (s.x !== null && s.y !== null ? [[s.x, s.y] as [number, number]] : []));
  const gains = steps.filter((s) => s.order === 1).map((s) => `${s.name} ${s.x} against ${s.y}`);
  const order = [...steps.map((s) => s.order)];
  let drop_b: string | null = null;
  if (fx.target_limit || fy.target_limit) {
    const l = limitOrder(fx.target_limit, fy.target_limit);
    order.push(l);
    const [p, q] = [fx.target_limit?.number, fy.target_limit?.number];
    if (l !== null && l !== 0 && p && q) read.push([p.value, q.value]);
    else if (l === 1) drop_b = fy.target_limit!.limit;
    if (l === 1) gains.push(`target limit "${fx.target_limit!.limit ?? 'none'}" against "${fy.target_limit!.limit}"`);
  }
  const merged = merge(order);
  if (merged === null) return { ...none, order: null };
  return { order: merged, gains: merged === 1 ? gains : [], read, drop_b };
}

/** The atoms of two cards with one key, as pairs in order. An atom with no partner stays out. */
export function alignAtoms(a: readonly RewardAtom[], b: readonly RewardAtom[]): Array<[RewardAtom, RewardAtom]> {
  const byKey = new Map<string, RewardAtom[]>();
  for (const y of b) byKey.set(kindKey(y), [...(byKey.get(kindKey(y)) ?? []), y]);
  const pairs: Array<[RewardAtom, RewardAtom]> = [];
  for (const x of a) {
    const list = byKey.get(kindKey(x));
    if (list?.length) pairs.push([x, list.shift()!]);
  }
  return pairs;
}

/** One change to a card text before the compare: the words of `from` become `to`. */
type Swap = readonly [from: string, to: string];

/** The words that a speed axis proves: the better card has the keyword, or the weaker card has the limit. */
function speedSwaps(a: ProofCard, b: ProofCard): { a: Swap[]; b: Swap[] } {
  const axis = (c: ProofCard, key: string): Swap[] => c.atoms.filter((x) => `${x.family}.${x.type_key}` === key).map((x) => [bareWords(x.quote, namesOf(c)), '']);
  const out: { a: Swap[]; b: Swap[] } = { a: [], b: [] };
  for (const [i, s] of a.speed.entries()) {
    const t = b.speed[i]!;
    if (s.cast === 'instant' && t.cast === 'sorcery') out.a.push(...axis(a, 'ENABLES.FLASH'));
    if (s.wait === 'now' && t.wait === 'next_turn') out.a.push(...axis(a, 'COMBAT.HASTE'));
    if (s.tapped === false && t.tapped === true) out.b.push(...axis(b, 'CONSTRAINTS.ENTERS_TAPPED'));
    if (!s.ability_limit && t.ability_limit) out.b.push(...axis(b, 'CONSTRAINTS.TIMING'));
  }
  return out;
}

/** The whole text of a card as a proof compares it, after the swaps. */
function proofText(c: ProofCard, swaps: readonly Swap[]): string {
  const names = namesOf(c);
  return c.faces.map((f) => swaps.reduce((s, [from, to]) => s.split(from).join(to), bareWords(f.oracle_text, names))
    .replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim()).join(' // ');
}

/** The types with a printed number that the card record does not hold. */
const UNREAD_SIZE = /\b(?:Planeswalker|Battle)\b/;

/** The stages of the field check, in order. A pair keeps the reason of the order that passed more stages. */
const STAGES = ['faces_differ', 'type_words', 'unread_size', 'cost_order', 'cost_higher', 'body_order', 'body_lower', 'slower', 'unread_field', 'field_lower', 'text_differs', 'no_gain'] as const;
export type FieldReason = typeof STAGES[number];

export type FieldResult = { ok: true; gains: string[] } | { ok: false; reason: FieldReason };

/** The field check of the ordered pair: is `a` equal or better on each read field, and better on one? */
export function fieldCheck(a: ProofCard, b: ProofCard, reward: AtomTest): FieldResult {
  const fail = (reason: FieldReason): FieldResult => ({ ok: false, reason });
  if (a.layout !== b.layout || a.faces.length !== b.faces.length) return fail('faces_differ');
  if (a.faces.some((f, i) => f.type_line !== b.faces[i]!.type_line)) return fail('type_words');
  if (a.faces.some((f) => UNREAD_SIZE.test(f.type_line))) return fail('unread_size');
  const cost = costOrder(a, b);
  if (cost === null) return fail('cost_order');
  if (cost === -1) return fail('cost_higher');
  const body = bodyOrder(a, b);
  if (body === null) return fail('body_order');
  if (body === -1) return fail('body_lower');
  const speed = speedOrder(a, b);
  if (speed === null || speed === -1) return fail('slower');

  const gains: string[] = [];
  if (cost === 1) gains.push('cost');
  if (body === 1) gains.push('power or toughness');
  if (speed === 1) gains.push('speed');
  const swaps = speed === 1 ? speedSwaps(a, b) : { a: [], b: [] };
  const read: Array<[number, number]> = [];
  const differ: Array<[string, string]> = [];
  for (const [x, y] of alignAtoms(a.atoms, b.atoms)) {
    const s = atomStep(x, y, a, b, reward);
    if (s.order === null) return fail('unread_field');
    if (s.order === -1) return fail('field_lower');
    const qx = bareWords(x.quote, namesOf(a));
    const qy = bareWords(y.quote, namesOf(b));
    if (qx === qy) continue;
    gains.push(...s.gains);
    read.push(...s.read);
    if (s.drop_b) swaps.b.push([qy, qy.split(s.drop_b).join('')]);
    else differ.push([qx, qy]);
  }
  // Two atoms can quote one sentence, and one field is sufficient to read each number of it.
  if (differ.some(([qx, qy]) => !numbersRead(qx, qy, read))) return fail('unread_field');
  for (const [qx, qy] of differ) {
    swaps.a.push([qx, maskNumbers(qx)]);
    swaps.b.push([qy, maskNumbers(qy)]);
  }
  if (proofText(a, swaps.a) !== proofText(b, swaps.b)) return fail('text_differs');
  return gains.length ? { ok: true, gains: [...new Set(gains)] } : fail('no_gain');
}

/** The links of `b` that `a` lacks, as short text. The two cards count as one card here. The `-` pairs go the other way: `a` must have none that `b` lacks. */
export function linkGap(a: ProofCard, b: ProofCard, links: LinkSource): string[] {
  const la = links(a.oracle_id);
  const lb = links(b.oracle_id);
  const here = (s: ReadonlySet<string>) => new Set([...s].map((id) => (id === a.oracle_id || id === b.oracle_id ? 'this pair' : id)));
  const lacks = (want: ReadonlySet<string>, have: ReadonlySet<string>, name: string) => {
    const got = here(have);
    return [...here(want)].filter((x) => !got.has(x)).map((x) => `${name} ${x}`);
  };
  return [
    ...lacks(lb.out, la.out, 'out'), ...lacks(lb.in, la.in, 'in'), ...lacks(la.anti, lb.anti, 'anti'),
    ...[...lb.class_in].filter((c) => !la.class_in.has(c)).map((c) => `class_in ${c}`),
    ...[...lb.class_of].filter((c) => !la.class_of.has(c)).map((c) => `class_of ${c}`),
  ];
}

const faceHasCost = (c: ProofCard, faceIndex: number) => Boolean(c.faces.find((f) => f.face_index === faceIndex)?.mana_cost);

/** The class of one pair. The first three steps stop at a break of the brief, and each such pair stays `not_comparable`. */
export function classifyPair(x: ProofCard, y: ProofCard, ctx: Pick<ProofContext, 'reward' | 'condition' | 'links'>): PairResult {
  const [lo, hi] = x.oracle_id < y.oracle_id ? [x, y] : [y, x];
  const result = (cls: PairClass, reason: string): PairResult => ({ a: lo.oracle_id, b: hi.oracle_id, class: cls, reason, gains: [], link_gap: [] });
  const aligned = alignAtoms(lo.atoms, hi.atoms);

  // Plan sec. 2.1, Task 2 Q5: a reward on a face with no cost has no price to compare.
  if (aligned.some(([p, q]) => (ctx.reward(p) && !faceHasCost(lo, p.face_index)) || (ctx.reward(q) && !faceHasCost(hi, q.face_index)))) return result('not_comparable', 'face_no_cost');
  const speed = speedOrder(lo, hi);
  if (speed === null) return result('not_comparable', 'speed_null');
  const cost = costOrder(lo, hi);
  if (speed !== 0 && cost !== null && cost !== 0 && speed !== cost) return result('not_comparable', 'speed_against_cost');
  for (const [p, q] of aligned) {
    const lp = lo.fields.get(p.id)?.target_limit;
    const lq = hi.fields.get(q.id)?.target_limit;
    if (lp && lq && lp.head !== lq.head) return result('not_comparable', 'target_head');
    const cp = targetCount(p.quote);
    const cq = targetCount(q.quote);
    if (cp && cq && !sameCount(cp, cq)) return result('not_comparable', 'target_count');
  }

  const need = (c: ProofCard, other: ProofCard) => {
    const keys = new Set(other.atoms.map(kindKey));
    return c.atoms.find((a) => ctx.condition(a) && !keys.has(kindKey(a)));
  };
  const missing = need(lo, hi) ?? need(hi, lo);
  if (missing) return result('conditional', `${missing.family}.${missing.type_key}`);

  const forward = fieldCheck(lo, hi, ctx.reward);
  const back = fieldCheck(hi, lo, ctx.reward);
  const pass = forward.ok ? { strong: lo, weak: hi, r: forward } : back.ok ? { strong: hi, weak: lo, r: back } : null;
  if (pass) {
    const gap = linkGap(pass.strong, pass.weak, ctx.links);
    const base = { a: pass.strong.oracle_id, b: pass.weak.oracle_id, gains: pass.r.gains };
    return gap.length ? { ...base, class: 'not_comparable', reason: 'link_gap', link_gap: gap } : { ...base, class: 'dominated_in_pool', reason: 'proof', link_gap: [] };
  }
  const reasons = [forward, back].map((r) => (r.ok ? 'no_gain' : r.reason));
  return result('not_comparable', reasons.sort((p, q) => STAGES.indexOf(q) - STAGES.indexOf(p))[0]!);
}

export interface ProofRun {
  /** One result for each card pair that shares a group. */
  pairs: Map<string, PairResult>;
  /** The count of pair and group rows of each class. A pair in two groups counts twice here. */
  rows: Record<PairClass, number>;
}

/** Each pair of each group of two or more cards. A pair in two groups keeps one class, because the class reads the whole cards. */
export function classifyGroups(groups: readonly RewardGroup[], ctx: ProofContext): ProofRun {
  const pairs = new Map<string, PairResult>();
  const rows: Record<PairClass, number> = { dominated_in_pool: 0, conditional: 0, not_comparable: 0 };
  for (const g of groups) {
    for (const [i, p] of g.members.entries()) {
      for (const q of g.members.slice(i + 1)) {
        const key = p.oracle_id < q.oracle_id ? `${p.oracle_id}|${q.oracle_id}` : `${q.oracle_id}|${p.oracle_id}`;
        let r = pairs.get(key);
        if (!r) { r = classifyPair(ctx.cards.get(p.oracle_id)!, ctx.cards.get(q.oracle_id)!, ctx); pairs.set(key, r); }
        rows[r.class]++;
      }
    }
  }
  return { pairs, rows };
}

/** The rule of the brief: an atom of a type with the accepted role `demand`. */
export function demandTest(roles: readonly TypeRole[]): AtomTest {
  return typeTest(roles, (r) => r.status === 'accepted' && r.role === 'demand');
}

/** The params that name who supplies an event. */
const SUPPLIER_PARAMS: readonly string[] = ['controller', 'whose', 'player'];

/**
 * The narrower rule: a demand atom that the deck must supply. The card itself supplies an atom with
 * `subject` `self`, and an opponent supplies an atom with `opponent` in one of `SUPPLIER_PARAMS`.
 */
export function deckDemandTest(roles: readonly TypeRole[]): AtomTest {
  const demand = demandTest(roles);
  return (a) => demand(a) && a.params['subject'] !== 'self' && !SUPPLIER_PARAMS.some((p) => a.params[p] === 'opponent');
}

const shortQuote = (q: string) => (q.length > 70 ? `${q.slice(0, 67)}...` : q).replace(/\s+/g, ' ');

/**
 * The class of each spell. `conditional` comes first, because the rate formula reads it: the class
 * protects a card that a link needs. The weaker card of a proof is `dominated_in_pool`.
 */
export function cardClasses(input: Pick<GroupInput, 'spells' | 'atoms'>, condition: AtomTest, dominated: ReadonlySet<string>): CardClass[] {
  const first = new Map<string, RewardAtom>();
  for (const a of input.atoms) if (condition(a) && !first.has(a.oracle_id)) first.set(a.oracle_id, a);
  return input.spells.map((s) => {
    const a = first.get(s.oracle_id);
    if (a) return { oracle_id: s.oracle_id, class: 'conditional', reason: `needs ${a.family}.${a.type_key}: ${shortQuote(a.quote)}` };
    return { oracle_id: s.oracle_id, class: dominated.has(s.oracle_id) ? 'dominated_in_pool' : 'plain', reason: null };
  });
}

/** The card records of the spells of a group input, with their fields. Read only. */
export function loadProofCards(db: DatabaseSync, input: GroupInput, buildId: number): Map<string, ProofCard> {
  const faces = db.prepare('SELECT face_index, mana_cost, power, toughness FROM card_faces WHERE oracle_id = ?');
  const record = db.prepare('SELECT name, mana_cost, power, toughness, color_identity FROM cards WHERE oracle_id = ?');
  const atoms = new Map<string, RewardAtom[]>();
  for (const a of input.atoms) atoms.set(a.oracle_id, [...(atoms.get(a.oracle_id) ?? []), a]);
  const cards = new Map<string, ProofCard>();
  for (const { card } of readBuildCards(db, buildId)) {
    const own = atoms.get(card.oracle_id);
    if (!own) continue;
    const c = record.get(card.oracle_id) as { name: string; mana_cost: string | null; power: string | null; toughness: string | null; color_identity: string };
    const stored = new Map((faces.all(card.oracle_id) as unknown as Array<Pick<ProofFace, 'face_index' | 'mana_cost' | 'power' | 'toughness'>>).map((f) => [f.face_index, f]));
    const { atoms: fields, speed } = cardFields(card, own);
    cards.set(card.oracle_id, {
      oracle_id: card.oracle_id, name: c.name, layout: card.layout, color_identity: JSON.parse(c.color_identity) as string[],
      faces: card.faces.map((f) => ({ ...f, ...(stored.get(f.face_index) ?? { mana_cost: c.mana_cost, power: c.power, toughness: c.toughness }) })),
      atoms: own, fields, speed,
    });
  }
  return cards;
}
