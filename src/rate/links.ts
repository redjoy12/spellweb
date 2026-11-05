/**
 * The links of each card of a build, for the link check of a proof (card rate plan sec. 2.2, Q1). A
 * build stores no links, so this file is the one caller of `BuildIndex` in `src/rate`. It first
 * compares the links of each card with the stored `card_degree` rows of the build. It stops when a
 * row differs, because the code then no longer gives the links of that build. Read only.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex } from '../graph/buildIndex.js';
import type { LinkFacts, LinkSource } from './proof.js';

export interface StoredDegree { oracle_id: string; out_degree: number; in_degree: number; class_edges: number; anti_degree: number }
export type LinkIndex = Pick<BuildIndex, 'cards' | 'edgesForCard' | 'classes'>;

/** `cards`: the count of cards that agree with `card_degree`. */
export function linkSource(index: LinkIndex, stored: readonly StoredDegree[], buildId: number): { links: LinkSource; cards: number } {
  const degrees = new Map(stored.map((r) => [r.oracle_id, r]));
  const facts = new Map<string, LinkFacts & { class_of: Set<string> }>();
  const used = new Set<string>();
  let differ = 0;
  for (const id of index.cards()) {
    const e = index.edgesForCard(id);
    const anti = new Set(e.anti.flatMap((x) => (x.supply_oracle === null ? [] : [x.supply_oracle === id ? x.demand_oracle : x.supply_oracle])));
    const f = {
      out: new Set(e.out.map((x) => x.demand_oracle)), in: new Set(e.in.flatMap((x) => (x.supply_oracle === null ? [] : [x.supply_oracle]))), anti,
      class_in: new Set(e.classes.flatMap((x) => (x.class_id === null ? [] : [x.class_id]))), class_of: new Set<string>(),
    };
    for (const c of f.class_in) used.add(c);
    facts.set(id, f);
    const s = degrees.get(id);
    if (!s || s.out_degree !== f.out.size || s.in_degree !== f.in.size || s.class_edges !== e.classes.length || s.anti_degree !== anti.size) differ++;
  }
  if (differ > 0) throw new Error(`stop: the links of ${differ} of ${facts.size} cards differ from card_degree of build ${buildId}, so the code no longer gives the links of this build`);
  for (const c of used) for (const m of index.classes.get(c)?.members ?? []) facts.get(m)?.class_of.add(c);
  return {
    cards: facts.size,
    links: (id) => {
      const f = facts.get(id);
      if (!f) throw new Error(`card ${id} has no links in build ${buildId}`);
      return f;
    },
  };
}

export function readLinks(db: DatabaseSync, buildId: number): { links: LinkSource; cards: number } {
  const stored = db.prepare('SELECT oracle_id, out_degree, in_degree, class_edges, anti_degree FROM card_degree WHERE build_id = ?').all(buildId) as unknown as StoredDegree[];
  return linkSource(BuildIndex.load(db, buildId), stored, buildId);
}
