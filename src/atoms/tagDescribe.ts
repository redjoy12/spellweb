/**
 * Plain descriptions and keyword parts of the tag kinds (owner request 2026-10-24, tag check round 2,
 * problems P1 and P2 in docs/tag-check-round-2.md sec. 5).
 *
 * The code knows no Magic. Isolated agents write each description from the packet text only: the
 * type's label, params and evidence, the CR text that the evidence cites, and a few card quotes.
 * Three stages, each a directory of batches with packet.md and response.json:
 *   write   one agent writes a description (and the parts, when the CR text defines the type as a
 *           sequence of other actions in the vocabulary)
 *   check   a second agent agrees, or gives a fix
 *   debate  for each fix, a third agent picks the writer or the checker version
 * The result is config/tag-descriptions.json. An item that has no agreement keeps no parts (plan
 * default, owner review rule of 2026-10-11).
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownShortNames, redactCardNames, redactionNames } from './extract.js';

export const TAG_DESCRIBE_DIR = 'data/tag-describe';
export const TAG_DESCRIPTIONS_PATH = 'config/tag-descriptions.json';
export type Stage = 'write' | 'check' | 'debate';

/** always: the CR text says the step always happens. may: a player chooses it ("may", "or"). if: a condition decides it. */
export const PART_WHEN = ['always', 'may', 'if'] as const;
export interface Part { type: string; when: (typeof PART_WHEN)[number]; params?: Record<string, unknown> }
export interface Described { description: string; parts: Part[]; rules: string[] }
export interface WriteAnswer extends Described { id: string; type: string; note?: string }
export interface CheckAnswer { id: string; type: string; verdict: 'agree' | 'fix'; reason?: string; fix?: Described }
export interface DebateAnswer { id: string; type: string; pick: 'writer' | 'checker'; reason: string }
export interface TagDescription extends Described {
  /** agreed: writer and checker agree. debated: a debate picked one version. */
  status: 'agreed' | 'debated';
  source: 'writer' | 'checker';
}
export interface TagDescriptions { schema_version: number; made_at: string; types: Record<string, TagDescription> }

interface TypeRow { family: string; type_key: string; label: string; params_schema: string; evidence: string; provenance: string }
const idOf = (r: { family: string; type_key: string }) => `${r.family}.${r.type_key}`;
const MAX_RULES = 12;
const MAX_RULE_CHARS = 3_000;

/** The types that current atoms of `schemaVersion` use, in key order. */
export function usedTypes(db: DatabaseSync, schemaVersion: number): TypeRow[] {
  return db.prepare(`SELECT t.family, t.type_key, t.label, t.params_schema, t.evidence, t.provenance FROM atom_types t
    WHERE t.schema_version = ? AND EXISTS (SELECT 1 FROM atoms a WHERE a.is_current = 1 AND a.schema_version = t.schema_version
      AND a.family = t.family AND a.type_key = t.type_key)
    ORDER BY t.family, t.type_key`).all(schemaVersion) as unknown as TypeRow[];
}

/** One line per vocabulary type: key, label and the param names with their values. */
export function vocabulary(db: DatabaseSync, schemaVersion: number): string {
  const rows = db.prepare('SELECT family, type_key, label, params_schema FROM atom_types WHERE schema_version = ? ORDER BY family, type_key')
    .all(schemaVersion) as unknown as TypeRow[];
  return rows.map((r) => {
    const props = (JSON.parse(r.params_schema) as { properties?: Record<string, { enum?: unknown[]; type?: unknown; items?: { enum?: unknown[] } }> }).properties ?? {};
    const ps = Object.entries(props).map(([k, v]) => `${k}${v.enum ? `(${v.enum.join('|')})` : v.items?.enum ? `[${v.items.enum.join('|')}]` : ''}`);
    return `- ${idOf(r)} - ${r.label}${ps.length ? ` - params: ${ps.join(', ')}` : ''}`;
  }).join('\n');
}

