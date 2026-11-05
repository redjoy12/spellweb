/**
 * npm run cr-debate -- --prepare --round <n> [--size 40]
 * npm run cr-debate -- --submit --round <n>
 * npm run cr-debate -- --status
 *
 * The debate of the fuzzy CR sentence pairs (src/graph/crDebate.ts; docs/phase-3-duplicate-reasons.md
 * sec. 11.4 step A). --prepare writes data/cr-debate/round-<n>/batch-XX/debater-K/packet.md. Dispatch
 * one fresh `edge-rule-debater` subagent per debater directory, with the directory path only. It
 * writes response.json. --submit checks the answers and updates data/cr-debate/verdicts.json.
 */
import { openDb } from '../db/client.js';
import { currentCorpusId } from '../atoms/golden.js';
import { CR_BATCH_SIZE, crPairs, loadVerdicts, prepareCrRound, submitCrRound } from '../graph/crDebate.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const db = openDb();
const corpus = currentCorpusId(db);

if (args.includes('--prepare')) {
  const m = prepareCrRound(db, corpus, Number(opt('--round')), undefined, Number(opt('--size') ?? CR_BATCH_SIZE));
  console.log(`round ${m.round}: ${m.batches.reduce((s, b) => s + b.items.length, 0)} items in ${m.batches.length} batches; ${m.batches.length * 3} debater directories`);
} else if (args.includes('--submit')) {
  console.log(JSON.stringify(submitCrRound(db, Number(opt('--round'))), null, 2));
} else {
  const v = loadVerdicts();
  const counts: Record<string, number> = {};
  for (const e of Object.values(v?.items ?? {})) counts[e.verdict] = (counts[e.verdict] ?? 0) + 1;
  const owner = (db.prepare("SELECT choice, COUNT(*) n FROM owner_decisions WHERE kind = 'cr_text' GROUP BY choice").all() as Array<{ choice: string; n: number }>);
  console.log(JSON.stringify({ pairs: crPairs(db, corpus).length, debate: counts, owner }, null, 2));
}
