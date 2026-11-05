/**
 * One turn of a deck session (deck chat design sec. 4): the API starts the Claude Code CLI, the turn
 * text goes through stdin, and the reply shows when it is complete, after the card name check.
 * `spawnClaude` is the only part that starts a process, so a test can replace it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DeckView } from '../../deck/justify.js';
import type { Swap } from '../../deck/swap.js';
import { deckChatStore, markCommentsRead, swapLine, unreadFor, type ChatContext, type ChatRow, type ChatStore } from './store.js';
import { checkNames } from './tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(here, '../../../config/deck-chat.json');
const PROMPT = resolve(here, '../../../config/deck-chat-prompt.md');

/**
 * One kind of talk: the deck chat or the build chat (build chat design sec. 7). The turn engine is
 * the same for both. `name` is the name of the tool server, so the tools of a session are
 * `mcp__<name>__*`, and `folder` is the folder of the sessions next to the database.
 */
export interface ChatSpace {
  name: string;
  folder: string;
  store: ChatStore;
  /** The path of the prompt. Each turn reads it again. */
  prompt: string;
  /** What Claude has not read yet, as lines before the owner text, and a step after a good reply. */
  unread(id: number, chat: ChatRow): { lines: string[]; done: () => void };
}

/** The deck chat (deck chat design sec. 4): new notes and new card comments go before the owner text. */
export function deckSpace(db: DatabaseSync, deck: (deckId: number) => DeckView, extra?: (deckId: number, chat: ChatRow) => string[]): ChatSpace {
  return {
    name: 'deck', folder: 'deck-chat', store: deckChatStore, prompt: PROMPT,
    unread(deckId, chat) {
      const unread = unreadFor(db, deckId, chat, deck(deckId));
      const lines: string[] = [...(extra?.(deckId, chat) ?? [])];
      if (unread.notes.length > 0) lines.push('What the owner did since your last reply:', ...unread.notes.map((n) => `- ${n.text}`), '');
      if (unread.comments.length > 0) lines.push('New comments of the owner on cards:', ...unread.comments.map((c) => `- [[${unread.name(c.oracle_id)}]]: ${c.text}`), '');
      const lastNote = unread.notes.at(-1)?.id ?? null;
      return {
        lines,
        done: () => {
          markCommentsRead(db, deckId, unread.comments);
          if (lastNote !== null) deckChatStore.setChat(db, deckId, 'told_message_id', lastNote);
        },
      };
    },
  };
}

const ConfigZ = z.object({
  model: z.string().min(1), effort: z.string().min(1), fallback_model: z.string().min(1),
  rewrites: z.number().int().nonnegative(), find_cards_limit: z.number().int().positive(),
  link_check_max: z.number().int().positive().default(40),
});
export type ChatConfig = z.infer<typeof ConfigZ>;

export const loadChatConfig = (path: string = CONFIG): ChatConfig => ConfigZ.parse(JSON.parse(readFileSync(path, 'utf8')));

/** The text of the Opus safety filter (design sec. 6). After it, each later Opus turn of the session fails. */
const FLAG_TEXT = /safeguards flagged this message/i;
const SESSION_MISSING = /No conversation found with session ID/i;
const SESSION_IN_USE = /Session ID \S+ is already in use/i;
const COMPACT = /^\/compact\b/;

export interface RunRequest { args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; onLine: (line: string) => void }
export interface RunExit { code: number | null; stderr: string }
export interface RunHandle { kill(): void; done: Promise<RunExit> }
export type ChatRunner = (req: RunRequest) => RunHandle;

/** Starts the CLI with no shell. `kill` stops a turn on Windows, and the session can resume after that. */
export const spawnClaude: ChatRunner = ({ args, cwd, env, stdin, onLine }) => {
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let rest = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    const lines = (rest + d).split('\n');
    rest = lines.pop()!;
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.stderr.on('data', (d: string) => { stderr += d; });
  child.stdin.on('error', () => undefined); // the process can stop before it reads the text
  child.stdin.end(stdin);
  const done = new Promise<RunExit>((ok) => {
    child.on('error', (err) => ok({ code: null, stderr: `The API could not start the claude CLI: ${err.message}` }));
    child.on('close', (code) => {
      if (rest.trim()) onLine(rest);
      ok({ code, stderr });
    });
  });
  return { kill: () => child.kill(), done };
};

