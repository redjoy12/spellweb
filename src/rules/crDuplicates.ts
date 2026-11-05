/**
 * Repeated text inside the Comprehensive Rules (owner request 2026-10-18). The CR states some
 * sentences two or more times: in a rule and in its glossary entry, or in two rules. This module
 * splits each rule text and each glossary definition of a corpus into sentences, and groups the
 * sentences that say the same thing in nearly the same words (`sameText`, src/rules/sameText.ts).
 *
 * Each group has one main sentence, and the other members are "also stated in" it. The main
 * sentence is the first sentence in CR order (rules in their order, then the glossary) that covers
 * all other members (`covers`). A member that the main sentence does not cover leaves the group.
 * A cross-reference sentence ("See rule ...") is never grouped.
 *
 * Each member has a tier. Only the tiers `exact` (equal after normalisation) and `contained` (the
 * member is a run of whole words of the main sentence) are applied (`mainOf`): the main sentence
 * has all the words of the member. A `fuzzy` member has other words (for example one more
 * qualifier), so the words alone cannot show that it states the same rule. It is a candidate only,
 * for a person or an isolated debate. The grouping is mechanical, on the words only; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { covers, normaliseText, sameText, SIMILAR } from './sameText.js';

export interface CrSentence {
  /** `rule|<number>|<start>` or `glossary|<term>|<start>`. */
  key: string;
  source: 'rule' | 'glossary';
  /** The rule number, or the glossary term. */
  ref: string;
  /** The offsets of the sentence in the stored text of the rule or the definition. */
  start: number;
  end: number;
  text: string;
  norm: string;
  /** The place in CR order: rules by ordinal, then the glossary by term. */
  order: number;
}

export type CrTier = 'exact' | 'contained' | 'fuzzy';
export interface CrMember extends CrSentence { tier: CrTier }
export interface CrGroup { main: CrSentence; members: CrMember[] }

/** The tier of a member against its main sentence (normalised texts). */
export function tierOf(main: string, member: string): CrTier {
  if (main === member) return 'exact';
  return ` ${main} `.includes(` ${member} `) ? 'contained' : 'fuzzy';
}

/** A cross-reference sentence: "See rule ...", "(See also ...)". */
export const isCrossReference = (norm: string) => norm === 'see' || norm.startsWith('see ');

export interface CrDuplicates {
  sentences: CrSentence[];
  groups: CrGroup[];
  /** The main sentence of each applied member (tiers `exact` and `contained`), keyed by `key`. */
  mainOf: Map<string, CrSentence>;
  /** The sentences of each source text, keyed `rule|<number>` or `glossary|<term>`, in text order. */
  byText: Map<string, CrSentence[]>;
}

/**
 * The sentences of a text: a sentence ends at `.`, `!` or `?` (and a closing quote or bracket)
 * before white space and a capital letter, a quote or a bracket. The offsets exclude the space
 * between sentences.
 */
export function splitSentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /[.!?]["')\]]*(?=\s+["'(\[]?[A-Z])/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    out.push({ start, end });
    start = end;
    while (start < text.length && /\s/.test(text[start]!)) start++;
  }
  if (start < text.length && text.slice(start).trim()) out.push({ start, end: text.trimEnd().length });
  return out.filter((s) => s.end > s.start);
}

export const textKey = (source: 'rule' | 'glossary', ref: string) => `${source}|${ref}`;

/** The sentences of the rule texts and glossary definitions of a corpus, in CR order. */
export function crSentences(db: DatabaseSync, corpusId: number): CrSentence[] {
  const texts: Array<{ source: 'rule' | 'glossary'; ref: string; text: string }> = [
    ...(db.prepare("SELECT number ref, text FROM rules WHERE corpus_id = ? AND text <> '' ORDER BY ordinal").all(corpusId) as
      Array<{ ref: string; text: string }>).map((r) => ({ source: 'rule' as const, ...r })),
    ...(db.prepare('SELECT term ref, definition text FROM glossary_entries WHERE corpus_id = ? ORDER BY term_key').all(corpusId) as
      Array<{ ref: string; text: string }>).map((r) => ({ source: 'glossary' as const, ...r })),
  ];
  const out: CrSentence[] = [];
  for (const t of texts) {
    for (const s of splitSentences(t.text)) {
      const text = t.text.slice(s.start, s.end);
      out.push({ key: `${t.source}|${t.ref}|${s.start}`, source: t.source, ref: t.ref, start: s.start, end: s.end, text, norm: normaliseText(text), order: out.length });
    }
  }
  return out;
}

