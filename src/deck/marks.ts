/**
 * The owner marks on the links of a deck (Phase 4 design sec. 9). The stored deck does not change:
 * `withMarks` adds the marks of this moment to a view, so a mark stays after a reload and shows on
 * each deck that has the link.
 *
 * A false mark is a row of `edge_reports`, by edge key. A weak mark is an owner answer "Yes, but
 * weak", so the next deck reads it through `weakPairKeys`. Its key `dk:supply>demand` belongs to no
 * round of the "Your decisions" page, so no tally counts it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { clearDecision } from '../graph/ownerDecisions.js';
import { weakPairKeys } from './deck.js';
import { activeOwnerLinks } from './linkChanges.js';
import type { DeckView, LinkView } from './justify.js';

const weakMarkKey = (supply: string, demand: string) => `dk:${supply}>${demand}`;

/** Records (or replaces) a weak mark on one direction of a pair. */
export function saveWeakMark(db: DatabaseSync, supply: string, demand: string, note: string): void {
  db.prepare("INSERT OR REPLACE INTO owner_decisions (kind, item_key, choice, note, decided_at) VALUES ('link_rule', ?, 'weak_link', ?, ?)")
    .run(weakMarkKey(supply, demand), note, new Date().toISOString());
}

/** Removes a weak mark of the deck page. An answer on the "Your decisions" page stays. */
export function clearWeakMark(db: DatabaseSync, supply: string, demand: string): boolean {
  return clearDecision(db, 'link_rule', weakMarkKey(supply, demand));
}

/** The view with the marks of this moment. A rejected report is no mark. */
export function withMarks(db: DatabaseSync, view: DeckView): DeckView {
  const weak = weakPairKeys(db);
  const own = new Set((db.prepare("SELECT item_key FROM owner_decisions WHERE kind = 'link_rule' AND item_key LIKE 'dk:%' AND choice = 'weak_link'")
    .all() as Array<{ item_key: string }>).map((r) => r.item_key));
  const keys = view.cards.flatMap((c) => c.links.map((l) => l.edge_key));
  // In ID order, so the newest report of an edge decides.
  const reports = new Map((db.prepare(
    `SELECT r.edge_key, r.id, r.note FROM edge_reports r WHERE r.status <> 'rejected' AND r.edge_key IN (SELECT value FROM json_each(?)) ORDER BY r.id`,
  ).all(JSON.stringify(keys)) as Array<{ edge_key: string; id: number; note: string }>).map((r) => [r.edge_key, { id: r.id, note: r.note }]));
  // Link review design sec. 8: a stored deck keeps an owner link after its removal, so the mark says so.
  const activeOwner = new Set(activeOwnerLinks(db).map((o) => o.id));
  const marked = (id: string, l: LinkView): LinkView => {
    const [supply, demand] = l.direction === 'gives' ? [id, l.other] : [l.other, id];
    const { weak: _stored, owner_removed: _removed, ...link } = l;
    const report = reports.get(l.edge_key);
    return {
      ...link,
      ...(weak.has(`${supply}>${demand}`) ? { weak: true as const } : {}),
      ...(own.has(weakMarkKey(supply, demand)) ? { weak_mark: true as const } : {}),
      ...(report ? { report } : {}),
      ...(l.owner_link !== undefined && !activeOwner.has(l.owner_link) ? { owner_removed: true as const } : {}),
    };
  };
  return { ...view, cards: view.cards.map((c) => ({ ...c, links: c.links.map((l) => marked(c.oracle_id, l)) })) };
}
