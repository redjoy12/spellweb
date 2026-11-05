/**
 * The debate of the fuzzy CR sentence pairs (owner decision 2026-10-18: "try the isolated debate
 * first"; docs/phase-3-duplicate-reasons.md sec. 11.4 step A).
 *
 * Each item is one fuzzy member of a CR sentence group (src/rules/crDuplicates.ts) and its main
 * sentence. Three fresh `edge-rule-debater` subagents read a packet that holds only the sentence
 * pairs and the instructions, and select `same` or `different` for each item, with an argument and
 * quotes from the two sentences. The item is agreed when all three debaters of one round select the
 * same option, each with valid quotes. From round 2 the packet shows the arguments of the round
 * before. After MAX_ROUNDS an item that is not agreed keeps the default: `different` (not
 * applied), and it stays pending for the owner.
 *
 * An owner answer (`owner_decisions`, kind `cr_text`) comes before a debate: such an item is not
 * debated. The verdicts are debate verdicts, not owner decisions. They go to
 * data/cr-debate/verdicts.json. The code makes no model call and knows no Magic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { crDuplicates } from '../rules/crDuplicates.js';
import { EvidenceZ } from './ruleSchema.js';
import { normalizeQuote } from './quotes.js';

export const CR_DEBATERS = 3;
export const CR_MAX_ROUNDS = 3;
export const CR_BATCH_SIZE = 40;

const here = dirname(fileURLToPath(import.meta.url));
export const VERDICTS_PATH = resolve(here, '../../data/cr-debate/verdicts.json');
export const crDebateDir = () => resolve(here, '../../data/cr-debate');
export const crDebaterDir = (round: number, batch: number, debater: number, root = crDebateDir()) =>
  join(root, `round-${round}`, `batch-${String(batch).padStart(2, '0')}`, `debater-${debater}`);

export interface CrDebateItem {
  key: string;
  main: { source: 'rule' | 'glossary'; ref: string; text: string };
  member: { source: 'rule' | 'glossary'; ref: string; text: string };
}

export type Verdict = 'same' | 'different' | 'no_agreement';
export interface VerdictEntry {
  verdict: Verdict;
  round: number;
  main: string;
  member: string;
  /** The valid choices of the last round: same, different, and the number of answers with a fault. */
  votes: { same: number; different: number; faults: number };
}
export interface VerdictFile {
  note: string;
  corpus: number;
  decided_by: 'debate';
  items: Record<string, VerdictEntry>;
}

export function loadVerdicts(path = VERDICTS_PATH): VerdictFile | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as VerdictFile) : null;
}

const label = (s: { source: string; ref: string }) => (s.source === 'rule' ? `rule ${s.ref}` : `glossary ${s.ref}`);

/** All fuzzy pairs of the corpus, keyed as on the decisions page (`c<corpus>:<member>><main>`). */
export function crPairs(db: DatabaseSync, corpusId: number): CrDebateItem[] {
  const d = crDuplicates(db, corpusId);
  return d.groups.flatMap((g) => g.members.filter((m) => m.tier === 'fuzzy').map((m) => ({
    key: `c${corpusId}:${m.key}>${g.main.key}`,
    main: { source: g.main.source, ref: g.main.ref, text: g.main.text },
    member: { source: m.source, ref: m.ref, text: m.text },
  })));
}

function ownerAnswered(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT item_key FROM owner_decisions WHERE kind = 'cr_text'").all() as Array<{ item_key: string }>).map((r) => r.item_key));
}

