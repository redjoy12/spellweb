/**
 * The tables of the games, and the counts of a deck (game review design sec. 3). The page and the
 * chat tools read the same view. No model is necessary here, and the deck search reads none of it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { namesOf } from './cardTable.js';
import type { DeckLink } from './link.js';
import type { RebuiltGame } from './rebuild.js';
import { gameLines } from './report.js';

export interface GameRow {
  id: number;
  match_id: string;
  game_number: number;
  played_at: string;
  file: string;
  status: 'ok' | 'unreadable';
  reason: string | null;
  parser_version: number;
  game_json: string | null;
  deck_id: number | null;
  link_kind: 'exact' | 'close' | null;
  link_json: string | null;
}

export interface ScanStatus {
  log_found: boolean;
  /** null: the log does not say. */
  detailed: boolean | null;
  scanned_at: string | null;
  error: string | null;
  /** Games that link to no deck. */
  other_games: number;
  /** Games that the scan could not read. */
  unreadable_games: number;
}

export function scanStatus(db: DatabaseSync): ScanStatus {
  const s = db.prepare('SELECT log_found, detailed, scanned_at, error FROM game_scan_state WHERE id = 1').get() as
    { log_found: number; detailed: number | null; scanned_at: string; error: string | null } | undefined;
  const { other, bad } = db.prepare(
    `SELECT COALESCE(SUM(status = 'ok' AND deck_id IS NULL), 0) AS other, COALESCE(SUM(status = 'unreadable'), 0) AS bad FROM games`,
  ).get() as { other: number; bad: number };
  return { log_found: s?.log_found === 1, detailed: s?.detailed === null || s === undefined ? null : s.detailed === 1, scanned_at: s?.scanned_at ?? null, error: s?.error ?? null, other_games: other, unreadable_games: bad };
}

export interface GameView {
  id: number;
  played_at: string;
  result: RebuiltGame['result'];
  reason: string | null;
  on_play: boolean;
  mulligans: number;
  turn_count: number;
  missed_land_drops: number;
  opponent_colours: string[];
  link: Pick<DeckLink, 'kind' | 'differ' | 'older' | 'in' | 'out'>;
  lines: string[];
}

export interface CardCount { name: string; oracle_id: string | null; drawn: number; cast: number; left: number; wins: number }

interface Score { wins: number; losses: number; draws: number }

export interface DeckGames {
  status: ScanStatus;
  totals: Score & { on_play: Score; on_draw: Score };
  games: GameView[];
  cards: CardCount[];
  /** Each `[[Name]]` of the lines, with its card, for the hover zoom. */
  card_ids: Record<string, string>;
}

/** Each game of a deck, the newest first. */
export function gamesOfDeck(db: DatabaseSync, deckId: number): Array<GameRow & { game: RebuiltGame }> {
  const rows = db.prepare("SELECT * FROM games WHERE deck_id = ? AND status = 'ok' ORDER BY played_at DESC, id DESC").all(deckId) as unknown as GameRow[];
  return rows.map((r) => ({ ...r, game: JSON.parse(r.game_json!) as RebuiltGame }));
}

const tally = (rows: ReadonlyArray<{ game: RebuiltGame }>): Score => ({
  wins: rows.filter((r) => r.game.result === 'win').length,
  losses: rows.filter((r) => r.game.result === 'loss').length,
  draws: rows.filter((r) => r.game.result === 'draw').length,
});

/** The note of a game that is `close` to the deck: which cards differ. */
function linkNote(link: DeckLink): string | null {
  const side = (l: DeckLink['in']) => l.map((c) => `${c.copies} ${c.name}`).join(', ');
  const parts = [
    link.older ? 'You played an earlier version of this deck.' : null,
    link.kind === 'close' ? `The game deck differs from this version by ${link.differ} copies. In the game, not in the deck: ${side(link.in)}. In the deck, not in the game: ${side(link.out)}.` : null,
  ];
  return parts.filter(Boolean).join(' ') || null;
}

