/**
 * Isolated labels of the edge golden set (spec rev. 6 sec. 11.3-11.4, plan Task 2).
 *
 * The file protocol of Phase 2: `prepareLabelRound` writes one directory for each pass of each
 * batch (plan D5), a FRESH `edge-golden-labeler` subagent reads its `packet.md` and writes
 * `response.json`, and `submitLabelRound` validates, votes and stores. The code makes no model
 * call. The session that runs it never labels a pair (spec sec. 11.1).
 *
 * Layout: <goldenBatchesDir>/round-<n>/batch-<nnn>/pass-<k>/{manifest.json, packet.md, response.json}
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ownShortNames, redactWithMap, redactionNames } from '../atoms/extract.js';
import { loadPacketPolicy, type PacketPolicy } from '../rules/relevance.js';
import { draw } from '../util/draw.js';
import {
  contentRefs, emptyContent, loadRowStore, mergeContent, renderContent, set5CrContent, typeCrContent, withKernel,
  type CrContent,
} from './crContent.js';
import type { Characteristic } from './intrinsic.js';
import type { GraphPolicy } from './policy.js';
import { checkEvidence, type Evidence } from './quotes.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(here, '../../data/edge-golden-batches');

/** Read on every call, so tests can point it at a temp directory and never touch `data/`. */
export function goldenBatchesDir(): string {
  return process.env['EDGE_GOLDEN_BATCHES_DIR'] ?? DEFAULT_DIR;
}

/** spec sec. 11.3: each batch runs three times. */
export const PASSES = 3;
/** spec sec. 11.4: the owner sample. The size is `owner_sample` in the graph policy. */
export const OWNER_SAMPLE_MAX_DISPUTED = 8;
export const OWNER_SAMPLE_LABELS: Record<Label, number> = { synergy: 6, anti: 3, none: 3 };

export type Label = 'synergy' | 'anti' | 'none';
export type ClauseRef = { face_index: number; clause_index: number }
                      | { characteristic: Characteristic };

/** A refusal of a verdict: `invalid` is a 400, `not_found` a 404. */
export class GoldenError extends Error {
  constructor(readonly kind: 'invalid' | 'not_found', message: string) { super(message); }
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const pad3 = (n: number) => String(n).padStart(3, '0');
const pairKey = (i: number) => `P${String(i + 1).padStart(2, '0')}`;
const cardKey = (i: number) => `K${String(i + 1).padStart(2, '0')}`;
export const roundDir = (round: number) => join(goldenBatchesDir(), `round-${round}`);
const batchDir = (round: number, batch: number) => join(roundDir(round), `batch-${pad3(batch)}`);
const passDir = (round: number, batch: number, pass: number) => join(batchDir(round, batch), `pass-${pass}`);

// ---- the card view: one source for the packet and the page -----------------------------------

export interface ClauseView { face_index: number; clause_index: number; kind: string; text: string }
export interface AtomView {
  id: number; face_index: number; family: string; type_key: string; params: Record<string, unknown>;
  /** The clauses that the atom span overlaps, as "face.clause". */
  clauses: string[];
  quote: string;
  schema_version: number;
}
export interface CardView {
  oracle_id: string;
  /** Set when the current text cannot be shown (a stale pair): the reason. The page only. */
  unavailable?: string;
  mana_value: number;
  color_identity: string[];
  faces: Array<{ face_index: number; type_line: string; power: string | null; toughness: string | null; clauses: ClauseView[] }>;
  atoms: AtomView[];
}

/**
 * One card as the labeler sees it: the redacted type lines and clause texts (Phase 2 short-name
 * redaction), the mana value, the colour identity and the current atoms with redacted quotes and
 * redacted string params.
 * Clauses come from the `clauses` table of the current oracle text.
 */
export function cardView(db: DatabaseSync, oracleId: string, names: readonly string[]): CardView {
  const card = db.prepare('SELECT cmc, color_identity, oracle_hash FROM cards WHERE oracle_id = ?')
    .get(oracleId) as { cmc: number; color_identity: string; oracle_hash: string } | undefined;
  if (!card) throw new Error(`no card with oracle_id ${oracleId}`);
  const own = ownShortNames(db, oracleId);
  const red = (s: string) => redactWithMap(s, names, own).text;
  const redValue = (v: unknown): unknown =>
    typeof v === 'string' ? red(v)
      : Array.isArray(v) ? v.map(redValue)
        : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redValue(x)])) : v;
  const faces = db.prepare('SELECT face_index, type_line, power, toughness FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; type_line: string; power: string | null; toughness: string | null }>;
  const clauses = db.prepare(
    'SELECT face_index, clause_index, span_start, span_end, text, kind FROM clauses WHERE oracle_id = ? AND oracle_hash = ? ORDER BY face_index, clause_index',
  ).all(oracleId, card.oracle_hash) as unknown as Array<ClauseView & { span_start: number; span_end: number }>;
  if (clauses.length === 0 && faces.length > 0) {
    const any = db.prepare('SELECT 1 FROM clauses WHERE oracle_id = ? LIMIT 1').get(oracleId);
    if (any) throw new Error(`card ${oracleId}: its clauses are from an older oracle text`);
  }
  const atoms = db.prepare(
    `SELECT id, face_index, family, type_key, params_json, span_start, span_end, quote, schema_version
       FROM atoms WHERE oracle_id = ? AND is_current = 1 ORDER BY face_index, span_start, id`,
  ).all(oracleId) as Array<{ id: number; face_index: number; family: string; type_key: string; params_json: string;
                            span_start: number; span_end: number; quote: string; schema_version: number }>;
  return {
    oracle_id: oracleId,
    mana_value: card.cmc,
    color_identity: JSON.parse(card.color_identity) as string[],
    faces: faces.map((f) => ({
      face_index: f.face_index,
      type_line: red(f.type_line),
      power: f.power,
      toughness: f.toughness,
      clauses: clauses.filter((c) => c.face_index === f.face_index)
        .map((c) => ({ face_index: c.face_index, clause_index: c.clause_index, kind: c.kind, text: red(c.text) })),
    })),
    atoms: atoms.map((a) => ({
      id: a.id, face_index: a.face_index, family: a.family, type_key: a.type_key,
      params: redValue(JSON.parse(a.params_json)) as Record<string, unknown>,
      clauses: a.quote === '' ? [] : clauses
        .filter((c) => c.face_index === a.face_index && a.span_start < c.span_end && c.span_start < a.span_end)
        .map((c) => `${c.face_index}.${c.clause_index}`),
      quote: red(a.quote),
      schema_version: a.schema_version,
    })),
  };
}

