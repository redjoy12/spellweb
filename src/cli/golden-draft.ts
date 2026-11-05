/**
 * The assisted golden-set drafting CLI (plan Task 6, Step 5 — amended;
 * `docs/golden-set-procedure.md`, "Assisted drafting").
 *
 * This CLI makes NO model calls. It is the interface an assistant drafter drives:
 * it hands out the ungated materials, records every corpus read, validates what
 * comes back, and — only on the project owner's explicit `--accept` — writes into
 * `golden_cards` / `golden_atoms`.
 *
 *   npm run golden:draft -- --next [n]                     next un-drafted candidates
 *   npm run golden:draft -- --packet <oracle_id>           write the drafting packet
 *   npm run golden:draft -- --lookup <oracle_id> <rule>    read a rule, and LOG the read
 *   npm run golden:draft -- --lookup <oracle_id> --search <text>
 *   npm run golden:draft -- --lookup <oracle_id> --glossary <term>
 *   npm run golden:draft -- --stage <proposal.json>        validate + stage (exit 1 if invalid)
 *   npm run golden:draft -- --show <oracle_id>             render a proposal for adjudication
 *   npm run golden:draft -- --accept <oracle_id> [--complete] [--note "..."]
 *   npm run golden:draft -- --reject <oracle_id> --note "..."
 *   npm run golden:draft -- --status                       the ledger
 *
 * `--accept` is the ONLY command in this file that writes to the database, and
 * `--complete` is the owner's own claim, never the drafter's (sec. 8.2 computes
 * precision over complete cards only, so an unconfirmed `complete` is the one
 * mistake here that silently corrupts a metric).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/client.js';
import { currentCorpusId } from '../atoms/golden.js';
import {
  buildDraftingPacket,
  writePacket,
  readPacket,
  readProposal,
  writeProposal,
  validateProposal,
  acceptProposal,
  rejectProposal,
  recordLookup,
  loadLookups,
  ledger,
  cardDir,
  proposalPath,
} from '../atoms/goldenDraft.js';
import type { DraftProposal } from '../atoms/goldenDraft.js';

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = resolve(here, '../../docs/golden-set-candidates.json');

const db = openDb();

function fail(msg: string): never {
  console.error(msg);
  db.close();
  process.exit(1);
}

function candidates(): Array<{ oracle_id: string; name: string }> {
  if (!existsSync(CANDIDATES)) fail(`no ${CANDIDATES} — run \`npm run golden -- --select\` first`);
  const artifact = JSON.parse(readFileSync(CANDIDATES, 'utf8')) as {
    cards: Array<{ oracle_id: string; name: string }>;
  };
  return artifact.cards.map((c) => ({ oracle_id: c.oracle_id, name: c.name }));
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// --------------------------------------------------------------------------------- --next
function runNext(n: number): void {
  const rows = ledger(candidates()).filter((e) => e.stage === 'not-started');
  console.log(`# ${rows.length} candidate(s) not started; next ${Math.min(n, rows.length)}:`);
  for (const r of rows.slice(0, n)) console.log(`${r.oracle_id}  ${r.name}`);
  if (rows.length === 0) console.log('# (none — every candidate has at least a packet)');
}

// --------------------------------------------------------------------------------- --packet
function runPacket(oracleId: string): void {
  const packet = buildDraftingPacket(db, oracleId);
  const path = writePacket(packet);
  const clauses = packet.faces.reduce((n, f) => n + f.clauses.length, 0);
  const nonReminder = packet.faces.reduce((n, f) => n + f.clauses.filter((c) => c.kind !== 'reminder').length, 0);
  console.log(`wrote ${path}`);
  console.log(
    `${packet.name} — ${packet.faces.length} face(s), ${clauses} clause(s) (${nonReminder} non-reminder), ` +
      `${packet.rules.length} ungated rule(s), ${packet.vocabulary_count} atom type(s) in ${packet.vocabulary_path}`,
  );
  console.log('The packet is the UNGATED corpus view. Cite only rules you read from it or looked up.');
}

// --------------------------------------------------------------------------------- --lookup
//
// Every read is appended to the card's lookup log, which `validateProposal` uses
// as the read gate: a cited rule that appears in neither the packet nor this log
// was produced from memory, not from the corpus, and is rejected. That is the
// whole point of routing lookups through the CLI rather than letting a drafter
// query the database however it likes.
function runLookup(oracleId: string, argv: string[]): void {
  const corpusId = currentCorpusId(db);
  const search = argValue(argv, '--search');
  const glossary = argValue(argv, '--glossary');

  if (search) {
    const rows = db
      .prepare(
        `SELECT number, section_number, subsection_title, text FROM rules
          WHERE corpus_id = ? AND text LIKE ? ORDER BY ordinal LIMIT 25`,
      )
      .all(corpusId, `%${search}%`) as Array<{ number: string; section_number: string; subsection_title: string | null; text: string }>;
    for (const r of rows) console.log(`[${r.number}]${r.subsection_title ? ` (${r.subsection_title})` : ''} ${r.text}`);
    if (rows.length === 0) console.log('(no rule text matched)');
    recordLookup(oracleId, { kind: 'search', query: search, returned: rows.map((r) => r.number) });
    console.log(`\n# logged: search "${search}" -> ${rows.length} rule(s) now citable for ${oracleId}`);
    return;
  }

  if (glossary) {
    const row = db
      .prepare('SELECT term, definition, cross_refs FROM glossary_entries WHERE corpus_id = ? AND term_key = ?')
      .get(corpusId, glossary.toLowerCase()) as { term: string; definition: string; cross_refs: string } | undefined;
    if (!row) {
      recordLookup(oracleId, { kind: 'glossary', query: glossary, returned: [] });
      console.log(`(no glossary entry for "${glossary}")`);
      return;
    }
    const refs = JSON.parse(row.cross_refs) as string[];
    console.log(`${row.term}: ${row.definition}`);
    console.log(`cross_refs: ${refs.join(', ') || '(none)'}`);
    const stmt = db.prepare('SELECT number, text FROM rules WHERE corpus_id = ? AND number = ?');
    const returned: string[] = [];
    for (const n of refs) {
      const r = stmt.get(corpusId, n) as { number: string; text: string } | undefined;
      if (!r) continue;
      console.log(`  [${r.number}] ${r.text}`);
      returned.push(r.number);
    }
    recordLookup(oracleId, { kind: 'glossary', query: glossary, returned });
    console.log(`\n# logged: glossary "${glossary}" -> ${returned.length} rule(s) now citable for ${oracleId}`);
    return;
  }

  // A rule number, with its subsection body: `702.19` returns 702.19 and
  // 702.19a-g. Matched on the parsed `subsection_number`/`section_number`, NOT on
  // a `number LIKE '702.19%'` prefix — that prefix also matches 702.190..702.194,
  // five unrelated keywords, and every one of them would become citable.
  const number = argv[2];
  if (!number) fail('usage: --lookup <oracle_id> <rule_number> | --search <text> | --glossary <term>');
  const rows = db
    .prepare(
      `SELECT number, subsection_title, text FROM rules
        WHERE corpus_id = ? AND (number = ? OR subsection_number = ? OR section_number = ?)
        ORDER BY ordinal LIMIT 60`,
    )
    .all(corpusId, number, number, number) as Array<{ number: string; subsection_title: string | null; text: string }>;
  for (const r of rows) console.log(`[${r.number}]${r.subsection_title ? ` (${r.subsection_title})` : ''} ${r.text}`);
  if (rows.length === 0) console.log(`(no rule ${number} in this corpus — do not cite it)`);
  recordLookup(oracleId, { kind: 'rule', query: number, returned: rows.map((r) => r.number) });
  console.log(`\n# logged: rule "${number}" -> ${rows.length} rule(s) now citable for ${oracleId}`);
}

// --------------------------------------------------------------------------------- --stage
function runStage(path: string): void {
  if (!existsSync(path)) fail(`no such proposal file: ${path}`);
  const proposal = JSON.parse(readFileSync(path, 'utf8')) as DraftProposal;
  if (!proposal.oracle_id) fail('proposal has no oracle_id');
  if (!proposal.drafted_by) fail('proposal has no drafted_by — a draft must name its drafter');

  const staged = writeProposal(proposal);
  const v = validateProposal(db, proposal);

  console.log(`staged ${staged}`);
  console.log(
    `${v.atoms} atom(s), ${v.unclassified} unclassified, ${v.non_reminder_clauses} non-reminder clause(s), ` +
      `${v.uncovered_clauses} uncovered`,
  );
  for (const w of v.warnings) console.log(`  warn: ${w}`);
  if (!v.ok) {
    console.error(`INVALID — ${v.errors.length} error(s); fix and re-stage. NOT acceptable as-is:`);
    for (const e of v.errors) console.error(`  - ${e}`);
    db.close();
    process.exit(1);
  }
  console.log('VALID — awaiting the owner\'s adjudication (--show, then --accept or --reject).');
}

// --------------------------------------------------------------------------------- --show
//
// The adjudication surface for a single card: every proposed atom next to the
// quote it claims and the rule text it cites, so the owner is checking a reading
// rather than reconstructing one.
function runShow(oracleId: string): void {
  const proposal = readProposal(oracleId);
  if (!proposal) fail(`no staged proposal for ${oracleId} (looked in ${proposalPath(oracleId)})`);
  const packet = readPacket(oracleId);
  const corpusId = currentCorpusId(db);
  const ruleStmt = db.prepare('SELECT text FROM rules WHERE corpus_id = ? AND number = ?');

  console.log(`==== ${packet?.name ?? oracleId} ====`);
  console.log(`oracle_id: ${oracleId}`);
  console.log(`drafted_by: ${proposal.drafted_by}   at: ${proposal.drafted_at}`);
  console.log(`claims_complete: ${proposal.claims_complete}   (the owner's own call overrides this)`);
  if (proposal.notes.trim()) console.log(`notes: ${proposal.notes}`);
  console.log();

  for (const f of packet?.faces ?? []) {
    console.log(`---- face ${f.face_index}: ${f.name} ----`);
    console.log(f.oracle_text);
    console.log();
  }

  proposal.atoms.forEach((a, i) => {
    console.log(`[atom ${i}] face ${a.face_index}  ${a.family}.${a.type_key}  span ${a.span_start}-${a.span_end}`);
    console.log(`  quote:  "${a.quote}"`);
    console.log(`  params: ${JSON.stringify(a.params)}`);
    console.log(`  why:    ${a.rationale}`);
    for (const n of a.rule_numbers) {
      const r = ruleStmt.get(corpusId, n) as { text: string } | undefined;
      console.log(`  [${n}] ${r ? r.text : '*** NOT IN CORPUS ***'}`);
    }
    console.log();
  });

  proposal.unclassified.forEach((u, i) => {
    console.log(`[unclassified ${i}] face ${u.face_index}  span ${u.span_start}-${u.span_end}`);
    console.log(`  quote:  "${u.quote}"`);
    console.log(`  label:  ${u.proposed_label}`);
    console.log(`  why:    ${u.rationale}`);
    console.log();
  });

  const v = validateProposal(db, proposal);
  console.log(`validation: ${v.ok ? 'VALID' : 'INVALID'} — ${v.errors.length} error(s), ${v.warnings.length} warning(s)`);
  for (const e of v.errors) console.log(`  error: ${e}`);
  for (const w of v.warnings) console.log(`  warn:  ${w}`);
  const lookups = loadLookups(oracleId);
  console.log(`reads on record: ${lookups.length} lookup(s) + ${packet?.rules.length ?? 0} packet rule(s)`);
}

// --------------------------------------------------------------------------------- --accept / --reject
function runAccept(oracleId: string, complete: boolean, note: string): void {
  const res = acceptProposal(db, oracleId, { complete, note });
  console.log(
    `accepted ${oracleId} as ${complete ? 'COMPLETE' : 'partial (complete = false)'} — ` +
      `${res.atoms} golden atom(s), ${res.unclassified} unclassified candidate(s) written`,
  );
  console.log(`now run: npm run golden -- --verify ${oracleId}`);
}

function runReject(oracleId: string, note: string): void {
  if (!note.trim()) fail('--reject requires --note "why", so the drafter can correct rather than guess');
  rejectProposal(oracleId, note);
  console.log(`rejected ${oracleId} — ${note}`);
  console.log(`the proposal stays on disk at ${cardDir(oracleId)} for redrafting`);
}

// --------------------------------------------------------------------------------- --status
function runStatus(): void {
  const rows = ledger(candidates());
  const by: Record<string, number> = {};
  for (const r of rows) by[r.stage] = (by[r.stage] ?? 0) + 1;

  const order = ['not-started', 'packet', 'drafted', 'accepted', 'rejected'];
  console.log(`# golden-set drafting ledger — ${rows.length} candidate(s)`);
  console.log(`# ${order.map((s) => `${s}: ${by[s] ?? 0}`).join('   ')}`);
  console.log();
  const shown = rows.filter((r) => r.stage !== 'not-started');
  if (shown.length === 0) {
    console.log('(nothing staged yet — start with --next)');
    return;
  }
  console.log(`${'oracle_id'.padEnd(40)} ${'name'.padEnd(30)} ${'stage'.padEnd(12)} ${'atoms'.padStart(5)} ${'uncl'.padStart(4)} ${'reads'.padStart(5)}`);
  for (const r of shown.sort((a, b) => a.stage.localeCompare(b.stage) || a.oracle_id.localeCompare(b.oracle_id))) {
    console.log(
      `${r.oracle_id.padEnd(40)} ${r.name.slice(0, 30).padEnd(30)} ${r.stage.padEnd(12)} ` +
        `${String(r.atoms).padStart(5)} ${String(r.unclassified).padStart(4)} ${String(r.lookups).padStart(5)}`,
    );
  }
}

// --------------------------------------------------------------------------------- entry
function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const note = argValue(argv, '--note') ?? '';

  if (mode === '--next') runNext(Number(argv[1] ?? 10));
  else if (mode === '--packet') {
    if (!argv[1]) fail('usage: --packet <oracle_id>');
    runPacket(argv[1]);
  } else if (mode === '--lookup') {
    if (!argv[1]) fail('usage: --lookup <oracle_id> <rule_number> | --search <text> | --glossary <term>');
    runLookup(argv[1], argv);
  } else if (mode === '--stage') {
    if (!argv[1]) fail('usage: --stage <proposal.json>');
    runStage(argv[1]);
  } else if (mode === '--show') {
    if (!argv[1]) fail('usage: --show <oracle_id>');
    runShow(argv[1]);
  } else if (mode === '--accept') {
    if (!argv[1]) fail('usage: --accept <oracle_id> [--complete] [--note "..."]');
    runAccept(argv[1], argv.includes('--complete'), note);
  } else if (mode === '--reject') {
    if (!argv[1]) fail('usage: --reject <oracle_id> --note "why"');
    runReject(argv[1], note);
  } else if (mode === '--status') runStatus();
  else {
    fail(
      'usage: npm run golden:draft -- --next [n] | --packet <id> | --lookup <id> ... | ' +
        '--stage <file> | --show <id> | --accept <id> [--complete] | --reject <id> --note "..." | --status',
    );
  }
  db.close();
}

main();
