/**
 * The golden-set offline CLI (plan Task 6, Step 3). Four modes, all offline, no
 * model calls. It supports the project owner's hand-drafting of the ~150-card
 * golden set; it never drafts or suggests atoms.
 *
 *   npm run golden -- --bottom-decile       re-measure the gate's blind spots into
 *                                           docs/task1-bottom-decile-cards.json
 *                                           (after every pool or corpus refresh)
 *   npm run golden -- --select              stratified candidate list to stdout
 *                                           AND docs/golden-set-candidates.json
 *   npm run golden -- --draft <oracle_id>   faces + clause split + UNGATED corpus
 *                                           term lookup (an aid to hand-drafting)
 *   npm run golden -- --verify <oracle_id>  validate a drafted entry; REJECTS
 *                                           (exit 1) on any failure
 *
 * `--draft` surfaces term matches against the full `rule_term_index` (the ungated
 * corpus), NOT the assembled gated packet — the golden set is drafted against the
 * ungated corpus specifically so it can audit the gate (sec. 3.6, sec. 8.1).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/client.js';
import { splitOracleText } from '../atoms/clauses.js';
import { currentCorpusId, verifyGoldenCard } from '../atoms/golden.js';
import { cardMatchText, matchTerms, loadPacketPolicy, measureBottomDecile } from '../rules/relevance.js';

const here = dirname(fileURLToPath(import.meta.url));
// Committed output artifact for Step 1 ("produce and commit the stratified
// candidate list" - task-6-brief.md scope note). Re-running --select overwrites
// it deterministically; the file itself is what gets committed, not regenerated
// on every run.
const CANDIDATES_OUT = resolve(here, '../../docs/golden-set-candidates.json');
const BOTTOM_DECILE_PATH = resolve(here, '../../docs/task1-bottom-decile-cards.json');

const db = openDb();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function currentCorpus(): number {
  try {
    return currentCorpusId(db);
  } catch {
    fail('no current rules corpus - run `npm run sync:rules` first');
  }
}

// --------------------------------------------------------------------------------- --select
//
// Selection is a query, not a judgement call (plan Step 1). Cover every non-normal
// layout present in the pool, the sec. 3.6 failure shapes (gets -X/-X, base power),
// the gate's blind spots (Task 1's bottom-decile-matched cards - see note in bucket
// 4 below), and the longest oracle texts; backfill a rarity only if it's entirely
// absent from those (bucket 6 - see its comment; Important finding 6, first review
// pass, on why this is a backfill and not a fixed-size sample). Output is a
// deterministic table, plus a committed JSON artifact (docs/golden-set-candidates.json).
function runSelect(): void {
  const rows: Map<string, { name: string; layout: string; rarity: string; textLen: number; buckets: string[] }> = new Map();

  const add = (oracleId: string, bucket: string) => {
    const card = db
      .prepare('SELECT name, layout, rarity FROM cards WHERE oracle_id = ?')
      .get(oracleId) as { name: string; layout: string; rarity: string } | undefined;
    if (!card) return;
    const faces = db
      .prepare('SELECT SUM(LENGTH(oracle_text)) n FROM card_faces WHERE oracle_id = ?')
      .get(oracleId) as { n: number | null };
    const textLen = faces.n ?? 0;
    const existing = rows.get(oracleId);
    if (existing) existing.buckets.push(bucket);
    else rows.set(oracleId, { name: card.name, layout: card.layout, rarity: card.rarity, textLen, buckets: [bucket] });
  };

  // 1. Every non-normal layout, with all 3 meld (their back faces have empty oracle_text;
  //    without a deliberate include they go untested). Other layouts get a few each.
  const layouts = db
    .prepare("SELECT layout, COUNT(*) n FROM cards WHERE layout <> 'normal' GROUP BY layout ORDER BY n DESC")
    .all() as Array<{ layout: string; n: number }>;
  for (const { layout, n } of layouts) {
    const ids = db
      .prepare('SELECT oracle_id FROM cards WHERE layout = ? ORDER BY oracle_id')
      .all(layout) as Array<{ oracle_id: string }>;
    const takeCount = n <= 3 ? n : 8;                                  // all of meld (3); a few of each other
    for (const id of ids.slice(0, takeCount)) add(id.oracle_id, `layout:${layout}`);
  }

  // 2. sec. 3.6 failure class — `base power` (needs CR 613, which term match cannot reach).
  const basePower = db
    .prepare("SELECT DISTINCT oracle_id FROM card_faces WHERE oracle_text LIKE '%base power%' ORDER BY oracle_id LIMIT 12")
    .all() as Array<{ oracle_id: string }>;
  for (const id of basePower) add(id.oracle_id, 'shape:base-power');

  // 3. sec. 3.6 failure class — `gets -X/-X` PT modification.
  const ptMod = db
    .prepare("SELECT DISTINCT oracle_id FROM card_faces WHERE oracle_text LIKE '%gets -%' ORDER BY oracle_id LIMIT 12")
    .all() as Array<{ oracle_id: string }>;
  for (const id of ptMod) add(id.oracle_id, 'shape:gets-minus-minus');

  // 4. The gate's blind spots — plan Step 1 calls these "the cards that matched
  //    zero rules" (Task 1 Step 13). That phrasing is STALE: measured against the
  //    real corpus, zero cards match zero rules (task-6-brief.md scope note), which
  //    is why Task 1 produced docs/task1-bottom-decile-cards.json instead - the 526
  //    cards at or below the bottom-decile threshold (<= 4 matched rules, ties
  //    included). Read that committed artifact rather than recomputing matchTerms
  //    live: it's already the mechanically-derived, reviewed list, and re-deriving
  //    it here would risk silently drifting from what Task 1 actually measured.
  //    Lowest rule_count first (then oracle_id) so the sample is the thinnest
  //    packets in the pool, per the note field's own rationale.
  const bottomDecile = JSON.parse(readFileSync(BOTTOM_DECILE_PATH, 'utf8')) as {
    cards: Array<{ oracle_id: string; name: string; rule_count: number }>;
  };
  //
  //    Cards with NO oracle text are excluded here. They sort to the very top of
  //    a rule_count ordering - a vanilla creature has no text to match terms
  //    against, so it matches almost nothing - and the first pass of this bucket
  //    spent three of its fifteen slots on French vanillas. That is a misread of
  //    what the bucket is for: a blind spot is a card whose real text the gate
  //    under-serves, and a card with no text is not under-served, it has nothing
  //    to serve. One vanilla is still worth having, and bucket 4b takes it
  //    deliberately rather than by accident.
  const hasText = db.prepare(
    'SELECT COALESCE(SUM(LENGTH(oracle_text)), 0) n FROM card_faces WHERE oracle_id = ?',
  );
  const textLenOf = (oracleId: string): number => (hasText.get(oracleId) as { n: number }).n;

  const blindSpotSample = [...bottomDecile.cards]
    .filter((c) => textLenOf(c.oracle_id) > 0)
    .sort((a, b) => a.rule_count - b.rule_count || a.oracle_id.localeCompare(b.oracle_id))
    .slice(0, 15);
  for (const c of blindSpotSample) add(c.oracle_id, `blind-spot:rule_count=${c.rule_count}`);

  // 4b. ONE vanilla creature - a card whose `oracle_text` is the empty string, so
  //     it yields zero clauses and the correct extraction is zero atoms. It is
  //     the only card shape that scores a provider for INVENTING an atom: sec. 8.2
  //     precision counts every atom a run emits on a complete golden card, and
  //     this card contributes none of its own to match against. One is enough -
  //     every vanilla tests the identical thing, and slots here are hand-verified
  //     by the owner. Lowest oracle_id for determinism.
  const vanilla = db
    .prepare(
      `SELECT oracle_id FROM card_faces GROUP BY oracle_id
        HAVING COALESCE(SUM(LENGTH(oracle_text)), 0) = 0 ORDER BY oracle_id LIMIT 1`,
    )
    .all() as Array<{ oracle_id: string }>;
  for (const id of vanilla) add(id.oracle_id, 'vanilla:no-oracle-text');

  // 5. The longest oracle texts — the cards that exercise the splitter and the
  //    coverage gate hardest.
  const longest = db
    .prepare(
      `SELECT oracle_id, SUM(LENGTH(oracle_text)) n FROM card_faces
        GROUP BY oracle_id ORDER BY n DESC, oracle_id LIMIT 20`,
    )
    .all() as Array<{ oracle_id: string }>;
  for (const id of longest) add(id.oracle_id, 'longest-text');

  // 6. Rarity BACKFILL — ONLY for a rarity that's entirely absent from the
  //    buckets above (Important finding 6, first review pass). The five
  //    mechanical buckets already span every rarity in practice; unconditionally
  //    sampling N-per-rarity here selected cards by nothing but oracle_id sort
  //    order, which is exactly the "judgement call" plan Step 1 rules out for
  //    a selection query, and cost the owner real hand-drafting time on cards
  //    included for no reason beyond hitting a target count. This bucket now
  //    only fires as a genuine gap-filler, and is expected to select ZERO cards
  //    against the current pool.
  const presentRarities = new Set([...rows.values()].map((r) => r.rarity));
  for (const rarity of ['common', 'uncommon', 'rare', 'mythic']) {
    if (presentRarities.has(rarity)) continue;
    const sample = db
      .prepare('SELECT oracle_id FROM cards WHERE rarity = ? ORDER BY oracle_id LIMIT 3')
      .all(rarity) as Array<{ oracle_id: string }>;
    for (const id of sample) add(id.oracle_id, `rarity-backfill:${rarity}`);
  }

  // Output, deterministic: by layout, then rarity, then oracle_id.
  const out = [...rows.entries()].map(([oracle_id, r]) => ({
    oracle_id, ...r, buckets: r.buckets.join(' '),
  }));
  out.sort((a, b) => a.layout.localeCompare(b.layout) || a.rarity.localeCompare(b.rarity) || a.oracle_id.localeCompare(b.oracle_id));

  const header = `${'oracle_id'.padEnd(40)} ${'name'.padEnd(28)} ${'layout'.padEnd(12)} ${'rarity'.padEnd(9)} ${'len'.padStart(5)}  buckets`;
  console.log(`# Golden-set candidates (${out.length} cards). Buckets overlap; a card may carry several.`);
  console.log(`# Drafted against the UNGATED corpus. Verify with: npm run golden -- --verify <oracle_id>`);
  console.log(header);
  for (const r of out) {
    console.log(
      `${r.oracle_id.padEnd(40)} ${r.name.slice(0, 28).padEnd(28)} ${r.layout.padEnd(12)} ${r.rarity.padEnd(9)} ${String(r.textLen).padStart(5)}  ${r.buckets}`,
    );
  }

  // Committed output artifact (plan Task 6 Step 1's scope note: "produce and
  // commit the stratified candidate list"). This is the actual selection the
  // project owner works from in Step 5 (out of scope here) - regenerating it via
  // --select must reproduce the same file from the same pool + bottom-decile
  // artifact, so nothing about the selection is hand-maintained.
  const artifact = {
    generated_by: 'src/cli/golden.ts --select (plan Task 6, Step 1)',
    generated_at: new Date().toISOString(),
    method:
      'stratified over: every non-normal layout present in the pool (all 3 meld), ' +
      'the sec. 3.6 failure shapes (base power, gets -X/-X), the bottom-decile ' +
      'blind spots from docs/task1-bottom-decile-cards.json (cards with oracle ' +
      'text only), one vanilla creature with no oracle text, and the 20 longest ' +
      'oracle texts; a rarity is backfilled only if entirely absent from the above',
    count: out.length,
    cards: out,
  };
  writeFileSync(CANDIDATES_OUT, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  console.log();
  console.log(`wrote ${CANDIDATES_OUT}`);
}

// --------------------------------------------------------------------------- --bottom-decile
//
// Regenerates the blind-spot input --select reads (bucket 4). It is a snapshot of one
// pool + corpus, so every `sync:cards` / `sync:rules` must be followed by this before
// --select (docs/golden-set-procedure.md, "Rotation and pool refresh") - a refresh
// that skips it leaves bucket 4 selecting from the old pool.
function runBottomDecile(): void {
  const corpusId = currentCorpus();
  const m = measureBottomDecile(db, corpusId, loadPacketPolicy());
  const previous = new Set(
    (JSON.parse(readFileSync(BOTTOM_DECILE_PATH, 'utf8')) as { cards: Array<{ oracle_id: string }> })
      .cards.map((c) => c.oracle_id),
  );
  const now = new Set(m.cards.map((c) => c.oracle_id));
  const artifact = {
    generated_by: 'src/cli/golden.ts --bottom-decile (plan Task 1, Step 13 method)',
    generated_at: new Date().toISOString(),
    corpus_id: corpusId,
    pool_size: m.pool_size,
    method: 'matchTerms only (no crossref expansion) over every non-rotated pool card',
    bottom_decile_index: m.bottom_decile_index,
    bottom_decile_threshold_rule_count: m.bottom_decile_threshold_rule_count,
    note:
      'All cards whose matched-rule count is <= the bottom-decile threshold (ties included, ' +
      'so this list is >= 10% of the pool). Task 6 Step 1 uses these as golden-set candidates - ' +
      "the thinnest packets in the pool, and therefore the most likely to hit spec sec. 3.6's failure class.",
    count: m.cards.length,
    cards: m.cards,
  };
  writeFileSync(BOTTOM_DECILE_PATH, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  console.log(`corpus ${corpusId}, pool ${m.pool_size} cards`);
  console.log(`threshold ${m.bottom_decile_threshold_rule_count} rules (index ${m.bottom_decile_index}), ${m.cards.length} cards`);
  console.log(`vs previous file: +${[...now].filter((id) => !previous.has(id)).length} entered, ` +
              `-${[...previous].filter((id) => !now.has(id)).length} left`);
  console.log(`wrote ${BOTTOM_DECILE_PATH}`);
}

// --------------------------------------------------------------------------------- --draft
function runDraft(oracleId: string): void {
  const card = db
    .prepare('SELECT name, layout, rarity, type_line, oracle_hash FROM cards WHERE oracle_id = ?')
    .get(oracleId) as { name: string; layout: string; rarity: string; type_line: string; oracle_hash: string } | undefined;
  if (!card) fail(`no card with oracle_id ${oracleId}`);

  console.log(`==== ${card.name} ====`);
  console.log(`oracle_id: ${oracleId}`);
  console.log(`layout: ${card.layout}   rarity: ${card.rarity}`);
  console.log(`type_line: ${card.type_line}`);
  console.log(`oracle_hash: ${card.oracle_hash}`);
  console.log();

  const faces = db
    .prepare('SELECT face_index, name, oracle_text FROM card_faces WHERE oracle_id = ? ORDER BY face_index')
    .all(oracleId) as Array<{ face_index: number; name: string; oracle_text: string }>;

  for (const f of faces) {
    console.log(`---- face ${f.face_index}: ${f.name} ----`);
    console.log(f.oracle_text);
    console.log();
    console.log('clauses (splitOracleText):');
    const clauses = splitOracleText(f.oracle_text, f.face_index);
    if (clauses.length === 0) console.log('  (none — empty oracle_text yields no clauses)');
    for (const c of clauses) {
      console.log(`  [${c.clause_index}] ${c.kind.padEnd(11)} ${c.span_start}-${c.span_end}  "${c.text}"`);
    }
    console.log();
  }

  // Ungated corpus lookup: matchTerms over rule_term_index (the full parsed corpus),
  // NOT the assembled gated packet. This is the audit surface — a rule that shows
  // up here but would be dropped by the gate is the signal the packet is missing it.
  const corpusId = currentCorpus();
  const policy = loadPacketPolicy();
  const { text } = cardMatchText(db, oracleId);
  const matched = matchTerms(db, corpusId, text, policy);
  console.log('---- ungated corpus term lookup (rule_term_index) ----');
  if (matched.length === 0) {
    console.log('  (no terms matched — this card is a gate blind spot; reading it may need kernel rules)');
  } else {
    for (const m of matched) {
      const rules = m.rule_numbers.join(', ') || '(definition only)';
      const def = m.definition ? `  def: ${m.definition.slice(0, 80)}` : '';
      console.log(`  "${m.term}" [${m.source}] surface="${m.surface}" -> ${rules}${def}`);
    }
  }
  console.log();
  console.log('NOTE: this aids hand-drafting; it does NOT suggest atoms. Draft each clause');
  console.log('against the ungated rules above, then write via upsertGoldenCard and run --verify.');
}

// --------------------------------------------------------------------------------- --verify
function runVerify(oracleId: string): void {
  const result = verifyGoldenCard(db, oracleId);
  if (result.ok) {
    console.log(`OK: ${oracleId} — ${result.atoms} atoms, ${result.non_reminder_clauses} non-reminder clauses all covered.`);
    process.exitCode = 0;
  } else {
    console.error(`FAIL: ${oracleId} — ${result.errors.length} problem(s):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------------------------- entry
function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if (mode === '--select') runSelect();
  else if (mode === '--bottom-decile') runBottomDecile();
  else if (mode === '--draft') {
    if (!argv[1]) fail('usage: npm run golden -- --draft <oracle_id>');
    runDraft(argv[1]);
  } else if (mode === '--verify') {
    if (!argv[1]) fail('usage: npm run golden -- --verify <oracle_id>');
    runVerify(argv[1]);
  } else {
    fail('usage: npm run golden -- --bottom-decile | --select | --draft <oracle_id> | --verify <oracle_id>');
  }
  db.close();
}

main();