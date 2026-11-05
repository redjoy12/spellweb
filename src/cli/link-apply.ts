/**
 * npm run link-apply -- <command>   (link review design sec. 7.3 and 10)
 *
 *   --show <request>                                  the items of an apply request, with the rules and their pair counts
 *   --owner-link <suggestion> [--block | --add]       an owner link from a suggestion (block for a delete, add for the others)
 *   --weak <suggestion> [--remove]                    write or remove the weak mark of a suggestion
 *   --applied <suggestion>[,...] --how <text> [--build <id>]   mark suggestions as applied
 *   --question <suggestion> --text <text>             send a suggestion back to the tab with a question
 *   --report <id>[,...] --status accepted|rejected|open        set the state of false link reports
 *   --done <request> --results <text>                 close an apply request
 *   --close-fixed-reports [--dry-run]                 set each open report whose link is not on the newest build to accepted
 *
 * The apply session of the desktop app runs these commands (config/link-apply-procedure.md). Use
 * APP_DB_PATH for a database copy.
 */
import { openDb } from '../db/client.js';
import { newestBuild, scopePairTable, weakPairKeys, withWeakAnswers } from '../deck/deck.js';
import {
  applyRequestText, cardInfos, closeRequest, fixedReports, LinkChangeError, markApplied, sendQuestion, setReportStatus, weakFromSuggestion, writeOwnerLink,
} from '../deck/linkChanges.js';
import { loadDeckPolicy } from '../deck/policy.js';
import { BuildIndex } from '../graph/buildIndex.js';

const args = process.argv.slice(2);
const one = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const has = (flag: string) => args.includes(flag);
const ids = (raw: string | undefined, flag: string) => {
  const list = (raw ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (list.length === 0) throw new LinkChangeError('invalid', `${flag} needs one or more IDs`);
  return list;
};
const need = (flag: string) => {
  const v = one(flag);
  if (!v || v.startsWith('--')) throw new LinkChangeError('invalid', `${flag} needs a value`);
  return v;
};

const db = openDb(process.env['APP_DB_PATH']);
const graph = () => {
  const buildId = newestBuild(db);
  const idx = BuildIndex.load(db, buildId);
  return { buildId, idx, base: scopePairTable(db, idx) };
};

try {
  if (has('--show')) {
    const { idx, base } = graph();
    console.log(applyRequestText(db, idx, withWeakAnswers(db, base, loadDeckPolicy()), weakPairKeys(db), ids(one('--show'), '--show')[0]!));
  } else if (has('--owner-link')) {
    const [sid] = ids(one('--owner-link'), '--owner-link');
    const id = writeOwnerLink(db, sid!, has('--block') ? 'block' : has('--add') ? 'add' : undefined);
    console.log(`Owner link ${id} written from suggestion ${sid}. A new deck reads it.`);
  } else if (has('--weak')) {
    const [sid] = ids(one('--weak'), '--weak');
    weakFromSuggestion(db, sid!, has('--remove'));
    const s = db.prepare('SELECT supply_oracle, demand_oracle FROM link_suggestions WHERE id = ?').get(sid!) as { supply_oracle: string; demand_oracle: string };
    const weak = weakPairKeys(db).has(`${s.supply_oracle}>${s.demand_oracle}`);
    console.log(`Suggestion ${sid}: the pair is ${weak ? 'weak' : 'not weak'} now.${has('--remove') && weak ? ' Another owner answer keeps it weak: read owner_decisions for this pair.' : ''}`);
  } else if (has('--applied')) {
    const list = ids(one('--applied'), '--applied');
    markApplied(db, list, need('--how'), one('--build') ? Number(one('--build')) : null);
    console.log(`Applied: suggestions ${list.join(', ')}.`);
  } else if (has('--question')) {
    const [sid] = ids(one('--question'), '--question');
    sendQuestion(db, sid!, need('--text'));
    console.log(`Suggestion ${sid} is back on the Decisions page with the question.`);
  } else if (has('--report')) {
    const list = ids(one('--report'), '--report');
    const status = need('--status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'open') throw new LinkChangeError('invalid', '--status is accepted, rejected or open');
    console.log(`${setReportStatus(db, list, status)} reports set to ${status}.`);
  } else if (has('--done')) {
    const [rid] = ids(one('--done'), '--done');
    closeRequest(db, rid!, need('--results'));
    console.log(`Apply request ${rid} is done.`);
  } else if (has('--close-fixed-reports')) {
    const { buildId, base } = graph();
    const { fixed, kept } = fixedReports(db, base);
    const names = cardInfos(db, [...fixed, ...kept].flatMap((r) => [r.supply_oracle, r.demand_oracle]));
    const line = (r: (typeof fixed)[number]) => `  ${r.id}: ${names.get(r.supply_oracle)?.name ?? r.supply_oracle} -> ${names.get(r.demand_oracle)?.name ?? r.demand_oracle} (marked on build ${r.build_id})`;
    console.log(`Build ${buildId}. ${fixed.length} open reports have no link now, and ${kept.length} keep their link.`);
    console.log('Keep their link (they stay open):', ...kept.map(line).map((l) => `\n${l}`));
    if (has('--dry-run')) console.log(`Dry run: no report changes. Without --dry-run, ${fixed.length} reports become accepted.`);
    else console.log(`${setReportStatus(db, fixed.map((r) => r.id), 'accepted')} reports set to accepted.`);
  } else {
    console.log('Give a command: --show, --owner-link, --weak, --applied, --question, --report, --done or --close-fixed-reports. See the head of src/cli/link-apply.ts.');
    process.exitCode = 1;
  }
} catch (err) {
  if (err instanceof LinkChangeError) {
    console.error(`link-apply: ${err.message}`);
    process.exitCode = 1;
  } else throw err;
}
