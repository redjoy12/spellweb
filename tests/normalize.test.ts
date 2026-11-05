import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { toCardRecord, oracleHash } from '../src/scryfall/normalize.js';
import type { ScryfallCard } from '../src/scryfall/types.js';

const fixture: ScryfallCard[] = JSON.parse(readFileSync('tests/fixtures/cards.sample.json', 'utf8'));

describe('toCardRecord', () => {
  it('gives a single-faced card exactly one face at index 0', () => {
    const c: ScryfallCard = {
      object: 'card', id: 'x', oracle_id: 'o1', name: 'Simple', lang: 'en', layout: 'normal',
      released_at: '2025-01-01', mana_cost: '{1}{G}', cmc: 2, type_line: 'Creature — Bear',
      oracle_text: 'Trample', colors: ['G'], color_identity: ['G'], keywords: ['Trample'],
      power: '2', toughness: '2', rarity: 'common', set: 'aaa', collector_number: '1',
      games: ['arena'], digital: false, legalities: { standard: 'legal' },
      image_uris: { normal: 'https://img/n.jpg', art_crop: 'https://img/a.jpg' },
    };
    const r = toCardRecord(c);
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0]).toMatchObject({ face_index: 0, name: 'Simple', oracle_text: 'Trample' });
    expect(r.image_normal).toBe('https://img/n.jpg');
  });

  it('splits every fixture card with card_faces into one face row per face', () => {
    const multi = fixture.filter((c) => c.card_faces && c.card_faces.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const c of multi) {
      const r = toCardRecord(c);
      expect(r.faces).toHaveLength(c.card_faces!.length);
      r.faces.forEach((f, i) => expect(f.face_index).toBe(i));
    }
  });

  it('falls back to face 0 for mana cost and image when the top level lacks them', () => {
    const twoSided = fixture.find((c) => !c.image_uris && c.card_faces);
    expect(twoSided, 'fixture needs a transform/modal_dfc card').toBeDefined();
    const r = toCardRecord(twoSided!);
    expect(r.image_normal).toBeTruthy();
    expect(r.mana_cost).toBe(twoSided!.card_faces![0]!.mana_cost ?? null);
  });

  it('never leaves a face oracle_text undefined', () => {
    for (const c of fixture) {
      for (const f of toCardRecord(c).faces) expect(typeof f.oracle_text).toBe('string');
    }
  });
});

describe('oracleHash', () => {
  it('is stable across calls and sensitive to face text', () => {
    const a = [{ face_index: 0, name: 'A', mana_cost: null, type_line: 'T', oracle_text: 'x',
                 power: null, toughness: null, colors: [], image_normal: null }];
    const b = [{ ...a[0]!, oracle_text: 'y' }];
    expect(oracleHash(a as any)).toBe(oracleHash(a as any));
    expect(oracleHash(a as any)).not.toBe(oracleHash(b as any));
  });
});
