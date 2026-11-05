import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { ScryfallCard } from '../scryfall/types.js';
import { isPoolLegal, pickPreferredPrinting } from '../scryfall/filter.js';
import { toCardRecord, type CardRecord } from '../scryfall/normalize.js';

/**
 * Streams the gzipped JSONL bulk file, keeps only pool-legal printings, and
 * yields one CardRecord per oracle_id using the deterministic printing preference.
 *
 * Memory note: only the surviving printings are held (a few thousand), never the
 * whole 558 MB file.
 */
export async function* streamPoolCards(gzPath: string): AsyncGenerator<CardRecord> {
  const byOracle = new Map<string, ScryfallCard[]>();

  const rs = createReadStream(gzPath);
  const gz = createGunzip();
  rs.on('error', (e) => gz.destroy(e));
  const rl = createInterface({ input: rs.pipe(gz), crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed || trimmed === '[' || trimmed === ']') continue;
    let card: ScryfallCard;
    try {
      card = JSON.parse(trimmed) as ScryfallCard;
    } catch {
      continue; // a malformed row must not abort a 6,760-record ingest
    }
    if (!isPoolLegal(card)) continue;
    const list = byOracle.get(card.oracle_id!);
    if (list) list.push(card);
    else byOracle.set(card.oracle_id!, [card]);
  }

  for (const printings of byOracle.values()) {
    yield toCardRecord(pickPreferredPrinting(printings));
  }
}

/** Counts every JSONL row so `printings_seen` reflects the real file size. */
async function countRows(gzPath: string): Promise<number> {
  const rs = createReadStream(gzPath);
  const gz = createGunzip();
  rs.on('error', (e) => gz.destroy(e));
  const rl = createInterface({ input: rs.pipe(gz), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    const t = line.trim();
    if (t && t !== '[' && t !== ']') n++;
  }
  return n;
}

export interface IngestOptions {
  gzPath: string;
  sourceType: string;
  sourceUri: string;
  sourceUpdatedAt: string;
}

export async function ingestSnapshot(
  db: DatabaseSync,
  opts: IngestOptions,
): Promise<{ snapshotId: number; printingsSeen: number; cardsKept: number }> {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status)
     VALUES (?, ?, ?, ?, 'in_progress')`,
  ).run(opts.sourceType, opts.sourceUri, opts.sourceUpdatedAt, now);
  const { id: snapshotId } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

  const insert = db.prepare(
    `INSERT INTO snapshot_cards (
       snapshot_id, oracle_id, name, layout, mana_cost, cmc, type_line, oracle_text,
       colors, color_identity, keywords, power, toughness, rarity, arena_id,
       set_code, collector_number, image_normal, image_art_crop, faces_json, oracle_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  let cardsKept = 0;
  try {
    db.exec('BEGIN');
    for await (const c of streamPoolCards(opts.gzPath)) {
      insert.run(
        snapshotId, c.oracle_id, c.name, c.layout, c.mana_cost, c.cmc, c.type_line, c.oracle_text,
        JSON.stringify(c.colors), JSON.stringify(c.color_identity), JSON.stringify(c.keywords),
        c.power, c.toughness, c.rarity, c.arena_id, c.set_code, c.collector_number,
        c.image_normal, c.image_art_crop, JSON.stringify(c.faces), c.oracle_hash,
      );
      cardsKept++;
    }
    if (cardsKept === 0) throw new Error(`kept 0 cards from ${opts.gzPath} — upstream format change?`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE snapshots SET status = 'failed' WHERE id = ?").run(snapshotId);
    throw err;
  }

  try {
    const printingsSeen = await countRows(opts.gzPath);
    db.prepare(
      "UPDATE snapshots SET status = 'complete', printings_seen = ?, cards_kept = ? WHERE id = ?",
    ).run(printingsSeen, cardsKept, snapshotId);

    return { snapshotId, printingsSeen, cardsKept };
  } catch (err) {
    db.prepare("UPDATE snapshots SET status = 'failed' WHERE id = ?").run(snapshotId);
    throw err;
  }
}