export function deckGames(db: DatabaseSync, deckId: number): DeckGames {
  const rows = gamesOfDeck(db, deckId);
  const ids = rows.flatMap(({ game: g }) => [
    ...g.deck, ...g.drawn, ...g.opening_hand, ...g.left_in_hand, ...g.opponent.cards,
    ...g.turns.flatMap((t) => [...(t.hand ?? []), ...t.plays.map((p) => p.grp), ...t.attackers, ...t.blockers, ...t.moved.map((m) => m.grp), ...t.board.you.map((b) => b.grp), ...t.board.opponent.map((b) => b.grp)]),
  ]);
  const names = namesOf(db, ids);

  const counts = new Map<string, CardCount>();
  const count = (grp: number) => {
    const c = names.get(grp)!;
    const key = c.oracle_id ?? c.name;
    if (!counts.has(key)) counts.set(key, { name: c.name, oracle_id: c.oracle_id, drawn: 0, cast: 0, left: 0, wins: 0 });
    return counts.get(key)!;
  };
  for (const { game: g } of rows) {
    for (const grp of g.deck) count(grp);
    for (const c of new Set(g.drawn.map(count))) {
      c.drawn++;
      if (g.result === 'win') c.wins++;
    }
    for (const c of new Set(g.left_in_hand.map(count))) c.left++;
    for (const t of g.turns) for (const p of t.plays) if (p.who === 'you' && p.what === 'cast') count(p.grp).cast++;
  }

  const games: GameView[] = rows.map((r) => {
    const link = JSON.parse(r.link_json!) as DeckLink;
    const g = r.game;
    return {
      id: r.id, played_at: g.played_at, result: g.result, reason: g.reason, on_play: g.on_play, mulligans: g.mulligans, turn_count: g.turn_count,
      missed_land_drops: g.missed_land_turns.length, opponent_colours: g.opponent.colours,
      link: { kind: link.kind, differ: link.differ, older: link.older, in: link.in, out: link.out },
      lines: gameLines(r.id, g, names, [linkNote(link), r.reason].filter(Boolean).join(' ') || null),
    };
  });
  return {
    status: scanStatus(db),
    totals: { ...tally(rows), on_play: tally(rows.filter((r) => r.game.on_play)), on_draw: tally(rows.filter((r) => !r.game.on_play)) },
    games,
    cards: [...counts.values()].sort((a, b) => b.drawn - a.drawn || b.cast - a.cast || (a.name < b.name ? -1 : 1)),
    card_ids: Object.fromEntries([...names.values()].flatMap((c) => (c.oracle_id ? [[c.name, c.oracle_id]] : []))),
  };
}

const record = (r: Score) => `${r.wins}-${r.losses}${r.draws > 0 ? `-${r.draws}` : ''}`;

/** The text of the `list_games` tool. */
export function gamesText(view: DeckGames): string {
  const { totals: t, games, cards, status } = view;
  if (games.length === 0) {
    const why = status.detailed === false ? ' The Arena log has no game data: the owner must select Detailed Logs in Arena.' : '';
    return `This deck has no games.${why}`;
  }
  return [
    `${games.length} game${games.length === 1 ? '' : 's'}. Wins-losses ${record(t)}. On the play ${record(t.on_play)}. On the draw ${record(t.on_draw)}.`,
    ...games.map((g) => `Game ${g.id}: ${g.played_at}, ${g.result}${g.reason ? ` (${g.reason})` : ''}, on the ${g.on_play ? 'play' : 'draw'}, ${g.mulligans} mulligans, ${g.turn_count} turns, ${g.missed_land_drops} missed land drops, opponent ${g.opponent_colours.join('') || 'colours not seen'}, link ${g.link.kind}${g.link.older ? ' to an earlier version' : ''}.`),
    '',
    'Each card: games with the card drawn, times cast, games with the card left in hand, wins with the card drawn.',
    ...cards.map((c) => `${c.oracle_id ? `[[${c.name}]]` : c.name}: drawn ${c.drawn}, cast ${c.cast}, left in hand ${c.left}, wins ${c.wins}.`),
  ].join('\n');
}
