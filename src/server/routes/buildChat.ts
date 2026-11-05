/**
 * The routes of the build chat (build chat design sec. 8): the talks before a deck, their messages,
 * the draft form, and the tool route of a turn. A talk that built a deck takes no new message.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAtomSchema } from '../../atoms/schema.js';
import { newestBuild, withWeakAnswers } from '../../deck/deck.js';
import { loadDeckPolicy } from '../../deck/policy.js';
import { buildChatStore, buildSpace, createTalk, draftChanges, DraftZ, emptyDraft, namesOf, saveDraft, talkList, talkOf, type BuildChatRow, type Draft } from '../chat/build.js';
import { BUILD_TOOLS, callBuildTool, type BuildToolContext } from '../chat/buildTools.js';
import { lastContext } from '../chat/store.js';
import { ChatTurns, loadChatConfig, spawnClaude, TurnError, type ChatRunner } from '../chat/turn.js';
import { tableOf } from './decks.js';
import { indexOfBuild } from './graph.js';

const SendZ = z.union([z.object({ text: z.string().trim().min(1) }).strict(), z.object({ continue_on_fallback: z.literal(true) }).strict()]);
const DraftBodyZ = z.object({ draft: DraftZ, brief: z.string() }).strict();
const NewZ = z.object({ draft: DraftZ.optional() }).strict();

interface RpcMessage { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }

export async function buildChatRoutes(app: FastifyInstance, opts: { chatRunner?: ChatRunner }) {
  const graph = () => {
    const buildId = newestBuild(app.db);
    const policy = loadDeckPolicy();
    return { buildId, idx: indexOfBuild(app.db)(buildId)!, table: withWeakAnswers(app.db, tableOf(app.db, buildId), policy) };
  };

  const turns = new ChatTurns({
    db: app.db,
    runner: opts.chatRunner ?? spawnClaude,
    config: loadChatConfig,
    space: buildSpace(app.db, loadDeckPolicy),
    toolUrl: (id) => {
      const a = app.server.address();
      return `http://127.0.0.1:${a && typeof a === 'object' ? a.port : 0}/api/build-chat-mcp/${id}`;
    },
  });
  app.addHook('onClose', async () => turns.stopAll());

  const talk = (raw: string): BuildChatRow | null => {
    const id = Number(raw);
    return Number.isInteger(id) ? talkOf(app.db, id, loadDeckPolicy()) : null;
  };

  /** The draft with the name and colours of each card, so the page can show it. */
  const draftView = (d: Draft) => {
    const names = namesOf(app.db, [...d.seeds, ...d.pinned, ...d.excluded]);
    const cards = (ids: readonly string[]) => ids.map((id) => ({ oracle_id: id, name: names.get(id)?.name ?? id, color_identity: names.get(id)?.color_identity ?? [] }));
    return { ...d, seeds: cards(d.seeds), pinned: cards(d.pinned), excluded: cards(d.excluded) };
  };

  const view = (t: BuildChatRow) => {
    const config = loadChatConfig();
    const messages = buildChatStore.messagesOf(app.db, t.chat_id);
    return {
      id: t.chat_id, model: t.model ?? config.model, fallback_model: config.fallback_model, running: turns.isRunning(t.chat_id), flagged: t.flagged === 1,
      context: lastContext(messages), messages, draft: draftView(t.draft), brief: t.brief, deck_id: t.deck_id, created_at: t.created_at,
    };
  };

  app.get('/api/build-chats', async () => ({ talks: talkList(app.db) }));

  // The tag names of the "Never tags" field, with the label of each tag.
  app.get('/api/build-chat-tags', async () => ({
    tags: loadAtomSchema().types.map((t) => ({ tag: `${t.family}.${t.type_key}`, label: t.label })).sort((a, b) => (a.tag < b.tag ? -1 : 1)),
  }));

  app.post<{ Body: unknown }>('/api/build-chats', async (req, reply) => {
    const parsed = NewZ.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'the body can have a draft only' });
    const id = createTalk(app.db, loadChatConfig().model, parsed.data.draft ?? emptyDraft(loadDeckPolicy()));
    return reply.code(201).send(view(talkOf(app.db, id, loadDeckPolicy())!));
  });

  app.get<{ Params: { id: string } }>('/api/build-chats/:id', async (req, reply) => {
    const t = talk(req.params.id);
    if (!t) return reply.code(404).send({ error: `no talk ${req.params.id}` });
    return view(t);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/build-chats/:id/messages', async (req, reply) => {
    const t = talk(req.params.id);
    if (!t) return reply.code(404).send({ error: `no talk ${req.params.id}` });
    if (t.deck_id !== null) return reply.code(409).send({ error: `This talk built deck ${t.deck_id}. Start a new talk.` });
    const parsed = SendZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the body needs text' });
    try {
      if ('text' in parsed.data) turns.send(t.chat_id, parsed.data.text);
      else turns.continueOnFallback(t.chat_id);
    } catch (err) {
      if (err instanceof TurnError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return reply.code(202).send(view(talk(req.params.id)!));
  });

  /** An owner change of the form. The change goes to Claude as a note with the next message. */
  app.put<{ Params: { id: string }; Body: unknown }>('/api/build-chats/:id/draft', async (req, reply) => {
    const t = talk(req.params.id);
    if (!t) return reply.code(404).send({ error: `no talk ${req.params.id}` });
    if (t.deck_id !== null) return reply.code(409).send({ error: `This talk built deck ${t.deck_id}. Start a new talk.` });
    const parsed = DraftBodyZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `bad draft: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    const changes = draftChanges(app.db, t.draft, parsed.data.draft, t.brief, parsed.data.brief);
    if (changes.length > 0) {
      saveDraft(app.db, t.chat_id, parsed.data.draft, parsed.data.brief);
      buildChatStore.addMessage(app.db, t.chat_id, 'note', `You changed the form: ${changes.join('; ')}.`);
    }
    return view(talk(req.params.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/build-chats/:id/turn', async (req, reply) => {
    const t = talk(req.params.id);
    if (!t) return reply.code(404).send({ error: `no talk ${req.params.id}` });
    return { stopped: turns.stop(t.chat_id) };
  });

  const toolContext = (id: number): BuildToolContext => ({
    db: app.db, findLimit: loadChatConfig().find_cards_limit, policy: loadDeckPolicy,
    talk: () => talkOf(app.db, id, loadDeckPolicy())!,
    save: (draft, brief) => saveDraft(app.db, id, draft, brief),
    graph,
    step: (text) => { buildChatStore.addMessage(app.db, id, 'step', text); },
    ask: (answers) => turns.setReplyData(id, 'answers', answers),
  });

  app.all<{ Params: { id: string }; Body: RpcMessage }>('/api/build-chat-mcp/:id', async (req, reply) => {
    if (req.method !== 'POST') return reply.code(405).send();
    const id = Number(req.params.id);
    if (!turns.tokenFits(id, req.headers.authorization)) return reply.code(401).send();
    const m = req.body;
    if (m.id === undefined) return reply.code(202).send();
    const answer = (result: unknown) => reply.send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return answer({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'build', version: '1.0.0' } });
    if (m.method === 'tools/list') return answer({ tools: BUILD_TOOLS });
    if (m.method === 'ping') return answer({});
    if (m.method === 'tools/call') {
      const out = callBuildTool(toolContext(id), m.params?.name ?? '', m.params?.arguments ?? {});
      return answer({ content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) });
    }
    return reply.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  });
}
