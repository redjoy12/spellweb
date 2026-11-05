import { openDb } from '../db/client.js';
import { fetchBulkCatalog, selectBulkEntry, ensureBulkFile } from '../scryfall/bulk.js';
import { ingestSnapshot } from '../pool/ingest.js';
import { diffSnapshots, applyDiff } from '../pool/diff.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/cache');

try {
  const db = openDb();

  const previous = db
    .prepare("SELECT id FROM snapshots WHERE status = 'complete' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;

  console.log('Resolving Scryfall bulk catalog…');
  const entry = selectBulkEntry(await fetchBulkCatalog(), 'default_cards');
  const mb = (n: number) => (n / 1e6).toFixed(0);
  const size = entry.compressed_size !== undefined ? `${mb(entry.compressed_size)} MB download`
    : entry.size !== undefined ? `${mb(entry.size)} MB uncompressed` : 'size unknown';
  console.log(`  default_cards updated ${entry.updated_at} (${size})`);

  console.log('Ensuring local bulk file…');
  const gzPath = await ensureBulkFile(entry, CACHE_DIR);

  console.log('Ingesting snapshot…');
  const { snapshotId, printingsSeen, cardsKept } = await ingestSnapshot(db, {
    gzPath,
    sourceType: entry.type,
    sourceUri: entry.jsonl_download_uri,
    sourceUpdatedAt: entry.updated_at,
  });
  console.log(`  snapshot ${snapshotId}: ${printingsSeen} printings seen, ${cardsKept} pool cards kept`);

  const entries = diffSnapshots(db, previous?.id ?? null, snapshotId);
  const diffId = applyDiff(db, { fromSnapshotId: previous?.id ?? null, toSnapshotId: snapshotId, entries });

  const summary = db.prepare('SELECT * FROM pool_diffs WHERE id = ?').get(diffId) as any;
  console.log(
    `  diff ${diffId}: +${summary.added_count} added, ~${summary.changed_count} errata, ` +
    `-${summary.rotated_count} rotated, ↩${summary.returned_count} returned`,
  );
  console.log(`  extraction queue: ${(db.prepare("SELECT COUNT(*) AS n FROM extraction_queue WHERE status='pending'").get() as any).n} pending`);
} catch (err) {
  console.error('sync:cards failed:', err);
  process.exitCode = 1;
}
