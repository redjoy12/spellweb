import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { packetPolicySha, type PacketPolicy } from './relevance.js';
import {
  assembleScopedPacketForCorpus, containingBlocks, isCovered, termSelection, type CorePacketConfig,
} from './packet.js';

export interface KernelRule {
  rule_number: string;
  evidence: string;
}

export interface KernelReport {
  kernel: KernelRule[];
  /** Golden citations naming a rule this corpus doesn't have (ruling R3) - a golden-set
   *  bug, or a citation a CR refresh renumbered. Never admitted to the kernel. */
  skippedRules: Array<{ atom_id: number; oracle_id: string; rule_number: string }>;
  /** Golden cards absent from `cards` - no packet can be assembled for them (ruling R3). */
  skippedCards: string[];
}

interface GoldenAtomRow { id: number; oracle_id: string; rule_numbers: string }

/** Every golden atom, grouped by card, in a deterministic order. */
function goldenAtomsByCard(db: DatabaseSync): Map<string, GoldenAtomRow[]> {
  const rows = db
    .prepare('SELECT id, oracle_id, rule_numbers FROM golden_atoms ORDER BY oracle_id, id')
    .all() as unknown as GoldenAtomRow[];
  const byCard = new Map<string, GoldenAtomRow[]>();
  for (const r of rows) {
    const list = byCard.get(r.oracle_id) ?? [];
    list.push(r);
    byCard.set(r.oracle_id, list);
  }
  return byCard;
}

/** A rule number this corpus has: a `rules` row, or a bare section in `rule_sections`. */
function ruleExistsIn(db: DatabaseSync, corpusId: number): (rule: string) => boolean {
  const asRule = db.prepare('SELECT 1 FROM rules WHERE corpus_id = ? AND number = ?');
  const asSection = db.prepare('SELECT 1 FROM rule_sections WHERE corpus_id = ? AND number = ?');
  return (rule) => asRule.get(corpusId, rule) !== undefined || asSection.get(corpusId, rule) !== undefined;
}

function cardExists(db: DatabaseSync): (oracleId: string) => boolean {
  const q = db.prepare('SELECT 1 FROM cards WHERE oracle_id = ?');
  return (oracleId) => q.get(oracleId) !== undefined;
}

/**
 * sec. 3.4. The kernel is the smallest set K such that, for every golden atom, every rule
 * it cites is covered by its card's packet - where that packet is the card's
 * term-reachable selection (`termSelection`, ruling R1) plus K. Derived from a stated
 * objective, so it is falsifiable; nothing here consults pool-wide frequency, because a
 * frequency cutoff cannot promote a rule no card's text mentions (704, 613, 611 and 607
 * all measure 0.0% - they are exactly the rules a kernel exists to carry).
 *
 * "Covered" is containment (`isCovered`, ruling R2). Minimality is containment too: a
 * candidate inside another candidate is dropped, so citations of both 704 and 704.5f
 * leave 704 alone.
 */
export function deriveKernelReport(
  db: DatabaseSync,
  corpusId: number,
  policy: PacketPolicy,
  config?: CorePacketConfig,
): KernelReport {
  const exists = ruleExistsIn(db, corpusId);
  const inPool = cardExists(db);
  const candidates = new Map<string, { first: string; count: number }>();
  const skippedRules: KernelReport['skippedRules'] = [];
  const skippedCards: string[] = [];

  for (const [oracleId, atoms] of goldenAtomsByCard(db)) {
    if (!inPool(oracleId)) { skippedCards.push(oracleId); continue; }
    const reachable = new Set(
      termSelection(db, corpusId, oracleId, policy, config).sections.map((s) => s.number),
    );
    for (const atom of atoms) {
      for (const rule of JSON.parse(atom.rule_numbers) as string[]) {
        if (!exists(rule)) {
          skippedRules.push({ atom_id: atom.id, oracle_id: oracleId, rule_number: rule });
          continue;
        }
        if (isCovered(reachable, rule)) continue;
        const c = candidates.get(rule);
        if (c) c.count++;
        else candidates.set(rule, { first: `golden atom ${atom.id} on ${oracleId}`, count: 1 });
      }
    }
  }

  const all = new Set(candidates.keys());
  const kernel: KernelRule[] = [];
  for (const rule of [...all].sort()) {
    // Inside another candidate: its containing block is itself in the kernel.
    if (containingBlocks(rule).slice(1).some((n) => all.has(n))) continue;
    const { first, count } = candidates.get(rule)!;
    const more = count > 1 ? ` (+${count - 1} more)` : '';
    kernel.push({
      rule_number: rule,
      evidence: `cited by ${first}${more}, not term-reachable for its card`,
    });
  }
  return { kernel, skippedRules, skippedCards };
}

/** `deriveKernelReport`'s kernel alone - the plan's interface. */
export function deriveKernel(
  db: DatabaseSync,
  corpusId: number,
  policy: PacketPolicy,
  config?: CorePacketConfig,
): KernelRule[] {
  return deriveKernelReport(db, corpusId, policy, config).kernel;
}

