/**
 * Size and speed fields of the card rate (card rate plan Task 1). A fixed parse of `atoms.quote`
 * and the card record fills what the params do not hold. A field that the parse cannot read stays
 * null, and it never gets a default number. Speed is an order, not a price: `compareSpeed` gives
 * null when two faces trade one axis for another. This file reads the database and writes nothing.
 */
import type { DatabaseSync } from 'node:sqlite';

/** One face of a card record: a `card_faces` row, or the `cards` row of a card with one face. */
export interface RateFace { face_index: number; name: string; type_line: string; oracle_text: string }
export interface RateCard { oracle_id: string; layout: string; faces: RateFace[] }
export interface RateAtom {
  id: number; oracle_id: string; face_index: number; family: string; type_key: string;
  params: Record<string, unknown>; quote: string;
}

export interface TargetLimit {
  /** The type words of the target, such as `creature or planeswalker`, or `any target`. */
  head: string;
  /** The words that narrow the target, as the quote has them. Null: the head is the whole target. */
  limit: string | null;
  /** A limit with one number: `with mana value 3 or less` is mana_value, max 3. */
  number: { stat: 'mana_value' | 'power' | 'toughness'; bound: 'max' | 'min'; value: number } | null;
}

export interface AtomFields {
  stat_power: number | null;
  stat_toughness: number | null;
  token_power: number | null;
  token_toughness: number | null;
  mana_amount: number | null;
  target_limit: TargetLimit | null;
  /** Why a field stays null, such as `stat:x`, `stat:for_each`, `token:copy`, `mana:no_amount`, `target:several`. */
  notes: string[];
}

/** The speed axes of one face. A null axis is one that the rule cannot read. */
export interface Speed {
  face_index: number;
  /** `instant`: the type line says Instant, or the face has the keyword Flash. Null: a land, a back face, a flash with a condition. */
  cast: 'instant' | 'sorcery' | null;
  /** `next_turn`: a creature with no Haste cannot attack this turn. Null: its haste has a condition. */
  wait: 'now' | 'next_turn' | null;
  /** The face enters tapped. Null: only with a condition. */
  tapped: boolean | null;
  /** An activated ability of the face has the words "only as a sorcery" or "only during your turn". */
  ability_limit: boolean;
}

const SIGNED = /([+\-−])(\d+|X)\/([+\-−])(\d+|X)/g;
const UNSIGNED = /(?<![+\-−\d/])\b(\d+|X)\/(\d+|X)\b(?!\/)/g;
const NUMBER_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The value of one part of `+2/-X`. `X` has no value, and `-0` is 0. */
function part(sign: string, digits: string): number | null {
  if (digits === 'X') return null;
  return (sign === '+' ? 1 : -1) * Number(digits) + 0;
}

/** The reminder text right after the quote on the face, or ''. A keyword such as `Mobilize 1` has its numbers there. */
function reminderAfter(quote: string, face: RateFace | undefined): string {
  if (!quote || !face) return '';
  const at = face.oracle_text.toLowerCase().indexOf(quote.toLowerCase());
  if (at < 0) return '';
  return /^ \(([^)]*)\)/.exec(face.oracle_text.slice(at + quote.length))?.[1] ?? '';
}

/** Size of a stat change. A quote with two sizes takes the one of the atom's `sign`. */
function statSize(quote: string, sign: unknown, f: AtomFields): void {
  const shapes = [...quote.matchAll(SIGNED)].filter((m) => {
    const up = [m[1], m[3]].filter((s) => s === '+').length;
    return sign === '+' ? up === 2 : sign === '-' ? up === 0 : up === 1;
  });
  if (shapes.length !== 1) { f.notes.push(shapes.length ? 'stat:several' : 'stat:no_size'); return; }
  if (/\bfor each\b/i.test(quote)) { f.notes.push('stat:for_each'); return; }
  const m = shapes[0]!;
  f.stat_power = part(m[1]!, m[2]!);
  f.stat_toughness = part(m[3]!, m[4]!);
  if (f.stat_power === null || f.stat_toughness === null) f.notes.push('stat:x');
}

