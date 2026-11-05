/**
 * `npm run kernel:derive` (plan Task 7). Derives the packet kernel for the current
 * corpus from the golden set's citations, persists it, and reports what sec. 3.4
 * requires on every run: the kernel's size, so a kernel creeping back toward Phase 1's
 * 385,012-character core is caught here rather than in a bill.
 *
 * Then measures the scoped packet over the whole pool (Step 7) and runs the standing
 * packet-policy diff against the kernel just persisted - exit 1 if it is non-empty.
 * Offline; no model calls. Re-run after accepting golden cards or after `sync:rules`.
 */
import { openDb } from '../db/client.js';
import { loadPacketPolicy } from '../rules/relevance.js';
import { assembleScopedPacket, kernelBlocks } from '../rules/packet.js';
import { deriveKernelReport, packetPolicyDiff, persistKernel } from '../rules/kernel.js';

const PHASE1_CORE_CHARS = 385_012;          // Phase 1's measured constant core packet
const TASK1_MEAN_RULES = 9.9;               // Task 1's measured matchTerms rules/card

const db = openDb();

try {
  const corpus = db.prepare('SELECT id, effective_date FROM rules_corpus WHERE is_current = 1')
    .get() as { id: number; effective_date: string } | undefined;
  if (!corpus) throw new Error('No current rules corpus - run `npm run sync:rules` first');
  const policy = loadPacketPolicy();

  const report = deriveKernelReport(db, corpus.id, policy);
  persistKernel(db, corpus.id, report.kernel);

  const { blocks, missing } = kernelBlocks(db, corpus.id);
  const kernelChars = blocks.reduce((n, s) => n + s.chars, 0);
  console.log(`corpus ${corpus.id} (effective ${corpus.effective_date})`);
  console.log(`kernel: ${report.kernel.length} golden_citation rules persisted, ` +
              `${blocks.length} rendered blocks (incl. any review_promoted), ${kernelChars} chars`);
  for (const s of [...blocks].sort((a, b) => b.chars - a.chars)) {
    const ev = report.kernel.find((k) => k.rule_number === s.number)?.evidence ?? 'review_promoted';
    console.log(`  ${s.number.padEnd(9)} ${String(s.chars).padStart(6)}  ${ev}`);
  }
  if (missing.length > 0) console.log(`  KERNEL ROWS RENDERING NOTHING: ${missing.join(', ')}`);

  console.log(`skipped citations (rule not in corpus ${corpus.id}): ${report.skippedRules.length}`);
  for (const s of report.skippedRules) {
    console.log(`  ${s.rule_number} cited by golden atom ${s.atom_id} on ${s.oracle_id}`);
  }
  console.log(`skipped golden cards (not in cards): ${report.skippedCards.length}`);
  for (const id of report.skippedCards) console.log(`  ${id}`);

  // Step 7: the number this phase turns on.
  const cards = db.prepare('SELECT oracle_id FROM cards').all() as Array<{ oracle_id: string }>;
  let sum = 0, max = 0, maxId = '', ruleSum = 0, blockSum = 0;
  for (const { oracle_id } of cards) {
    const p = assembleScopedPacket(db, oracle_id, policy);
    sum += p.selectedChars;
    if (p.selectedChars > max) { max = p.selectedChars; maxId = oracle_id; }
    ruleSum += new Set(p.matchedTerms.flatMap((m) => m.rule_numbers)).size;
    blockSum += p.sections.length;
  }
  const mean = sum / cards.length;
  console.log(`scoped packet over ${cards.length} cards: mean selectedChars ${Math.round(mean)}, ` +
              `max ${max} (${maxId})`);
  console.log(`reduction vs Phase 1 core (${PHASE1_CORE_CHARS}): ${(PHASE1_CORE_CHARS / mean).toFixed(1)}x`);
  console.log(`mean matchTerms rules/card: ${(ruleSum / cards.length).toFixed(1)} ` +
              `(Task 1 baseline ${TASK1_MEAN_RULES}); mean rendered blocks/card: ${(blockSum / cards.length).toFixed(1)}`);

  const diff = packetPolicyDiff(db, corpus.id, policy);
  console.log(`packet-policy diff: ${diff.length} golden cards with missing citations`);
  for (const d of diff) console.log(`  ${d.oracle_id}: ${d.missing.join(', ')}`);
  if (diff.length > 0) process.exitCode = 1;
} catch (err) {
  console.error('kernel:derive failed:', err);
  process.exitCode = 1;
}
