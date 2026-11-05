/**
 * `npm run batch:select` (plan Task 11): the stratified bounded batch. Parent spec sec. 12's cost
 * control - prove extraction quality on ~400 cards before committing to the whole pool.
 *
 *   npm run batch:select -- [--size 400] [--seed 1] [--ids]
 *
 * Prints the selection's shape (and with --ids, the oracle ids). `npm run extract -- --prepare
 * --batch stratified [--sample 400] [--seed 1]` prepares the same selection for extraction.
 *
 * Selection is two-stage, and every stratum is read from the live pool, never from config:
 *   1. Forced picks, the edge cases a proportional sample would miss:
 *      - min(count, LAYOUT_FLOOR) cards of every non-normal layout, so a layout at or under the
 *        floor (meld today) comes in whole;
 *      - min(count, LAYOUT_FLOOR) cards with an empty-text face (zero clauses, coverage 1.0);
 *      - the LONGEST longest cards by total oracle text and by single-face oracle text.
 *   2. A systematic sample of the rest, ordered layout > rarity > type line > length decile >
 *      colour identity, so every one of those strata gets its proportional share.
 * Ties and the sample's start are drawn from a hash of (seed, oracle_id), so a seed always
 * reproduces its batch and a rerun is comparable against the previous one.
 *
 * Atom families are not a selection stratum: unextracted cards have no atoms, and a hand-written
 * text -> family mapping would be Magic knowledge in code (I1). Family coverage is measured on the
 * extracted batch instead (ruling R11-3). Rotated cards are not in the pool the builder uses and
 * are never selected (R11-4).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/client.js';
import { draw } from '../util/draw.js';

export interface BatchSpec { size: number; seed: number }

/** The per-layout (and empty-face) floor of forced picks. */
export const LAYOUT_FLOOR = 3;
/** How many of the longest cards, by each length measure, are always selected. */
export const LONGEST = 5;

interface PoolCard {
  oracle_id: string; layout: string; rarity: string; color_identity: string; type_line: string;
  total_len: number; max_face_len: number; has_empty_face: number;
}

/** The front face's type line up to its subtypes: "Legendary Creature — Elf" -> "Legendary Creature". */
function typeHead(typeLine: string): string {
  return (typeLine.split(' // ')[0] ?? '').split(' — ')[0]!.trim();
}

export function loadPool(db: DatabaseSync): PoolCard[] {
  return db.prepare(
    `SELECT c.oracle_id, c.layout, c.rarity, COALESCE(c.color_identity, '') AS color_identity,
            COALESCE(c.type_line, '') AS type_line,
            SUM(LENGTH(COALESCE(f.oracle_text, ''))) AS total_len,
            MAX(LENGTH(COALESCE(f.oracle_text, ''))) AS max_face_len,
            MAX(COALESCE(f.oracle_text, '') = '') AS has_empty_face
       FROM cards c JOIN card_faces f USING (oracle_id)
      WHERE c.rotated = 0
      GROUP BY c.oracle_id
      ORDER BY c.oracle_id`,
  ).all() as unknown as PoolCard[];
}

export function selectStratifiedBatch(db: DatabaseSync, spec: BatchSpec): string[] {
  const { size, seed } = spec;
  const pool = loadPool(db);
  if (!Number.isInteger(size) || size < 1) throw new Error(`batch size must be a positive integer, got ${size}`);
  if (size > pool.length) throw new Error(`batch size ${size} exceeds the live pool of ${pool.length} cards`);

  const rank = new Map(pool.map((c) => [c.oracle_id, draw(seed, c.oracle_id)]));
  const byRank = (a: PoolCard, b: PoolCard) => rank.get(a.oracle_id)! - rank.get(b.oracle_id)!;
  const forced = new Set<string>();
  const takeFloor = (cards: PoolCard[]) => {
    for (const c of [...cards].sort(byRank).slice(0, LAYOUT_FLOOR)) forced.add(c.oracle_id);
  };

  // 1. Forced picks.
  const layouts = [...new Set(pool.map((c) => c.layout))].filter((l) => l !== 'normal').sort();
  for (const l of layouts) takeFloor(pool.filter((c) => c.layout === l));
  takeFloor(pool.filter((c) => c.has_empty_face));
  for (const measure of ['total_len', 'max_face_len'] as const) {
    const longest = [...pool].sort((a, b) => b[measure] - a[measure] || a.oracle_id.localeCompare(b.oracle_id));
    for (const c of longest.slice(0, LONGEST)) forced.add(c.oracle_id);
  }
  if (forced.size > size) {
    throw new Error(`batch size ${size} is smaller than the ${forced.size} forced edge-case picks`);
  }

  // 2. Systematic sample of the rest over the stratified ordering.
  const lens = pool.map((c) => c.total_len).sort((a, b) => a - b);
  const decile = (len: number) => {
    let lo = 0;
    let hi = lens.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lens[mid]! < len) lo = mid + 1; else hi = mid; }
    return Math.min(9, Math.floor((lo * 10) / lens.length));
  };
  const rest = pool.filter((c) => !forced.has(c.oracle_id)).map((c) => ({
    c, key: [c.layout, c.rarity, typeHead(c.type_line), String(decile(c.total_len)).padStart(2, '0'), c.color_identity],
  }));
  rest.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const d = a.key[i]!.localeCompare(b.key[i]!);
      if (d !== 0) return d;
    }
    return byRank(a.c, b.c);
  });
  const k = size - forced.size;
  const step = rest.length / k;
  const start = draw(seed, 'start') * step;
  const picked = [...forced];
  for (let i = 0; i < k; i++) picked.push(rest[Math.floor(start + i * step)]!.c.oracle_id);
  return picked.sort();
}

// The colour slice lives in src/pool/slice.ts, so library code (Phase 3 scopes) need not import a CLI.
export { selectColourSlice } from '../pool/slice.js';

// ---- CLI -------------------------------------------------------------------------------------

function main(argv: string[]): void {
  const spec: BatchSpec = { size: 400, seed: 1 };
  let ids = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--size') spec.size = Number(argv[++i]);
    else if (a === '--seed') spec.seed = Number(argv[++i]);
    else if (a === '--ids') ids = true;
    else { console.error(`batch:select: unknown argument ${a}`); process.exit(1); }
  }
  const db = openDb();
  const batch = selectStratifiedBatch(db, spec);
  const pool = loadPool(db);
  const inBatch = new Set(batch);
  const golden = new Set((db.prepare('SELECT oracle_id FROM golden_cards').all() as Array<{ oracle_id: string }>)
    .map((r) => r.oracle_id));
  const tally = (key: (c: PoolCard) => string) => {
    const t = new Map<string, [number, number]>();
    for (const c of pool) {
      const e = t.get(key(c)) ?? [0, 0];
      e[0]++;
      if (inBatch.has(c.oracle_id)) e[1]++;
      t.set(key(c), e);
    }
    return [...t].sort((a, b) => b[1][0] - a[1][0]).map(([k, [n, got]]) => `${k} ${got}/${n}`).join(', ');
  };
  console.log(`stratified batch: ${batch.length} of ${pool.length} live cards, seed ${spec.seed}`);
  console.log(`  layout:  ${tally((c) => c.layout)}`);
  console.log(`  rarity:  ${tally((c) => c.rarity)}`);
  console.log(`  type:    ${tally((c) => typeHead(c.type_line))}`);
  console.log(`  colours: ${tally((c) => c.color_identity || 'C')}`);
  console.log(`  golden-set overlap: ${batch.filter((id) => golden.has(id)).length}`);
  if (ids) for (const id of batch) console.log(id);
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
