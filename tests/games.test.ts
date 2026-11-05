import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../src/db/client.js';
import { loadCardTable, namesOf, newestCardFile } from '../src/games/cardTable.js';
import { deckGames, gamesText, scanStatus } from '../src/games/counts.js';
import { linkGame } from '../src/games/link.js';
import { localTime, logHead, readEntries, splitGames, type GameStateMessage, type Kept } from '../src/games/logText.js';
import { GameError, PARSER_VERSION, rebuildGame, type RebuiltGame } from '../src/games/rebuild.js';
import { gameLines } from '../src/games/report.js';
import { loadGameConfig, scanLogs } from '../src/games/scan.js';
import { buildServer } from '../src/server/app.js';
import { callTool, CHAT_TOOLS, type ToolContext } from '../src/server/chat/tools.js';

/** The first 6 turns and the end of a real game, with no names (game review design Step 1). */
const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures/game-log-sample.txt'), 'utf8');
const REAL_LOG = join(import.meta.dirname, '../data/game-review-sample/Player-2026-11-02.log');
const MATCH = '77557aa1-83c9-4898-830c-ad8455f427fe';
const SWAMP = 58445;
const WARLOCK = 91654;
const SUMMARIZED = [
  '[Message summarized because one or more GameStateMessages exceeded the 50 GameObject or 50 Annotation limit.]',
  '::: GameStateMessage', ':: GameObject Count = 63', ':: Annotation Count = 4', '::: ActionsAvailableReq',
].join('\n');

const entriesOf = (text: string) => readEntries(Buffer.from(text), 0);
const keptOf = (text: string): Kept[] => {
  const { entries, end } = entriesOf(text);
  return splitGames(entries, end).games[0]!.messages;
};
const sampleGame = () => rebuildGame(keptOf(SAMPLE));

/** The log up to the first message of turn 5, so the game is still running. */
const running = () => SAMPLE.slice(0, SAMPLE.lastIndexOf('[UnityCrossThreadLogger]', SAMPLE.indexOf('"turnNumber":5')));

function testDb(): DatabaseSync {
  const db = openDb(':memory:');
  db.exec('PRAGMA foreign_keys = OFF'); // the rows of a test have no build or card
  return db;
}

/** A card table and a deck that fit the sample game: `deck` rows give the copies of each Arena ID. */
function seedDeck(db: DatabaseSync, changes: Array<[number, number]> = []): number {
  const copies = new Map<number, number>();
  for (const id of sampleGame().deck) copies.set(id, (copies.get(id) ?? 0) + 1);
  for (const [id, n] of changes) copies.set(id, (copies.get(id) ?? 0) + n);
  for (const id of new Set([...copies.keys(), ...sampleIds()])) {
    db.prepare('INSERT OR IGNORE INTO arena_cards (arena_id, name, oracle_id, is_token) VALUES (?, ?, ?, 0)').run(id, `Card ${id}`, `oracle-${id}`);
  }
  const cards = [...copies].filter(([, n]) => n > 0).map(([id, n]) => ({ oracle_id: `oracle-${id}`, name: `Card ${id}`, copies: n }));
  return Number(db.prepare('INSERT INTO decks (build_id, goal_json, policy_sha, deck_json, created_at) VALUES (1, ?, ?, ?, ?)').run('{}', 'x', JSON.stringify({ cards }), 'now').lastInsertRowid);
}

function sampleIds(): number[] {
  const g = sampleGame();
  return [...g.drawn, ...g.opponent.cards, ...g.turns.flatMap((t) => [...t.plays.map((p) => p.grp), ...t.moved.map((m) => m.grp), ...t.board.you.map((b) => b.grp)])];
}

