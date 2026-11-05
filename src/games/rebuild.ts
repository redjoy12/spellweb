/**
 * One game from its messages (game review design sec. 3): the zones and the objects of each state,
 * and then a list of turns with the facts that the design counts. The numbers are Arena IDs. The card
 * table gives their names when the app reads a game, so a new card table needs no new rebuild.
 *
 * An undo state (the owner cancels a cast) comes from Arena as a full state with the id of the state
 * that it goes back to. It repeats the annotations of that state, and all events after that state
 * did not happen.
 */
import type { Annotation, GameObject, GameResult, GameStateMessage, Kept, Player, TurnInfo, Zone } from './logText.js';

/** Add 1 when a change here must rebuild the games that the app has kept. The scan reads them again. */
export const PARSER_VERSION = 1;

export interface BoardCard { grp: number; power: number | null; toughness: number | null }

export interface GameTurn {
  n: number;
  who: 'you' | 'opponent';
  /** The hand at the first main phase of an owner turn. */
  hand: number[] | null;
  plays: Array<{ who: 'you' | 'opponent'; what: 'land' | 'cast' | 'activate'; grp: number; mana: number }>;
  attackers: number[];
  blockers: number[];
  /** Cards that changed zone for a reason other than a draw, a land or a cast. `what` is the Arena category. */
  moved: Array<{ who: 'you' | 'opponent'; what: string; grp: number }>;
  /** The lands of the player of this turn at the end of the turn. */
  lands: number;
  /** The untapped lands of the owner at the end of an owner turn. */
  untapped: number | null;
  life: { you: [number, number]; opponent: [number, number] };
  board: { you: BoardCard[]; opponent: BoardCard[] };
  /** A summarized message hides a part of this turn. */
  summarized: boolean;
}

export interface RebuiltGame {
  match_id: string;
  game_number: number;
  played_at: string;
  /** The Arena ID of each card of the main deck, one for each copy. */
  deck: number[];
  result: 'win' | 'loss' | 'draw';
  reason: string | null;
  on_play: boolean;
  mulligans: number;
  opponent_mulligans: number;
  opening_hand: number[];
  turn_count: number;
  turns: GameTurn[];
  left_in_hand: number[];
  /** Each card of the owner that was in hand at some time, one for each copy. */
  drawn: number[];
  missed_land_turns: number[];
  opponent: { colours: string[]; cards: number[] };
  summarized: number;
}

/** A game that the app keeps but cannot use. The route counts these, and a parser fix reads them again. */
export class GameError extends Error {}

const COLOURS: Record<string, string> = { CardColor_White: 'W', CardColor_Blue: 'U', CardColor_Black: 'B', CardColor_Red: 'R', CardColor_Green: 'G' };
const BASIC_COLOURS: Record<string, string> = { SubType_Plains: 'W', SubType_Island: 'U', SubType_Swamp: 'B', SubType_Mountain: 'R', SubType_Forest: 'G' };
const ACTION_ACTIVATE = 2;

const detail = (a: Annotation, key: string) => a.details?.find((d) => d.key === key);
const isLand = (o: GameObject | undefined) => o?.cardTypes?.includes('CardType_Land') ?? false;
const isCard = (o: GameObject | undefined) => o?.type !== 'GameObjectType_Ability' && (o?.grpId ?? 0) > 0;

type Event =
  | { state: number; turn: number; kind: 'play'; who: number; what: 'land' | 'cast' | 'activate'; grp: number; id: number }
  | { state: number; turn: number; kind: 'mana'; id: number }
  | { state: number; turn: number; kind: 'attack' | 'block'; grp: number; id: number }
  | { state: number; turn: number; kind: 'moved'; who: number; what: string; grp: number };

interface Snapshot { n: number; active: number; hand: number[] | null; lands: number; untapped: number; life: Map<number, number>; board: Map<number, BoardCard[]>; summarized: boolean; startLife: Map<number, number> }