/** The CR rules that a type's evidence cites, with the lettered rules of each cited subsection. */
export function citedRules(db: DatabaseSync, corpusId: number, evidence: string): Array<{ number: string; text: string }> {
  const cited = [...new Set([...evidence.matchAll(/\b(\d{3}\.\d+[a-z]?)\b/g)].map((m) => m[1]!))];
  const out = new Map<string, string>();
  const bySub = db.prepare('SELECT number, text FROM rules WHERE corpus_id = ? AND subsection_number = ? ORDER BY ordinal');
  const one = db.prepare('SELECT number, text FROM rules WHERE corpus_id = ? AND number = ?');
  for (const n of cited) {
    const rows = (/[a-z]$/.test(n) ? [one.get(corpusId, n)] : bySub.all(corpusId, n)) as Array<{ number: string; text: string } | undefined>;
    for (const r of rows) if (r && r.text && out.size < MAX_RULES) out.set(r.number, r.text);
  }
  let chars = 0;
  return [...out].map(([number, text]) => ({ number, text })).filter((r) => (chars += r.text.length) <= MAX_RULE_CHARS);
}

const INSTRUCTIONS = `# Tag kind descriptions

**Language:** ASD-STE100

The app gives "tags" to card texts. Each tag kind has a key (for example PRODUCES.CONNIVE), a label and params. The owner of the app cannot understand many tags. Write a plain description of each tag kind below.

## Rules

1. Read the text in this packet first. You can use your own knowledge of Magic. Do not invent a quote or a rule number.
2. The description says what a card text with this tag does, or what it needs. Use one or two sentences, 30 words or fewer (never more than 35). Use simple words and the active voice. Do not use the word "params": say "the tag records ...\".
3. Do not use the words "gives a way to do something", "makes or does something" or "watches for something". Say the real action.
4. For a keyword or a keyword action, say what the keyword does, from its CR text. Do not only repeat its name.
5. If the label or the params show a limit of the tag kind (for example "one creature", or "free or costed"), state it.
6. "parts": only when the CR text defines this tag kind as a sequence of other actions, and those actions are tag kinds in the vocabulary list. Example: a CR text "draws a card, then discards a card" gives the parts PRODUCES.CARD_DRAW and PRODUCES.DISCARD.
   - Give a param of a part only when the CR text fixes its value. Leave out every other param. Do not set a subject or an object to "self" unless the CR text says the step acts on the object with this keyword.
   - Give each part "when": "always" if the CR text says the step always happens; "may" if a player chooses it (the text says "may", or a choice "A or B" between two steps); "if" if a condition decides it ("if a nonland card is discarded", "unless").
   - A choice "A or B" is not a sequence of A and B. Give both parts with "when": "may".
   - If the CR text gives variants of the keyword that change a step (for example "connive N", or a variant that searches in place of a draw), give the step only if all variants have it. Otherwise give it with "when": "if".
   - Do not give the tag kind itself as a part. Do not give a part that only a card's own text adds.
   - For most tag kinds, "parts" is an empty list.
7. "rules": the CR rule numbers in this packet that you used. Use [] if you used none.
8. "note": optional, one sentence. Use it when the packet does not give enough text for a good description.

## Output

Write response.json next to this packet. Give one item for each tag kind, in the same order:

\`\`\`json
{ "items": [ { "id": "T01", "type": "PRODUCES.EXAMPLE", "description": "...", "parts": [ { "type": "PRODUCES.CARD_DRAW", "when": "always", "params": { "amount": 1 } } ], "rules": ["<a rule number of this packet>"], "note": "" } ] }
\`\`\`
`;

const CHECK_INSTRUCTIONS = `# Check of tag kind descriptions

**Language:** ASD-STE100

Another writer wrote a description and the parts of each tag kind below. Check each item against the rules in the "Rules for the writer" section. You can use your own knowledge of Magic.

- "agree": the description is true by the packet text, clear, and follows the rules. The parts are correct and complete by the CR text.
- "fix": something is wrong, not clear, or missing. Give "reason" (one sentence) and "fix": a full new version with "description", "parts" and "rules".

Do not give "fix" only for a small change of words. Give "fix" when a fact is wrong, a fact is not from the packet, the description does not say what the tag does, or the parts are wrong.

## Output

Write response.json next to this packet:

\`\`\`json
{ "items": [ { "id": "T01", "type": "PRODUCES.CONNIVE", "verdict": "agree" },
             { "id": "T02", "type": "...", "verdict": "fix", "reason": "...", "fix": { "description": "...", "parts": [], "rules": [] } } ] }
\`\`\`
`;

const DEBATE_INSTRUCTIONS = `# Debate of tag kind descriptions

**Language:** ASD-STE100

For each tag kind below, a writer and a checker do not agree. Read both versions. Pick the version that is more correct by the packet text and the rules in "Rules for the writer". You can use your own knowledge of Magic.

## Output

Write response.json next to this packet:

\`\`\`json
{ "items": [ { "id": "T01", "type": "PRODUCES.CONNIVE", "pick": "writer", "reason": "one sentence" } ] }
\`\`\`
`;