/** The environment of a session: no `CLAUDE*` or `ANTHROPIC*` name, and no memory notes. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k))), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

/**
 * The only built-in tools of a session (owner change of 2026-11-04): web search and web page reads.
 * No tool that reads files, runs commands or changes code.
 */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

export function cliArgs(a: { sessionId: string; resume: boolean; model: string; effort: string; mcpConfig: string; systemPrompt: string; server?: string }): string[] {
  return [
    '-p', a.resume ? '--resume' : '--session-id', a.sessionId, '--model', a.model, '--effort', a.effort, '--tools', WEB_TOOLS.join(','),
    '--mcp-config', a.mcpConfig, '--strict-mcp-config', '--allowedTools', [`mcp__${a.server ?? 'deck'}__*`, ...WEB_TOOLS].join(','), '--permission-mode', 'dontAsk',
    '--setting-sources', '', '--system-prompt', a.systemPrompt, '--output-format', 'stream-json', '--verbose',
  ];
}

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
interface ResultLine { type: 'result'; is_error?: boolean; result?: string; errors?: string[]; usage?: Usage; total_cost_usd?: number; num_turns?: number; modelUsage?: Record<string, { contextWindow?: number }> }
interface StreamLine { type?: string; subtype?: string; model?: string; message?: { usage?: Usage }; compact_metadata?: { post_tokens?: number } }

interface Pass { reply: string | null; failure: string | null; compacted: boolean; context: ChatContext | null; session: 'missing' | 'in_use' | null; result: ResultLine | null }

/** All that one model call read. The `result` line is no use here: its usage is the sum of the turn. */
const contextOf = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

interface LiveTurn {
  token: string; handle: RunHandle | null; stopped: boolean; swaps: Map<string, { swap: Swap; reason: string }>;
  /** Fields that a tool adds to the data of the reply, for example the answer buttons of the build chat. */
  replyData: Record<string, unknown>;
}

/** A send that the chat cannot take now. The route gives this message to the owner. */
export class TurnError extends Error {}

export interface TurnDeps {
  db: DatabaseSync;
  runner: ChatRunner;
  config: () => ChatConfig;
  /** The deck as it is now. Only the deck chat reads it, when `space` is absent. */
  deck?: (deckId: number) => DeckView;
  /** The local URL of the tool route of a talk. */
  toolUrl: (id: number) => string;
  /** The kind of talk. The default is the deck chat. */
  space?: ChatSpace;
}

/** The turns of one server: at most one for each deck. */
export class ChatTurns {
  private live = new Map<number, LiveTurn>();
  private space: ChatSpace;
  private s: ChatStore;

  constructor(private d: TurnDeps) {
    if (!d.space && !d.deck) throw new Error('ChatTurns needs a space or a deck');
    this.space = d.space ?? deckSpace(d.db, d.deck!);
    this.s = this.space.store;
    // A row in the running state has no process in this server, so its turn ended with the old server.
    for (const id of this.s.running(d.db)) {
      this.s.addMessage(d.db, id, 'error', 'The server restarted during this turn, so the turn stopped. The talk is safe. You can send your message again.');
      this.s.setTurnState(d.db, id, 'idle');
    }
  }

  isRunning = (deckId: number) => this.live.has(deckId);

  tokenFits(deckId: number, header: string | undefined): boolean {
    const turn = this.live.get(deckId);
    return turn !== undefined && header === `Bearer ${turn.token}`;
  }

  /** Each box shows under the reply, so a turn with no reply shows no box. */
  offerSwap(deckId: number, swap: Swap, reason: string): void {
    this.live.get(deckId)?.swaps.set(JSON.stringify(swap), { swap, reason });
  }

  /** A tool adds a field to the data of the reply of this turn. */
  setReplyData(id: number, key: string, value: unknown): void {
    const turn = this.live.get(id);
    if (turn) turn.replyData[key] = value;
  }

  private check(deckId: number): ChatRow {
    const chat = this.s.ensureChat(this.d.db, deckId, this.d.config().model);
    if (this.isRunning(deckId)) throw new TurnError('Claude is still working on the last message.');
    return chat;
  }

