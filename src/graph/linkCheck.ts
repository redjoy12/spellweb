/**
 * The link check (spec rev. 17 sec. 5.9, owner request 2026-10-18): 20 real linked card pairs of
 * one build, for the owner to mark on the "Your decisions" page. The marks show whether the
 * written link test gives the owner answers. They are owner labels; they change nothing else.
 *
 * The sample is mechanical and seeded, so it is the same each time:
 * - `wide`: one pair for each of the 10 build rules that link the most card pairs,
 * - `random`: 10 card pairs drawn uniformly from all linked card pairs.
 * Only typed `+` edges between two different cards count (no class edges, no self pairs).
 * The code makes no decision on a pair; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { BuildIndex } from './buildIndex.js';
import { isIntrinsic } from './ruleSchema.js';
import { setRules, type StoredRule } from './ruleSet.js';
import type { MergedEdge } from './merge.js';

export const LINK_CHECK_PATH = 'docs/link-check/sample.json';
export const LINK_CHECK_CHOICES = ['link', 'weak_link', 'no_link', 'unsure'] as const;

export interface LinkCheckCard { oracle_id: string; name: string; mana_cost: string | null; type_line: string; oracle_text: string; image: string | null }
export interface LinkCheckReason {
  supply_quote: string; demand_quote: string; grade: string;
  rules: Array<{ rule_id: string; supply: string; demand: string; evidence: Array<{ ref: string; quote: string }> }>;
}
export interface LinkCheckItem {
  /** keyword_part: a pair that only the keyword parts link, on an experiment copy (src/graph/partsLinkCheck.ts). */
  key: string; stratum: 'wide' | 'random' | 'keyword_part';
  /** The check round (1 = the first 20 pairs). A later round confirms tests corrected on an earlier one. */
  round?: number;
  /** For `wide`: the rule that chose the pair, and the count of card pairs it links. */
  chosen_by?: { rule_id: string; card_pairs: number };
  /** For `keyword_part`: the keyword, and the part of it that gives the link. */
  part?: { group: string; keyword: string; keyword_label: string; part: string; part_label: string; when: string };
  supply: LinkCheckCard; demand: LinkCheckCard;
  reasons: LinkCheckReason[];
}
export interface LinkCheckSample { build: number; rule_set: number; seed: number; made_at: string; linked_pairs: number; items: LinkCheckItem[] }

