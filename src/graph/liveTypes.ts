/**
 * The Stage B scope (Phase 3 spec rev. 10 sec. 5.3).
 *
 * A rule for a type that no card has can never make an edge. With `stage_b_scope: 'live'`,
 * Stage B derives and debates only the live types:
 * - a type that a current atom has (any schema version: a card that the current schema has not
 *   extracted again keeps the atoms of its last run), or
 * - a type that no earlier schema version had, so that no extraction can show it yet.
 * The other types are deferred, not removed. When a card gets an atom of a deferred type, the
 * next prepare gives it a batch (a new demand type) or a supplementary batch (a new supply type),
 * and its disputed rules join the next debate round.
 * The code makes no model call and knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { typeEntries } from './crContent.js';
import type { PacketContext } from './edgePackets.js';
import { demandTypes, supplyTypes } from './ruleSet.js';

const idOf = (e: { family: string; type_key: string }) => `${e.family}.${e.type_key}`;

export function liveTypes(db: DatabaseSync, schemaVersion: number): Set<string> {
  const has = new Set((db.prepare("SELECT DISTINCT family || '.' || type_key t FROM atoms WHERE is_current = 1").all() as Array<{ t: string }>).map((r) => r.t));
  const older = new Set((db.prepare("SELECT DISTINCT family || '.' || type_key t FROM atom_types WHERE schema_version < ?").all(schemaVersion) as Array<{ t: string }>).map((r) => r.t));
  return new Set(typeEntries(db, schemaVersion).map(idOf).filter((t) => has.has(t) || !older.has(t)));
}

/** The demand and supply types of a set inside the Stage B scope, and the deferred ones. */
export function stageBTypes(
  db: DatabaseSync, setId: number, ctx: PacketContext,
): { supply: string[]; demand: string[]; deferred: string[] } {
  const supply = supplyTypes(db, setId);
  const demand = demandTypes(db, setId);
  if (ctx.graph.stage_b_scope === 'all') return { supply, demand, deferred: [] };
  const live = liveTypes(db, ctx.schemaVersion);
  const deferred = [...new Set([...supply, ...demand])].filter((t) => !live.has(t)).sort();
  return { supply: supply.filter((t) => live.has(t)), demand: demand.filter((t) => live.has(t)), deferred };
}
