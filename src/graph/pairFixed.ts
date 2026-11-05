/**
 * Two-part Stage B packets (Phase 3 spec rev. 10 sec. 5.2).
 *
 * A single-part Stage B packet repeats the same CR text in every pass of every batch: 94% of
 * each packet, read again by each fresh subagent. A two-part packet splits it:
 * - the fixed part (class kinds, CR text, instructions, answer format) is the same for all batches
 *   of a deriver group, so the CLI writes it into the system prompt of a generated agent. All
 *   passes then share one prompt-cache entry;
 * - the batch part (`packet.md`) has the demand type, the CR text of the demand type that the
 *   fixed part does not have, and the supply candidates of the group.
 *
 * The supply types split into groups so that each fixed part fits the packet budget with a
 * reserve for the batch part (`planSupplyGroups`). The debaters get one fixed part with all
 * types: a debate item names its rule, and an old single-part batch can have candidates of more
 * than one group.
 *
 * A batch records `sha(agent file sha + '\n' + batch part)`. The submit refuses a batch when the
 * agent file on disk is not the file of the set, so a pass never mixes two fixed parts.
 * The code makes no model call and knows no Magic.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  PAIR_ANSWER_FORMAT, PAIR_INSTRUCTIONS, packetContext, planSharedPart, planSupplyGroups, type PacketContext, type SharedPart,
} from './edgePackets.js';
import { DEBATE_ANSWER_FORMAT, DEBATE_INSTRUCTIONS } from './debateText.js';
import { stageBTypes } from './liveTypes.js';
import { getRuleSet } from './ruleSet.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS_DIR = resolve(here, '../../.claude/agents');

/** Read on every call, so tests can point it at a temp directory and never touch `.claude/`. */
export function agentsDir(): string {
  return process.env['EDGE_AGENTS_DIR'] ?? DEFAULT_AGENTS_DIR;
}

/** The bytes that a fixed part leaves for the batch part inside the packet budget. */
export const BATCH_PART_RESERVE = 40_000;

export const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

export interface GeneratedAgent {
  name: string;
  fileText: string;
  /** sha16 of fileText. */
  sha: string;
  /** The packet references of the fixed part. */
  refs: string[];
}

export interface PairFixed {
  ctx: PacketContext;
  groups: Array<{ group: number; supply: string[]; shared: SharedPart; agent: GeneratedAgent }>;
  debater: GeneratedAgent;
}

export const deriverAgentName = (group: number) => `edge-rule-pair-deriver-g${group}`;
export const DEBATER_AGENT = 'edge-rule-pair-debater';

/** The model alias of the agent file for the model id that the set records. */
function modelAlias(model: string): string {
  for (const a of ['opus', 'sonnet', 'haiku']) if (model.includes(a)) return a;
  return model;
}

const DERIVER_RULES = `You are the deriver for one pass of one Stage B batch. Your packet has two parts:
- The fixed part is the text under "Fixed part of the packet" below. It has the parts "Instructions", "Comprehensive Rules" and "Answer format". It is the same for all batches of your group.
- The batch part is the file \`packet.md\` in the pass directory that you are given. It has the parts "Demand type", "Supply candidates" and "Intrinsic class kinds and permitted values". Some batch parts also have "Comprehensive Rules (batch part)".

"This packet" in the instructions means the two parts together. The CR text of this packet is the text of "Comprehensive Rules" and of "Comprehensive Rules (batch part)". Your answer must come from the text in this packet only, never from anything that you remember about the game or about a card.

1. Read \`<pass-dir>/packet.md\` completely. It is short. Read it in one call.
2. Do not read any other file. Do not read the repository, the database, other batches or other passes.
3. Obey the "Instructions" part of the fixed part.
4. Write \`<pass-dir>/response.json\` one time, in the format of the "Answer format" part. "The directory of this packet" is the pass directory. The file must be valid JSON.
5. Your final reply is one line of 20 words or fewer: the number of rules that you wrote and the number of missing-rule reports. Do not write a summary, a table or a list.

Rules that are easy to break:

- Read only the batch part. The fixed part is already in these instructions.
- A "[for: ...]" line can name types that are not in your batch part. Those names are for other batches.
- Use only the families, type keys, params and enum values that the packet shows.
- Copy each quote character for character from a rule or a glossary entry in the packet. Give the rule number or the glossary term as the packet shows it.
- Each item needs evidence. If the CR text in the packet is not sufficient, report what you need in \`missing_rules\`. Do not use text from memory.`;