describe('the text of a log', () => {
  it('reads the head: detailed logs, the install folder and an ID that a new log changes', () => {
    const head = logHead(SAMPLE.slice(0, 2000));
    expect(head).toMatchObject({ detailed: true, install: 'C:/Fake Games/MTGA' });
    expect(logHead('DETAILED LOGS: DISABLED\n').detailed).toBe(false);
    expect(logHead('no such line\n')).toEqual({ id: null, detailed: null, install: null });
    expect(logHead(SAMPLE.slice(0, 2000).replace('11:41:19', '11:41:20')).id).not.toBe(head.id);
  });

  it('turns a match header time into sortable text', () => {
    expect(localTime('11/2/2026 1:45:07 PM')).toBe('2026-11-02 13:45:07');
    expect(localTime('1/2/2026 12:05:00 AM')).toBe('2026-01-02 00:05:00');
    expect(localTime('1/2/2026 12:05:00 PM')).toBe('2026-01-02 12:05:00');
  });

  it('takes game messages, and no hover, account ID or name', () => {
    const { entries, end } = entriesOf(SAMPLE);
    expect(end).toBe(Buffer.byteLength(SAMPLE));
    expect(entries.filter((e) => e.bad)).toEqual([]);
    const kinds = new Set(entries.map((e) => e.kept!.k));
    expect(kinds).toEqual(new Set(['deck', 'room', 'gre', 'client']));
    expect(entries.some((e) => e.kept!.k === 'client' && e.kept!.m.type === 'ClientMessageType_UIMessage')).toBe(false);
    const text = JSON.stringify(entries.map((e) => e.kept));
    for (const secret of ['ACCOUNT0000', 'NAME', 'USER']) expect(text).not.toContain(secret);
  });

  it('uses the local time of match headers, not the UTC time of a bare header', () => {
    expect(keptOf(SAMPLE).find((k) => k.k === 'gre')!.t).toBe('2026-11-02 13:42:36');
  });

  it('stops before a message that a live log has written only in part', () => {
    const at = SAMPLE.indexOf('ClientToGreuimessage');
    const start = SAMPLE.lastIndexOf('[UnityCrossThreadLogger]', at);
    const cut = SAMPLE.slice(0, SAMPLE.indexOf('\n', SAMPLE.indexOf('{', at)) + 1);
    expect(entriesOf(cut).end).toBe(Buffer.byteLength(SAMPLE.slice(0, start)));
  });

  it('counts a body that it cannot read', () => {
    const broken = '[UnityCrossThreadLogger]11/2/2026 1:42:40 PM: Match to ACCOUNT0000000000000000000: GreToClientEvent\nnot json at all\n';
    const at = SAMPLE.indexOf('[UnityCrossThreadLogger]', SAMPLE.indexOf('"turnNumber":3'));
    const { entries, end } = entriesOf(`${SAMPLE.slice(0, at)}${broken}${SAMPLE.slice(at)}`);
    expect(entries.filter((e) => e.bad)).toHaveLength(1);
    expect(splitGames(entries, end).games.map((g) => g.bad)).toEqual([1]);
  });

  it('reads a summarized message and its counts', () => {
    const text = `${SAMPLE.split('\n').slice(0, 3).join('\n')}\n[UnityCrossThreadLogger]11/2/2026 1:42:40 PM: Match to ACCOUNT0000000000000000000: GreToClientEvent\n${SUMMARIZED}\n[UnityCrossThreadLogger]11/2/2026 1:42:41 PM\n`;
    const { entries } = entriesOf(text);
    expect(entries.map((e) => e.kept)).toEqual([{ t: '2026-11-02 13:42:40', k: 'summary', m: { objects: 63, annotations: 4 } }]);
  });
});

