import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchBulkCatalog, selectBulkEntry, ensureBulkFile } from '../src/scryfall/bulk.js';

const CATALOG = {
  object: 'list',
  data: [
    { object: 'bulk_data', type: 'oracle_cards', updated_at: '2026-07-24T09:04:08.721+00:00',
      download_uri: 'https://data.scryfall.io/oracle-cards/x.json',
      jsonl_download_uri: 'https://data.scryfall.io/oracle-cards/x.jsonl.gz', size: 179921900 },
    { object: 'bulk_data', type: 'default_cards', updated_at: '2026-07-24T09:10:04.747+00:00',
      download_uri: 'https://data.scryfall.io/default-cards/y.json',
      jsonl_download_uri: 'https://data.scryfall.io/default-cards/y.jsonl.gz', size: 557959033 },
  ],
};

describe('bulk', () => {
  it('selects the default_cards entry', async () => {
    const fake = (async () => new Response(JSON.stringify(CATALOG), { status: 200 })) as any;
    const entries = await fetchBulkCatalog(fake);
    const e = selectBulkEntry(entries, 'default_cards');
    expect(e.updated_at).toBe('2026-07-24T09:10:04.747+00:00');
    expect(e.jsonl_download_uri).toMatch(/default-cards/);
  });

  it('throws a named error when the requested type is absent', async () => {
    expect(() => selectBulkEntry([], 'default_cards')).toThrow(/default_cards/);
  });

  it('downloads once and reuses the cache when updated_at is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bulk-'));
    const entry = CATALOG.data[1] as any;
    let calls = 0;
    const fake = (async () => { calls++; return new Response('{"a":1}\n', { status: 200 }); }) as any;

    const p1 = await ensureBulkFile(entry, dir, fake);
    const p2 = await ensureBulkFile(entry, dir, fake);
    expect(p1).toBe(p2);
    expect(existsSync(p1)).toBe(true);
    expect(calls).toBe(1);

    const bumped = { ...entry, updated_at: '2026-07-25T00:00:00.000+00:00' };
    await ensureBulkFile(bumped, dir, fake);
    expect(calls).toBe(2);
  });
});