/** A word pair in more than this share of the sentences does not make candidate pairs (it is too common). */
const COMMON_SHARE = 1 / 25;

const wordPairs = (norm: string) => {
  const w = norm.split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) out.add(`${w[i]} ${w[i + 1]}`);
  if (w.length === 1) out.add(w[0]!);
  return out;
};

/** The groups of sentences that say the same thing (see the file header). */
export function groupSentences(sentences: readonly CrSentence[]): CrDuplicates {
  const pairs = sentences.map((s) => wordPairs(s.norm));
  const common = Math.max(50, Math.ceil(sentences.length * COMMON_SHARE));
  const index = new Map<string, number[]>();
  pairs.forEach((ps, i) => { for (const p of ps) { const l = index.get(p); if (l) l.push(i); else index.set(p, [i]); } });
  const parent = sentences.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const exact = new Map<string, number>();
  const skip = sentences.map((s) => isCrossReference(s.norm));
  sentences.forEach((s, i) => {
    if (skip[i]) return;
    const e = exact.get(s.norm);
    if (e === undefined) exact.set(s.norm, i); else parent[find(i)] = find(e);
  });
  // A pair can pass `sameText` only when the shorter text shares SIMILAR of its word pairs (also
  // when it is contained). The shared count is at most the counted pairs plus the common pairs
  // that the index skips, so a candidate below that bound is skipped without a test.
  for (let i = 0; i < sentences.length; i++) {
    if (skip[i]) continue;
    const shared = new Map<number, number>();
    let skipped = 0;
    for (const p of pairs[i]!) {
      const l = index.get(p)!;
      if (l.length > common) { skipped++; continue; }
      for (const j of l) if (j > i && !skip[j]) shared.set(j, (shared.get(j) ?? 0) + 1);
    }
    for (const [j, n] of shared) {
      if (n + skipped < SIMILAR * Math.min(pairs[i]!.size, pairs[j]!.size)) continue;
      if (find(i) !== find(j) && sameText(sentences[i]!.norm, sentences[j]!.norm)) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map<number, CrSentence[]>();
  sentences.forEach((s, i) => { const r = find(i); const c = clusters.get(r); if (c) c.push(s); else clusters.set(r, [s]); });
  const groups: CrGroup[] = [];
  const mainOf = new Map<string, CrSentence>();
  for (const c of clusters.values()) {
    if (c.length < 2) continue;
    c.sort((a, b) => a.order - b.order);
    const main = c.find((m) => c.every((x) => x === m || covers(m.norm, x.norm))) ?? c[0]!;
    const members = c.filter((x) => x !== main && covers(main.norm, x.norm)).map((x) => ({ ...x, tier: tierOf(main.norm, x.norm) }));
    if (members.length === 0) continue;
    groups.push({ main, members });
    for (const m of members) if (m.tier !== 'fuzzy') mainOf.set(m.key, main);
  }
  groups.sort((a, b) => a.main.order - b.main.order);
  const byText = new Map<string, CrSentence[]>();
  for (const s of sentences) {
    const k = textKey(s.source, s.ref);
    const l = byText.get(k);
    if (l) l.push(s); else byText.set(k, [s]);
  }
  return { sentences: [...sentences], groups, mainOf, byText };
}

/**
 * The groups with more applied members: each fuzzy member whose key is in `same` (an owner answer
 * or an agreed debate verdict, `confirmedSame` in src/graph/crDebate.ts) joins `mainOf`.
 */
export function withConfirmed(d: CrDuplicates, same: ReadonlySet<string>): CrDuplicates {
  const mainOf = new Map(d.mainOf);
  for (const g of d.groups) for (const m of g.members) if (m.tier === 'fuzzy' && same.has(m.key)) mainOf.set(m.key, g.main);
  return { ...d, mainOf };
}

const cache = new WeakMap<DatabaseSync, Map<number, CrDuplicates>>();

/** The repeated sentences of a corpus. Cached for each database and corpus. */
export function crDuplicates(db: DatabaseSync, corpusId: number): CrDuplicates {
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  let d = m.get(corpusId);
  if (!d) { d = groupSentences(crSentences(db, corpusId)); m.set(corpusId, d); }
  return d;
}