describe('the games of a log', () => {
  it('finds one game with its deck request and its end', () => {
    const { entries, end } = entriesOf(SAMPLE);
    const { games, resume } = splitGames(entries, end);
    expect(games.map((g) => [g.matchId, g.gameNumber, g.ended, g.bad])).toEqual([[MATCH, 1, true, 0]]);
    expect(games[0]!.messages[0]!.k).toBe('deck');
    expect(resume).toBe(end);
  });

  it('resumes at the deck request of a game that is still running', () => {
    const text = running();
    const { entries, end } = entriesOf(text);
    const { games, resume } = splitGames(entries, end);
    expect(games[0]!.ended).toBe(false);
    expect(resume).toBe(Buffer.byteLength(text.slice(0, text.indexOf('[UnityCrossThreadLogger]==> EventSetDeck'))));
  });

  it('resumes at a deck request that no game has used', () => {
    const text = SAMPLE.split('\n').slice(0, 4).join('\n') + '\n';
    const { entries, end } = entriesOf(text);
    expect(splitGames(entries, end)).toEqual({ games: [], resume: entries[0]!.start });
  });

  it('gives each game of one read its own ConnectResp and its own deck request', () => {
    const { entries, end } = entriesOf(SAMPLE + SAMPLE.replaceAll(MATCH, 'next-match'));
    const { games } = splitGames(entries, end);
    expect(games.map((g) => g.matchId)).toEqual([MATCH, 'next-match']);
    for (const g of games) {
      expect(g.messages.filter((k) => k.k === 'gre' && k.m.connectResp)).toHaveLength(1);
      expect(g.messages.filter((k) => k.k === 'deck')).toHaveLength(1);
      expect(g.ended).toBe(true);
    }
  });

  it('closes a game with no end when the next game starts', () => {
    const next = SAMPLE.replaceAll(MATCH, 'next-match');
    const { entries, end } = entriesOf(running() + next);
    const { games } = splitGames(entries, end);
    expect(games.map((g) => [g.matchId, g.ended])).toEqual([[MATCH, false], ['next-match', true]]);
  });
});

