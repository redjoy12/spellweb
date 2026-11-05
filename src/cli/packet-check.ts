/**
 * `npm run packet-check` (plan Task 10, amended 2026-10-04: the bake-off became the packet-hole
 * check). Scores a golden extraction run against the golden set with sec. 8.2's metrics and
 * sec. 9's bars, then sorts every missed golden atom into packet hole / in packet / not
 * extracted. Makes no model calls.
 *
 *   --run <run_id>        the golden run to check (default: the latest finished golden run)
 *   --report <file.md>    also write the full result as a dated Markdown record
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../db/client.js';
import { assembleScopedPacket } from '../rules/packet.js';
import { loadPacketPolicy } from '../rules/relevance.js';
import { packetParts } from '../atoms/extract.js';
import { runPacketRules } from '../atoms/extractBatch.js';
import { BARS, checkRun, type BarMetric, type PacketCheck } from '../atoms/packetCheck.js';

function fail(message: string): never {
  console.error(`packet-check: ${message}`);
  process.exit(1);
}

let runArg: number | undefined;
let report: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const val = () => argv[++i] ?? fail(`${a} needs a value`);
  if (a === '--run') runArg = Number(val());
  else if (a === '--report') report = val();
  else fail(`unknown argument ${a}`);
}

const db = openDb();
const runId = runArg ?? (db.prepare(
  "SELECT max(id) id FROM extraction_runs WHERE batch_kind = 'golden' AND status = 'complete' AND provider <> 'human'",
).get() as { id: number | null }).id ?? fail('no finished golden extraction run');
const run = db.prepare('SELECT * FROM extraction_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
if (!run) fail(`no run ${runId}`);
if (run['batch_kind'] !== 'golden') fail(`run ${runId} is a ${String(run['batch_kind'])} run, not a golden one`);

const policy = loadPacketPolicy();
const result = checkRun(db, runId, {
  packetRules: runPacketRules(runId),
  currentPacketRules: (id) => new Set(packetParts(assembleScopedPacket(db, id, policy)).packetRules),
});
const corpus = db.prepare('SELECT effective_date FROM rules_corpus WHERE id = ?').get(run['corpus_id'] as number) as
  { effective_date: string } | undefined;
const kernel = db.prepare('SELECT count(*) n FROM packet_kernel WHERE corpus_id = ?').get(run['corpus_id'] as number) as { n: number };
db.close();

const pct = (v: number | null) => (v === null ? 'unmeasured' : `${(v * 100).toFixed(1)}%`);
const share = (n: number, d: number) => pct(d === 0 ? null : n / d);
const count = (v: PacketCheck['misses'][number]['verdict']) => result.misses.filter((m) => m.verdict === v).length;

function metricRows(): string[] {
  const s = result.score;
  return [
    '| Metric | Value | Bar | |',
    '|---|---|---|---|',
    ...(Object.keys(BARS) as BarMetric[]).map((k) =>
      `| ${k} | ${pct(s[k])} | ${(BARS[k] * 100).toFixed(0)}% | ${result.acceptable.failed.includes(k) ? 'FAIL' : 'pass'} |`),
    `| citation_in_corpus | ${pct(s.citation_in_corpus)} | - | diagnostic |`,
    `| missing_rule_rate | ${s.missing_rule_rate.toFixed(3)} / card | - | diagnostic |`,
    `| unclassified_rate | ${s.unclassified_rate.toFixed(3)} / card | - | diagnostic |`,
  ];
}

const summary = [
  `run ${runId} (${String(run['model'])}, corpus ${corpus?.effective_date ?? run['corpus_id']}, ` +
    `policy ${String(run['packet_policy_sha']).slice(0, 8)}, schema v${String(run['schema_version'])})`,
  `golden: ${result.score.golden_cards_total} cards (${result.score.complete_cards} complete), ` +
    `${result.score.golden_atoms_total} atoms; matched ${result.score.golden_atoms_matched}; ` +
    `run atoms on complete cards ${result.score.accepted_atoms}, matched ${result.score.matched_atoms}`,
  `misses: ${result.misses.length} - ${count('packet_hole')} packet hole ` +
    `(${result.misses.filter((m) => m.closed_now).length} closed in today's packet), ` +
    `${count('in_packet')} in packet, ${count('not_extracted')} not extracted`,
  `extras on complete cards: ${result.extras.length}; extractor missing-rule reports: ${result.missingRules.length}`,
  `decision: ${result.acceptable.ok ? 'ACCEPTABLE' : `NOT ACCEPTABLE (${result.acceptable.failed.join(', ')})`}`,
];

console.log(summary.join('\n'));
console.log(metricRows().join('\n'));
for (const m of result.misses.filter((x) => x.verdict === 'packet_hole')) {
  console.log(`  HOLE ${m.name}: ${m.family} ${m.type_key} "${m.quote}" not shown ${m.not_shown.join(', ')}` +
    `${m.closed_now ? ' (closed now)' : ''}`);
}

if (report) {
  const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const missTable = (v: PacketCheck['misses'][number]['verdict']) => {
    const rows = result.misses.filter((m) => m.verdict === v);
    if (rows.length === 0) return ['(none)'];
    return [
      '| Card | Golden atom | Quote | Cites | Run instead |',
      '|---|---|---|---|---|',
      ...rows.map((m) => `| ${esc(m.name)} | ${m.family} ${m.type_key} | ${esc(m.quote)} | ${m.rule_numbers.join(', ')}` +
        `${m.not_shown.length ? ` (not shown: ${m.not_shown.join(', ')}${m.closed_now ? '; closed now' : ''})` : ''} | ` +
        `${[m.run_same_type_elsewhere ? `same type elsewhere x${m.run_same_type_elsewhere}` : '', ...m.run_types_on_span]
          .filter(Boolean).join('; ') || '-'} |`),
    ];
  };
  const md = [
    `# Packet-hole check - run ${runId}`,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run packet-check -- --run ${runId}\`. ` +
      `Kernel: ${kernel.n} rules on this corpus today.`,
    '',
    ...summary.map((l) => `- ${l}`),
    '',
    '## Metrics (spec sec. 8.2, bars sec. 9)',
    '',
    ...metricRows(),
    '',
    '## Packet holes',
    '',
    'Golden atoms the run missed whose cited rules were not in the card\'s packet. Fix in `config/packet-policy.json` or the kernel.',
    '',
    ...missTable('packet_hole'),
    '',
    '## Misses with every cited rule in the packet',
    '',
    'Reading or convention disagreements - the packet is not to blame.',
    '',
    ...missTable('in_packet'),
    '',
    '## Not extracted',
    '',
    ...missTable('not_extracted'),
    '',
    '## Extras on complete cards (precision\'s false positives)',
    '',
    ...(result.extras.length === 0 ? ['(none)'] : [
      '| Card | Run atom | Quote |',
      '|---|---|---|',
      ...result.extras.map((x) => `| ${esc(x.name)} | ${x.family} ${x.type_key} | ${esc(x.quote)} |`),
    ]),
    '',
    '## Extractor missing-rule reports',
    '',
    ...(result.missingRules.length === 0 ? ['(none)'] : [
      '| Card | Quote | Statement |',
      '|---|---|---|',
      ...result.missingRules.map((r) => `| ${esc(r.name)} | ${esc(r.quote)} | ${esc(r.statement)} |`),
    ]),
    '',
    '## Schema v15 params (spec sec. 20)',
    '',
    'Agreement of each param on the matched atom pairs whose golden atom is at v15. The match above ignores params.',
    '',
    ...(result.params.length === 0 ? ['(no matched v15 golden atoms)'] : [
      `All params: ${share(result.params.reduce((n, p) => n + p.agree, 0), result.params.reduce((n, p) => n + p.total, 0))}`,
      '',
      '| Type | Param | Agree | Pairs | Share |',
      '|---|---|---|---|---|',
      ...result.params.map((p) => `| ${p.type} | ${p.param} | ${p.agree} | ${p.total} | ${share(p.agree, p.total)} |`),
      '',
      '### Disagreements',
      '',
      ...(result.paramDisagreements.length === 0 ? ['(none)'] : [
        '| Card | Type | Param | Golden | Run | Quote |',
        '|---|---|---|---|---|---|',
        ...result.paramDisagreements.map((d) =>
          `| ${esc(d.name)} | ${d.type} | ${d.param} | ${esc(JSON.stringify(d.golden))} | ${esc(JSON.stringify(d.run) ?? '(missing)')} | ${esc(d.quote)} |`),
      ]),
    ]),
    '',
  ].join('\n');
  writeFileSync(report, md);
  console.log(`wrote ${report}`);
}
if (!result.acceptable.ok) process.exitCode = 1;