  send(deckId: number, text: string): void {
    const chat = this.check(deckId);
    if (chat.flagged) throw new TurnError(`The safety filter flagged this talk, so it cannot continue on ${chat.model}. Press "Continue with Sonnet".`);
    this.s.addMessage(this.d.db, deckId, 'owner', text);
    this.start(deckId, text);
  }

  /** The owner chose to continue a flagged talk: the same session on the fallback model, with the last message. */
  continueOnFallback(deckId: number): void {
    const chat = this.check(deckId);
    const text = this.s.lastOwnerText(this.d.db, deckId);
    if (!chat.flagged || text === null) throw new TurnError('This talk has no flag.');
    const model = this.d.config().fallback_model;
    this.s.setModel(this.d.db, deckId, model);
    this.s.setChat(this.d.db, deckId, 'flagged', 0);
    this.s.addMessage(this.d.db, deckId, 'note', `You continued this talk on ${model}.`);
    this.start(deckId, text);
  }

  stop(deckId: number): boolean {
    const turn = this.live.get(deckId);
    if (!turn) return false;
    turn.stopped = true;
    turn.handle?.kill();
    return true;
  }

  /** The server stops: each live turn ends. */
  stopAll(): void {
    for (const id of this.live.keys()) this.stop(id);
  }

  private start(deckId: number, text: string): void {
    const turn: LiveTurn = { token: randomBytes(24).toString('hex'), handle: null, stopped: false, swaps: new Map(), replyData: {} };
    this.live.set(deckId, turn);
    this.s.setTurnState(this.d.db, deckId, 'running');
    this.run(deckId, turn, text)
      .catch((err: Error) => this.s.addMessage(this.d.db, deckId, 'error', `The turn failed: ${err.message}`))
      .finally(() => {
        this.s.setTurnState(this.d.db, deckId, 'idle');
        this.live.delete(deckId);
      });
  }

  /** The owner text, after what Claude has not read yet. `/compact` goes alone: the CLI sees a command only at the start of the text, and the unread text waits for the next message. */
  private turnInput(id: number, ownerText: string): { text: string; done: () => void } {
    if (COMPACT.test(ownerText)) return { text: ownerText, done: () => undefined };
    const unread = this.space.unread(id, this.s.chatOf(this.d.db, id)!);
    return { text: unread.lines.length > 0 ? [...unread.lines, 'Message of the owner:', ownerText].join('\n') : ownerText, done: unread.done };
  }

  private async run(deckId: number, turn: LiveTurn, ownerText: string): Promise<void> {
    const { db, config } = this.d;
    const { addMessage, setChat } = this.s;
    const started = Date.now();
    const input = this.turnInput(deckId, ownerText);
    let text = input.text;
    let rewrites = 0;
    let retried = false;
    const passes: ResultLine[] = [];
    for (;;) {
      const pass = await this.pass(deckId, turn, text);
      if (pass.result) passes.push(pass.result);
      if (turn.stopped) {
        addMessage(db, deckId, 'note', 'You stopped this turn.');
        return;
      }
      if (pass.session && !retried) {
        // The app and the CLI differ about the session file. Each turn does this at most one time.
        retried = true;
        setChat(db, deckId, 'started', pass.session === 'in_use' ? 1 : 0);
        continue;
      }
      if (pass.compacted) {
        addMessage(db, deckId, 'note', 'You compacted this talk. The session keeps a summary of the earlier messages, and this page still shows all of them.', { context: pass.context });
        return;
      }
      if (pass.failure !== null) {
        if (FLAG_TEXT.test(pass.failure)) setChat(db, deckId, 'flagged', 1);
        addMessage(db, deckId, 'error', pass.failure, { flagged: FLAG_TEXT.test(pass.failure) });
        return;
      }
      const names = checkNames(db, pass.reply!);
      if (names.bad.length === 0) {
        this.finish(deckId, turn, pass.reply!, names.cards, passes, Date.now() - started, input.done, pass.context);
        return;
      }
      if (rewrites === config().rewrites) {
        addMessage(db, deckId, 'error', `The turn failed: the reply names cards that do not exist: ${names.bad.join(', ')}. Send your message again.`);
        return;
      }
      rewrites++;
      addMessage(db, deckId, 'step', 'A card name was false, so Claude writes the reply again.');
      text = `These names in your reply are not real cards: ${names.bad.join(', ')}. Get the real names with find_cards or card_detail. Then write the whole reply again. A swap box that you already proposed stays.`;
    }
  }