/** The packet section of one type. */
function typeSection(db: DatabaseSync, corpusId: number, id: string, t: TypeRow, names: readonly string[]): string {
  const props = (JSON.parse(t.params_schema) as { properties?: Record<string, unknown> }).properties ?? {};
  const rules = citedRules(db, corpusId, t.evidence);
  // Card names are hidden ("~"), as in the extraction packets: the agent works from the text only.
  // The card's own short names ("Aang" of "Aang, at the Crossroads") are hidden too.
  const quotes = [...new Set((db.prepare(`SELECT oracle_id, quote FROM atoms WHERE is_current = 1 AND family = ? AND type_key = ? AND quote <> ''
    ORDER BY oracle_id, span_start`).all(t.family, t.type_key) as Array<{ oracle_id: string; quote: string }>)
    .map((r) => redactCardNames(r.quote, [...names, ...ownShortNames(db, r.oracle_id)])))].slice(0, 3);
  return [
    `### ${id}: ${idOf(t)}`, '',
    `- Label: ${t.label}`,
    `- Params: ${Object.keys(props).length ? JSON.stringify(props) : 'none'}`,
    `- Evidence: ${t.evidence}`,
    ...(rules.length ? ['- CR text:', ...rules.map((r) => `  - ${r.number}: ${r.text}`)] : ['- CR text: none cited']),
    ...(quotes.length ? ['- Card texts with this tag:', ...quotes.map((q) => `  - "${q}"`)] : []),
    '',
  ].join('\n');
}

const stageDir = (run: number, stage: Stage) => join(TAG_DESCRIBE_DIR, `run-${run}`, stage);
const batchDirs = (run: number, stage: Stage) => {
  const d = stageDir(run, stage);
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith('batch-')).sort().map((n) => join(d, n)) : [];
};
const writeBatch = (dir: string, text: string, meta: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'packet.md'), text, 'utf8');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
};
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** Stage 1: writes the writer batches of all used types. Returns the batch directories. */
export function prepareWrite(db: DatabaseSync, run: number, schemaVersion: number, corpusId: number, size = 25): string[] {
  const types = usedTypes(db, schemaVersion);
  const vocab = vocabulary(db, schemaVersion);
  const names = redactionNames(db);
  const dirs: string[] = [];
  for (let b = 0; b * size < types.length; b++) {
    const part = types.slice(b * size, (b + 1) * size);
    const ids = part.map((_, i) => `T${String(i + 1).padStart(2, '0')}`);
    const dir = join(stageDir(run, 'write'), `batch-${String(b + 1).padStart(3, '0')}`);
    writeBatch(dir, [INSTRUCTIONS, '## Tag kinds to describe', '', ...part.map((t, i) => typeSection(db, corpusId, ids[i]!, t, names)), '## Vocabulary list (for parts)', '', vocab, ''].join('\n'),
      { schema_version: schemaVersion, corpus_id: corpusId, items: part.map((t, i) => ({ id: ids[i], type: idOf(t) })) });
    dirs.push(dir);
  }
  return dirs;
}

/** Checks one description or fix against the vocabulary and the packet. Returns the errors. */
export function validateDescribed(d: Described, ctx: { self: string; schemas: ReadonlyMap<string, string>; packetRules: ReadonlySet<string> }): string[] {
  const e: string[] = [];
  if (typeof d.description !== 'string' || !d.description.trim()) e.push('no description');
  else if (d.description.trim().split(/\s+/).length > 35) e.push('description has more than 35 words');
  if (!Array.isArray(d.parts)) e.push('parts is not a list');
  for (const p of Array.isArray(d.parts) ? d.parts : []) {
    if (p.type === ctx.self) { e.push('a part is the type itself'); continue; }
    if (!PART_WHEN.includes(p.when)) e.push(`part ${p.type} has "when" ${JSON.stringify(p.when)}, not one of ${PART_WHEN.join(', ')}`);
    const schema = ctx.schemas.get(p.type);
    if (!schema) { e.push(`part ${p.type} is not in the vocabulary`); continue; }
    const props = (JSON.parse(schema) as { properties?: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }> }).properties ?? {};
    for (const [k, v] of Object.entries(p.params ?? {})) {
      const spec = props[k];
      if (!spec) { e.push(`part ${p.type} has no param ${k}`); continue; }
      const allowed = spec.enum ?? null;
      if (allowed && !allowed.includes(v)) e.push(`part ${p.type} param ${k} has value ${JSON.stringify(v)}, not in ${JSON.stringify(allowed)}`);
      if (spec.items?.enum && (!Array.isArray(v) || v.some((x) => !spec.items!.enum!.includes(x)))) e.push(`part ${p.type} param ${k} has a value not in the list`);
    }
  }
  if (!Array.isArray(d.rules)) e.push('rules is not a list');
  for (const r of Array.isArray(d.rules) ? d.rules : []) if (!ctx.packetRules.has(r)) e.push(`rule ${r} is not in the packet`);
  return e;
}

