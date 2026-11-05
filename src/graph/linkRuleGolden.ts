/**
 * Plan 2026-10-31-schema-v17 Task 17 step 10: the owner answers of a link rule round become golden
 * pairs, so that recall can see the links of a new tag (docs/schema-v19-results.md sec. 9.10).
 *
 * The pairs come from the links of the app, so a "real" answer can only add a pair that the app has
 * already. The "no" answers go in also, because real answers alone raise precision by selection.
 * All pairs have the stratum `correction`, which no other pair has, so the score report shows them
 * in their own row.
 * - `link`, `weak_link`: label `synergy`, on the clauses and atoms of the `+` edge, confirmed before
 *   plausible: a tag with a param that no rule tests has only plausible edges (round 4: `CARD_DRAW`).
 * - `no_link`: label `none`.
 * - `anti`: label `anti`, on the same clauses and atoms.
 * - `unsure`, `other`: no row, until a later answer.
 *
 * The owner gives the label, so the CR chain is empty. A pair that has an owner note here keeps its
 * row: `conflicts` lists a pair whose answer changed after the apply.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BuildIndex } from './buildIndex.js';
import { ownerVerdict } from './goldenLabel.js';
import { nextRound, oracleHashes } from './goldenSelect.js';
import type { LinkRuleSample } from './linkRuleQuestions.js';
import { mergeEdges } from './merge.js';

/** The start of the `owner_note` that an apply writes. `link-rule-measure` does not read these pairs as earlier labels. */
export const LINK_RULE_NOTE = 'owner link rule round ';
/** The same for round 6. This answer is the label of an old pair and counts nowhere else, so `link-rule-measure` reads it as an earlier label. */
export const RECHECK_NOTE = 'owner link recheck round ';

const LABELS: Record<string, 'synergy' | 'anti' | 'none'> = { link: 'synergy', weak_link: 'synergy', no_link: 'none', anti: 'anti' };

export interface LinkRuleGoldenApply { added: Array<{ id: number; key: string; label: string }>; waiting: string[]; existing: string[]; conflicts: string[] }

/** The clause that holds a span of a card, or null. */
function clauseAt(db: DatabaseSync, oracle: string, face: number, span: readonly [number, number]): { face_index: number; clause_index: number } | null {
  const r = db.prepare('SELECT clause_index FROM clauses WHERE oracle_id = ? AND face_index = ? AND span_start < ? AND span_end > ? ORDER BY clause_index LIMIT 1')
    .get(oracle, face, span[1], span[0]) as { clause_index: number } | undefined;
  return r ? { face_index: face, clause_index: r.clause_index } : null;
}

/** The anchors of a pair: the first `+` edge A -> B in key order, confirmed before plausible. Throws when the build has no such edge. */
function anchors(db: DatabaseSync, index: BuildIndex, supply: string, demand: string) {
  const edges = mergeEdges(index.cardAtomEdges(supply).supply, index.ctx)
    .filter((e) => e.polarity === '+' && e.demand_oracle === demand && e.supply_span)
    .sort((a, b) => (a.grade !== b.grade ? (a.grade === 'confirmed' ? -1 : 1) : a.key < b.key ? -1 : 1));
  const e = edges[0];
  if (!e) throw new Error(`the build has no + edge for ${supply} > ${demand}`);
  const sid = e.atom_ids.find((id) => id !== e.demand_atom_id)!;
  const s = index.atoms.get(sid)!;
  const d = index.atoms.get(e.demand_atom_id)!;
  const supplyClause = clauseAt(db, supply, s.face_index, e.supply_span!);
  const demandClause = clauseAt(db, demand, d.face_index, d.span);
  if (!supplyClause || !demandClause) throw new Error(`no clause holds the edge of ${supply} > ${demand}`);
  return { supplyClause, demandClause, supplyAtom: sid, demandAtom: d.id };
}