describe('the rebuild of a game', () => {
  it('gives the result, the seat facts and the opening hand', () => {
    const g = sampleGame();
    expect(g).toMatchObject({ match_id: MATCH, game_number: 1, played_at: '2026-11-02 13:42:36', result: 'loss', reason: 'Concede', on_play: true, mulligans: 0, opponent_mulligans: 0, turn_count: 31, summarized: 0 });
    expect(g.opening_hand).toEqual([SWAMP, 96673, 103460, 96673, 103460, WARLOCK, SWAMP]);
    expect(g.deck).toHaveLength(60);
  });

  it('gives each turn: the hand, the plays, the mana, the moves and the untapped lands', () => {
    const t = sampleGame().turns.find((x) => x.n === 5)!;
    expect(t.who).toBe('you');
    expect(t.hand).toHaveLength(7);
    expect(t.plays).toEqual([{ who: 'you', what: 'land', grp: SWAMP, mana: 0 }, { who: 'you', what: 'cast', grp: WARLOCK, mana: 3 }]);
    expect(t.moved).toEqual([{ who: 'opponent', what: 'Discard', grp: 97170 }]);
    expect(t).toMatchObject({ lands: 3, untapped: 0 });
    expect(t.board.you).toEqual([{ grp: WARLOCK, power: 2, toughness: 2 }]);
  });

  it('gives the plays of the opponent, and no hand on an opponent turn', () => {
    const t = sampleGame().turns.find((x) => x.n === 6)!;
    expect(t).toMatchObject({ who: 'opponent', hand: null, untapped: null });
    expect(t.plays.map((p) => p.what)).toEqual(['land', 'cast']);
    expect(t.moved).toEqual([{ who: 'you', what: 'Destroy', grp: WARLOCK }]);
  });

  it('counts the cards of the opponent by card, across zones, and gives the colours', () => {
    const g = sampleGame();
    expect(g.opponent.colours).toEqual(['B']);
    expect(g.opponent.cards.filter((id) => id === 97170)).toHaveLength(5);
  });

  const state = (id: number, more: Partial<GameStateMessage>, prev = id - 1): Kept => ({ t: 'x', k: 'gre', m: { type: 'GREMessageType_GameStateMessage', systemSeatIds: [1], gameStateMessage: { type: 'GameStateType_Diff', gameStateId: id, prevGameStateId: prev, ...more } } });
  const hand = (ids: number[]) => ({ zoneId: 10, type: 'ZoneType_Hand', ownerSeatId: 1, objectInstanceIds: ids });
  const card = (instanceId: number, grpId: number) => ({ instanceId, grpId, type: 'GameObjectType_Card', ownerSeatId: 1, controllerSeatId: 1 });
  const moved = (id: number, category: string) => ({ type: ['AnnotationType_ZoneTransfer'], affectedIds: [id], details: [{ key: 'category', valueString: [category] }] });
  const start = (): Kept[] => [
    state(1, { type: 'GameStateType_Full', gameInfo: { matchID: 'm', gameNumber: 1 }, players: [{ systemSeatNumber: 1, teamId: 1, lifeTotal: 20 }, { systemSeatNumber: 2, teamId: 2, lifeTotal: 20 }], zones: [hand([5])], gameObjects: [card(5, 100)] }),
    state(2, { turnInfo: { phase: 'Phase_Main1', turnNumber: 1, activePlayer: 1 } }),
  ];
  const over: Kept = state(9, { gameInfo: { matchID: 'm', gameNumber: 1, stage: 'GameStage_GameOver', results: [{ scope: 'MatchScope_Game', result: 'ResultType_WinLoss', winningTeamId: 1, reason: 'ResultReason_Game' }] } });

  it('drops a cast that the owner cancelled, and reads no annotation of the undo state again', () => {
    const land = moved(5, 'PlayLand');
    const g = rebuildGame([
      ...start(),
      state(3, { annotations: [land] }),
      state(4, { annotations: [moved(5, 'CastSpell')] }),
      state(5, { type: 'GameStateType_Full', update: 'GameStateUpdate_Undo', zones: [hand([5])], players: [{ systemSeatNumber: 1, teamId: 1, lifeTotal: 20 }, { systemSeatNumber: 2, teamId: 2, lifeTotal: 20 }], annotations: [land] }, 3),
      over,
    ]);
    expect(g.turns[0]!.plays.map((p) => p.what)).toEqual(['land']);
    expect(g.result).toBe('win');
  });

  it('marks a summarized turn, and does not call it a missed land drop', () => {
    const summary: Kept = { t: 'x', k: 'summary', m: { objects: 60, annotations: 3 } };
    const g = rebuildGame([...start(), summary, over]);
    expect(g.summarized).toBe(1);
    expect(g.turns[0]!.summarized).toBe(true);
    expect(g.missed_land_turns).toEqual([]);
    expect(rebuildGame([...start(), over]).missed_land_turns).toEqual([1]);
  });

  it('takes the deck from the request when Arena summarized ConnectResp', () => {
    const kept = keptOf(SAMPLE).filter((k) => !(k.k === 'gre' && k.m.connectResp));
    const sorted = (l: readonly number[]) => [...l].sort((a, b) => a - b);
    expect(sorted(rebuildGame(kept).deck)).toEqual(sorted(sampleGame().deck));
  });

  it('counts the mulligans of the owner', () => {
    const answer: Kept = { t: 'x', k: 'client', m: { type: 'ClientMessageType_MulliganResp', mulliganResp: { decision: 'MulliganOption_Mulligan' } } };
    expect(rebuildGame([answer, ...start(), over]).mulligans).toBe(1);
  });

  it('refuses a game with no start or with no end', () => {
    expect(() => rebuildGame(start())).toThrow(GameError);
    expect(() => rebuildGame(start())).toThrow('no end');
    expect(() => rebuildGame([start()[0]!, over])).toThrow('no start');
  });

  (existsSync(REAL_LOG) ? it : it.skip)('rebuilds the whole real game', () => {
    const buf = readFileSync(REAL_LOG);
    const { entries, end } = readEntries(buf, 0);
    const { games } = splitGames(entries, end);
    expect(entries.filter((e) => e.bad)).toEqual([]);
    expect(games).toHaveLength(1);
    const g = rebuildGame(games[0]!.messages);
    expect(g).toMatchObject({ result: 'loss', reason: 'Concede', on_play: true, turn_count: 31, mulligans: 0, summarized: 0 });
    expect(g.turns).toHaveLength(31);
    const casts = g.turns.flatMap((t) => t.plays).filter((p) => p.what === 'cast');
    expect(casts).toHaveLength(22); // the log has 23 CastSpell moves, and the owner cancelled one
    expect(g.turns.flatMap((t) => t.plays).filter((p) => p.what === 'land')).toHaveLength(18);
  });
});