function renderCard(key: string, v: CardView): string {
  const out = [
    `## ${key}`,
    `Mana value: ${v.mana_value}`,
    `Color identity: ${v.color_identity.length ? v.color_identity.join(', ') : '(none)'}`,
  ];
  for (const f of v.faces) {
    out.push(`### ${key} face ${f.face_index}`, `Type line: ${f.type_line}`);
    if (f.power !== null || f.toughness !== null) out.push(`Power/toughness: ${f.power ?? '-'}/${f.toughness ?? '-'}`);
    out.push('Clauses:');
    out.push(...(f.clauses.length ? f.clauses.map((c) => `- clause ${c.face_index}.${c.clause_index} (${c.kind}): ${c.text}`) : ['(none)']));
  }
  out.push(`### ${key} atoms`);
  out.push(...(v.atoms.length ? v.atoms.map((a) => {
    const params = Object.keys(a.params).length ? ` params ${JSON.stringify(a.params)}` : '';
    const where = a.clauses.length ? `clause ${a.clauses.join(', ')}` : `face ${a.face_index}, type line`;
    return `- atom ${a.id}: ${a.family} ${a.type_key}${params}; ${where}; quote "${a.quote}"`;
  }) : ['(none)']));
  return out.join('\n');
}

// ---- the label packet ---------------------------------------------------------------------------

/**
 * The label instructions (plan D14, spec sec. 11.3). They state only the procedure and the
 * answer format. The two label definitions are the words of spec sec. 5.1 and sec. 8. The owner
 * examines this text before the first round. Revision 2 (owner decision 2026-10-11, after round 1):
 * step 7 on general links, and power and toughness as a characteristic.
 */
export const LABEL_INSTRUCTIONS = `You label pairs of Magic: The Gathering cards. Use ONLY the text in this packet. Do not use anything that you remember about the game or about a card. Card names are replaced by "~".

Each pair has a supply card S and a demand card D. Give each pair one label:
- synergy: card S supplies what card D demands.
- anti: card S removes or prevents a fact that card D needs.
- none: neither of the two.

Do these steps for each pair:
1. Read the clauses, the characteristics and the atoms of card S and card D.
2. Find the clause of card D that states the fact that card D demands or needs. This is the demand clause.
3. Find the clause of card S that supplies that fact, or that removes or prevents it. This is the supply clause. If the fact comes from a characteristic of card S (its type line, its mana value, its color identity or its power and toughness) and not from a clause, give that characteristic in place of the supply clause.
4. For each clause, give the ID of the atom of that card that expresses the fact. If no atom of that card expresses it, give null. A characteristic has no atom ID.
5. Give the CR chain: one or more items of Comprehensive Rules text from this packet that connect the supply fact to the demand fact. Copy each quote character for character.
6. If you cannot find the two clauses, or if the rules text in this packet does not connect them, give the label none.
7. A link can be general: the demand clause of card D accepts each card of a card type, or each source of the fact. When card S supplies such a fact, give the label synergy. Do not give none only because many cards supply the same fact.

Label each pair alone. The label of one pair has no effect on the label of a different pair.`;

export const LABEL_ANSWER_FORMAT = `Write ONE file, response.json, in the directory of this packet. Write it one time. It contains only this JSON object, with no commentary and no code fence:

{"pairs": {"P01": {...}, "P02": {...}}}

Give one entry for each pair key in the "Pairs" part. Each entry has these four fields:
- "label": "synergy", "anti" or "none".
- "supply": for synergy and anti, {"face_index": F, "clause_index": N, "atom_id": A} or {"characteristic": "type_line"}, {"characteristic": "mana_value"}, {"characteristic": "color_identity"} or {"characteristic": "power_toughness"}. For none, null.
- "demand": for synergy and anti, {"face_index": F, "clause_index": N, "atom_id": A}. For none, null.
- "cr_chain": for synergy and anti, one or more {"source": "rule", "ref": "R", "quote": "Q"} or {"source": "glossary", "ref": "T", "quote": "Q"}. R is a rule number as this packet shows it. T is a glossary term as this packet shows it. R and T are JSON strings. Q is copied from the text of that rule or glossary entry. For none, [].

"clause F.N" in the clause list of a card gives face_index F and clause_index N. A is a number from the atom list of the same card, or null. The supply clause is a clause of card S. The demand clause is a clause of card D.`;

export interface LabelManifest {
  round: number;
  batch_index: number;
  pass_index: number;
  corpus_id: number;
  names_sha: string;
  pairs: Array<{ key: string; pair_id: number; supply: string; demand: string }>;
  cards: Array<{ key: string; oracle_id: string; oracle_hash: string; clauses: string[]; atoms: number[] }>;
  packet_sha: string;
  packet_bytes: number;
}

export interface LabelContext { corpusId: number; termPolicy: PacketPolicy; names: readonly string[] }

export function labelContext(db: DatabaseSync, over: Partial<LabelContext> = {}): LabelContext {
  const corpus = db.prepare('SELECT id FROM rules_corpus WHERE is_current = 1').get() as { id: number } | undefined;
  if (!corpus && over.corpusId === undefined) throw new Error('no current rules corpus');
  return {
    corpusId: over.corpusId ?? corpus!.id,
    termPolicy: over.termPolicy ?? loadPacketPolicy(),
    names: over.names ?? redactionNames(db),
  };
}

interface Built {
  markdown: string;
  refs: string[];
  pairs: LabelManifest['pairs'];
  cards: LabelManifest['cards'];
}

/**
 * spec sec. 11.3: the packet of one batch. Parts: instructions, answer format, pairs, cards,
 * then the CR content - sets 1-3 of sec. 5.2 for each atom type of the cards, set 5 and the
 * Phase 2 kernel - with each rule labelled by the types that need it. No card name, no Stage A
 * role, no edge rule and no other golden label.
 */
