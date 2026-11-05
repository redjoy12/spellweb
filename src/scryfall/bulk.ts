import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const USER_AGENT = 'MTGADeckBuilder/0.1 (local research tool)';
const CATALOG_URL = 'https://api.scryfall.com/bulk-data';

export interface BulkEntry {
  type: string;
  updated_at: string;
  download_uri: string;
  jsonl_download_uri: string;
  /** Scryfall stopped sending `size` (2026-11); `compressed_size` is the download size. */
  size?: number;
  compressed_size?: number;
}

const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

export async function fetchBulkCatalog(fetchImpl: typeof fetch = fetch): Promise<BulkEntry[]> {
  const res = await fetchImpl(CATALOG_URL, { headers });
  if (!res.ok) throw new Error(`Scryfall bulk catalog returned HTTP ${res.status}`);
  const body = (await res.json()) as { data: BulkEntry[] };
  return body.data;
}

export function selectBulkEntry(entries: BulkEntry[], type: string): BulkEntry {
  const found = entries.find((e) => e.type === type);
  if (!found) throw new Error(`Scryfall bulk catalog has no entry of type "${type}"`);
  return found;
}

/**
 * Ensures the gzipped JSONL bulk file is on disk. Re-downloads only when the
 * catalog's updated_at differs from the cached sidecar, so repeated syncs are free.
 */
export async function ensureBulkFile(
  entry: BulkEntry,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${entry.type}.jsonl.gz`);
  const stamp = join(cacheDir, `${entry.type}.updated_at`);

  if (existsSync(file) && existsSync(stamp) && readFileSync(stamp, 'utf8') === entry.updated_at) {
    return file;
  }

  const res = await fetchImpl(entry.jsonl_download_uri, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-ndjson' },
  });
  if (!res.ok) throw new Error(`Scryfall bulk download returned HTTP ${res.status}`);
  if (!res.body) throw new Error('Scryfall bulk download returned an empty body');

  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
  writeFileSync(stamp, entry.updated_at, 'utf8');
  return file;
}