export const CR_DEBATE_INSTRUCTIONS = `You take part in a debate about pairs of sentences from the Comprehensive Rules (CR). Use ONLY the text in this packet. Do not use anything that you remember about the game or about a card.

Each item has two CR sentences, Text A and Text B. A word test found that they have nearly the same words. The app wants to keep only Text A, and to show Text B as "also stated in Text A". This is correct only when Text A states everything that Text B states.

The options of each item are:
- same: Text A states everything that Text B states. A reader who has only Text A knows all that Text B says. Text B can use other words, another word order, a pronoun in place of a noun, or a word that adds nothing to what the sentence states.
- different: Text B states something that Text A does not state. Examples: Text B names a different thing; Text B has a condition, a limit or a qualifier that Text A does not have, and it changes what the sentence states; Text B applies to things that Text A does not include.
The order of the options has no meaning.

Do these steps for each item:
1. Read Text A and Text B word by word. Find each word or part that is only in one of the two texts.
2. For each difference, decide from the two texts only if it changes what is stated.
3. If "Arguments of the previous round" has arguments for the item, read them. Examine each argument against the two texts. An argument is not correct only because other debaters gave it.
4. Select one option. Write an argument: two to four sentences that name the differences and state why they do or do not change what is stated.
5. Give the evidence: one or more quotes from Text A or Text B of the item. Copy each quote character for character. Do not join two parts with an ellipsis.

Decide each item alone. The decision on one item has no effect on the decision on a different item. Other debaters answer the same items in their own directories. Do not try to match their answers.`;

export const CR_DEBATE_ANSWER_FORMAT = `Write ONE file, response.json, in the directory of this packet. Write it one time. It contains only this JSON object, with no commentary and no code fence:

{"answers": [ANSWER, ...]}

ANSWER is {"item": "D", "choice": "C", "argument": "A", "evidence": [EVIDENCE, ...]}.
- D is the label of the item in "Disputed items", for example "D01".
- C is "same" or "different".
- A is your argument.
Give one or more EVIDENCE items for each ANSWER. EVIDENCE is {"source": "rule", "ref": "R", "quote": "Q"} or {"source": "glossary", "ref": "T", "quote": "Q"}. R is the rule number of Text A or Text B, as the item shows it after the word "rule". T is the glossary term of Text A or Text B as the item shows it. R and T are JSON strings. Q is copied from that text.

Give one ANSWER for each item. Use no other fields.`;

export const CrDebateResponse = z.object({
  answers: z.array(z.object({
    item: z.string().min(1), choice: z.string().min(1), argument: z.string().min(1), evidence: z.array(EvidenceZ),
  }).strict()),
}).strict();

interface PrevArgument { debater: number; choice: string; argument: string }
interface RoundManifest { round: number; corpus: number; batches: Array<{ batch: number; items: string[] }> }
interface RoundAnswers { round: number; answers: Record<string, Array<{ debater: number; choice: string | null; argument: string; fault: string | null }>> }

export function renderCrPacket(round: number, batch: number, debater: number, items: CrDebateItem[], prev: Map<string, PrevArgument[]>): string {
  const L = [`# Debate packet: repeated Comprehensive Rules sentences (round ${round}, batch ${batch}, debater ${debater})`, '',
    '## Instructions', '', CR_DEBATE_INSTRUCTIONS, '', '## Disputed items', ''];
  items.forEach((it, i) => {
    L.push(`### D${String(i + 1).padStart(2, '0')}`, '',
      `- Text A (${label(it.main)}): "${it.main.text}"`,
      `- Text B (${label(it.member)}): "${it.member.text}"`,
      '- Options: same, different');
    const args = prev.get(it.key) ?? [];
    if (args.length) {
      L.push('- Arguments of the previous round:');
      for (const a of args) L.push(`  - Debater ${String.fromCharCode(64 + a.debater)}: choice ${a.choice}. Argument: ${a.argument}`);
    }
    L.push('');
  });
  L.push('## Answer format', '', CR_DEBATE_ANSWER_FORMAT, '');
  return L.join('\n');
}

/** The items of a round: round 1, every fuzzy pair with no owner answer; later rounds, the pairs that are not agreed. */
export function roundItems(db: DatabaseSync, corpusId: number, round: number, root = crDebateDir()): CrDebateItem[] {
  const answered = ownerAnswered(db);
  const all = crPairs(db, corpusId).filter((p) => !answered.has(p.key));
  if (round === 1) return all;
  const prev = JSON.parse(readFileSync(join(root, `round-${round - 1}`, 'outcomes.json'), 'utf8')) as Record<string, Verdict>;
  return all.filter((p) => prev[p.key] === 'no_agreement');
}