  private finish(deckId: number, turn: LiveTurn, reply: string, cards: Record<string, string>, passes: readonly ResultLine[], ms: number, done: () => void, context: ChatContext | null): void {
    const { db } = this.d;
    const { addMessage } = this.s;
    const sum = (k: keyof Usage) => passes.reduce((s, r) => s + (r.usage?.[k] ?? 0), 0);
    const chat = this.s.chatOf(db, deckId)!;
    addMessage(db, deckId, 'claude', reply, {
      ...turn.replyData,
      cards, model: chat.model, ms, passes: passes.length, tool_steps: passes.reduce((s, r) => s + (r.num_turns ?? 0), 0),
      session_cost_usd: passes.at(-1)?.total_cost_usd ?? null, // the CLI gives the sum of the session, not of this turn
      usage: { input: sum('input_tokens'), output: sum('output_tokens'), cache_read: sum('cache_read_input_tokens'), cache_write: sum('cache_creation_input_tokens') },
      context,
    });
    for (const { swap, reason } of turn.swaps.values()) {
      addMessage(db, deckId, 'swap', swapLine(swap), { ...swap, reason, status: 'open' });
    }
    done();
  }

  /** One start of the CLI. `is_error` decides a failure, because a failed turn can have subtype `success`. */
  private async pass(deckId: number, turn: LiveTurn, text: string): Promise<Pass> {
    const { db, runner, config, toolUrl } = this.d;
    const { name, folder, prompt } = this.space;
    const chat = this.s.chatOf(db, deckId)!;
    const c = config();
    const file = db.location();
    const cwd = file ? join(dirname(file), folder) : join(tmpdir(), `mtga-${folder}`);
    mkdirSync(cwd, { recursive: true });
    const mcpConfig = JSON.stringify({ mcpServers: { [name]: { type: 'http', url: toolUrl(deckId), headers: { Authorization: `Bearer ${turn.token}` } } } });
    let result: ResultLine | null = null;
    const seen: { boundary: boolean; model: string | null; used: number | null } = { boundary: false, model: null, used: null };
    const noise: string[] = [];
    const onLine = (line: string) => {
      let j: StreamLine | null = null;
      try { j = JSON.parse(line) as StreamLine; } catch { noise.push(line); }
      // The CLI made the session file, also when the turn fails later.
      if (j?.type === 'system' && j.subtype === 'init') {
        this.s.setChat(db, deckId, 'started', 1);
        seen.model = j.model ?? null;
      }
      if (j?.type === 'assistant' && j.message?.usage) seen.used = contextOf(j.message.usage);
      if (j?.type === 'system' && j.subtype === 'compact_boundary') {
        seen.boundary = true;
        seen.used = j.compact_metadata?.post_tokens ?? seen.used;
      }
      if (j?.type === 'result') result = j as unknown as ResultLine;
    };
    turn.handle = runner({
      args: cliArgs({ sessionId: chat.session_id, resume: chat.started === 1, model: chat.model, effort: c.effort, mcpConfig, systemPrompt: readFileSync(prompt, 'utf8'), server: name }),
      cwd, env: cleanEnv(process.env), stdin: text, onLine,
    });
    const exit = await turn.handle.done;
    const r = result as ResultLine | null;
    const said = [r?.result, ...(r?.errors ?? []), exit.stderr, ...noise].filter(Boolean).join('\n').trim();
    const session = SESSION_MISSING.test(said) ? 'missing' : SESSION_IN_USE.test(said) ? 'in_use' : null;
    const limit = seen.model ? r?.modelUsage?.[seen.model]?.contextWindow : undefined;
    const context = seen.used !== null && limit ? { used: seen.used, limit } : null;
    if (r && !r.is_error && r.result?.trim()) return { reply: r.result.trim(), failure: null, compacted: false, context, session, result: r };
    // `/compact` has an empty result, so its boundary line is the sign that it worked.
    if (r && !r.is_error && seen.boundary && COMPACT.test(text.trim())) return { reply: null, failure: null, compacted: true, context, session, result: r };
    return { reply: null, failure: said || `The CLI stopped with code ${exit.code} and gave no message.`, compacted: false, context, session, result: r };
  }
}