describe('the card table', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arena-cards-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cardFile(path: string): void {
    const f = new DatabaseSync(path);
    f.exec('CREATE TABLE Cards (GrpId INT, TitleId INT, IsToken INT); CREATE TABLE Localizations_enUS (LocId INT, Formatted INT, Loc TEXT)');
    const add = f.prepare('INSERT INTO Cards VALUES (?, ?, ?)');
    const loc = f.prepare('INSERT INTO Localizations_enUS VALUES (?, ?, ?)');
    for (const [grp, title, token] of [[1, 10, 0], [2, 10, 0], [3, 20, 0], [4, 30, 1], [5, 40, 0], [6, 50, 0], [7, 99, 0]] as const) add.run(grp, title, token);
    loc.run(10, 0, 'Thought-Stalker Warlock');
    loc.run(10, 1, '<nobr>Thought-Stalker</nobr> Warlock');
    loc.run(20, 1, 'Back Face');
    loc.run(30, 1, 'Clue');
    loc.run(40, 1, 'Dusk /// Dawn');
    loc.run(50, 1, 'Not In This App');
    f.close();
  }

  it('resolves each printing by name, a face, a split card, a token and a card outside this app', () => {
    const db = testDb();
    const card = (id: string, name: string) => db.prepare(`INSERT INTO cards (oracle_id, name, layout, cmc, type_line, colors, color_identity, keywords, rarity, set_code, collector_number, oracle_hash, first_seen_snapshot_id, last_seen_snapshot_id) VALUES (?, ?, 'normal', 0, 'x', '[]', '[]', '[]', 'c', 's', '1', 'h', 1, 1)`).run(id, name);
    card('a', 'Thought-Stalker Warlock');
    card('b', 'Front Face // Back Face');
    db.prepare(`INSERT INTO card_faces (oracle_id, face_index, name, type_line, colors) VALUES ('b', 1, 'Back Face', 'x', '[]')`).run();
    card('c', 'Dusk // Dawn');
    const file = join(dir, 'cards.mtga');
    cardFile(file);
    expect(loadCardTable(db, file)).toBe(6);
    const names = namesOf(db, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(names.get(1)).toEqual({ name: 'Thought-Stalker Warlock', oracle_id: 'a', token: false });
    expect(names.get(2)!.oracle_id).toBe('a');
    expect(names.get(3)!.oracle_id).toBe('b');
    expect(names.get(4)).toEqual({ name: 'Clue', oracle_id: null, token: true });
    expect(names.get(5)!.oracle_id).toBe('c');
    expect(names.get(6)).toEqual({ name: 'Not In This App', oracle_id: null, token: false });
    expect(names.get(8)!.name).toBe('Unknown card 8');
  });

  it('takes the newest card file of an install', () => {
    const raw = join(dir, 'MTGA_Data', 'Downloads', 'Raw');
    mkdirSync(raw, { recursive: true });
    for (const [name, day] of [['Raw_CardDatabase_old.mtga', 1], ['Raw_CardDatabase_new.mtga', 2], ['Raw_Other.mtga', 3]] as const) {
      writeFileSync(join(raw, name), '');
      utimesSync(join(raw, name), new Date(2026, 1, day), new Date(2026, 1, day));
    }
    expect(newestCardFile(dir)).toBe(join(raw, 'Raw_CardDatabase_new.mtga'));
    expect(newestCardFile(join(dir, 'none'))).toBeNull();
  });
});

