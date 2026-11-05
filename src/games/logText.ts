/**
 * The Arena log as text (game review design sec. 3): the head of a log, the game messages, and one
 * list of messages for each game. No screen name and no account ID leaves this file: a header line
 * gives only its time and its kind, and a room message gives only its state and its result.
 */
import { createHash } from 'node:crypto';

/** One game message, as the app keeps it in `data/game-logs/`. */
export type Kept =
  | { t: string; k: 'gre'; m: GreMessage }
  | { t: string; k: 'client'; m: ClientMessage }
  | { t: string; k: 'room'; m: RoomMessage }
  | { t: string; k: 'deck'; m: { main: DeckEntry[] } }
  | { t: string; k: 'summary'; m: { objects: number | null; annotations: number | null } };

export interface DeckEntry { cardId: number; quantity: number }

export interface GreMessage {
  type: string;
  systemSeatIds?: number[];
  gameStateMessage?: GameStateMessage;
  connectResp?: { deckMessage?: { deckCards?: number[] } };
  [key: string]: unknown;
}

export interface ClientMessage { type?: string; mulliganResp?: { decision?: string }; [key: string]: unknown }

export interface GameResult { scope?: string; result?: string; winningTeamId?: number; reason?: string }

export interface RoomMessage { matchId: string | null; stateType: string | null; resultList: GameResult[] }

export interface Annotation {
  type: string[];
  affectorId?: number;
  affectedIds?: number[];
  details?: Array<{ key: string; valueInt32?: number[]; valueString?: string[] }>;
}

export interface GameObject {
  instanceId: number;
  grpId?: number;
  type?: string;
  ownerSeatId?: number;
  controllerSeatId?: number;
  cardTypes?: string[];
  subtypes?: string[];
  color?: string[];
  power?: { value?: number };
  toughness?: { value?: number };
  isTapped?: boolean;
  attackState?: string;
  blockState?: string;
  objectSourceGrpId?: number;
}

export interface Zone { zoneId: number; type: string; ownerSeatId?: number; objectInstanceIds?: number[] }

export interface Player { systemSeatNumber: number; lifeTotal?: number; teamId?: number; mulliganCount?: number }

export interface TurnInfo { phase?: string; step?: string; turnNumber?: number; activePlayer?: number }

export interface GameStateMessage {
  type: string;
  gameStateId: number;
  prevGameStateId?: number;
  update?: string;
  gameInfo?: { matchID?: string; gameNumber?: number; stage?: string; results?: GameResult[] };
  players?: Player[];
  turnInfo?: TurnInfo;
  zones?: Zone[];
  gameObjects?: GameObject[];
  annotations?: Annotation[];
}

export interface LogHead {
  /** Changes with each start of Arena, and stays when the log moves to `Player-prev.log`. */
  id: string | null;
  detailed: boolean | null;
  /** The install folder of Arena (design sec. 2). */
  install: string | null;
}

export const HEAD_BYTES = 64 * 1024;
const FIRST_TIME = /^\[UnityCrossThreadLogger\]\d+\/\d+\/\d+ \d+:\d+:\d+ [AP]M.*$/m;

export function logHead(text: string): LogHead {
  const time = FIRST_TIME.exec(text);
  const detail = /^DETAILED LOGS: (ENABLED|DISABLED)\s*$/m.exec(text)?.[1];
  return {
    id: time ? createHash('sha1').update(text.slice(0, time.index + time[0].length)).digest('hex') : null,
    detailed: detail === undefined ? null : detail === 'ENABLED',
    install: /^Mono path\[0\] = '(.+)\/MTGA_Data\/Managed'/m.exec(text)?.[1] ?? null,
  };
}

/** A match header time (`11/2/2026 1:45:07 PM`) as sortable local text. A bare time header of this log is UTC, so the app does not read those. */
export function localTime(raw: string): string {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+) ([AP])M$/.exec(raw);
  if (!m) return raw;
  const hour = (Number(m[4]) % 12) + (m[7] === 'P' ? 12 : 0);
  const two = (n: string | number) => String(n).padStart(2, '0');
  return `${m[3]}-${two(m[1]!)}-${two(m[2]!)} ${two(hour)}:${m[5]}:${m[6]}`;
}

export interface Entry { start: number; kept: Kept | null; bad?: true }

const GAME_HEADER = /^\[UnityCrossThreadLogger\](\d+\/\d+\/\d+ \d+:\d+:\d+ [AP]M): (?:Match to \S+: (GreToClientEvent|MatchGameRoomStateChangedEvent)|\S+ to Match: (ClientToGremessage|ClientToGreuimessage))\s*$/i;
const DECK_REQUEST = /^\[UnityCrossThreadLogger\]==> EventSetDeck\w*\s+(\{.*\})\s*$/;
const SUMMARIZED = '[Message summarized';

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function roomMessage(raw: unknown): RoomMessage {
  const info = (raw as { matchGameRoomStateChangedEvent?: { gameRoomInfo?: { stateType?: string; gameRoomConfig?: { matchId?: string }; finalMatchResult?: { matchId?: string; resultList?: GameResult[] } } } })?.matchGameRoomStateChangedEvent?.gameRoomInfo;
  return { matchId: info?.gameRoomConfig?.matchId ?? info?.finalMatchResult?.matchId ?? null, stateType: info?.stateType ?? null, resultList: info?.finalMatchResult?.resultList ?? [] };
}

function deckRequest(line: string): DeckEntry[] | null {
  const outer = parseJson(DECK_REQUEST.exec(line)![1]!) as { request?: string } | undefined;
  const inner = outer?.request ? parseJson(outer.request) as { Deck?: { MainDeck?: DeckEntry[] } } | undefined : undefined;
  return inner?.Deck?.MainDeck?.map(({ cardId, quantity }) => ({ cardId, quantity })) ?? null;
}

