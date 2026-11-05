import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';

describe('openDb', () => {
  it('creates every Phase 1 table', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r: any) => r.name as string);
    for (const t of [
      'cards', 'card_faces', 'snapshots', 'snapshot_cards',
      'pool_diffs', 'pool_diff_entries', 'extraction_queue',
      'rules_corpus', 'rule_sections', 'rules', 'glossary_entries',
      'keyword_rule_map', 'type_rule_map',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('is idempotent — applying the schema twice does not throw', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'db-')), 'app.db');
    expect(() => openDb(path)).not.toThrow();
    expect(() => openDb(path)).not.toThrow();
  });

  it('supports FTS5 match queries on cards_fts', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cards_fts (oracle_id, name, type_line, oracle_text) VALUES (?,?,?,?)')
      .run('o1', 'Test Card', 'Creature — Human', 'Whenever a creature you control dies, draw a card.');
    const hits = db.prepare('SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?').all('dies');
    expect(hits).toHaveLength(1);
  });
});