/**
 * Replaces the corpus's `golden_citation` kernel rows with `rules`, in one transaction.
 * `review_promoted` rows (Task 12's accepted missing-rule reports) are left alone; a
 * derived rule that review already promoted keeps its review row.
 */
export function persistKernel(db: DatabaseSync, corpusId: number, rules: KernelRule[]): void {
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM packet_kernel WHERE corpus_id = ? AND origin = 'golden_citation'").run(corpusId);
    const ins = db.prepare(
      `INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence)
       VALUES (?, ?, 'golden_citation', ?)
       ON CONFLICT (corpus_id, rule_number) DO NOTHING`,
    );
    for (const r of rules) ins.run(corpusId, r.rule_number, r.evidence);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * sec. 8.1's standing report: per golden card, every cited rule its packet - assembled
 * exactly as extraction will assemble it, from the PERSISTED kernel of this corpus
 * (ruling R5) - does not cover. Empty by construction after `kernel:derive`; anything
 * here is a bug: a stale kernel (golden cards accepted since the last derive), a
 * citation naming a rule the corpus lacks, or a golden card absent from the pool (no
 * packet exists, so every citation is missing).
 */
export function packetPolicyDiff(
  db: DatabaseSync,
  corpusId: number,
  policy: PacketPolicy,
  config?: CorePacketConfig,
): Array<{ oracle_id: string; missing: string[] }> {
  const exists = ruleExistsIn(db, corpusId);
  const inPool = cardExists(db);
  const out: Array<{ oracle_id: string; missing: string[] }> = [];

  for (const [oracleId, atoms] of goldenAtomsByCard(db)) {
    const cited = new Set(atoms.flatMap((a) => JSON.parse(a.rule_numbers) as string[]));
    let missing: string[];
    if (!inPool(oracleId)) {
      missing = [...cited];
    } else {
      const packet = assembleScopedPacketForCorpus(db, corpusId, oracleId, policy, config);
      const rendered = new Set(packet.sections.map((s) => s.number));
      // A nonexistent rule is missing even if a containing block renders: the citation
      // itself is wrong, and that is what this report exists to surface.
      missing = [...cited].filter((r) => !exists(r) || !isCovered(rendered, r));
    }
    if (missing.length > 0) out.push({ oracle_id: oracleId, missing: missing.sort() });
  }
  return out;
}

/**
 * The `packet_policy_sha` a run records: the tunable policy AND the kernel it was assembled
 * with. sec. 3.4 says accepting a missing-rule report "bumps packet_policy_sha"; the policy
 * file alone cannot, because the kernel lives in `packet_kernel`, not in config. Hashing the
 * sorted rule list makes two runs comparable exactly when they were shown the same rules.
 */
export function packetPolicyShaWithKernel(db: DatabaseSync, corpusId: number, policy: PacketPolicy): string {
  const kernel = (db.prepare('SELECT rule_number FROM packet_kernel WHERE corpus_id = ? ORDER BY rule_number')
    .all(corpusId) as Array<{ rule_number: string }>).map((r) => r.rule_number);
  return createHash('sha256')
    .update([packetPolicySha(policy), String(corpusId), kernel.join(',')].join('|'), 'utf8')
    .digest('hex').slice(0, 16);
}

/**
 * Kernel rules accepted in review (`origin = 'review_promoted'`, sec. 3.4 / 6.4) belong to the
 * kernel, not to one corpus - but `packet_kernel` is keyed by corpus, and a CR refresh starts a
 * new corpus that `deriveKernel` fills from golden citations only. Without this, every accepted
 * missing-rule report is silently lost on the next `sync:rules`.
 *
 * Copies every review-promoted rule from the other corpora into `corpusId`, if that corpus still
 * has the rule. A rule the new corpus lacks (renumbered or removed) is NOT carried and is
 * returned in `dropped`, so the caller can say so loudly - the hole it closed may be open again.
 * Run it BEFORE `persistKernel`: a carried row then survives a derived row for the same rule.
 */
export function carryPromotedKernel(db: DatabaseSync, corpusId: number): { carried: string[]; dropped: string[] } {
  const rows = db.prepare(
    `SELECT rule_number, evidence, corpus_id FROM packet_kernel
      WHERE origin = 'review_promoted' AND corpus_id <> ?
      ORDER BY rule_number, corpus_id DESC`,
  ).all(corpusId) as Array<{ rule_number: string; evidence: string; corpus_id: number }>;
  const exists = ruleExistsIn(db, corpusId);
  const ins = db.prepare(
    `INSERT INTO packet_kernel (corpus_id, rule_number, origin, evidence) VALUES (?, ?, 'review_promoted', ?)
     ON CONFLICT (corpus_id, rule_number) DO NOTHING`,
  );
  const carried: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.rule_number)) continue;          // newest corpus's row per rule (ORDER BY above)
    seen.add(r.rule_number);
    if (!exists(r.rule_number)) { dropped.push(r.rule_number); continue; }
    const evidence = r.evidence.includes('[carried from corpus') ? r.evidence
      : `${r.evidence} [carried from corpus ${r.corpus_id}]`;
    if (Number(ins.run(corpusId, r.rule_number, evidence).changes) > 0) carried.push(r.rule_number);
  }
  return { carried, dropped };
}
