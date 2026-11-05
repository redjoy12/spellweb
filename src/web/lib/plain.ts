/**
 * The plain names of types, card kinds and rule sides, with no React and no fetch: the UI (through
 * terms.ts and EdgeRow) and the server (the fix-request brief) use the same words.
 */

/** A rule side: a type with conditions, or a card kind (an intrinsic class). */
export interface PlainPredicate { param: string; op: string; value: unknown }
export type PlainSide = { family: string; type_key: string; where: PlainPredicate[] } | { intrinsic: string; value: string | number };

/** A key with no label: "PRODUCES.MANA_PRODUCTION" -> "mana production". */
function humanize(key: string): string {
  const t = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  return t.toLowerCase().replace(/_/g, ' ');
}

/** The short plain name of a type: the label up to its first explanation. */
export function typeName(key: string, labels: Record<string, string>): string {
  const label = labels[key];
  if (!label) return humanize(key);
  return label.split(' - ')[0]!.split(' (')[0]!.trim();
}

/** The full label of a type, for a tooltip. */
export function typeTitle(key: string, labels: Record<string, string>): string {
  return labels[key] ? `${labels[key]} (${key})` : key;
}

/** A signed type pair ("+ PRODUCES.MANA_PRODUCTION -> ENABLES.ACTIVATE") in plain words. */
export function typePairName(pair: string, labels: Record<string, string>): string {
  const m = /^([+-])\s*(\S+)\s*->\s*(\S+)$/.exec(pair.trim());
  if (!m) return pair;
  return `${m[1] === '-' ? 'conflict: ' : ''}gives “${typeName(m[2]!, labels)}” → needs “${typeName(m[3]!, labels)}”`;
}

/** A card-kind group ("card_type", "creature") in plain words. */
export function kindName(intrinsic: string, value: string | number): string {
  switch (intrinsic) {
    case 'card_type': return `every ${String(value).toLowerCase()} card`;
    case 'subtype': return `every ${String(value)} card`;
    case 'mana_value': return `every card with mana value ${String(value)}`;
    case 'color_identity': return `every card with colour ${String(value)}`;
    default: return `every card with ${intrinsic.replace(/_/g, ' ')} ${String(value)}`;
  }
}

const COLOUR_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/** A colour scope ("BR") in words ("Black-Red"). */
export function scopeName(scope: string): string {
  const names = [...scope].map((c) => COLOUR_NAME[c]).filter(Boolean);
  return names.length ? names.join('-') : scope;
}

/** A rule side in its technical form: "FAMILY.TYPE_KEY [param op value]". */
export function sideText(s: PlainSide): string {
  if ('intrinsic' in s) return `${s.intrinsic} = ${String(s.value)}`;
  const where = s.where.map((p) => `${p.param} ${p.op} ${JSON.stringify(p.value)}`).join(', ');
  return `${s.family}.${s.type_key}${where ? ` [${where}]` : ''}`;
}

/** A rule side in plain words: the type label and its conditions. */
export function plainSide(s: PlainSide, labels: Record<string, string>): string {
  if ('intrinsic' in s) return kindName(s.intrinsic, s.value);
  const name = typeName(`${s.family}.${s.type_key}`, labels);
  const where = s.where.map((p) => `${p.param.replace(/_/g, ' ')} ${p.op === 'eq' ? 'is' : p.op} ${JSON.stringify(p.value)}`).join(', ');
  return where ? `${name} (only if ${where})` : name;
}

/** A reason in one plain sentence, with no markup. */
export function reasonSentence(r: { polarity: '+' | '-'; supply: PlainSide; demand: PlainSide }, labels: Record<string, string>): string {
  return `A card that gives "${plainSide(r.supply, labels)}" ${r.polarity === '-' ? 'works against' : 'helps'} a card that needs "${plainSide(r.demand, labels)}".`;
}