/** Size of a token: the one unsigned `N/N` of the quote, or else the `N/N ... token` of its reminder text. */
function tokenSize(quote: string, reminder: string, f: AtomFields): void {
  const sizes = (text: string) => [...new Set([...text.matchAll(UNSIGNED)].map((m) => m[0]))];
  const inQuote = sizes(quote);
  const shapes = inQuote.length ? inQuote : sizes(/\b(?:\d+|X)\/(?:\d+|X)\b[^.]*\btokens?\b/.exec(reminder)?.[0] ?? '');
  if (shapes.length > 1) { f.notes.push('token:several'); return; }
  if (!shapes.length) { f.notes.push(/\bcop(?:y|ies)\b/i.test(quote) ? 'token:copy' : 'token:no_size'); return; }
  const [p, t] = shapes[0]!.split('/') as [string, string];
  f.token_power = part('+', p);
  f.token_toughness = part('+', t);
  if (f.token_power === null || f.token_toughness === null) f.notes.push('token:x');
}

/** Amount of mana of one atom. In `{B}{R}` an atom of colour B gets 1, and in `{B} or {R}` each colour gets 1. */
function manaAmount(quote: string, reminder: string, color: unknown, f: AtomFields): void {
  const text = /\badds? /i.test(quote) ? quote : reminder;
  if (/\bfor each\b/i.test(text)) { f.notes.push('mana:for_each'); return; }
  const clauses = [...text.matchAll(/\badds? ([^.]*)/gi)].map((m) => m[1]!);
  if (clauses.length !== 1) { f.notes.push(clauses.length ? 'mana:several' : 'mana:no_amount'); return; }
  const clause = clauses[0]!.replace(/^an additional /, '');
  const word = /^(\w+) mana\b/.exec(clause)?.[1];
  if (word) { if (NUMBER_WORD[word]) f.mana_amount = NUMBER_WORD[word]!; else f.notes.push('mana:no_amount'); return; }
  const symbols = /^(?:\{[WUBRGC]\})+(?:,? (?:or )?(?:\{[WUBRGC]\})+)*/.exec(clause)?.[0];
  if (!symbols) { f.notes.push('mana:no_amount'); return; }
  const options = symbols.split(/,? or |, /).map((o) => o.match(/\{.\}/g)!);
  const counts = typeof color === 'string' && 'WUBRGC'.includes(color)
    ? options.map((o) => o.filter((s) => s === `{${color}}`).length).filter((n) => n > 0)
    : [...new Set(options.map((o) => o.length))];
  if (counts.length === 1) f.mana_amount = counts[0]!;
  else f.notes.push('mana:no_amount');
}