describe('the link of a game to a deck', () => {
  it('gives exact for the same cards, whatever the printing', () => {
    const db = testDb();
    const deck = seedDeck(db);
    db.prepare(`INSERT INTO arena_cards (arena_id, name, oracle_id, is_token) VALUES (999, 'Card ${SWAMP}', 'oracle-${SWAMP}', 0)`).run();
    const game = sampleGame().deck.map((id) => (id === SWAMP ? 999 : id));
    expect(linkGame(db, game, 8)).toMatchObject({ deck_id: deck, kind: 'exact', differ: 0, older: false, in: [], out: [] });
  });

  it('gives close with the changes, and no link past the limit', () => {
    const db = testDb();
    const deck = seedDeck(db, [[SWAMP, -2], [WARLOCK, 2]]);
    const link = linkGame(db, sampleGame().deck, 8)!;
    expect(link).toMatchObject({ deck_id: deck, kind: 'close', differ: 2 });
    expect(link.in).toEqual([{ oracle_id: `oracle-${SWAMP}`, name: `Card ${SWAMP}`, copies: 2 }]);
    expect(link.out).toEqual([{ oracle_id: `oracle-${WARLOCK}`, name: `Card ${WARLOCK}`, copies: 2 }]);
    expect(linkGame(db, sampleGame().deck, 1)).toBeNull();
  });

  it('finds a version from before a swap', () => {
    const db = testDb();
    const deck = seedDeck(db);
    const old = (db.prepare('SELECT deck_json FROM decks WHERE id = ?').get(deck) as { deck_json: string }).deck_json;
    db.prepare(`UPDATE decks SET deck_json = '{"cards":[]}' WHERE id = ?`).run(deck);
    db.prepare(`INSERT INTO deck_versions (deck_id, message_id, build_id, policy_sha, deck_json, created_at) VALUES (?, 1, 1, 'x', ?, 'now')`).run(deck, old);
    expect(linkGame(db, sampleGame().deck, 8)).toMatchObject({ deck_id: deck, kind: 'exact', older: true });
  });

  it('takes the closest deck, and a game with no deck list has no link', () => {
    const db = testDb();
    seedDeck(db, [[SWAMP, -2], [WARLOCK, 2]]);
    const near = seedDeck(db, [[SWAMP, -1], [WARLOCK, 1]]);
    expect(linkGame(db, sampleGame().deck, 8)).toMatchObject({ deck_id: near, differ: 1 });
    expect(linkGame(db, [], 8)).toBeNull();
  });
});