/** Writes the answers of one round to the golden set. With `dryRun`, writes nothing. */
export function applyLinkRuleGolden(db: DatabaseSync, index: BuildIndex, round: number, sample: LinkRuleSample, opts: { dryRun?: boolean } = {}): LinkRuleGoldenApply {
  const out: LinkRuleGoldenApply = { added: [], waiting: [], existing: [], conflicts: [] };
  const answers = new Map((db.prepare("SELECT item_key, choice, note FROM owner_decisions WHERE kind = 'link_rule'").all() as Array<{ item_key: string; choice: string; note: string }>)
    .map((a) => [a.item_key, a]));
  const row = db.prepare('SELECT id, label, owner_note FROM edge_golden_pairs WHERE supply_oracle = ? AND demand_oracle = ?');
  const insert = db.prepare(`INSERT INTO edge_golden_pairs (supply_oracle, demand_oracle, stratum, round, label, supply_clause, demand_clause,
      supply_atom_id, demand_atom_id, cr_chain_json, votes, status, owner_note, oracle_hashes, created_at)
    VALUES (?, ?, 'correction', ?, ?, ?, ?, ?, ?, '[]', 0, 'owner_accepted', ?, ?, ?)`);
  const goldenRound = nextRound(db);
  const now = new Date().toISOString();
  for (const p of sample.pairs) {
    const a = answers.get(p.key);
    const label = a ? LABELS[a.choice] : undefined;
    const old = row.get(p.supply, p.demand) as { id: number; label: string; owner_note: string | null } | undefined;
    if (old) {
      (old.owner_note?.startsWith(LINK_RULE_NOTE) && old.label === label ? out.existing : out.conflicts).push(p.key);
      continue;
    }
    if (!a || !label) { out.waiting.push(p.key); continue; }
    const polar = label !== 'none' ? anchors(db, index, p.supply, p.demand) : null;
    const note = `${LINK_RULE_NOTE}${round} ${now.slice(0, 10)}: ${a.choice}${a.note ? ` (${a.note})` : ''}`;
    const id = opts.dryRun ? 0 : Number(insert.run(p.supply, p.demand, goldenRound, label,
      polar ? JSON.stringify(polar.supplyClause) : null, polar ? JSON.stringify(polar.demandClause) : null,
      polar?.supplyAtom ?? null, polar?.demandAtom ?? null, note, oracleHashes(db, p.supply, p.demand), now).lastInsertRowid);
    out.added.push({ id, key: p.key, label });
  }
  return out;
}

export interface RecheckApply { corrected: Array<{ id: number; label: string }>; accepted: number[]; unchanged: number[]; waiting: string[]; existing: number[]; conflicts: number[] }

/**
 * Writes the answers of round 6 (docs/schema-v20-results.md sec. 16) to their old golden pairs. With
 * `dryRun`, writes nothing. `applyLinkRuleGolden` only adds pairs, so it cannot do this. A pair keeps
 * its stratum, because the question is about the old label.
 * - A new label: the pair becomes `owner_corrected`, on the clauses and atoms of the `+` edge. The
 *   owner gives the label, so the CR chain is empty.
 * - The same label on a labeler pair: the pair becomes `owner_accepted`.
 * - The same label on an owner pair: no change.
 * - `unsure`, `other`: no change, until a later answer.
 */
export function applyRecheckGolden(db: DatabaseSync, index: BuildIndex, sample: LinkRuleSample, opts: { dryRun?: boolean } = {}): RecheckApply {
  const out: RecheckApply = { corrected: [], accepted: [], unchanged: [], waiting: [], existing: [], conflicts: [] };
  const answers = new Map((db.prepare("SELECT item_key, choice, note FROM owner_decisions WHERE kind = 'link_rule'").all() as Array<{ item_key: string; choice: string; note: string }>)
    .map((a) => [a.item_key, a]));
  const row = db.prepare('SELECT label, status, owner_note FROM edge_golden_pairs WHERE id = ?');
  const update = db.prepare(`UPDATE edge_golden_pairs SET status = 'owner_corrected', label = ?, supply_clause = ?, demand_clause = ?,
      supply_atom_id = ?, demand_atom_id = ?, cr_chain_json = '[]', owner_note = ? WHERE id = ?`);
  const when = new Date().toISOString().slice(0, 10);
  for (const p of sample.pairs) {
    const id = p.golden_pair!;
    const a = answers.get(p.key);
    const label = a ? LABELS[a.choice] : undefined;
    const old = row.get(id) as { label: string; status: string; owner_note: string | null };
    if (old.owner_note?.startsWith(RECHECK_NOTE)) { (old.label === label ? out.existing : out.conflicts).push(id); continue; }
    if (!a || !label) { out.waiting.push(p.key); continue; }
    const note = `${RECHECK_NOTE}6 ${when}: ${a.choice}${a.note ? ` (${a.note})` : ''}`;
    if (label === old.label) {
      if (old.status !== 'accepted') { out.unchanged.push(id); continue; }
      if (!opts.dryRun) ownerVerdict(db, id, { accept: true, note });
      out.accepted.push(id);
      continue;
    }
    const polar = label !== 'none' ? anchors(db, index, p.supply, p.demand) : null;
    if (!opts.dryRun) {
      update.run(label, polar ? JSON.stringify(polar.supplyClause) : null, polar ? JSON.stringify(polar.demandClause) : null,
        polar?.supplyAtom ?? null, polar?.demandAtom ?? null, note, id);
    }
    out.corrected.push({ id, label });
  }
  return out;
}