/** Writes the packets of one round: one directory for each batch and debater. */
export function prepareCrRound(db: DatabaseSync, corpusId: number, round: number, root = crDebateDir(), size = CR_BATCH_SIZE): RoundManifest {
  if (round < 1 || round > CR_MAX_ROUNDS) throw new Error(`round ${round}: use 1 to ${CR_MAX_ROUNDS}`);
  const items = roundItems(db, corpusId, round, root);
  const prev = new Map<string, PrevArgument[]>();
  if (round > 1) {
    const a = JSON.parse(readFileSync(join(root, `round-${round - 1}`, 'answers.json'), 'utf8')) as RoundAnswers;
    for (const [k, list] of Object.entries(a.answers)) {
      prev.set(k, list.filter((x) => x.fault === null && x.choice !== null).map((x) => ({ debater: x.debater, choice: x.choice!, argument: x.argument })));
    }
  }
  const manifest: RoundManifest = { round, corpus: corpusId, batches: [] };
  for (let i = 0, b = 1; i < items.length; i += size, b++) {
    const part = items.slice(i, i + size);
    manifest.batches.push({ batch: b, items: part.map((p) => p.key) });
    for (let d = 1; d <= CR_DEBATERS; d++) {
      const dir = crDebaterDir(round, b, d, root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'packet.md'), renderCrPacket(round, b, d, part, prev), 'utf8');
    }
  }
  mkdirSync(join(root, `round-${round}`), { recursive: true });
  writeFileSync(join(root, `round-${round}`, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

const quoteIn = (text: string, q: string) => { const n = normalizeQuote(q); return n !== '' && normalizeQuote(text).includes(n); };

/** The fault of one answer, or null: the choice, the argument and each quote (it must be in Text A or Text B, with its ref). */
export function answerFault(item: CrDebateItem, a: { choice: string; argument: string; evidence: Array<{ source: string; ref: string; quote: string }> }): string | null {
  if (a.choice !== 'same' && a.choice !== 'different') return `choice "${a.choice}" is not same or different`;
  if (!a.argument.trim()) return 'no argument';
  if (a.evidence.length === 0) return 'no evidence';
  for (const e of a.evidence) {
    // Text A and Text B can be two sentences of one rule or glossary entry: the quote can be in either.
    const texts = [item.main, item.member].filter((t) => t.source === e.source && t.ref.toLowerCase() === e.ref.toLowerCase());
    if (texts.length === 0) return `evidence ref ${e.source} ${e.ref} is not Text A or Text B`;
    if (!texts.some((t) => quoteIn(t.text, e.quote))) return `quote not verbatim in ${e.source} ${e.ref}`;
  }
  return null;
}

export interface CrSubmitResult { round: number; items: number; agreed: { same: number; different: number }; not_agreed: number; missing: string[]; faults: number }

/**
 * Reads the answers of one round, finds the outcome of each item, and updates the verdict file.
 * A missing response.json stops the submit (the round is not complete).
 */
export function submitCrRound(db: DatabaseSync, round: number, root = crDebateDir(), verdictsPath = VERDICTS_PATH): CrSubmitResult {
  const manifest = JSON.parse(readFileSync(join(root, `round-${round}`, 'manifest.json'), 'utf8')) as RoundManifest;
  const byKey = new Map(crPairs(db, manifest.corpus).map((p) => [p.key, p]));
  const missing: string[] = [];
  for (const b of manifest.batches) for (let d = 1; d <= CR_DEBATERS; d++) {
    if (!existsSync(join(crDebaterDir(round, b.batch, d, root), 'response.json'))) missing.push(`batch ${b.batch} debater ${d}`);
  }
  if (missing.length) return { round, items: 0, agreed: { same: 0, different: 0 }, not_agreed: 0, missing, faults: 0 };

  const answers: RoundAnswers = { round, answers: {} };
  let faults = 0;
  for (const b of manifest.batches) {
    for (let d = 1; d <= CR_DEBATERS; d++) {
      const file = join(crDebaterDir(round, b.batch, d, root), 'response.json');
      let parsed: z.infer<typeof CrDebateResponse> | null = null;
      try { parsed = CrDebateResponse.parse(JSON.parse(readFileSync(file, 'utf8'))); } catch { parsed = null; }
      b.items.forEach((key, i) => {
        const lab = `D${String(i + 1).padStart(2, '0')}`;
        const a = parsed?.answers.find((x) => x.item === lab);
        const item = byKey.get(key);
        const fault = !item ? 'item not in the corpus' : !parsed ? 'response.json is not valid' : !a ? `no answer for ${lab}` : answerFault(item, a);
        if (fault) faults++;
        (answers.answers[key] ??= []).push({ debater: d, choice: a?.choice ?? null, argument: a?.argument ?? '', fault });
      });
    }
  }
  writeFileSync(join(root, `round-${round}`, 'answers.json'), JSON.stringify(answers, null, 2) + '\n', 'utf8');

  const file: VerdictFile = loadVerdicts(verdictsPath) ?? {
    note: 'Debate verdicts on the fuzzy CR sentence pairs (src/graph/crDebate.ts). Not owner decisions. Generated by npm run cr-debate; do not edit.',
    corpus: manifest.corpus, decided_by: 'debate', items: {},
  };
  const outcomes: Record<string, Verdict> = {};
  const res: CrSubmitResult = { round, items: 0, agreed: { same: 0, different: 0 }, not_agreed: 0, missing: [], faults };
  for (const [key, list] of Object.entries(answers.answers)) {
    res.items++;
    const valid = list.filter((x) => x.fault === null);
    const votes = { same: valid.filter((x) => x.choice === 'same').length, different: valid.filter((x) => x.choice === 'different').length, faults: list.length - valid.length };
    const verdict: Verdict = votes.same === CR_DEBATERS ? 'same' : votes.different === CR_DEBATERS ? 'different' : 'no_agreement';
    outcomes[key] = verdict;
    if (verdict === 'no_agreement') res.not_agreed++; else res.agreed[verdict]++;
    const p = byKey.get(key)!;
    // A pair that is not agreed after the last round keeps 'no_agreement': the default `different` applies.
    if (verdict !== 'no_agreement' || round === CR_MAX_ROUNDS || !file.items[key]) {
      file.items[key] = { verdict, round, main: label(p.main), member: label(p.member), votes };
    }
  }
  writeFileSync(join(root, `round-${round}`, 'outcomes.json'), JSON.stringify(outcomes, null, 2) + '\n', 'utf8');
  mkdirSync(dirname(verdictsPath), { recursive: true });
  writeFileSync(verdictsPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
  return res;
}

/**
 * The fuzzy member sentences that state the same thing as their main sentence (keys of
 * `CrSentence`): an owner answer `same`, or else an agreed debate verdict `same`. An owner answer
 * `different` keeps the member out; `unsure` leaves the debate verdict.
 */
export function confirmedSame(db: DatabaseSync, corpusId: number, verdictsPath = VERDICTS_PATH): Set<string> {
  const member = (key: string) => key.slice(key.indexOf(':') + 1, key.indexOf('>'));
  const owner = new Map((db.prepare("SELECT item_key, choice FROM owner_decisions WHERE kind = 'cr_text'").all() as Array<{ item_key: string; choice: string }>)
    .filter((r) => r.item_key.startsWith(`c${corpusId}:`)).map((r) => [r.item_key, r.choice]));
  const out = new Set<string>();
  const v = loadVerdicts(verdictsPath);
  if (v && v.corpus === corpusId) for (const [k, e] of Object.entries(v.items)) if (e.verdict === 'same' && owner.get(k) !== 'different') out.add(member(k));
  for (const [k, c] of owner) if (c === 'same') out.add(member(k));
  return out;
}