const DEBATER_RULES = `You are one debater for one round of one Stage B batch. Your packet has two parts:
- The fixed part is the text under "Fixed part of the packet" below. It has the parts "Instructions", "Instructions of the earlier passes", "Intrinsic class kinds and permitted values", "Comprehensive Rules" and "Answer format". It is the same for all debate batches.
- The batch part is the file \`packet.md\` in the debater directory that you are given. It has the parts "Demand type", "Supply candidates", "Disputed items" and, from round 2, "Arguments of the previous round".

"This packet" in the instructions means the two parts together. Your answer must come from the text in this packet only, never from anything that you remember about the game or about a card.

1. Read \`<debater-dir>/packet.md\` completely. It is short. Read it in one call.
2. Do not read any other file. Do not read the repository, the database, other batches, other rounds or other debaters.
3. Obey the "Instructions" part of the fixed part.
4. Write \`<debater-dir>/response.json\` one time, in the format of the "Answer format" part. "The directory of this packet" is the debater directory. The file must be valid JSON.
5. Your final reply is one line of 20 words or fewer: the number of answers that you wrote. Do not write a summary, a table or a list.

Rules that are easy to break:

- Read only the batch part. The fixed part is already in these instructions.
- A "[for: ...]" line can name types that are not in your batch part. Those names are for other batches.
- Select one option that the item shows. Do not write a new rule.
- Give one answer for each item in "Disputed items".
- Copy each quote character for character from a rule or a glossary entry in the packet. Give the rule number or the glossary term as the packet shows it.
- An argument of the previous round is not evidence. Examine it against the CR text.`;

function renderAgent(
  name: string, description: string, model: string, rules: string, title: string, fixedParts: string[], refs: string[],
): GeneratedAgent {
  const fileText = [
    `---\nname: ${name}\ndescription: ${description}\ntools: Read, Write\nmodel: ${model}\n---`,
    rules,
    `# Fixed part of the packet - ${title}`,
    ...fixedParts,
  ].join('\n\n') + '\n';
  return { name, fileText, sha: sha16(fileText), refs };
}

function setBasis(db: DatabaseSync, setId: number, over: Partial<PacketContext>) {
  const set = getRuleSet(db, setId);
  if (!set) throw new Error(`no edge-rule set ${setId}`);
  const ctx = packetContext(db, { corpusId: set.corpus_id, schemaVersion: set.schema_version, ...over });
  // spec rev. 10 sec. 5.3: the fixed parts have the CR text of the types in the Stage B scope.
  const { supply, demand } = stageBTypes(db, setId, ctx);
  return { ctx, supply, demand, model: modelAlias(set.model) };
}

/**
 * The deriver groups of a set, each with its fixed part and its generated agent. Deterministic
 * for the set's roles, schema, corpus and policy files.
 */
export function deriverAgents(db: DatabaseSync, setId: number, over: Partial<PacketContext> = {}): Omit<PairFixed, 'debater'> {
  const { ctx, supply, demand, model } = setBasis(db, setId, over);
  const budget = ctx.graph.packet_budget_bytes - BATCH_PART_RESERVE;
  const parts = supply.length ? planSupplyGroups(db, ctx, supply, demand, budget) : [];
  const groups = parts.map((shared, i) => {
    const group = i + 1;
    const name = deriverAgentName(group);
    const agent = renderAgent(
      name,
      `Generated by npm run edge-rules for edge-rule set ${setId} - do not edit. Derives ONE pass of ONE Stage B batch of deriver group ${group} of the MTGA deck builder's Phase 3 edge rules. Reads the batch part packet.md in the pass directory and writes response.json next to it. Give it the pass directory path and nothing else.`,
      model, DERIVER_RULES, `set ${setId}, Stage B, deriver group ${group} of ${parts.length}`,
      [`# Instructions\n${PAIR_INSTRUCTIONS}`, shared.markdown.trimEnd(), `# Answer format\n${PAIR_ANSWER_FORMAT}`],
      // The class kinds are in each batch part (planPairBatchPart), after the supply candidates.
      shared.refs,
    );
    return { group, supply: shared.types, shared, agent };
  });
  return { ctx, groups };
}