interface Meta { schema_version: number; corpus_id: number; items: Array<{ id: string; type: string }> }

function context(db: DatabaseSync, meta: Meta, dir: string) {
  const schemas = new Map((db.prepare('SELECT family, type_key, params_schema FROM atom_types WHERE schema_version = ?').all(meta.schema_version) as unknown as TypeRow[])
    .map((r) => [idOf(r), r.params_schema]));
  const packet = readFileSync(join(dir, 'packet.md'), 'utf8');
  const packetRules = new Set([...packet.matchAll(/^ {2}- (\d{3}\.\d+[a-z]?): /gm)].map((m) => m[1]!));
  return { schemas, packetRules };
}

/** Reads and checks the writer answers of all batches. Throws on an error. */
export function readWrite(db: DatabaseSync, run: number): Array<{ dir: string; meta: Meta; answers: WriteAnswer[] }> {
  return batchDirs(run, 'write').map((dir) => {
    const meta = readJson<Meta>(join(dir, 'meta.json'));
    const { items } = readJson<{ items: WriteAnswer[] }>(join(dir, 'response.json'));
    const ctx = context(db, meta, dir);
    const errors: string[] = [];
    if (items.length !== meta.items.length) errors.push(`${items.length} answers for ${meta.items.length} types`);
    meta.items.forEach((m, i) => {
      const a = items[i];
      if (!a || a.id !== m.id || a.type !== m.type) { errors.push(`${m.id}: answer is for ${a?.id} ${a?.type}`); return; }
      errors.push(...validateDescribed(a, { ...ctx, self: m.type }).map((x) => `${m.id} ${m.type}: ${x}`));
    });
    if (errors.length) throw new Error(`${dir}:\n  ${errors.join('\n  ')}`);
    return { dir, meta, answers: items };
  });
}

const answerBlock = (label: string, d: Described) =>
  `- ${label}: ${JSON.stringify({ description: d.description, parts: d.parts, rules: d.rules })}`;

/** Stage 2: one check batch for each writer batch. */
export function prepareCheck(db: DatabaseSync, run: number): string[] {
  return readWrite(db, run).map(({ dir, meta, answers }) => {
    const packet = readFileSync(join(dir, 'packet.md'), 'utf8');
    const [, body] = packet.split('## Tag kinds to describe');
    const out = join(stageDir(run, 'check'), dir.split(/[\\/]/).pop()!);
    writeBatch(out, [CHECK_INSTRUCTIONS, '## Rules for the writer', '', INSTRUCTIONS.split('## Rules')[1]!.split('## Output')[0]!.trim(), '',
      '## Writer answers', '', ...answers.map((a) => answerBlock(`${a.id} ${a.type}`, a)), '', '## Tag kinds', body!].join('\n'), meta);
    return out;
  });
}

/** Reads and checks the checker answers. */
export function readCheck(db: DatabaseSync, run: number): Array<{ dir: string; meta: Meta; answers: CheckAnswer[] }> {
  return batchDirs(run, 'check').map((dir) => {
    const meta = readJson<Meta>(join(dir, 'meta.json'));
    const { items } = readJson<{ items: CheckAnswer[] }>(join(dir, 'response.json'));
    const ctx = context(db, meta, dir);
    const errors: string[] = [];
    if (items.length !== meta.items.length) errors.push(`${items.length} answers for ${meta.items.length} types`);
    meta.items.forEach((m, i) => {
      const a = items[i];
      if (!a || a.id !== m.id || a.type !== m.type) { errors.push(`${m.id}: answer is for ${a?.id} ${a?.type}`); return; }
      if (a.verdict !== 'agree' && a.verdict !== 'fix') errors.push(`${m.id}: verdict ${String(a.verdict)}`);
      if (a.verdict === 'fix') {
        if (!a.fix) errors.push(`${m.id}: fix with no new version`);
        else errors.push(...validateDescribed(a.fix, { ...ctx, self: m.type }).map((x) => `${m.id} ${m.type} fix: ${x}`));
      }
    });
    if (errors.length) throw new Error(`${dir}:\n  ${errors.join('\n  ')}`);
    return { dir, meta, answers: items };
  });
}