describe('the scan of a log folder', () => {
  let dir = '';
  let keepDir = '';
  let db: DatabaseSync;
  const scan = () => scanLogs(db, { dir, keepDir, closeCopies: 8 });
  const log = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const rows = () => db.prepare('SELECT status, reason, deck_id, link_kind FROM games').all() as Array<{ status: string; reason: string | null; deck_id: number | null; link_kind: string | null }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arena-log-'));
    keepDir = join(dir, 'kept');
    db = testDb();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows a game when it ends, links it, and reads only new bytes after that', () => {
    const deck = seedDeck(db);
    log('Player.log', running());
    expect(scan().added).toBe(0);
    expect(rows()).toEqual([]);
    log('Player.log', SAMPLE);
    expect(scan().added).toBe(1);
    expect(rows()).toEqual([{ status: 'ok', reason: null, deck_id: deck, link_kind: 'exact' }]);
    expect(scan()).toEqual({ added: 0, bytes: 0 });
    expect(scanStatus(db)).toMatchObject({ log_found: true, detailed: true, other_games: 0, unreadable_games: 0, error: null });
  });

  it('keeps the messages of a game with no name, and reads them again after a parser change', () => {
    seedDeck(db);
    log('Player.log', SAMPLE);
    scan();
    const [file] = readdirSync(keepDir);
    const text = gunzipSync(readFileSync(join(keepDir, file!))).toString('utf8');
    for (const secret of ['ACCOUNT0000', 'NAME', 'USER', 'userId', 'playerName']) expect(text).not.toContain(secret);
    db.prepare(`UPDATE games SET parser_version = 0, game_json = '{}'`).run();
    scan();
    const row = db.prepare('SELECT parser_version, game_json, link_kind FROM games').get() as { parser_version: number; game_json: string; link_kind: string };
    expect(row.parser_version).toBe(PARSER_VERSION);
    expect(row.link_kind).toBe('exact');
    expect((JSON.parse(row.game_json) as RebuiltGame).turn_count).toBe(31);
  });

  it('keeps its place when the log moves to the previous name, and does not count a game two times', () => {
    log('Player.log', SAMPLE);
    expect(scan().added).toBe(1);
    renameSync(join(dir, 'Player.log'), join(dir, 'Player-prev.log'));
    log('Player.log', SAMPLE.replace('11:41:19', '12:00:00').replaceAll(MATCH, 'second-match'));
    expect(scan().added).toBe(1);
    expect(rows()).toHaveLength(2);
    expect(scan()).toEqual({ added: 0, bytes: 0 });
  });

  it('counts a game that a closed log never ended, and a game that links to no deck', () => {
    log('Player-prev.log', running());
    expect(scan().added).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'unreadable', reason: 'the log has no end of this game' });
    expect(scanStatus(db).unreadable_games).toBe(1);
    log('Player.log', SAMPLE.replace('11:41:19', '12:00:00').replaceAll(MATCH, 'second-match'));
    scan();
    expect(scanStatus(db)).toMatchObject({ other_games: 1, unreadable_games: 1 });
  });

  it('links an old game when its deck comes later', () => {
    log('Player.log', SAMPLE);
    scan();
    expect(rows()[0]!.deck_id).toBeNull();
    const deck = seedDeck(db);
    scan();
    expect(rows()[0]!.deck_id).toBe(deck);
  });

  it('says that the log has no game data, and that a folder has no log', () => {
    scan();
    expect(scanStatus(db)).toMatchObject({ log_found: false, detailed: null });
    log('Player.log', SAMPLE.replace('DETAILED LOGS: ENABLED', 'DETAILED LOGS: DISABLED'));
    scan();
    expect(scanStatus(db)).toMatchObject({ log_found: true, detailed: false });
  });

  it('keeps the scan state when a scan fails', () => {
    log('Player.log', SAMPLE);
    db.exec('DROP TABLE game_log_files');
    expect(scan()).toEqual({ added: 0, bytes: 0 });
    expect(scanStatus(db).error).toContain('game_log_files');
  });
});

