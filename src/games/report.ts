/**
 * One game as text (game review design sec. 3): the facts of the game, and then a list of turns. A
 * card of this app has its name in `[[ ]]`, as a chat reply must write it. A token has a plain name,
 * because the card name check of the chat has no tokens. The deck page shows the same lines.
 */
import type { CardNames } from './cardTable.js';
import type { BoardCard, GameTurn, RebuiltGame } from './rebuild.js';

const MOVED: Record<string, string> = { Destroy: 'Destroyed', Sacrifice: 'Sacrificed', Exile: 'Exiled', Discard: 'Discarded', Return: 'Returned', Mill: 'Milled', Countered: 'Countered' };
const movedText = (what: string) => (what.startsWith('SBA_') ? 'Died' : MOVED[what] ?? what);
const RESULT = { win: 'Win', loss: 'Loss', draw: 'Draw' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function gameLines(id: number, g: RebuiltGame, names: CardNames, note: string | null = null): string[] {
  const name = (grp: number) => {
    const c = names.get(grp);
    return c?.oracle_id ? `[[${c.name}]]` : c?.name ?? `Unknown card ${grp}`;
  };
  const list = (grps: readonly number[]) => (grps.length > 0 ? grps.map(name).join(', ') : 'none');
  const counted = (grps: readonly number[]) => {
    const n = new Map<string, number>();
    for (const grp of grps) n.set(name(grp), (n.get(name(grp)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([x, c]) => `${c} ${x}`).join(', ');
  };
  const paid = (p: { grp: number; mana: number }) => (p.mana > 0 ? `${name(p.grp)} (${p.mana} mana)` : name(p.grp));
  const body = (b: BoardCard) => (b.power === null ? name(b.grp) : `${name(b.grp)} ${b.power}/${b.toughness}`);

  const turnLines = (t: GameTurn): string[] => {
    const mine = t.plays.filter((p) => p.who === t.who);
    const other = t.plays.filter((p) => p.who !== t.who);
    const has = (l: typeof t.plays, what: string) => l.filter((p) => p.what === what);
    const lands = has(mine, 'land');
    const line = [`Turn ${t.n}, ${t.who}.`];
    if (t.hand) line.push(`Hand: ${list(t.hand)}.`);
    if (lands.length > 0) line.push(`Land: ${lands.map(paid).join(', ')} (${plural(t.lands, 'land')}).`);
    else line.push(`No land (${plural(t.lands, 'land')}).`);
    if (has(mine, 'cast').length > 0) line.push(`Cast: ${has(mine, 'cast').map(paid).join(', ')}.`);
    if (has(mine, 'activate').length > 0) line.push(`Used: ${has(mine, 'activate').map(paid).join(', ')}.`);
    if (t.untapped !== null) line.push(`${plural(t.untapped, 'land')} untapped.`);

    const them = t.who === 'you' ? 'Opponent' : 'You';
    const next: string[] = [];
    if (t.attackers.length > 0) next.push(`Attack: ${list(t.attackers)}.`);
    if (t.blockers.length > 0) next.push(`Block: ${list(t.blockers)}.`);
    if (has(other, 'cast').length > 0) next.push(`${them} cast: ${has(other, 'cast').map(paid).join(', ')}.`);
    if (has(other, 'activate').length > 0) next.push(`${them} used: ${has(other, 'activate').map(paid).join(', ')}.`);
    const moves = new Map<string, string[]>();
    for (const m of t.moved) moves.set(movedText(m.what), [...(moves.get(movedText(m.what)) ?? []), `${m.who === 'you' ? 'your' : 'opponent'} ${name(m.grp)}`]);
    for (const [what, cards] of moves) next.push(`${what}: ${cards.join(', ')}.`);
    if (t.life.opponent[0] !== t.life.opponent[1]) next.push(`Opponent life ${t.life.opponent[0]} -> ${t.life.opponent[1]}.`);
    if (t.life.you[0] !== t.life.you[1]) next.push(`Your life ${t.life.you[0]} -> ${t.life.you[1]}.`);
    if (t.summarized) next.push('Arena summarized a message of this turn, so this turn has no full detail.');

    const side = (who: string, cards: readonly BoardCard[]) => (cards.length > 0 ? [`${who} ${cards.map(body).join(', ')}`] : []);
    const board = [...side('you', t.board.you), ...side('opponent', t.board.opponent)];
    return [line.join(' '), ...(next.length > 0 ? [next.join(' ')] : []), ...(board.length > 0 ? [`Board at the end: ${board.join('; ')}.`] : [])];
  };

  const mine = g.turns.filter((t) => t.who === 'you');
  return [
    `Game ${id}. ${g.played_at}. ${RESULT[g.result]}${g.reason ? ` (${g.reason})` : ''}. You were on the ${g.on_play ? 'play' : 'draw'}. ${plural(g.mulligans, 'mulligan')}, opponent ${g.opponent_mulligans}. ${plural(g.turn_count, 'turn')}, ${mine.length} of them yours.`,
    ...(note ? [note] : []),
    `Opening hand: ${list(g.opening_hand)}.`,
    `Lands at the end of your turns: ${mine.map((t) => `turn ${t.n}: ${t.lands}`).join(', ')}.`,
    `Missed land drops: ${g.missed_land_turns.length > 0 ? `${g.missed_land_turns.length}, on turns ${g.missed_land_turns.join(', ')}` : 'none'}.`,
    `Untapped lands at the end of your turns: ${mine.map((t) => `turn ${t.n}: ${t.untapped}`).join(', ')}.`,
    `Left in hand at the end: ${list(g.left_in_hand)}.`,
    `Opponent colours: ${g.opponent.colours.join('') || 'none seen'}. Opponent cards seen: ${counted(g.opponent.cards) || 'none'}.`,
    ...(g.summarized > 0 ? [`Arena summarized ${plural(g.summarized, 'message')} of this game. A count can be low after such a message.`] : []),
    '',
    ...g.turns.flatMap(turnLines),
  ];
}