/** Stage 3: one debate batch with all the fix items (or none, when every item is agreed). */
export function prepareDebate(db: DatabaseSync, run: number): string | null {
  const writes = new Map(readWrite(db, run).map((w) => [w.dir.split(/[\\/]/).pop()!, w]));
  const sections: string[] = [];
  const items: Array<{ id: string; type: string; batch: string; local: string }> = [];
  for (const c of readCheck(db, run)) {
    const name = c.dir.split(/[\\/]/).pop()!;
    const w = writes.get(name)!;
    const packet = readFileSync(join(w.dir, 'packet.md'), 'utf8');
    c.answers.forEach((a, i) => {
      if (a.verdict !== 'fix') return;
      const id = `T${String(items.length + 1).padStart(2, '0')}`;
      const section = packet.split(/^### /m).find((s) => s.startsWith(`${a.id}: ${a.type}`))!.split(/\n## /)[0]!;
      sections.push(`### ${id}: ${a.type}${section.slice(`${a.id}: ${a.type}`.length)}`,
        answerBlock('Writer version', w.answers[i]!), answerBlock('Checker version', a.fix!), `- Checker reason: ${a.reason ?? ''}`, '');
      items.push({ id, type: a.type, batch: name, local: a.id });
    });
  }
  if (!items.length) return null;
  const meta = readJson<Meta>(join([...writes.values()][0]!.dir, 'meta.json'));
  const out = join(stageDir(run, 'debate'), 'batch-001');
  writeBatch(out, [DEBATE_INSTRUCTIONS, '## Rules for the writer', '', INSTRUCTIONS.split('## Rules')[1]!.split('## Output')[0]!.trim(), '', '## Tag kinds', '', ...sections,
    '## Vocabulary list (for parts)', '', vocabulary(db, meta.schema_version), ''].join('\n'),
    { schema_version: meta.schema_version, corpus_id: meta.corpus_id, items });
  return out;
}

/** Joins the three stages into the descriptions file. */
export function finalise(db: DatabaseSync, run: number): TagDescriptions {
  const writes = readWrite(db, run);
  const checks = new Map(readCheck(db, run).map((c) => [c.dir.split(/[\\/]/).pop()!, c]));
  const debateDir = batchDirs(run, 'debate')[0];
  const picks = new Map<string, DebateAnswer>();
  if (debateDir) {
    const meta = readJson<{ items: Array<{ id: string; type: string; batch: string; local: string }> }>(join(debateDir, 'meta.json'));
    const { items } = readJson<{ items: DebateAnswer[] }>(join(debateDir, 'response.json'));
    meta.items.forEach((m, i) => {
      const a = items[i];
      if (!a || a.id !== m.id || a.type !== m.type || (a.pick !== 'writer' && a.pick !== 'checker')) throw new Error(`debate ${m.id}: bad answer`);
      picks.set(`${m.batch}/${m.local}`, a);
    });
  }
  const types: Record<string, TagDescription> = {};
  for (const w of writes) {
    const name = w.dir.split(/[\\/]/).pop()!;
    const c = checks.get(name);
    if (!c) throw new Error(`no check for ${name}`);
    w.answers.forEach((a, i) => {
      const ch = c.answers[i]!;
      const keep = (d: Described): Described => ({ description: d.description.trim(), parts: d.parts, rules: d.rules });
      if (ch.verdict === 'agree') { types[a.type] = { ...keep(a), status: 'agreed', source: 'writer' }; return; }
      const pick = picks.get(`${name}/${a.id}`);
      if (!pick) throw new Error(`${a.type}: a fix with no debate answer`);
      types[a.type] = { ...keep(pick.pick === 'writer' ? a : ch.fix!), status: 'debated', source: pick.pick };
    });
  }
  return { schema_version: writes[0]!.meta.schema_version, made_at: new Date().toISOString(), types };
}

export function loadTagDescriptions(path: string = TAG_DESCRIPTIONS_PATH): TagDescriptions | null {
  return existsSync(path) ? readJson<TagDescriptions>(path) : null;
}
