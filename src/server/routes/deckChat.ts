/**
 * The routes of the deck chat (deck chat design sec. 5): the talk, the comments, swap and undo, and
 * the tool route of a turn. Comments, swaps and undo work with no CLI, so a CLI failure stops only
 * the talk. The tool route takes JSON-RPC, and each turn has its own bearer token.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LegalityError } from '../../deck/check.js';
import { newestBuild, withWeakAnswers } from '../../deck/deck.js';
import { LINK_CHECK_MESSAGE } from '../../deck/linkChanges.js';
import { withMarks } from '../../deck/marks.js';
import { deckPolicySha, loadDeckPolicy } from '../../deck/policy.js';
import { swappedDeck, SwapError, type Swap } from '../../deck/swap.js';
import { addMessage, chatOf, lastContext, lastVersion, messagesOf, refuseSwap, saveComment, storeSwap, swapBoxOf, undoSwap } from '../chat/store.js';
import { callTool, CHAT_TOOLS, type ToolContext } from '../chat/tools.js';
import { ChatTurns, deckSpace, loadChatConfig, spawnClaude, TurnError, type ChatRunner } from '../chat/turn.js';
import { deckRowOf, tableOf, viewOf } from './decks.js';
import { indexOfBuild } from './graph.js';

const SendZ = z.union([z.object({ text: z.string().trim().min(1) }).strict(), z.object({ continue_on_fallback: z.literal(true) }).strict()]);
const CommentZ = z.object({ text: z.string().trim() }).strict();
const SwapChoiceZ = z.object({ choice: z.enum(['swap', 'refuse']) }).strict();

interface RpcMessage { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }

export async function deckChatRoutes(app: FastifyInstance, opts: { chatRunner?: ChatRunner }) {
  /** The newest build, as a new deck reads it (design sec. 5). */
  const graph = () => {
    const buildId = newestBuild(app.db);
    const policy = loadDeckPolicy();
    return { buildId, policy, idx: indexOfBuild(app.db)(buildId)!, table: withWeakAnswers(app.db, tableOf(app.db, buildId), policy) };
  };
  const swapped = (deckId: number, swap: Swap) => {
    const { buildId, policy, idx, table } = graph();
    return swappedDeck(app.db, idx, table, viewOf(deckRowOf(app.db, String(deckId))!.deck_json), swap, buildId, deckPolicySha(policy), policy);
  };

  const turns = new ChatTurns({
    db: app.db,
    runner: opts.chatRunner ?? spawnClaude,
    config: loadChatConfig,
    // Build chat design sec. 6: the first turn of a deck from a build talk reads the brief.
    space: deckSpace(app.db, (id) => viewOf(deckRowOf(app.db, String(id))!.deck_json), (id, chat) => {
      const brief = chat.started === 0 ? deckRowOf(app.db, String(id))?.brief : null;
      return brief ? ['The owner described this deck in a talk before the build. The brief of that talk:', brief, ''] : [];
    }),
    toolUrl: (id) => {
      const a = app.server.address();
      return `http://127.0.0.1:${a && typeof a === 'object' ? a.port : 0}/api/deck-chat-mcp/${id}`;
    },
  });
  app.addHook('onClose', async () => turns.stopAll());

  const toolContext = (deckId: number): ToolContext => ({
    db: app.db, deckId, findLimit: loadChatConfig().find_cards_limit, linkCheckMax: loadChatConfig().link_check_max,
    deck: () => viewOf(deckRowOf(app.db, String(deckId))!.deck_json),
    graph,
    trySwap: (swap) => { swapped(deckId, swap); },
    step: (text) => { addMessage(app.db, deckId, 'step', text); },
    offerSwap: (swap, reason) => turns.offerSwap(deckId, swap, reason),
  });

  const chatView = (deckId: number) => {
    const chat = chatOf(app.db, deckId);
    const config = loadChatConfig();
    const messages = messagesOf(app.db, deckId);
    return {
      model: chat?.model ?? config.model, fallback_model: config.fallback_model, running: turns.isRunning(deckId), flagged: chat?.flagged === 1,
      undo_message_id: lastVersion(app.db, deckId)?.message_id ?? null, context: lastContext(messages), messages,
    };
  };

  app.get<{ Params: { id: string } }>('/api/decks/:id/chat', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    return chatView(r.id);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/decks/:id/chat', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    const parsed = SendZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs text' });
    try {
      if ('text' in parsed.data) turns.send(r.id, parsed.data.text);
      else turns.continueOnFallback(r.id);
    } catch (err) {
      if (err instanceof TurnError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return reply.code(202).send(chatView(r.id));
  });

  // Link review design sec. 2: the button sends a fixed message, so the check is a normal turn of the talk.
  app.post<{ Params: { id: string } }>('/api/decks/:id/link-check', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    try {
      turns.send(r.id, LINK_CHECK_MESSAGE);
    } catch (err) {
      if (err instanceof TurnError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return reply.code(202).send(chatView(r.id));
  });

  app.delete<{ Params: { id: string } }>('/api/decks/:id/chat/turn', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    return { stopped: turns.stop(r.id) };
  });

  app.put<{ Params: { id: string; oracleId: string }; Body: unknown }>('/api/decks/:id/comments/:oracleId', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    const parsed = CommentZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs text' });
    if (!viewOf(r.deck_json).cards.some((c) => c.oracle_id === req.params.oracleId)) return reply.code(404).send({ error: 'this card is not in the deck' });
    saveComment(app.db, r.id, req.params.oracleId, parsed.data.text);
    return { ok: true };
  });

  app.post<{ Params: { id: string; messageId: string }; Body: unknown }>('/api/decks/:id/swap/:messageId', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    const parsed = SwapChoiceZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs a choice: swap or refuse' });
    const messageId = Number(req.params.messageId);
    const box = Number.isInteger(messageId) ? swapBoxOf(app.db, r.id, messageId) : null;
    if (!box) return reply.code(404).send({ error: 'this deck has no such swap' });
    if (box.status !== 'open') return reply.code(409).send({ error: `this swap is already ${box.status}` });
    if (parsed.data.choice === 'refuse') {
      refuseSwap(app.db, r.id, messageId, box);
      return { ok: true, deck: withMarks(app.db, viewOf(r.deck_json)) };
    }
    try {
      const view = swapped(r.id, box);
      storeSwap(app.db, r.id, messageId, box, view);
      return { ok: true, deck: withMarks(app.db, view) };
    } catch (err) {
      if (err instanceof SwapError || err instanceof LegalityError) return reply.code(422).send({ error: `This swap is not possible now: ${err.message}.` });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/decks/:id/undo', async (req, reply) => {
    const r = deckRowOf(app.db, req.params.id);
    if (!r) return reply.code(404).send({ error: `no deck ${req.params.id}` });
    if (!undoSwap(app.db, r.id)) return reply.code(409).send({ error: 'this deck has no swap to undo' });
    return { ok: true, deck: withMarks(app.db, viewOf(deckRowOf(app.db, req.params.id)!.deck_json)) };
  });

  app.all<{ Params: { deckId: string }; Body: RpcMessage }>('/api/deck-chat-mcp/:deckId', async (req, reply) => {
    if (req.method !== 'POST') return reply.code(405).send();
    const deckId = Number(req.params.deckId);
    if (!turns.tokenFits(deckId, req.headers.authorization)) return reply.code(401).send();
    const m = req.body;
    if (m.id === undefined) return reply.code(202).send();
    const answer = (result: unknown) => reply.send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return answer({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'deck', version: '1.0.0' } });
    if (m.method === 'tools/list') return answer({ tools: CHAT_TOOLS });
    if (m.method === 'ping') return answer({});
    if (m.method === 'tools/call') {
      const out = callTool(toolContext(deckId), m.params?.name ?? '', m.params?.arguments ?? {});
      return answer({ content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) });
    }
    return reply.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  });
}