export function rebuildGame(messages: readonly Kept[]): RebuiltGame {
  const seat = ownerSeat(messages);
  const objects = new Map<number, GameObject>();
  const zones = new Map<number, Zone>();
  const players = new Map<number, Player>();
  const parent = new Map<number, number>(); // an object takes a new id when it changes zone
  const root = (id: number): number => (parent.has(id) ? root(parent.get(id)!) : id);
  const events: Event[] = [];
  const turns = new Map<number, Snapshot>();
  const inHand = new Map<number, number>();
  const seenPublic = new Map<number, GameObject>();
  let turnInfo: TurnInfo = {};
  let turn = 0;
  let opening: number[] | null = null;
  let onPlay: boolean | null = null;
  let summarizedCount = 0;
  let summaryWaits = false;
  let results: GameResult[] = [];
  let hand: number[] = [];

  const zoneOf = (type: string, owner?: number) => [...zones.values()].find((z) => z.type === type && (owner === undefined || z.ownerSeatId === owner));
  const handNow = () => (zoneOf('ZoneType_Hand', seat)?.objectInstanceIds ?? []).map((id) => objects.get(id)).filter(isCard).map((o) => o!.grpId!);
  const battlefield = () => (zoneOf('ZoneType_Battlefield')?.objectInstanceIds ?? []).map((id) => objects.get(id)).filter((o): o is GameObject => isCard(o));
  const lifeNow = () => new Map([...players].map(([s, p]) => [s, p.lifeTotal ?? 0]));

  /** The row of a turn, with the facts of the state now. The last state of a turn gives the row its end. */
  const snapshot = (n: number) => {
    const row = turns.get(n);
    if (!row) return;
    const field = battlefield();
    const lands = field.filter((o) => isLand(o) && o.controllerSeatId === row.active);
    row.lands = lands.length;
    row.untapped = field.filter((o) => isLand(o) && o.controllerSeatId === seat && !o.isTapped).length;
    row.life = lifeNow();
    row.board = new Map([...players.keys()].map((s) => [s, field.filter((o) => !isLand(o) && o.controllerSeatId === s).map((o) => ({ grp: o.grpId!, power: o.power?.value ?? null, toughness: o.toughness?.value ?? null }))]));
  };

  const apply = (s: GameStateMessage) => {
    if (s.type === 'GameStateType_Full') {
      zones.clear();
      players.clear();
    }
    for (const z of s.zones ?? []) zones.set(z.zoneId, z);
    for (const o of s.gameObjects ?? []) objects.set(o.instanceId, o);
    for (const p of s.players ?? []) players.set(p.systemSeatNumber, { ...players.get(p.systemSeatNumber), ...p });
    if (s.turnInfo) turnInfo = s.turnInfo;
  };

  const read = (s: GameStateMessage, a: Annotation) => {
    if (a.type.includes('AnnotationType_ObjectIdChanged')) {
      const from = detail(a, 'orig_id')?.valueInt32?.[0];
      const to = detail(a, 'new_id')?.valueInt32?.[0];
      if (from !== undefined && to !== undefined) parent.set(to, from);
    }
    if (a.type.includes('AnnotationType_ZoneTransfer')) {
      const category = detail(a, 'category')?.valueString?.[0] ?? 'Moved';
      for (const id of a.affectedIds ?? []) {
        const o = objects.get(id);
        if (!isCard(o)) continue;
        const base = { state: s.gameStateId, turn, id };
        if (category === 'PlayLand') events.push({ ...base, kind: 'play', what: 'land', who: o!.controllerSeatId ?? 0, grp: o!.grpId! });
        else if (category === 'CastSpell') events.push({ ...base, kind: 'play', what: 'cast', who: o!.controllerSeatId ?? 0, grp: o!.grpId! });
        else if (category !== 'Draw' && category !== 'Resolve') events.push({ state: s.gameStateId, turn, kind: 'moved', who: o!.ownerSeatId ?? 0, what: category, grp: o!.grpId! });
      }
    }
    if (a.type.includes('AnnotationType_ManaPaid')) for (const id of a.affectedIds ?? []) events.push({ state: s.gameStateId, turn, kind: 'mana', id });
    if (a.type.includes('AnnotationType_UserActionTaken') && detail(a, 'actionType')?.valueInt32?.[0] === ACTION_ACTIVATE) {
      for (const id of a.affectedIds ?? []) {
        const source = objects.get(id)?.objectSourceGrpId;
        if (source) events.push({ state: s.gameStateId, turn, kind: 'play', what: 'activate', who: a.affectorId ?? 0, grp: source, id });
      }
    }
  };

  for (const k of messages) {
    if (k.k === 'summary') {
      summarizedCount++;
      summaryWaits = true;
      if (turns.has(turn)) turns.get(turn)!.summarized = true;
      continue;
    }
    if (k.k === 'room') {
      if (results.length === 0) results = k.m.resultList;
      continue;
    }
    if (k.k !== 'gre' || !k.m.gameStateMessage) continue;
    const s = k.m.gameStateMessage;
    const next = s.turnInfo?.turnNumber;
    if (next !== undefined && next !== turn) snapshot(turn); // the state before this one ends that turn

    const undo = s.update === 'GameStateUpdate_Undo';
    if (undo) {
      const back = s.prevGameStateId ?? s.gameStateId;
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.state > back) events.splice(i, 1);
    }
    apply(s);
    if (s.gameInfo?.results?.length) results = s.gameInfo.results;

    if (next !== undefined && next !== turn) {
      turn = next;
      const active = s.turnInfo?.activePlayer ?? 0;
      turns.set(turn, { n: turn, active, hand: null, lands: 0, untapped: 0, life: lifeNow(), startLife: lifeNow(), board: new Map(), summarized: summaryWaits });
      summaryWaits = false;
      if (turn === 1) {
        onPlay = active === seat;
        opening = handNow();
      }
    }
    if (!undo) for (const a of s.annotations ?? []) read(s, a);

    if (turn > 0) {
      for (const id of zoneOf('ZoneType_Hand', seat)?.objectInstanceIds ?? []) {
        const o = objects.get(id);
        if (isCard(o)) inHand.set(root(id), o!.grpId!);
      }
      hand = handNow();
      const row = turns.get(turn)!;
      if (row.hand === null && turnInfo.phase === 'Phase_Main1' && row.active === seat) row.hand = hand;
      for (const o of s.gameObjects ?? []) {
        if (!isCard(o)) continue;
        if (o.attackState === 'AttackState_Attacking') events.push({ state: s.gameStateId, turn, kind: 'attack', grp: o.grpId!, id: root(o.instanceId) });
        if (o.blockState === 'BlockState_Blocking') events.push({ state: s.gameStateId, turn, kind: 'block', grp: o.grpId!, id: root(o.instanceId) });
      }
    }
    for (const o of s.gameObjects ?? []) if (o.ownerSeatId !== seat && o.ownerSeatId !== undefined && isCard(o) && o.type === 'GameObjectType_Card') seenPublic.set(root(o.instanceId), o);
  }
  snapshot(turn);

  if (turns.size === 0 || opening === null || onPlay === null) throw new GameError('the log has no start of this game');
  const game = results.filter((r) => r.scope === 'MatchScope_Game').at(-1) ?? results.at(-1);
  if (!game) throw new GameError('the log has no end of this game');
  const team = players.get(seat)?.teamId ?? seat;
  const result = game.result === 'ResultType_Draw' ? 'draw' : game.winningTeamId === team ? 'win' : 'loss';

  const label = (s: number) => (s === seat ? 'you' as const : 'opponent' as const);
  const rows: GameTurn[] = [...turns.values()].sort((a, b) => a.n - b.n).map((t) => {
    const here = events.filter((e) => e.turn === t.n);
    const paid = (id: number) => events.filter((e) => e.kind === 'mana' && e.id === id).length;
    const once = (list: Array<{ id: number; grp: number }>) => [...new Map(list.map((e) => [e.id, e.grp])).values()];
    const lifeOf = (s: number): [number, number] => [t.startLife.get(s) ?? 0, t.life.get(s) ?? 0];
    const opponentSeat = [...players.keys()].find((s) => s !== seat) ?? 0;
    return {
      n: t.n, who: label(t.active), hand: t.hand,
      plays: here.flatMap((e) => (e.kind === 'play' ? [{ who: label(e.who), what: e.what, grp: e.grp, mana: paid(e.id) }] : [])),
      attackers: once(here.filter((e): e is Extract<Event, { kind: 'attack' }> => e.kind === 'attack')),
      blockers: once(here.filter((e): e is Extract<Event, { kind: 'block' }> => e.kind === 'block')),
      moved: here.flatMap((e) => (e.kind === 'moved' ? [{ who: label(e.who), what: e.what, grp: e.grp }] : [])),
      lands: t.lands, untapped: t.active === seat ? t.untapped : null,
      life: { you: lifeOf(seat), opponent: lifeOf(opponentSeat) },
      board: { you: t.board.get(seat) ?? [], opponent: t.board.get(opponentSeat) ?? [] },
      summarized: t.summarized,
    };
  });

  const seen = [...seenPublic.values()];
  const colours = new Set(seen.flatMap((o) => (isLand(o) ? (o.subtypes ?? []).map((x) => BASIC_COLOURS[x]) : (o.color ?? []).map((x) => COLOURS[x]))).filter((x): x is string => x !== undefined));
  const first = messages.find((k) => k.k === 'gre')!;
  const info = messages.flatMap((k) => (k.k === 'gre' && k.m.gameStateMessage?.gameInfo?.matchID ? [k.m.gameStateMessage.gameInfo] : []))[0]!;
  const mulligans = messages.filter((k) => k.k === 'client' && k.m.mulliganResp?.decision === 'MulliganOption_Mulligan').length;
  return {
    match_id: info.matchID!, game_number: info.gameNumber ?? 1, played_at: first.t,
    deck: deckOf(messages), result, reason: game.reason?.replace(/^ResultReason_/, '') ?? null,
    on_play: onPlay, mulligans,
    opponent_mulligans: Math.max(0, ...[...players.values()].filter((p) => p.systemSeatNumber !== seat).map((p) => p.mulliganCount ?? 0)),
    opening_hand: opening, turn_count: Math.max(...turns.keys()), turns: rows, left_in_hand: hand, drawn: [...inHand.values()],
    missed_land_turns: rows.filter((t) => t.who === 'you' && !t.summarized && !t.plays.some((p) => p.who === 'you' && p.what === 'land')).map((t) => t.n),
    opponent: { colours: ['W', 'U', 'B', 'R', 'G'].filter((c) => colours.has(c)), cards: seen.map((o) => o.grpId!) },
    summarized: summarizedCount,
  };
}

/** The seat of the owner: the server sends most messages to that seat alone. */
function ownerSeat(messages: readonly Kept[]): number {
  for (const k of messages) if (k.k === 'gre' && k.m.systemSeatIds?.length === 1) return k.m.systemSeatIds[0]!;
  throw new GameError('the log does not say the seat of the owner');
}

/** The deck of `ConnectResp`, or the deck request when Arena summarized that message. */
function deckOf(messages: readonly Kept[]): number[] {
  for (const k of messages) {
    const cards = k.k === 'gre' ? k.m.connectResp?.deckMessage?.deckCards : undefined;
    if (cards?.length) return cards;
  }
  for (const k of messages) if (k.k === 'deck') return k.m.main.flatMap((c) => Array<number>(c.quantity).fill(c.cardId));
  return [];
}
