import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { streamPoolCards, ingestSnapshot } from '../src/pool/ingest.js';

function writeGz(cards: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ing-'));
  const p = join(dir, 'cards.jsonl.gz');
  writeFileSync(p, gzipSync(cards.map((c) => JSON.stringify(c)).join('\n') + '\n'));
  return p;
}

const printing = (over: Record<string, unknown>) => ({
  object: 'card', id: String(over.id ?? 'x'), oracle_id: 'o1', name: 'Card', lang: 'en',
  layout: 'normal', released_at: '2025-01-01', mana_cost: '{G}', cmc: 1,
  type_line: 'Creature — Bear', oracle_text: 'Trample', colors: ['G'], color_identity: ['G'],
  keywords: ['Trample'], power: '2', toughness: '2', rarity: 'common', set: 'aaa',
  collector_number: '1', games: ['arena'], digital: false, legalities: { standard: 'legal' },
  ...over,
});

describe('streamPoolCards', () => {
  it('drops out-of-pool printings and dedupes to one record per oracle_id', async () => {
    const p = writeGz([
      printing({ id: 'a', arena_id: 1, set: 'bbb', released_at: '2025-06-01' }),
      printing({ id: 'b', arena_id: 2, set: 'aaa', released_at: '2025-01-01' }),
      printing({ id: 'c', oracle_id: 'o2', games: ['paper'] }),                 // not on Arena
      printing({ id: 'd', oracle_id: 'o3', legalities: { standard: 'not_legal' } }),
    ]);
    const out = [];
    for await (const r of streamPoolCards(p)) out.push(r);
    expect(out).toHaveLength(1);
    expect(out[0]!.oracle_id).toBe('o1');
    expect(out[0]!.set_code).toBe('aaa');   // earliest release wins the tie
  });

  it('tolerates a trailing blank line and malformed rows without aborting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ing2-'));
    const p = join(dir, 'c.jsonl.gz');
    writeFileSync(p, gzipSync(JSON.stringify(printing({ id: 'a', arena_id: 1 })) + '\n\nnot-json\n'));
    const out = [];
    for await (const r of streamPoolCards(p)) out.push(r);
    expect(out).toHaveLength(1);
  });
});

describe('ingestSnapshot', () => {
  it('records a complete snapshot with counts and rows', async () => {
    const db = openDb(':memory:');
    const p = writeGz([
      printing({ id: 'a', arena_id: 1 }),
      printing({ id: 'b', oracle_id: 'o2', name: 'Other', arena_id: 2 }),
      printing({ id: 'c', oracle_id: 'o3', games: ['paper'] }),
    ]);
    const r = await ingestSnapshot(db, {
      gzPath: p, sourceType: 'default_cards',
      sourceUri: 'https://example/x.jsonl.gz', sourceUpdatedAt: '2026-07-24T09:10:04.747+00:00',
    });
    expect(r.printingsSeen).toBe(3);
    expect(r.cardsKept).toBe(2);
    const snap = db.prepare('SELECT status, cards_kept FROM snapshots WHERE id = ?').get(r.snapshotId) as any;
    expect(snap.status).toBe('complete');
    expect(snap.cards_kept).toBe(2);
    const n = db.prepare('SELECT COUNT(*) AS n FROM snapshot_cards WHERE snapshot_id = ?').get(r.snapshotId) as any;
    expect(n.n).toBe(2);
  });

  it('stores faces as JSON and an oracle hash', async () => {
    const db = openDb(':memory:');
    const p = writeGz([printing({ id: 'a', arena_id: 1 })]);
    const r = await ingestSnapshot(db, {
      gzPath: p, sourceType: 'default_cards', sourceUri: 'u', sourceUpdatedAt: 't',
    });
    const row = db.prepare('SELECT faces_json, oracle_hash FROM snapshot_cards WHERE snapshot_id = ?')
      .get(r.snapshotId) as any;
    expect(JSON.parse(row.faces_json)).toHaveLength(1);
    expect(row.oracle_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks the snapshot failed on a corrupt gzip and writes no snapshot_cards', async () => {
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'ing3-'));
    const p = join(dir, 'bad.jsonl.gz');
    writeFileSync(p, Buffer.from('this is not gzip'));
    await expect(ingestSnapshot(db, {
      gzPath: p, sourceType: 'default_cards', sourceUri: 'u', sourceUpdatedAt: 't',
    })).rejects.toThrow();
    const snap = db.prepare('SELECT status FROM snapshots').get() as any;
    expect(snap.status).toBe('failed');
    const n = db.prepare('SELECT COUNT(*) AS n FROM snapshot_cards').get() as any;
    expect(n.n).toBe(0);
  });
});