/** mulberry32: a small seeded generator, so the sample is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sideName = (s: StoredRule['supply'] | StoredRule['demand']) =>
  isIntrinsic(s) ? `${s.intrinsic}=${String(s.value)}` : `${s.family}.${s.type_key}`;

export function cardOf(db: DatabaseSync, oracleId: string): LinkCheckCard {
  const c = db.prepare('SELECT name, mana_cost, type_line, image_normal FROM cards WHERE oracle_id = ?').get(oracleId) as
    { name: string; mana_cost: string | null; type_line: string; image_normal: string | null };
  const faces = db.prepare('SELECT oracle_text, image_normal FROM card_faces WHERE oracle_id = ? ORDER BY face_index').all(oracleId) as
    Array<{ oracle_text: string; image_normal: string | null }>;
  return {
    oracle_id: oracleId, name: c.name, mana_cost: c.mana_cost, type_line: c.type_line,
    oracle_text: faces.map((f) => f.oracle_text).join('\n//\n'),
    image: c.image_normal ?? faces[0]?.image_normal ?? null,
  };
}

/** Makes the sample of one build. Reads the build; writes nothing. */
export function makeLinkCheckSample(db: DatabaseSync, buildId: number, opts: { seed?: number; wide?: number; random?: number; exclude?: ReadonlySet<string>; round?: number } = {}): LinkCheckSample {
  const seed = opts.seed ?? 20261018;
  const nWide = opts.wide ?? 10;
  const nRandom = opts.random ?? 10;
  const build = db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(buildId) as { rule_set_id: number } | undefined;
  if (!build) throw new Error(`no build ${buildId}`);
  const index = BuildIndex.load(db, buildId);
  const rules = new Map(setRules(db, build.rule_set_id, 'all').map((r) => [r.rule_hash, r]));

  // The typed + edges of each ordered card pair, and the card pairs of each rule.
  const pairs = new Map<string, MergedEdge[]>();
  const pairsOfRule = new Map<string, string[]>();
  for (const card of index.cards()) {
    for (const e of index.edgesForCard(card).out) {
      if (!e.supply_oracle || e.supply_oracle === e.demand_oracle) continue;
      const key = `${e.supply_oracle}>${e.demand_oracle}`;
      let list = pairs.get(key);
      if (!list) { list = []; pairs.set(key, list); }
      list.push(e);
    }
  }
  for (const [key, edges] of pairs) {
    for (const h of new Set(edges.flatMap((e) => e.rule_hashes))) {
      let l = pairsOfRule.get(h);
      if (!l) { l = []; pairsOfRule.set(h, l); }
      l.push(key);
    }
  }

  const rand = rng(seed);
  const used = new Set<string>(opts.exclude ?? []);
  const usedCards = new Set<string>([...(opts.exclude ?? [])].flatMap((k) => k.split('>')));
  const free = (key: string) => {
    const [s, d] = key.split('>');
    return !used.has(key) && !usedCards.has(s!) && !usedCards.has(d!);
  };
  const take = (key: string) => { used.add(key); for (const c of key.split('>')) usedCards.add(c); };
  const chosen: Array<{ key: string; stratum: 'wide' | 'random'; chosen_by?: LinkCheckItem['chosen_by'] }> = [];

  const wide = [...pairsOfRule.entries()].sort((a, b) => b[1].length - a[1].length || (rules.get(a[0])!.rule_id < rules.get(b[0])!.rule_id ? -1 : 1));
  for (const [hash, keys] of wide) {
    if (chosen.length >= nWide) break;
    const cand = keys.filter(free);
    if (!cand.length) continue;
    const key = cand[Math.floor(rand() * cand.length)]!;
    take(key);
    chosen.push({ key, stratum: 'wide', chosen_by: { rule_id: rules.get(hash)!.rule_id, card_pairs: keys.length } });
  }
  const all = [...pairs.keys()].sort();
  for (let tries = 0; chosen.length < nWide + nRandom && tries < 10_000; tries++) {
    const key = all[Math.floor(rand() * all.length)]!;
    if (!free(key)) continue;
    take(key);
    chosen.push({ key, stratum: 'random' });
  }

  const items: LinkCheckItem[] = chosen.map(({ key, stratum, chosen_by }) => {
    const [s, d] = key.split('>') as [string, string];
    const edges = [...pairs.get(key)!].sort((a, b) => b.weight.total - a.weight.total).slice(0, 3);
    return {
      key: `b${buildId}:${key}`, stratum, round: opts.round ?? 1, ...(chosen_by ? { chosen_by } : {}),
      supply: cardOf(db, s), demand: cardOf(db, d),
      reasons: edgeReasons(db, edges, rules),
    };
  });
  return { build: buildId, rule_set: build.rule_set_id, seed, made_at: new Date().toISOString(), linked_pairs: pairs.size, items };
}

/** The edges of a card pair as reasons: the two quotes, the grade and the rules with their evidence. */
export function edgeReasons(db: DatabaseSync, edges: readonly MergedEdge[], rules: ReadonlyMap<string, StoredRule>): LinkCheckReason[] {
  const quote = db.prepare('SELECT quote FROM atoms WHERE id = ?');
  const q = (id: number) => (quote.get(id) as { quote: string } | undefined)?.quote ?? '';
  return edges.map((e) => {
    const supplyIds = [...e.atom_ids];
    supplyIds.splice(supplyIds.indexOf(e.demand_atom_id), 1);
    return {
      supply_quote: [...new Set(supplyIds.map(q))].join(' / '), demand_quote: q(e.demand_atom_id), grade: e.grade,
      rules: e.rule_hashes.map((h) => rules.get(h)!).map((r) => ({
        rule_id: r.rule_id, supply: sideName(r.supply), demand: sideName(r.demand),
        evidence: r.evidence.map((x) => ({ ref: x.ref, quote: x.quote })),
      })),
    };
  });
}

export function loadLinkCheckSample(path: string = LINK_CHECK_PATH): LinkCheckSample | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as LinkCheckSample : null;
}