export function buildLabelPacket(
  db: DatabaseSync, ctx: LabelContext, head: string,
  pairs: Array<{ id: number; supply_oracle: string; demand_oracle: string }>,
  typeCache: Map<string, CrContent> = new Map(),
): Built {
  const keys = new Map<string, string>();
  for (const p of pairs) for (const c of [p.supply_oracle, p.demand_oracle]) if (!keys.has(c)) keys.set(c, cardKey(keys.size));
  const views = new Map([...keys.keys()].map((c) => [c, cardView(db, c, ctx.names)]));

  const typeContent = new Map<string, CrContent>();
  for (const v of views.values()) {
    for (const a of v.atoms) {
      const id = `${a.family}.${a.type_key}`;
      const cacheKey = `${a.schema_version}:${id}`;
      let c = typeCache.get(cacheKey);
      if (!c) {
        c = typeCrContent(db, ctx.corpusId, a.schema_version, a, ctx.termPolicy);
        typeCache.set(cacheKey, c);
      }
      typeContent.set(id, c);
    }
  }
  const kernel = typeCache.get('kernel') ?? withKernel(db, ctx.corpusId, emptyContent());
  const set5 = typeCache.get('set5') ?? set5CrContent(db, ctx.corpusId);
  typeCache.set('kernel', kernel);
  typeCache.set('set5', set5);
  const content = mergeContent(kernel, set5, ...typeContent.values());

  const ruleFor = new Map<string, string[]>();
  const termFor = new Map<string, string[]>();
  for (const [t, c] of [...typeContent].sort(([a], [b]) => a.localeCompare(b))) {
    for (const n of c.rules.keys()) ruleFor.set(n, [...(ruleFor.get(n) ?? []), t]);
    for (const g of c.glossary.keys()) termFor.set(g, [...(termFor.get(g) ?? []), t]);
  }
  const label = (base: string[], kern: boolean, five: boolean) =>
    [...base, ...(kern ? ['kernel'] : []), ...(five ? ['intrinsic classes'] : [])].join(', ');
  const store = loadRowStore(db, ctx.corpusId);
  const cr = renderContent(store, content,
    (n) => label(ruleFor.get(n) ?? [], kernel.rules.has(n), set5.rules.has(n)),
    (g) => label(termFor.get(g) ?? [], false, set5.glossary.has(g)));

  const pairList = pairs.map((p, i) => ({ key: pairKey(i), pair_id: p.id, supply: keys.get(p.supply_oracle)!, demand: keys.get(p.demand_oracle)! }));
  const markdown = [
    head,
    `# Instructions\n${LABEL_INSTRUCTIONS}`,
    `# Answer format\n${LABEL_ANSWER_FORMAT}`,
    `# Pairs\n${pairList.map((p) => `${p.key}: supply card S = ${p.supply}, demand card D = ${p.demand}`).join('\n')}`,
    `# Cards\n\n${[...views].map(([c, v]) => renderCard(keys.get(c)!, v)).join('\n\n')}`,
    `# Comprehensive Rules\n${cr}`,
  ].join('\n\n') + '\n';

  return {
    markdown,
    refs: contentRefs(store, content),
    pairs: pairList,
    cards: [...views].map(([c, v]) => ({
      key: keys.get(c)!,
      oracle_id: c,
      oracle_hash: (db.prepare('SELECT oracle_hash FROM cards WHERE oracle_id = ?').get(c) as { oracle_hash: string }).oracle_hash,
      clauses: v.faces.flatMap((f) => f.clauses.map((cl) => `${cl.face_index}.${cl.clause_index}`)),
      atoms: v.atoms.map((a) => a.id),
    })),
  };
}

export type Batch = Array<{ id: number; supply_oracle: string; demand_oracle: string }>;

/**
 * Splits a batch whose packet is larger than `budget` into two halves of consecutive pairs, again
 * and again, until each part fits (the budget of spec sec. 5.2). One pair that does not fit stays
 * alone; the CLI shows its size.
 */
export function splitToBudget(
  db: DatabaseSync, ctx: LabelContext, pairs: Batch, budget: number, cache: Map<string, CrContent>,
): Batch[] {
  if (pairs.length <= 1) return [pairs];
  const bytes = Buffer.byteLength(buildLabelPacket(db, ctx, '#', pairs, cache).markdown, 'utf8');
  if (bytes <= budget) return [pairs];
  const half = Math.ceil(pairs.length / 2);
  return [...splitToBudget(db, ctx, pairs.slice(0, half), budget, cache), ...splitToBudget(db, ctx, pairs.slice(half), budget, cache)];
}