const CONTROLLER = / (?:an opponent controls|you don't control|you control|that player controls)\b/g;
const PHRASE_END = /[.;:"]|,? and |, up to\b|,? (?:where|gets?|gains?|deals?|(?<!or )equal to|until|unless|shuffles|each|on the bottom|from)\b/;
const NARROW = 'non-?\\w+|white|blue|black|red|green|colorless|multicolored|monocolored|tapped|untapped|attacking|blocking';
const HEAD_NARROW = new RegExp(`^((?:${NARROW})(?:(?:, | or |, or )(?:${NARROW}))*) (.+)$`);
const PLAIN = '(?:creature|artifact|enchantment|land|planeswalker|permanent|player|opponent|card|spell|instant|sorcery|token|Vehicle|Spacecraft|Equipment)s?';
const ITEM = `${PLAIN}(?: ${PLAIN})*`;
const PLAIN_HEAD = new RegExp(`^${ITEM}(?:(?:, | or |, or | and/or )${ITEM})*$`);
const NUMBER_LIMIT = /^with (mana value|power|toughness) (\d+) or (less|greater)$/;

/** The target words that follow one `target`, or null when a word is not in the fixed lists. */
function targetPhrase(rest: string): TargetLimit | null {
  const end = PHRASE_END.exec(rest);
  let phrase = (end ? rest.slice(0, end.index) : rest).replace(CONTROLLER, '').trim();
  const limits: string[] = [];
  const front = HEAD_NARROW.exec(phrase);
  if (front) { limits.push(front[1]!); phrase = front[2]!; }
  const back = /^(.*?) ((?:with|without|that)\b.+)$/.exec(phrase);
  if (back) { phrase = back[1]!; limits.push(back[2]!); }
  if (!PLAIN_HEAD.test(phrase)) return null;
  const n = NUMBER_LIMIT.exec(limits[limits.length - 1] ?? '');
  return {
    head: phrase.replace(/\b(\w+)s\b/g, '$1'),
    limit: limits.length ? limits.join(' ') : null,
    number: n ? { stat: n[1]!.replace(' ', '_') as 'mana_value' | 'power' | 'toughness', bound: n[3] === 'less' ? 'max' : 'min', value: Number(n[2]) } : null,
  };
}

/** The limit of a removal quote. A quote with two targets gives a value only when both read the same. */
function targetLimit(quote: string, f: AtomFields): void {
  const found = [...quote.matchAll(/\b(any (?:other )?)?targets?\b/gi)];
  if (!found.length) { f.notes.push('target:no_target'); return; }
  const read = found.map((m) => (m[1] ? { head: 'any target', limit: null, number: null } : targetPhrase(quote.slice(m.index + m[0].length).trimStart())));
  if (read.some((r) => r === null)) { f.notes.push('target:unread'); return; }
  if (new Set(read.map((r) => JSON.stringify(r))).size > 1) { f.notes.push('target:several'); return; }
  f.target_limit = read[0]!;
}

/** The fields of one atom. Each field outside the kind of the atom stays null. */
export function atomFields(atom: RateAtom, face: RateFace | undefined): AtomFields {
  const f: AtomFields = {
    stat_power: null, stat_toughness: null, token_power: null, token_toughness: null, mana_amount: null, target_limit: null, notes: [],
  };
  const key = `${atom.family}.${atom.type_key}`;
  if (key === 'COMBAT.STAT_CHANGE') statSize(atom.quote, atom.params.sign, f);
  if (key === 'INTERACTION.TARGETED_REMOVAL') {
    targetLimit(atom.quote, f);
    if (atom.params.removal_type === 'minus') statSize(atom.quote, '-', f);
  }
  if (key === 'PRODUCES.CREATE') tokenSize(atom.quote, reminderAfter(atom.quote, face), f);
  if (key === 'PRODUCES.MANA_PRODUCTION') manaAmount(atom.quote, reminderAfter(atom.quote, face), atom.params.color, f);
  return f;
}

/** The speed of one face, from its type line and its speed atoms. */
export function faceSpeed(card: RateCard, face: RateFace, atoms: RateAtom[]): Speed {
  const own = atoms.filter((a) => a.face_index === face.face_index);
  const ofType = (key: string) => own.filter((a) => `${a.family}.${a.type_key}` === key);
  const types = face.type_line.split('—')[0]!;
  const is = (word: string) => new RegExp(`\\b${word}\\b`).test(types);
  const short = face.name.split(/[ ,]/).find((w) => !['The', 'A', 'An'].includes(w)) ?? face.name;
  const hasName = (q: string) => q.split(/[^\p{L}'-]+/u).includes(short);
  const namesFace = (q: string) => /\bthis (?:creature|vehicle|permanent)\b/i.test(q) || hasName(q);

  const flash = ofType('ENABLES.FLASH');
  const backFace = face.face_index > 0 && ['transform', 'meld'].includes(card.layout);
  let cast: Speed['cast'] = 'sorcery';
  if (is('Land') || backFace) cast = null;
  else if (is('Instant') || flash.some((a) => /^flash$/i.test(a.quote.trim()))) cast = 'instant';
  else if (flash.length) cast = null;

  const haste = ofType('COMBAT.HASTE');
  let wait: Speed['wait'] = 'now';
  if (is('Creature') && !haste.some((a) => /^haste$/i.test(a.quote.trim()))) {
    wait = haste.some((a) => namesFace(a.quote)) ? null : 'next_turn';
  }

  const entersTapped = ofType('CONSTRAINTS.ENTERS_TAPPED')
    .filter((a) => /\b(?:this \w+|it) enters? tapped\b/i.test(a.quote) || (hasName(a.quote) && /\benters tapped\b/.test(a.quote)));
  const tapped = entersTapped.some((a) => a.params.conditional === false) ? true : entersTapped.length ? null : false;

  // A limit inside quotation marks belongs to a token or to a granted ability, not to this face.
  const ability_limit = ofType('CONSTRAINTS.TIMING').some((a) => {
    const text = `${a.quote} ${reminderAfter(a.quote, face)}`;
    const m = /\bonly (?:as a sorcery|during your turn)\b/i.exec(text);
    return m !== null && (text.slice(0, m.index).match(/"/g) ?? []).length % 2 === 0;
  });

  return { face_index: face.face_index, cast, wait, tapped, ability_limit };
}

/** The fields of each atom of a card, and the speed of each face. */
export function cardFields(card: RateCard, atoms: RateAtom[]): { atoms: Map<number, AtomFields>; speed: Speed[] } {
  const faces = new Map(card.faces.map((f) => [f.face_index, f]));
  return {
    atoms: new Map(atoms.map((a) => [a.id, atomFields(a, faces.get(a.face_index))])),
    speed: card.faces.map((f) => faceSpeed(card, f, atoms)),
  };
}

const AXES: ((s: Speed) => number | null)[] = [
  (s) => (s.cast === null ? null : s.cast === 'instant' ? 1 : 0),
  (s) => (s.wait === null ? null : s.wait === 'now' ? 1 : 0),
  (s) => (s.tapped === null ? null : s.tapped ? 0 : 1),
  (s) => (s.ability_limit ? 0 : 1),
];

/** 1: `a` is faster, -1: `b` is faster, 0: the same. Null: an axis is unread, or each face wins on one axis. */
export function compareSpeed(a: Speed, b: Speed): 1 | 0 | -1 | null {
  let result: 1 | 0 | -1 = 0;
  for (const axis of AXES) {
    const x = axis(a);
    const y = axis(b);
    if (x === null || y === null) return null;
    if (x === y) continue;
    const step = x > y ? 1 : -1;
    if (result !== 0 && result !== step) return null;
    result = step;
  }
  return result;
}

/** Each card of a build with its atoms. Read only. */
export function readBuildCards(db: DatabaseSync, buildId: number): { card: RateCard; atoms: RateAtom[] }[] {
  const rows = db.prepare(`SELECT a.id, a.oracle_id, a.face_index, a.family, a.type_key, a.params_json, a.quote
    FROM graph_build_atoms g JOIN atoms a ON a.id = g.atom_id WHERE g.build_id = ? ORDER BY a.oracle_id, a.id`)
    .all(buildId) as unknown as (Omit<RateAtom, 'params'> & { params_json: string })[];
  const faceRows = db.prepare('SELECT oracle_id, face_index, name, type_line, oracle_text FROM card_faces ORDER BY oracle_id, face_index')
    .all() as unknown as (RateFace & { oracle_id: string })[];
  const faces = new Map<string, RateFace[]>();
  for (const { oracle_id, ...f } of faceRows) faces.set(oracle_id, [...(faces.get(oracle_id) ?? []), f]);
  const record = db.prepare('SELECT layout, name, type_line, oracle_text FROM cards WHERE oracle_id = ?');

  const byCard = new Map<string, RateAtom[]>();
  for (const { params_json, ...a } of rows) {
    byCard.set(a.oracle_id, [...(byCard.get(a.oracle_id) ?? []), { ...a, params: JSON.parse(params_json) as Record<string, unknown> }]);
  }
  return [...byCard].map(([oracle_id, atoms]) => {
    const c = record.get(oracle_id) as { layout: string; name: string; type_line: string; oracle_text: string | null };
    const own = faces.get(oracle_id) ?? [{ face_index: 0, name: c.name, type_line: c.type_line, oracle_text: c.oracle_text ?? '' }];
    return { card: { oracle_id, layout: c.layout, faces: own }, atoms };
  });
}

/** What a reward needs to act again. Results Task 6, R4: "one time" against "every single time". */
export type Uses = 'once' | 'repeat' | 'static';

/**
 * The line of a face that holds a position. A bullet belongs to the line above the bullets, so the
 * result starts with that line: "Whenever Hawkeye becomes tapped" is what makes a bullet act.
 */
export function abilityLine(oracleText: string, spanStart: number): string {
  const lines = oracleText.split('\n');
  let start = 0;
  let at = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (spanStart < start + lines[i]!.length + 1) { at = i; break; }
    start += lines[i]!.length + 1;
  }
  if (!lines[at]!.startsWith('•')) return lines[at]!;
  let head = at;
  while (head > 0 && lines[head]!.startsWith('•')) head--;
  return `${lines[head]}\n${lines[at]}`;
}

/** The first line, with no reminder text and no ability word such as "Raid — ". */
function bareAbility(line: string): string {
  return line.split('\n')[0]!.replace(/\([^)]*\)/g, ' ').trim().replace(/^[A-Z][A-Za-z' -]{0,30} — /, '');
}

const COST_WORD = /\{[^}]+\}|\b(?:sacrifice|discard|pay|exile|remove|tap)\b/i;

/** The words before the colon of an activated ability, or null when the line has no cost. */
export function costWords(line: string): string | null {
  const m = /^([^:"]{1,120}?):\s/.exec(bareAbility(line));
  return m && COST_WORD.test(m[1]!) ? m[1]! : null;
}

/** The uses of an ability line. `names` are the names of the card, because a cost can say "Sacrifice Sunfire Torch". */
export function usesOf(line: string, permanent: boolean, names: readonly string[] = []): Uses {
  if (!permanent) return 'once';
  const first = line.split('\n')[0]!;
  // The reminder of exhaust and power-up says this, and only one line of a card can hold it.
  if (/^(?:Exhaust|Power-up)\b/.test(first) || /\bactivate\b[^.]*\bonly once\b(?! each turn)/i.test(line)) return 'once';
  const cost = costWords(line);
  if (cost !== null) {
    const self = /\bsacrifice this\b/i.test(cost) || names.some((n) => cost.toLowerCase().includes(`sacrifice ${n.toLowerCase()}`));
    return self ? 'once' : 'repeat';
  }
  if (/^[IVX]+(?:, [IVX]+)+ —/.test(first)) return 'repeat';
  if (/^[IVX]+ —/.test(first)) return 'once';
  const bare = bareAbility(line);
  if (/^When\b/.test(bare)) return 'once';
  return /^(?:Whenever|At the beginning)\b/.test(bare) ? 'repeat' : 'static';
}

/** Results Task 6, R5: the words of a condition. "If you do" follows a choice of the player, so it is not one. */
export const hasConditionWords = (line: string): boolean =>
  /\bif (?!you do\b)|\bas long as\b|\bunless\b/i.test(line.replace(/\([^)]*\)/g, ' '));

/** The mana of an activation cost. Null: the line has no cost, or the cost has `{X}`. */
export function activationMana(line: string): number | null {
  const cost = costWords(line);
  if (cost === null || /\{X\}/.test(cost)) return null;
  let total = 0;
  for (const [, symbol] of cost.matchAll(/\{([^}]+)\}/g)) {
    if (symbol === 'T' || symbol === 'Q') continue;
    total += /^\d+$/.test(symbol!) ? Number(symbol) : 1;
  }
  return total;
}

/** Results Task 6, reason on pair 37: the choices that a card gives. */
export const optionCount = (oracleText: string): number => oracleText.split('\n').filter((l) => l.startsWith('•')).length;
