import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client.js';
import { buildServer } from '../src/server/app.js';

let app: FastifyInstance;

beforeAll(() => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO snapshots (source_type, source_uri, source_updated_at, ingested_at, status, cards_kept)
     VALUES ('t','u','t',datetime('now'),'complete',2)`,
  ).run();
  const insCard = db.prepare(
    `INSERT INTO cards (oracle_id,name,layout,mana_cost,cmc,type_line,oracle_text,colors,
       color_identity,keywords,rarity,set_code,collector_number,image_normal,
       oracle_hash,first_seen_snapshot_id,last_seen_snapshot_id,rotated)
     VALUES (?,?,?,'{1}',1,'Creature','x','[]','[]','[]','common','aaa','1',?,'h',1,1,0)`,
  );
  const insFace = db.prepare(
    `INSERT INTO card_faces (oracle_id,face_index,name,mana_cost,type_line,oracle_text,colors,image_normal)
     VALUES (?,?,?,'{1}','Creature','x','[]',?)`,
  );

  insCard.run('one', 'One Face', 'normal', 'https://img/one.jpg');
  insFace.run('one', 0, 'One Face', null);

  insCard.run('two', 'Day // Night', 'transform', 'https://img/day.jpg');
  insFace.run('two', 0, 'Day', 'https://img/day.jpg');
  insFace.run('two', 1, 'Night', 'https://img/night.jpg');

  app = buildServer(db);
});

const images = async (query: string) => (await app.inject({ method: 'GET', url: `/api/card-images?${query}` })).json().images;

describe('GET /api/card-images', () => {
  it('gives the one picture of a card by its oracle id', async () => {
    expect(await images('id=one')).toEqual(['https://img/one.jpg']);
  });

  it('gives both faces of a two-faced card, front first', async () => {
    expect(await images('id=two')).toEqual(['https://img/day.jpg', 'https://img/night.jpg']);
  });

  it('finds a card by its full name or by a face name', async () => {
    expect(await images('name=One+Face')).toEqual(['https://img/one.jpg']);
    expect(await images(`name=${encodeURIComponent('Day // Night')}`)).toEqual(['https://img/day.jpg', 'https://img/night.jpg']);
    expect(await images('name=Night')).toEqual(['https://img/day.jpg', 'https://img/night.jpg']);
  });

  it('answers 404 for an unknown card and 400 with no id or name', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/card-images?id=nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/card-images?name=Nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/card-images' })).statusCode).toBe(400);
  });
});
