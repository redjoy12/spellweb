/**
 * The owner check of the golden synergy pairs (owner request 2026-10-24, group A).
 *
 * The isolated labelers accepted these pairs on 2026-10-10, before the owner set the link rule
 * (2026-10-18: payoff/enabler yes, resource/definition/wrong-direction no). Many of them link a card
 * only because it is a creature. The "Your decisions" page shows each pair with the two full card
 * texts and no label, reason or app answer, so nothing steers the owner.
 *
 * An answer changes nothing at once. `applyGoldenCheck` writes the answers to the golden set:
 * - `link`, `weak_link`: the labeler label stays; the pair becomes `owner_accepted`.
 * - `no_link`: the label becomes `none`; the pair becomes `owner_corrected`.
 * - `anti`: the label becomes `anti`; the pair becomes `owner_corrected`. It keeps the clauses and
 *   the CR chain of the labelers (the same texts, the other direction), and an atom only while it is
 *   current. The owner wrote this rule in chat (2026-10-25, pair 32).
 * - `unsure`: no change.
 *
 * Some pairs are in the latest owner sample (spec sec. 11.4; `ownerAgreement` uses `latestSample`,
 * now sample 1). A `no_link` on one of them counts there as an owner correction, and can pass the
 * owner-correction limit. A `link` or `weak_link` counts as agreement. That is intended: these are
 * real owner verdicts on labeler labels (review of 2026-10-24).
 *
 * Six pairs (6, 33, 48, 73, 102, 104) were also on the `type_role` questions, which said that an
 * earlier check found a link. The owner answered those questions on 2026-10-24, so the owner saw
 * that claim before this check. `wrong_link` items of golden-check pairs are hidden on the page
 * (src/graph/ownerDecisions.ts), because they show the label and the reasons.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cardOf, type LinkCheckCard } from './linkCheck.js';
import { ownerVerdict } from './goldenLabel.js';

export const GOLDEN_CHECK_CHOICES = ['link', 'weak_link', 'no_link', 'anti', 'unsure'] as const;
/** The start of the `owner_note` that an apply writes. */
export const NOTE_PREFIX = 'owner golden check ';

export interface GoldenCheckItem { key: string; pair_id: number; supply: LinkCheckCard; demand: LinkCheckCard }

/**
 * The accepted labeler pairs with the label `synergy`, in pair order. A pair that an apply wrote,
 * or that has an answer, stays, so that the page still shows the answer and an Undo keeps it.
 */
export function goldenCheckItems(db: DatabaseSync): GoldenCheckItem[] {
  const rows = db.prepare(
    `SELECT id, supply_oracle, demand_oracle FROM edge_golden_pairs
      WHERE (status = 'accepted' AND label = 'synergy')
         OR (status IN ('owner_accepted','owner_corrected') AND owner_note LIKE '${NOTE_PREFIX}%')
         OR 'gp' || id IN (SELECT item_key FROM owner_decisions WHERE kind = 'golden_check')
      ORDER BY id`,
  ).all() as Array<{ id: number; supply_oracle: string; demand_oracle: string }>;
  return rows.map((r) => ({ key: `gp${r.id}`, pair_id: r.id, supply: cardOf(db, r.supply_oracle), demand: cardOf(db, r.demand_oracle) }));
}

/**
 * `skipped`: the pair is no longer an accepted synergy pair (an earlier apply, a new label round or
 * a stale text). `conflicts`: a pair that an apply wrote, whose state does not agree with the answer
 * now: the answer changed after the apply, or the answer was removed (Undo). The apply does not
 * change these; they need a look.
 */
export interface GoldenCheckApply { accepted: number[]; corrected: number[]; anti: number[]; waiting: number[]; skipped: number[]; conflicts: number[] }

/** True when the state of a pair that an apply wrote agrees with the answer. */
function agrees(choice: string, p: { status: string; label: string | null }): boolean {
  if (choice === 'link' || choice === 'weak_link') return p.status === 'owner_accepted' && p.label === 'synergy';
  if (choice === 'no_link') return p.status === 'owner_corrected' && p.label === 'none';
  if (choice === 'anti') return p.status === 'owner_corrected' && p.label === 'anti';
  return false; // unsure writes nothing, so an applied pair never agrees with it.
}

/** Writes the owner answers to the golden set. With `dryRun`, writes nothing. */
export function applyGoldenCheck(db: DatabaseSync, opts: { dryRun?: boolean } = {}): GoldenCheckApply {
  const out: GoldenCheckApply = { accepted: [], corrected: [], anti: [], waiting: [], skipped: [], conflicts: [] };
  const answers = new Map((db.prepare("SELECT item_key, choice, note FROM owner_decisions WHERE kind = 'golden_check'")
    .all() as Array<{ item_key: string; choice: string; note: string }>).map((a) => [Number(a.item_key.slice(2)), a]));
  const applied = db.prepare("SELECT id FROM edge_golden_pairs WHERE owner_note LIKE ? AND status IN ('owner_accepted','owner_corrected')")
    .all(`${NOTE_PREFIX}%`) as Array<{ id: number }>;
  const ids = [...new Set([...answers.keys(), ...applied.map((r) => r.id)])].sort((a, b) => a - b);
  const pair = db.prepare('SELECT status, label, owner_note FROM edge_golden_pairs WHERE id = ?');
  const when = new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    const a = answers.get(id);
    const p = pair.get(id) as { status: string; label: string | null; owner_note: string | null } | undefined;
    if (!a || p?.status !== 'accepted' || p.label !== 'synergy') {
      out.skipped.push(id);
      // A stale pair has a changed text: the answer is about the old text, so it is no conflict.
      if (p?.status !== 'stale' && p?.owner_note?.startsWith(NOTE_PREFIX) && (!a || !agrees(a.choice, p))) out.conflicts.push(id);
      continue;
    }
    const note = `${NOTE_PREFIX}${when}: ${a.choice}${a.note ? ` (${a.note})` : ''}`;
    if (a.choice === 'link' || a.choice === 'weak_link') {
      if (!opts.dryRun) ownerVerdict(db, id, { accept: true, note });
      out.accepted.push(id);
    } else if (a.choice === 'no_link') {
      if (!opts.dryRun) ownerVerdict(db, id, { accept: false, label: 'none', note });
      out.corrected.push(id);
    } else if (a.choice === 'anti') {
      if (!opts.dryRun) ownerVerdict(db, id, { accept: false, label: 'anti', note, ...sameSides(db, id) });
      out.anti.push(id);
    } else out.waiting.push(id);
  }
  return out;
}

/** The clauses, the current atoms and the CR chain of a pair, for an anti label on the same texts. */
function sameSides(db: DatabaseSync, id: number) {
  const r = db.prepare('SELECT supply_clause, demand_clause, supply_atom_id, demand_atom_id, cr_chain_json FROM edge_golden_pairs WHERE id = ?')
    .get(id) as { supply_clause: string | null; demand_clause: string | null; supply_atom_id: number | null; demand_atom_id: number | null; cr_chain_json: string | null };
  const current = (atom: number | null) => (atom !== null && db.prepare('SELECT 1 FROM atoms WHERE id = ? AND is_current = 1').get(atom) ? atom : null);
  return {
    supply_clause: r.supply_clause ? JSON.parse(r.supply_clause) : null,
    demand_clause: r.demand_clause ? JSON.parse(r.demand_clause) : null,
    supply_atom_id: current(r.supply_atom_id), demand_atom_id: current(r.demand_atom_id),
    cr_chain: r.cr_chain_json ? JSON.parse(r.cr_chain_json) : [],
  };
}