describe('the view of the games of a deck', () => {
  let dir = '';
  let db: DatabaseSync;
  let deck = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arena-games-'));
    db = testDb();
    deck = seedDeck(db);
    writeFileSync(join(dir, 'Player.log'), SAMPLE);
    scanLogs(db, { dir, keepDir: join(dir, 'kept'), closeCopies: 8 });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts wins and losses, on the play and on the draw, and each card', () => {
    const v = deckGames(db, deck);
    expect(v.totals).toEqual({ wins: 0, losses: 1, draws: 0, on_play: { wins: 0, losses: 1, draws: 0 }, on_draw: { wins: 0, losses: 0, draws: 0 } });
    expect(v.games).toHaveLength(1);
    expect(v.games[0]).toMatchObject({ result: 'loss', on_play: true, turn_count: 31, opponent_colours: ['B'], link: { kind: 'exact' } });
    const warlock = v.cards.find((c) => c.name === `Card ${WARLOCK}`)!;
    expect(warlock).toMatchObject({ drawn: 1, cast: 1, left: 0, wins: 0 });
    const swamp = v.cards.find((c) => c.name === `Card ${SWAMP}`)!;
    expect(swamp).toMatchObject({ drawn: 1, left: 1 });
  });

  it('writes a game as lines, with the facts of the design and each turn', () => {
    const lines = deckGames(db, deck).games[0]!.lines;
    expect(lines[0]).toMatch(/^Game 1\. 2026-11-02 13:42:36\. Loss \(Concede\)\. You were on the play\. 0 mulligans, opponent 0\. 31 turns, 4 of them yours\.$/);
    expect(lines).toContain(`Turn 5, you. Hand: [[Card ${SWAMP}]], [[Card ${SWAMP}]], [[Card 96673]], [[Card 103460]], [[Card 96673]], [[Card 103460]], [[Card ${WARLOCK}]]. Land: [[Card ${SWAMP}]] (3 lands). Cast: [[Card ${WARLOCK}]] (3 mana). 0 lands untapped.`);
    expect(lines.some((l) => l.startsWith('Turn 6, opponent. Land: '))).toBe(true);
    expect(lines.some((l) => l.includes('Destroyed: your [[Card 91654]].'))).toBe(true);
    for (const head of ['Opening hand:', 'Lands at the end of your turns:', 'Missed land drops:', 'Untapped lands at the end of your turns:', 'Left in hand at the end:', 'Opponent colours: B.']) {
      expect(lines.some((l) => l.startsWith(head))).toBe(true);
    }
  });

  it('writes a token with no [[ ]], and says when a message is summarized', () => {
    const g: RebuiltGame = { ...sampleGame(), summarized: 1, left_in_hand: [1] };
    g.turns[0]!.summarized = true;
    const names = new Map([[1, { name: 'Clue', oracle_id: null, token: true }]]);
    const lines = gameLines(1, g, names);
    expect(lines.some((l) => l.startsWith('Left in hand at the end: Clue.'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Arena summarized 1 message of this game'))).toBe(true);
    expect(lines.some((l) => l.includes('this turn has no full detail'))).toBe(true);
  });

  it('gives the games to the chat tools of this deck only', () => {
    const steps: string[] = [];
    const context = { db, deckId: deck, step: (t: string) => steps.push(t) } as unknown as ToolContext;
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['list_games', 'game_log']));
    const list = callTool(context, 'list_games', {});
    expect(list.text).toContain('1 game. Wins-losses 0-1. On the play 0-1. On the draw 0-0.');
    expect(list.text).toContain(`[[Card ${WARLOCK}]]: drawn 1, cast 1, left in hand 0, wins 0.`);
    expect(callTool(context, 'game_log', { game_id: 1 }).text).toContain('Turn 5, you.');
    expect(callTool(context, 'game_log', { game_id: 7 })).toEqual({ text: 'This deck has no game 7. Use list_games.', isError: true });
    expect(callTool({ ...context, deckId: deck + 1 }, 'game_log', { game_id: 1 }).isError).toBe(true);
    expect(callTool(context, 'game_log', {}).isError).toBe(true);
    expect(steps).toEqual(['Read the games.', 'Read game 1.']);
  });

  it('tells Claude why a deck has no games', () => {
    const other = seedDeck(db, [[SWAMP, -30]]);
    db.prepare(`UPDATE game_scan_state SET detailed = 0`).run();
    expect(gamesText(deckGames(db, other))).toBe('This deck has no games. The Arena log has no game data: the owner must select Detailed Logs in Arena.');
  });

  it('gives the games through the route, and 404 for a deck that does not exist', async () => {
    const app = buildServer(db);
    const res = await app.inject({ url: `/api/decks/${deck}/games` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { losses: 1 }, status: { detailed: true } });
    expect((await app.inject({ url: '/api/decks/9999/games' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('the settings of the game review', () => {
  it('has the design values', () => {
    expect(loadGameConfig()).toEqual({ scan_seconds: 30, close_copies: 8, log_dir: null });
  });
});