/** The sampled pairs of a round, in id order, split into batches of `batch_size`. */
function roundBatches(db: DatabaseSync, round: number, size: number): Batch[] {
  const pairs = db.prepare(
    "SELECT id, supply_oracle, demand_oracle FROM edge_golden_pairs WHERE round = ? AND status = 'sampled' ORDER BY id",
  ).all(round) as Batch;
  const out: Batch[] = [];
  for (let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
  return out;
}

/**
 * Writes the pass directories of a round (plan D5): for each batch of `batch_size` sampled pairs,
 * three pass directories with the same packet. Records each batch and its packet references.
 * Returns the pass directories.
 */
export function prepareLabelRound(
  db: DatabaseSync, round: number, policy: GraphPolicy, over: Partial<LabelContext> = {},
): string[] {
  const batches = roundBatches(db, round, policy.golden.batch_size);
  if (batches.length === 0) throw new Error(`round ${round} has no sampled pairs to label`);
  if (db.prepare('SELECT 1 FROM edge_golden_batches WHERE round = ? LIMIT 1').get(round)) {
    throw new Error(`round ${round} is already prepared`);
  }
  const ctx = labelContext(db, over);
  const namesSha = sha([...ctx.names].sort().join('\n'));
  const cache = new Map<string, CrContent>();
  const ins = db.prepare(`INSERT INTO edge_golden_batches (round, batch_index, pair_ids, corpus_id, refs_json, packet_sha, packet_bytes, prepared_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // The packets are built and the files written before the rows. If the rows fail, no batch row
  // exists and a new prepare writes the directories again. An old response.json is removed, so
  // that it never stands next to a new packet.
  const built = batches.flatMap((p) => splitToBudget(db, ctx, p, policy.packet_budget_bytes, cache)).map((pairs, b) => {
    const head = `# Edge golden labels - round ${round}, batch ${pad3(b + 1)} - ${pairs.length} pair(s)`;
    const packet = buildLabelPacket(db, ctx, head, pairs, cache);
    return { pairs, packet, bytes: Buffer.byteLength(packet.markdown, 'utf8'), packetSha: sha(packet.markdown) };
  });
  const dirs: string[] = [];
  built.forEach(({ packet, bytes, packetSha }, b) => {
    for (let k = 1; k <= PASSES; k++) {
      const dir = passDir(round, b + 1, k);
      mkdirSync(dir, { recursive: true });
      rmSync(join(dir, 'response.json'), { force: true });
      const manifest: LabelManifest = {
        round, batch_index: b + 1, pass_index: k, corpus_id: ctx.corpusId, names_sha: namesSha,
        pairs: packet.pairs, cards: packet.cards, packet_sha: packetSha, packet_bytes: bytes,
      };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      writeFileSync(join(dir, 'packet.md'), packet.markdown);
      dirs.push(dir);
    }
  });
  db.exec('BEGIN');
  try {
    built.forEach(({ pairs, packet, bytes, packetSha }, b) => {
      ins.run(round, b + 1, JSON.stringify(pairs.map((p) => p.id)), ctx.corpusId, JSON.stringify(packet.refs), packetSha, bytes, new Date().toISOString());
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return dirs;
}

// ---- answers and votes --------------------------------------------------------------------------

const Int = z.number().int().nonnegative();
const ClauseAnswer = z.object({ face_index: Int, clause_index: Int, atom_id: Int.nullable() }).strict();
const CHARACTERISTICS = ['type_line', 'mana_value', 'color_identity', 'power_toughness'] as const;
const CharAnswer = z.object({ characteristic: z.enum(CHARACTERISTICS) }).strict();
const EvidenceZ = z.object({ source: z.enum(['rule', 'glossary']), ref: z.string().min(1), quote: z.string().min(1) }).strict();
const AnswerZ = z.object({
  label: z.enum(['synergy', 'anti', 'none']),
  supply: z.union([ClauseAnswer, CharAnswer]).nullable(),
  demand: ClauseAnswer.nullable(),
  cr_chain: z.array(EvidenceZ),
}).strict();
export type Answer = z.infer<typeof AnswerZ>;

/** The clause part of an answer, as `edge_golden_pairs` stores it (no atom id). */
export function clauseOf(a: Answer['supply']): ClauseRef | null {
  if (a === null) return null;
  return 'characteristic' in a ? { characteristic: a.characteristic } : { face_index: a.face_index, clause_index: a.clause_index };
}

export function clauseKey(c: ClauseRef | null): string {
  if (c === null) return '-';
  return 'characteristic' in c ? `char:${c.characteristic}` : `${c.face_index}.${c.clause_index}`;
}

/** The vote key of spec sec. 11.3: the label and the two clause references. */
export function voteKey(a: Answer): string {
  return `${a.label}|${clauseKey(clauseOf(a.supply))}|${clauseKey(clauseOf(a.demand))}`;
}

/** The faults of a chain: one entry for each quote that fails the check of spec sec. 5.4. */
export function chainFaults(db: DatabaseSync, corpusId: number, chain: Evidence[], refs: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const e of chain) {
    const f = checkEvidence(db, corpusId, e, refs);
    if (f) out.push(`${f}: ${e.source} ${e.ref}`);
  }
  return out;
}

/**
 * Checks one pass answer for one pair. Returns the fault that stops the answer from voting, or
 * null. A pass answer votes only when its shape is valid, its clauses and atoms are in the packet,
 * and each chain quote passes the check of spec sec. 5.4.
 */
export function answerFault(
  db: DatabaseSync, corpusId: number, raw: unknown,
  cards: { supply: LabelManifest['cards'][number]; demand: LabelManifest['cards'][number] },
  refs: ReadonlySet<string>,
): { answer: Answer | null; fault: string | null } {
  if (raw === undefined) return { answer: null, fault: 'missing' };
  const parsed = AnswerZ.safeParse(raw);
  if (!parsed.success) return { answer: null, fault: `invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  const a = parsed.data;
  if (a.label === 'none') {
    // The answer format gives a none label null clauses and an empty chain. A chain here is not
    // checked, so it must not vote: each stored quote is a verified quote (spec sec. 10.2).
    if (a.supply !== null || a.demand !== null) return { answer: a, fault: 'invalid: a none label has null clauses' };
    return a.cr_chain.length === 0 ? { answer: a, fault: null } : { answer: a, fault: 'invalid: a none label needs an empty CR chain' };
  }
  if (a.supply === null || a.demand === null) return { answer: a, fault: 'invalid: a synergy or anti label needs both clauses' };
  if (a.cr_chain.length === 0) return { answer: a, fault: 'invalid: a synergy or anti label needs a CR chain' };
  const sides = [['supply', a.supply, cards.supply], ['demand', a.demand, cards.demand]] as const;
  for (const [side, ans, card] of sides) {
    if ('characteristic' in ans) continue;
    if (!card.clauses.includes(`${ans.face_index}.${ans.clause_index}`)) {
      return { answer: a, fault: `invalid: the ${side} clause ${ans.face_index}.${ans.clause_index} is not a clause of card ${card.key}` };
    }
    if (ans.atom_id !== null && !card.atoms.includes(ans.atom_id)) {
      return { answer: a, fault: `invalid: atom ${ans.atom_id} is not an atom of card ${card.key}` };
    }
  }
  const faults = chainFaults(db, corpusId, a.cr_chain, refs);
  return { answer: a, fault: faults.length ? `quote: ${faults.join('; ')}` : null };
}

export interface PassAnswer { pass_index: number; answer: Answer | null; fault: string | null }

export interface VoteResult {
  status: 'accepted' | 'disputed';
  votes: number;
  winner: Answer | null;
  supply_atom_id: number | null;
  demand_atom_id: number | null;
  chain: Evidence[];
}

/**
 * spec sec. 11.3: a pair is accepted when two or more passes give the same label and the same two
 * clauses. Only answers with no fault vote, so a pair is never accepted on a failed quote. The
 * atom ID of each side is the most frequent one in the winning group (the lowest pass first on a
 * tie). The chain is the union of the verified quotes of the winning group.
 */
export function votePair(passes: PassAnswer[]): VoteResult {
  const groups = new Map<string, PassAnswer[]>();
  for (const p of passes) {
    if (p.fault !== null || p.answer === null) continue;
    const k = voteKey(p.answer);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const best = [...groups.values()].sort((x, y) => y.length - x.length || x[0]!.pass_index - y[0]!.pass_index)[0];
  if (!best || best.length < 2) {
    return { status: 'disputed', votes: best?.length ?? 0, winner: null, supply_atom_id: null, demand_atom_id: null, chain: [] };
  }
  const atom = (side: 'supply' | 'demand'): number | null => {
    const counts = new Map<number | null, number>();
    for (const p of best) {
      const s = p.answer![side];
      const id = s && 'atom_id' in s ? s.atom_id : null;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].sort((x, y) => y[1] - x[1])[0]![0];
  };
  const seen = new Set<string>();
  const chain: Evidence[] = [];
  for (const p of best) {
    for (const e of p.answer!.cr_chain) {
      const k = `${e.source}|${e.ref}|${e.quote}`;
      if (!seen.has(k)) { seen.add(k); chain.push(e); }
    }
  }
  return { status: 'accepted', votes: best.length, winner: best[0]!.answer, supply_atom_id: atom('supply'), demand_atom_id: atom('demand'), chain };
}

function readManifest(dir: string): LabelManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as LabelManifest;
}

/**
 * Reads the three responses of each batch of a round, checks each pass answer, votes and stores
 * the result. All responses must be present and readable: nothing is stored otherwise. `rejected`
 * counts the pass answers that do not vote; `stale` counts the pairs skipped because a text changed.
 */
export function submitLabelRound(db: DatabaseSync, round: number): { accepted: number; disputed: number; rejected: number; stale: number } {
  const batches = db.prepare('SELECT batch_index, pair_ids, corpus_id, refs_json FROM edge_golden_batches WHERE round = ? ORDER BY batch_index')
    .all(round) as Array<{ batch_index: number; pair_ids: string; corpus_id: number; refs_json: string }>;
  if (batches.length === 0) throw new Error(`round ${round} is not prepared`);
  const missing = batches.flatMap((b) => Array.from({ length: PASSES }, (_, k) => passDir(round, b.batch_index, k + 1)))
    .filter((d) => !existsSync(join(d, 'response.json')));
  if (missing.length) throw new Error(`no response.json in:\n  ${missing.join('\n  ')}`);
  // A file that is not JSON with a "pairs" object stops the submit, so that its pass can run again.
  const responses = new Map<string, Record<string, unknown>>();
  const unreadable: string[] = [];
  for (const b of batches) {
    for (let k = 1; k <= PASSES; k++) {
      const file = join(passDir(round, b.batch_index, k), 'response.json');
      try {
        const body = JSON.parse(readFileSync(file, 'utf8')) as { pairs?: unknown };
        if (body.pairs === null || typeof body.pairs !== 'object' || Array.isArray(body.pairs)) throw new Error('no pairs object');
        responses.set(file, body.pairs as Record<string, unknown>);
      } catch (err) {
        unreadable.push(`${file} (${(err as Error).message})`);
      }
    }
  }
  if (unreadable.length) {
    throw new Error(`these files are not JSON with a "pairs" object; dispatch their passes again:\n  ${unreadable.join('\n  ')}`);
  }

  const status = db.prepare('SELECT status FROM edge_golden_pairs WHERE id = ?');
  const insVote = db.prepare('INSERT OR REPLACE INTO edge_golden_votes (pair_id, pass_index, answer_json, fault) VALUES (?, ?, ?, ?)');
  const update = db.prepare(`UPDATE edge_golden_pairs SET label = ?, supply_clause = ?, demand_clause = ?, supply_atom_id = ?,
                               demand_atom_id = ?, cr_chain_json = ?, votes = ?, status = ? WHERE id = ?`);
  const totals = { accepted: 0, disputed: 0, rejected: 0, stale: 0 };
  db.exec('BEGIN');
  try {
    for (const b of batches) {
      const refs = new Set(JSON.parse(b.refs_json) as string[]);
      const manifest = readManifest(passDir(round, b.batch_index, 1));
      const answers = Array.from({ length: PASSES }, (_, k) => responses.get(join(passDir(round, b.batch_index, k + 1), 'response.json'))!);
      const cardOf = new Map(manifest.cards.map((c) => [c.key, c]));
      for (const p of manifest.pairs) {
        const st = (status.get(p.pair_id) as { status: string } | undefined)?.status;
        // A pair that went stale after the prepare keeps no votes: its text is not the text the
        // labeler read. The other pairs of the round are stored.
        if (st === 'stale') { totals.stale++; continue; }
        if (st !== 'sampled') throw new Error(`pair ${p.pair_id} has the status ${st ?? 'unknown'}, not sampled: round ${round} is already submitted`);
        const cards = { supply: cardOf.get(p.supply)!, demand: cardOf.get(p.demand)! };
        const passes: PassAnswer[] = answers.map((r, k) => {
          const raw = r[p.key];
          const { answer, fault } = answerFault(db, b.corpus_id, raw, cards, refs);
          insVote.run(p.pair_id, k + 1, raw === undefined ? null : JSON.stringify(raw), fault);
          if (fault) totals.rejected++;
          return { pass_index: k + 1, answer, fault };
        });
        const v = votePair(passes);
        totals[v.status]++;
        const w = v.winner;
        update.run(
          w?.label ?? null,
          w ? JSON.stringify(clauseOf(w.supply)) : null,
          w ? JSON.stringify(clauseOf(w.demand)) : null,
          v.supply_atom_id, v.demand_atom_id,
          w ? JSON.stringify(v.chain) : null,
          v.votes, v.status, p.pair_id,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return totals;
}

/**
 * Plan Task 2 Step 9: after a change to the label instructions, the labeler runs again on all
 * pairs. This puts the accepted and disputed pairs of a round back to `sampled`, removes their
 * votes and batch rows, and moves the old pass directories aside (they are not deleted). A round
 * with an owner verdict or a pair in an owner sample is refused: those decisions are the owner's.
 */
export function resetLabelRound(db: DatabaseSync, round: number): { pairs: number; archived: string | null } {
  const owned = (db.prepare(
    `SELECT COUNT(*) n FROM edge_golden_pairs p WHERE p.round = ?
        AND (p.status IN ('owner_accepted','owner_corrected') OR EXISTS (SELECT 1 FROM edge_golden_owner_sample o WHERE o.pair_id = p.id))`,
  ).get(round) as { n: number }).n;
  if (owned > 0) throw new Error(`round ${round} has ${owned} pair(s) with an owner verdict or in an owner sample`);
  let pairs = 0;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM edge_golden_votes WHERE pair_id IN (SELECT id FROM edge_golden_pairs WHERE round = ?)').run(round);
    db.prepare('DELETE FROM edge_golden_batches WHERE round = ?').run(round);
    pairs = Number(db.prepare(
      `UPDATE edge_golden_pairs SET label = NULL, supply_clause = NULL, demand_clause = NULL, supply_atom_id = NULL,
              demand_atom_id = NULL, cr_chain_json = NULL, votes = 0, status = 'sampled'
        WHERE round = ? AND status IN ('accepted','disputed')`,
    ).run(round).changes);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const dir = roundDir(round);
  if (!existsSync(dir)) return { pairs, archived: null };
  const archived = `${dir}-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(dir, archived);
  return { pairs, archived };
}

// ---- stale pairs, owner sample and verdicts -----------------------------------------------------

/** spec sec. 11.3: a pair becomes `stale` when one of its two texts changes. Returns the count. */
export function retireStalePairs(db: DatabaseSync): number {
  const rows = db.prepare(
    `SELECT p.id, p.oracle_hashes, s.oracle_hash AS sh, d.oracle_hash AS dh FROM edge_golden_pairs p
       LEFT JOIN cards s ON s.oracle_id = p.supply_oracle LEFT JOIN cards d ON d.oracle_id = p.demand_oracle
      WHERE p.status <> 'stale'`,
  ).all() as Array<{ id: number; oracle_hashes: string; sh: string | null; dh: string | null }>;
  const mark = db.prepare("UPDATE edge_golden_pairs SET status = 'stale' WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const [s, d] = JSON.parse(r.oracle_hashes) as [string, string];
    if (s !== r.sh || d !== r.dh) { mark.run(r.id); n++; }
  }
  return n;
}

export const latestSample = (db: DatabaseSync): number =>
  (db.prepare('SELECT COALESCE(MAX(sample_no), 0) n FROM edge_golden_owner_sample').get() as { n: number }).n;

/**
 * spec sec. 11.4: the owner sample. Pairs, in a fixed draw order:
 * 1. all `disputed` pairs, to a maximum of `OWNER_SAMPLE_MAX_DISPUTED`;
 * 2. the label minimums of `OWNER_SAMPLE_LABELS` from the accepted pairs, first from strata
 *    that the sample does not have yet;
 * 3. one accepted pair of each stratum that has accepted pairs and is not in the sample yet;
 * 4. accepted pairs to `owner_sample` pairs.
 * A stratum with disputed pairs only, beyond the first 8, can stay out of the sample: the rules of
 * sec. 11.4 conflict there. `ownerSampleGaps` names such strata (review finding M6).
 * Writes a new sample and returns its pair ids. A new sample waits until the owner has decided
 * each pair of the last sample.
 */
export function selectOwnerSample(db: DatabaseSync, policy: GraphPolicy): number[] {
  const last = latestSample(db);
  const open = (db.prepare(
    `SELECT COUNT(*) n FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id
      WHERE o.sample_no = ? AND p.status IN ('accepted','disputed')`,
  ).get(last) as { n: number }).n;
  if (last > 0 && open > 0) throw new Error(`owner sample ${last} has ${open} pairs without a verdict`);
  const sampleNo = last + 1;
  const rows = (db.prepare("SELECT id, stratum, status, label FROM edge_golden_pairs WHERE status IN ('accepted','disputed')")
    .all() as Array<{ id: number; stratum: string; status: 'accepted' | 'disputed'; label: Label | null }>)
    .sort((a, b) => draw(sampleNo, String(a.id)) - draw(sampleNo, String(b.id)));
  const size = policy.golden.owner_sample;
  const chosen = new Map<number, (typeof rows)[number]>();
  const strata = () => new Set([...chosen.values()].map((r) => r.stratum));

  for (const r of rows.filter((x) => x.status === 'disputed').slice(0, OWNER_SAMPLE_MAX_DISPUTED)) chosen.set(r.id, r);
  const accepted = rows.filter((x) => x.status === 'accepted');
  for (const label of Object.keys(OWNER_SAMPLE_LABELS) as Label[]) {
    const have = () => [...chosen.values()].filter((r) => r.label === label).length;
    const pool = accepted.filter((r) => r.label === label);
    while (have() < OWNER_SAMPLE_LABELS[label]) {
      const s = strata();
      const next = pool.find((r) => !chosen.has(r.id) && !s.has(r.stratum)) ?? pool.find((r) => !chosen.has(r.id));
      if (!next) break;
      chosen.set(next.id, next);
    }
  }
  for (const stratum of [...new Set(accepted.map((r) => r.stratum))].sort()) {
    if (strata().has(stratum)) continue;
    const next = accepted.find((r) => r.stratum === stratum);
    if (next) chosen.set(next.id, next);
  }
  for (const r of accepted) {
    if (chosen.size >= size) break;
    chosen.set(r.id, r);
  }
  const ins = db.prepare('INSERT INTO edge_golden_owner_sample (sample_no, pair_id, prior_status, prior_label, sampled_at) VALUES (?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of chosen.values()) ins.run(sampleNo, r.id, r.status, r.label, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return [...chosen.keys()];
}

/** The strata with labelled (accepted or disputed) pairs that the latest owner sample does not have. */
export function ownerSampleGaps(db: DatabaseSync): string[] {
  const sample = latestSample(db);
  return (db.prepare(
    `SELECT DISTINCT stratum FROM edge_golden_pairs WHERE status IN ('accepted','disputed','owner_accepted','owner_corrected')
       AND stratum NOT IN (SELECT p.stratum FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id WHERE o.sample_no = ?)
     ORDER BY stratum`,
  ).all(sample) as Array<{ stratum: string }>).map((r) => r.stratum);
}

/** The packet references of the batch that a pair was labelled in, with its corpus. */
function pairRefs(db: DatabaseSync, pairId: number): { corpusId: number; refs: Set<string> } {
  const row = db.prepare(
    `SELECT b.corpus_id, b.refs_json FROM edge_golden_batches b, json_each(b.pair_ids) j WHERE j.value = ?`,
  ).get(pairId) as { corpus_id: number; refs_json: string } | undefined;
  if (!row) throw new GoldenError('invalid', `pair ${pairId} has no label batch`);
  return { corpusId: row.corpus_id, refs: new Set(JSON.parse(row.refs_json) as string[]) };
}

const ClauseRefZ = z.union([
  z.object({ face_index: Int, clause_index: Int }).strict(),
  z.object({ characteristic: z.enum(CHARACTERISTICS) }).strict(),
]);
/** The body of a verdict request. A body that does not parse is a 400 (review finding L1). */
export const VerdictZ = z.union([
  z.object({ accept: z.literal(true), note: z.string().optional() }).strict(),
  z.object({
    accept: z.literal(false),
    label: z.enum(['synergy', 'anti', 'none']),
    note: z.string(),
    supply_clause: ClauseRefZ.nullable().optional(),
    demand_clause: ClauseRefZ.nullable().optional(),
    supply_atom_id: Int.nullable().optional(),
    demand_atom_id: Int.nullable().optional(),
    cr_chain: z.array(EvidenceZ).optional(),
  }).strict(),
]);
export type Verdict = z.infer<typeof VerdictZ>;

/**
 * The owner's verdict on a pair (spec sec. 11.4, plan D13). An accept keeps the labeler label.
 * A correction stores the owner's label, clauses, atoms and chain verbatim; the CLI checks each
 * chain quote against the packet of the pair (spec sec. 5.4). The session never writes a verdict.
 */
export function ownerVerdict(db: DatabaseSync, pairId: number, v: Verdict): void {
  const pair = db.prepare('SELECT id, supply_oracle, demand_oracle, status, label FROM edge_golden_pairs WHERE id = ?')
    .get(pairId) as { id: number; supply_oracle: string; demand_oracle: string; status: string; label: Label | null } | undefined;
  if (!pair) throw new GoldenError('not_found', `no golden pair ${pairId}`);
  if (pair.status === 'stale') throw new GoldenError('invalid', `pair ${pairId} is stale: one of its texts changed`);
  if (pair.status === 'sampled') throw new GoldenError('invalid', `pair ${pairId} has no labels yet`);

  if (v.accept) {
    if (pair.label === null) throw new GoldenError('invalid', `pair ${pairId} is disputed: it has no label to accept. Give a correction.`);
    if (pair.status !== 'accepted') throw new GoldenError('invalid', `pair ${pairId} is ${pair.status}: only a labeler label can be accepted`);
    db.prepare("UPDATE edge_golden_pairs SET status = 'owner_accepted', owner_note = ? WHERE id = ?").run(v.note ?? null, pairId);
    return;
  }

  if (!['synergy', 'anti', 'none'].includes(v.label)) throw new GoldenError('invalid', `unknown label "${v.label}"`);
  if (typeof v.note !== 'string' || v.note.trim() === '') throw new GoldenError('invalid', 'a correction needs a note');
  const polar = v.label !== 'none';
  const supply = polar ? v.supply_clause ?? null : null;
  const demand = polar ? v.demand_clause ?? null : null;
  if (polar && (!supply || !demand)) throw new GoldenError('invalid', 'a synergy or anti label needs a supply clause and a demand clause');
  if (demand && 'characteristic' in demand) throw new GoldenError('invalid', 'only the supply side can be a characteristic');
  const clauseOk = db.prepare(
    `SELECT 1 FROM clauses c JOIN cards k ON k.oracle_id = c.oracle_id AND k.oracle_hash = c.oracle_hash
      WHERE c.oracle_id = ? AND c.face_index = ? AND c.clause_index = ?`,
  );
  const atomOk = db.prepare('SELECT 1 FROM atoms WHERE id = ? AND oracle_id = ? AND is_current = 1');
  for (const [side, ref, card, atom] of [
    ['supply', supply, pair.supply_oracle, v.supply_atom_id ?? null],
    ['demand', demand, pair.demand_oracle, v.demand_atom_id ?? null],
  ] as const) {
    if (!ref) continue;
    if ('characteristic' in ref) {
      if (!(CHARACTERISTICS as readonly string[]).includes(ref.characteristic)) {
        throw new GoldenError('invalid', `unknown characteristic "${ref.characteristic}"`);
      }
      if (atom !== null) throw new GoldenError('invalid', 'a characteristic supply has no atom ID');
    } else if (!clauseOk.get(card, ref.face_index, ref.clause_index)) {
      throw new GoldenError('invalid', `the ${side} card has no clause ${ref.face_index}.${ref.clause_index}`);
    }
    if (atom !== null && !atomOk.get(atom, card)) throw new GoldenError('invalid', `atom ${atom} is not a current atom of the ${side} card`);
  }
  const chain = v.cr_chain ?? [];
  if (polar && chain.length === 0) throw new GoldenError('invalid', 'a synergy or anti label needs a CR chain');
  if (chain.length > 0) {
    const { corpusId, refs } = pairRefs(db, pairId);
    const faults = chainFaults(db, corpusId, chain, refs);
    if (faults.length) throw new GoldenError('invalid', `the CR chain fails the quote check: ${faults.join('; ')}`);
  }
  db.prepare(`UPDATE edge_golden_pairs SET status = 'owner_corrected', label = ?, supply_clause = ?, demand_clause = ?,
                supply_atom_id = ?, demand_atom_id = ?, cr_chain_json = ?, owner_note = ? WHERE id = ?`)
    .run(v.label, supply ? JSON.stringify(supply) : null, demand ? JSON.stringify(demand) : null,
      supply ? v.supply_atom_id ?? null : null, demand ? v.demand_atom_id ?? null : null,
      JSON.stringify(chain), v.note, pairId);
}

/**
 * spec sec. 11.4: the agreement between the owner and the labeler on the latest sample. The rate
 * uses the pairs that had a labeler label when sampled: `owner_accepted` agrees,
 * `owner_corrected` does not. `corrected` is the number that the owner-correction limit tests.
 * A disputed pair has no labeler label, so it counts in `resolved_disputed` only.
 */
export function ownerAgreement(db: DatabaseSync): {
  sample: number; sampled: number; decided: number; corrected: number; resolved_disputed: number; rate: number | null;
} {
  const sample = latestSample(db);
  const rows = db.prepare(
    `SELECT o.prior_status, p.status FROM edge_golden_owner_sample o JOIN edge_golden_pairs p ON p.id = o.pair_id WHERE o.sample_no = ?`,
  ).all(sample) as Array<{ prior_status: string; status: string }>;
  const fromAccepted = rows.filter((r) => r.prior_status === 'accepted');
  const agreed = fromAccepted.filter((r) => r.status === 'owner_accepted').length;
  const corrected = fromAccepted.filter((r) => r.status === 'owner_corrected').length;
  return {
    sample,
    sampled: rows.length,
    decided: rows.filter((r) => r.status === 'owner_accepted' || r.status === 'owner_corrected').length,
    corrected,
    resolved_disputed: rows.filter((r) => r.prior_status === 'disputed' && r.status.startsWith('owner_')).length,
    rate: agreed + corrected > 0 ? agreed / (agreed + corrected) : null,
  };
}

// ---- the page -----------------------------------------------------------------------------------

export interface PairView {
  id: number; round: number; stratum: string; status: string; label: Label | null; votes: number;
  supply_clause: ClauseRef | null; demand_clause: ClauseRef | null;
  supply_atom_id: number | null; demand_atom_id: number | null;
  cr_chain: Evidence[]; owner_note: string | null; in_sample: boolean;
  supply: CardView; demand: CardView;
  passes: Array<{ pass_index: number; answer: unknown; fault: string | null }>;
  /** The isolated reviewer's blind answer in the latest owner sample, if any. */
  review: { outcome: string; answer: unknown; fault: string | null } | null;
}

const PAIR_STATUSES = ['sampled', 'accepted', 'disputed', 'owner_accepted', 'owner_corrected', 'stale'];

/**
 * The pairs for the /edge-golden page (spec sec. 13.5), with redacted texts and no card names.
 * `status` filters by status; 'sample' gives the pairs of the latest owner sample.
 */
export function listPairs(db: DatabaseSync, status?: string, names: readonly string[] = redactionNames(db)): PairView[] {
  const sample = latestSample(db);
  const inSample = new Set((db.prepare('SELECT pair_id FROM edge_golden_owner_sample WHERE sample_no = ?').all(sample) as Array<{ pair_id: number }>)
    .map((r) => r.pair_id));
  if (status && status !== 'sample' && !PAIR_STATUSES.includes(status)) throw new GoldenError('invalid', `unknown status "${status}"`);
  const rows = (status && status !== 'sample'
    ? db.prepare('SELECT * FROM edge_golden_pairs WHERE status = ? ORDER BY id').all(status)
    : db.prepare('SELECT * FROM edge_golden_pairs ORDER BY id').all()) as Array<Record<string, unknown>>;
  const votes = db.prepare('SELECT pass_index, answer_json, fault FROM edge_golden_votes WHERE pair_id = ? ORDER BY pass_index');
  const review = db.prepare('SELECT outcome, answer_json, fault FROM edge_golden_reviews WHERE sample_no = ? AND pair_id = ?');
  const views = new Map<string, CardView>();
  const view = (id: string) => {
    let v = views.get(id);
    if (!v) {
      try { v = cardView(db, id, names); } catch (err) {
        v = { oracle_id: id, mana_value: 0, color_identity: [], faces: [], atoms: [], unavailable: (err as Error).message };
      }
      views.set(id, v);
    }
    return v;
  };
  const json = <T>(v: unknown, empty: T): T => (typeof v === 'string' ? JSON.parse(v) as T : empty);
  return rows.filter((r) => status !== 'sample' || inSample.has(r['id'] as number)).map((r) => ({
    id: r['id'] as number, round: r['round'] as number, stratum: r['stratum'] as string, status: r['status'] as string,
    label: r['label'] as Label | null, votes: r['votes'] as number,
    supply_clause: json<ClauseRef | null>(r['supply_clause'], null), demand_clause: json<ClauseRef | null>(r['demand_clause'], null),
    supply_atom_id: r['supply_atom_id'] as number | null, demand_atom_id: r['demand_atom_id'] as number | null,
    cr_chain: json<Evidence[]>(r['cr_chain_json'], []), owner_note: r['owner_note'] as string | null,
    in_sample: inSample.has(r['id'] as number),
    supply: view(r['supply_oracle'] as string), demand: view(r['demand_oracle'] as string),
    passes: (votes.all(r['id'] as number) as Array<{ pass_index: number; answer_json: string | null; fault: string | null }>)
      .map((p) => ({ pass_index: p.pass_index, answer: p.answer_json ? JSON.parse(p.answer_json) as unknown : null, fault: p.fault })),
    review: ((r) => r ? { outcome: r.outcome, answer: r.answer_json ? JSON.parse(r.answer_json) as unknown : null, fault: r.fault } : null)(
      review.get(sample, r['id'] as number) as { outcome: string; answer_json: string | null; fault: string | null } | undefined),
  }));
}