/** The generated debater agent of a set: one fixed part with the CR content of all its types. */
export function debaterAgent(db: DatabaseSync, setId: number, over: Partial<PacketContext> = {}): GeneratedAgent {
  const { ctx, supply, demand, model } = setBasis(db, setId, over);
  const all = planSharedPart(db, ctx, new Set([...supply, ...demand]));
  return renderAgent(
    DEBATER_AGENT,
    `Generated by npm run edge-rules for edge-rule set ${setId} - do not edit. Debates ONE round of ONE Stage B batch of disputed rules of the MTGA deck builder's Phase 3 edge rules (spec sec. 5.6). Reads the batch part packet.md in the debater directory and writes response.json next to it. Give it the debater directory path and nothing else.`,
    model, DEBATER_RULES, `set ${setId}, Stage B debate`,
    [
      `# Instructions\n${DEBATE_INSTRUCTIONS}`, `# Instructions of the earlier passes\n${PAIR_INSTRUCTIONS}`,
      all.classes, all.markdown.trimEnd(), `# Answer format\n${DEBATE_ANSWER_FORMAT}`,
    ],
    all.refs,
  );
}

/** Writes each agent file that is missing or different. Returns the names of the files written. */
export function writeAgentFiles(agents: GeneratedAgent[]): string[] {
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const a of agents) {
    const file = join(dir, `${a.name}.md`);
    if (existsSync(file) && readFileSync(file, 'utf8') === a.fileText) continue;
    writeFileSync(file, a.fileText);
    written.push(a.name);
  }
  return written;
}

/** Throws when the agent file on disk is not the file of the set. */
export function checkAgentFile(a: GeneratedAgent): void {
  const file = join(agentsDir(), `${a.name}.md`);
  if (!existsSync(file)) throw new Error(`the agent file ${file} is missing`);
  if (readFileSync(file, 'utf8') !== a.fileText) {
    throw new Error(`the agent file ${file} is not the file of this set (it changed after the prepare); do not submit passes that it answered`);
  }
}

/** The recorded sha of a two-part packet. */
export const twoPartSha = (agentSha: string, batchPart: string) => sha16(`${agentSha}\n${batchPart}`);

/** The manifest fields of a two-part packet. */
export interface TwoPartManifest { agent: string; agent_sha: string }

/** True when the directory holds a two-part packet: its manifest names an agent, or its packet has the title. */
export function isTwoPart(dir: string, title: string): boolean {
  const m = join(dir, 'manifest.json');
  if (existsSync(m) && (JSON.parse(readFileSync(m, 'utf8')) as Partial<TwoPartManifest>).agent) return true;
  const p = join(dir, 'packet.md');
  return existsSync(p) && readFileSync(p, 'utf8').startsWith(title);
}

/**
 * Throws unless the agent file on disk is the file that the prepare wrote for this directory
 * and the batch part is the recorded one: `packetSha` is sha(agent sha + '\n' + batch part).
 */
export function checkTwoPart(dir: string, packetSha: string): void {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Partial<TwoPartManifest>;
  if (!m.agent || !m.agent_sha) throw new Error(`${dir}: the manifest names no generated agent`);
  const file = join(agentsDir(), `${m.agent}.md`);
  if (!existsSync(file)) throw new Error(`the agent file ${file} is missing`);
  if (sha16(readFileSync(file, 'utf8')) !== m.agent_sha) {
    throw new Error(`the agent file ${file} changed after the prepare of ${dir}; do not submit passes that it answered`);
  }
  if (twoPartSha(m.agent_sha, readFileSync(join(dir, 'packet.md'), 'utf8')) !== packetSha) {
    throw new Error(`${dir}: the packet is not the recorded two-part packet`);
  }
}
