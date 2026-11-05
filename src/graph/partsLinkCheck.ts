/**
 * The link check of the keyword parts (owner request 2026-10-24, step A of tag check round 2):
 * card pairs that a build on an experiment copy links only because of the part atoms that
 * `npm run tag-parts` added. The owner marks them on the "Your decisions" page, as `link_check`
 * items, to judge whether the parts help.
 *
 * A pair is new when the parts build links it (a typed + edge between two cards) and the base build
 * does not link it in either direction. The pair is put in the group of its part type; the sample
 * takes a quota of pairs from each group, round-robin over the keywords of the group, so that each
 * keyword shows. The sample is seeded. The code makes no decision on a pair; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { BuildIndex } from './buildIndex.js';
import { cardOf, edgeReasons, rng, type LinkCheckItem } from './linkCheck.js';
import { setRules } from './ruleSet.js';
import type { MergedEdge } from './merge.js';
import { loadTagDescriptions } from '../atoms/tagDescribe.js';

export interface PartsGroup { name: string; parts: string[]; keywords?: string[]; size: number }
export interface PartsLinkResult { new_pairs: number; by_group: Record<string, number>; by_keyword: Record<string, number>; items: LinkCheckItem[] }

/** The typed + edges between two different cards, by ordered pair `supply>demand`. */
function linkedPairs(index: BuildIndex): Map<string, MergedEdge[]> {
  const pairs = new Map<string, MergedEdge[]>();
  for (const card of index.cards()) {
    for (const e of index.edgesForCard(card).out) {
      if (e.polarity !== '+' || !e.supply_oracle || e.supply_oracle === e.demand_oracle) continue;
      const key = `${e.supply_oracle}>${e.demand_oracle}`;
      const list = pairs.get(key);
      if (list) list.push(e); else pairs.set(key, [e]);
    }
  }
  return pairs;
}

/**
 * Makes the sample. `firstPartAtom` is the first atom id that tag-parts added on the copy: every
 * atom with this id or a higher one is a part atom. Reads the database; writes nothing.
 */
export function makePartsLinkSample(db: DatabaseSync, opts: {
  partsBuild: number; baseBuild: number; firstPartAtom: number; groups: PartsGroup[]; seed?: number; round: number; keyPrefix: string;
}): PartsLinkResult {
  const d = loadTagDescriptions();
  if (!d) throw new Error('no config/tag-descriptions.json');
  const labels = new Map((db.prepare('SELECT family, type_key, label FROM atom_types WHERE schema_version = ?').all(d.schema_version) as Array<{ family: string; type_key: string; label: string }>)
    .map((r) => [`${r.family}.${r.type_key}`, r.label]));
  const build = db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(opts.partsBuild) as { rule_set_id: number } | undefined;
  if (!build) throw new Error(`no build ${opts.partsBuild}`);
  const rules = new Map(setRules(db, build.rule_set_id, 'all').map((r) => [r.rule_hash, r]));
  const base = linkedPairs(BuildIndex.load(db, opts.baseBuild));
  const parts = linkedPairs(BuildIndex.load(db, opts.partsBuild));

  const atom = db.prepare('SELECT oracle_id, face_index, family, type_key, span_start, span_end FROM atoms WHERE id = ?');
  const keywordAt = db.prepare(`SELECT family || '.' || type_key AS t FROM atoms WHERE id < ? AND is_current = 1 AND oracle_id = ? AND face_index = ?
    AND span_start = ? AND span_end = ?`);
  const withParts = new Map(Object.entries(d.types).filter(([, x]) => x.parts.length > 0));
  /** The part atom of a pair, with the keyword that it is a part of. */
  const partOf = (edges: MergedEdge[]): { part: string; keyword: string; when: string } | null => {
    for (const e of edges) {
      for (const id of e.atom_ids) {
        if (id < opts.firstPartAtom) continue;
        const a = atom.get(id) as { oracle_id: string; face_index: number; family: string; type_key: string; span_start: number; span_end: number };
        const part = `${a.family}.${a.type_key}`;
        for (const { t } of keywordAt.all(opts.firstPartAtom, a.oracle_id, a.face_index, a.span_start, a.span_end) as Array<{ t: string }>) {
          const p = withParts.get(t)?.parts.find((x) => x.type === part);
          if (p) return { part, keyword: t, when: p.when };
        }
      }
    }
    return null;
  };

  // The new pairs, by group and keyword.
  const pools = new Map<string, Map<string, Array<{ key: string; part: string; keyword: string; when: string }>>>();
  const byGroup: Record<string, number> = {};
  const byKeyword: Record<string, number> = {};
  let fresh = 0;
  for (const [key, edges] of [...parts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [s, dm] = key.split('>') as [string, string];
    if (base.has(key) || base.has(`${dm}>${s}`)) continue;
    const p = partOf(edges);
    if (!p) continue;
    fresh++;
    byKeyword[p.keyword] = (byKeyword[p.keyword] ?? 0) + 1;
    const g = opts.groups.find((x) => x.parts.includes(p.part) && (!x.keywords || x.keywords.includes(p.keyword)));
    if (!g) continue;
    byGroup[g.name] = (byGroup[g.name] ?? 0) + 1;
    const byKw = pools.get(g.name) ?? pools.set(g.name, new Map()).get(g.name)!;
    (byKw.get(p.keyword) ?? byKw.set(p.keyword, []).get(p.keyword)!).push({ key, ...p });
  }

  // Round-robin over the keywords of each group; no card in two items.
  const rand = rng(opts.seed ?? 20261024);
  const usedCards = new Set<string>();
  const items: LinkCheckItem[] = [];
  for (const g of opts.groups) {
    type Pick = { key: string; part: string; keyword: string; when: string };
    const kws = [...(pools.get(g.name) ?? new Map<string, Pick[]>()).entries()].sort((a, b) => b[1].length - a[1].length);
    let taken = 0;
    for (let pass = 0; taken < g.size && pass < 50; pass++) {
      for (const [, list] of kws) {
        if (taken >= g.size) break;
        const free = list.filter((x) => !x.key.split('>').some((c) => usedCards.has(c)));
        if (!free.length) continue;
        const pick = free[Math.floor(rand() * free.length)]!;
        for (const c of pick.key.split('>')) usedCards.add(c);
        const [s, dm] = pick.key.split('>') as [string, string];
        const edges = [...parts.get(pick.key)!].sort((a, b) => b.weight.total - a.weight.total).slice(0, 3);
        items.push({
          key: `${opts.keyPrefix}:${pick.key}`, stratum: 'keyword_part', round: opts.round,
          part: { group: g.name, keyword: pick.keyword, keyword_label: labels.get(pick.keyword) ?? pick.keyword, part: pick.part, part_label: labels.get(pick.part) ?? pick.part, when: pick.when },
          supply: cardOf(db, s), demand: cardOf(db, dm), reasons: edgeReasons(db, edges, rules),
        });
        taken++;
      }
    }
  }
  return { new_pairs: fresh, by_group: byGroup, by_keyword: byKeyword, items };
}