/**
 * The game messages of a part of a log. `end` is the byte after the last whole entry, so a client
 * message that a live log has written only in part is read again by the next scan. The hover messages
 * of the client and of the server have no game fact, so they go here.
 */
export function readEntries(buf: Buffer, base: number): { entries: Entry[]; end: number } {
  const lines: Array<{ start: number; text: string }> = [];
  let at = 0;
  for (;;) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    lines.push({ start: at, text: buf.toString('utf8', at, nl).replace(/\r$/, '') });
    at = nl + 1;
  }
  const entries: Entry[] = [];
  let end = base + at;
  let lastTime = '';

  for (let i = 0; i < lines.length; i++) {
    const { start, text } = lines[i]!;
    if (text.startsWith(SUMMARIZED)) {
      let j = i + 1;
      const count = (label: string) => {
        for (let k = i + 1; k < j; k++) {
          const n = new RegExp(`^:: ${label} Count = (\\d+)`).exec(lines[k]!.text)?.[1];
          if (n) return Number(n);
        }
        return null;
      };
      while (j < lines.length && !lines[j]!.text.startsWith('[')) j++;
      entries.push({ start: base + start, kept: { t: lastTime, k: 'summary', m: { objects: count('GameObject'), annotations: count('Annotation') } } });
      i = j - 1;
      continue;
    }
    if (DECK_REQUEST.test(text)) {
      const main = deckRequest(text);
      if (main) entries.push({ start: base + start, kept: { t: lastTime, k: 'deck', m: { main } } });
      continue;
    }
    const head = GAME_HEADER.exec(text);
    if (!head) continue;
    lastTime = localTime(head[1]!);
    const kind = (head[2] ?? head[3])!.toLowerCase();
    let j = i + 1;
    let body = '';
    let value: unknown;
    for (; j < lines.length; j++) {
      const l = lines[j]!.text;
      if (l.startsWith('[')) break;
      body += `${l}\n`;
      if (l.startsWith('{') ? l.trimEnd().endsWith('}') : l.startsWith('}')) value = parseJson(body);
      if (value !== undefined) break;
    }
    const whole = value !== undefined || j < lines.length;
    if (!whole) { // the log stops inside this message
      end = base + start;
      break;
    }
    const hover = kind === 'clienttogreuimessage';
    if (value === undefined) {
      // A summarized message has a header with no body. The marker line is the next entry.
      if (!hover && !lines[j]?.text.startsWith(SUMMARIZED)) entries.push({ start: base + start, kept: null, bad: true });
      i = j - 1;
      continue;
    }
    i = j;
    if (hover) continue;
    const from = base + start;
    if (kind === 'gretoclientevent') {
      const list = (value as { greToClientEvent?: { greToClientMessages?: GreMessage[] } }).greToClientEvent?.greToClientMessages ?? [];
      for (const m of list) if (m.type !== 'GREMessageType_UIMessage') entries.push({ start: from, kept: { t: lastTime, k: 'gre', m } });
    } else if (kind === 'matchgameroomstatechangedevent') {
      entries.push({ start: from, kept: { t: lastTime, k: 'room', m: roomMessage(value) } });
    } else {
      const m = (value as { payload?: ClientMessage }).payload;
      if (m) entries.push({ start: from, kept: { t: lastTime, k: 'client', m } });
    }
  }
  return { entries, end };
}

export interface RawGame { matchId: string; gameNumber: number; messages: Kept[]; ended: boolean; bad: number }

const stateOf = (k: Kept) => (k.k === 'gre' ? k.m.gameStateMessage : undefined);

/**
 * One list of messages for each game. A game starts at its first state with `gameInfo`, and it takes
 * the newest deck request and the `ConnectResp` before that state. `resume` is the byte where the next
 * scan must start: at the start of a game that is still running, or at a deck request that no game has
 * used yet. A log can start a new game with no end to the last one: that game stays with `ended` false.
 */
export function splitGames(entries: readonly Entry[], end: number): { games: RawGame[]; resume: number } {
  const games: RawGame[] = [];
  let cur: RawGame | null = null;
  let held: Array<{ start: number; kept: Kept }> = [];
  let curStart = end;

  for (const e of entries) {
    if (e.bad) {
      if (cur && !cur.ended) cur.bad++;
      continue;
    }
    const k = e.kept!;
    if (k.k === 'deck') {
      held = [{ start: e.start, kept: k }];
      continue;
    }
    if (k.k === 'room') {
      if (cur && k.m.matchId === cur.matchId) {
        cur.messages.push(k);
        if (/MatchCompleted$/.test(k.m.stateType ?? '')) cur.ended = true;
      }
      continue;
    }
    const info = stateOf(k)?.gameInfo;
    if (info?.matchID && (!cur || cur.matchId !== info.matchID || cur.gameNumber !== (info.gameNumber ?? 1))) {
      cur = { matchId: info.matchID, gameNumber: info.gameNumber ?? 1, messages: held.map((h) => h.kept), ended: false, bad: 0 };
      curStart = held[0]?.start ?? e.start;
      held = [];
      games.push(cur);
    }
    const connect = k.k === 'gre' && k.m.type === 'GREMessageType_ConnectResp';
    if (connect && (!cur || cur.ended)) held.push({ start: e.start, kept: k }); // the first message of the next game
    else if (cur && (!cur.ended || k.k === 'gre')) cur.messages.push(k);
    if (cur && info?.stage === 'GameStage_GameOver') cur.ended = true;
  }
  const last = games.at(-1);
  if (last && !last.ended) return { games, resume: curStart };
  return { games, resume: held[0]?.start ?? end };
}
