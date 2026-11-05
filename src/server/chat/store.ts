/**
 * The tables of the deck chat (design sec. 5): one talk for each deck, its messages, one comment for
 * each card of a deck, and the deck before each swap. The chat writes nothing to atoms, tags, links,
 * golden pairs or owner answers.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeckView } from '../../deck/justify.js';
import type { Swap } from '../../deck/swap.js';

export type ChatRole = 'owner' | 'claude' | 'step' | 'error' | 'swap' | 'note';
export interface ChatMessage { id: number; role: ChatRole; text: string; data: Record<string, unknown> | null; created_at: string }
/** The tokens that the session holds after a turn, and the limit of its model. */
export interface ChatContext { used: number; limit: number }
/** The row of a talk. A deck talk also has `deck_id`, and a build talk has `chat_id` and its draft. */
export interface ChatRow { session_id: string; model: string; started: number; turn_state: 'idle' | 'running'; flagged: number; told_message_id: number }
export type SwapStatus = 'open' | 'swapped' | 'refused' | 'undone';
export interface SwapBox extends Swap { reason: string; status: SwapStatus }

const now = () => new Date().toISOString();

/**
 * The two tables of one kind of talk. The deck chat has one talk for each deck; the build chat
 * (build chat design sec. 8) has one talk for each build talk. `key` is the column of the talk in
 * both tables. The names are constants of this file, never input.
 */
export interface ChatTables { chats: string; messages: string; key: string }
export const DECK_CHAT: ChatTables = { chats: 'deck_chats', messages: 'deck_chat_messages', key: 'deck_id' };
export const BUILD_CHAT: ChatTables = { chats: 'build_chats', messages: 'build_chat_messages', key: 'chat_id' };

/** The parts of a talk that each kind of talk has, on its own tables. */
export function chatStore(t: ChatTables) {
  const chatOf = (db: DatabaseSync, id: number) =>
    db.prepare(`SELECT * FROM ${t.chats} WHERE ${t.key} = ?`).get(id) as unknown as ChatRow | undefined;
  return {
    tables: t,
    chatOf,
    /** The talk with this ID. The first call makes it, with a new session ID. */
    ensureChat(db: DatabaseSync, id: number, model: string): ChatRow {
      db.prepare(`INSERT OR IGNORE INTO ${t.chats} (${t.key}, session_id, model) VALUES (?, ?, ?)`).run(id, randomUUID(), model);
      return chatOf(db, id)!;
    },
    setChat: (db: DatabaseSync, id: number, column: 'started' | 'flagged' | 'told_message_id', value: number) =>
      db.prepare(`UPDATE ${t.chats} SET ${column} = ? WHERE ${t.key} = ?`).run(value, id),
    setTurnState: (db: DatabaseSync, id: number, state: ChatRow['turn_state']) =>
      db.prepare(`UPDATE ${t.chats} SET turn_state = ? WHERE ${t.key} = ?`).run(state, id),
    setModel: (db: DatabaseSync, id: number, model: string) =>
      db.prepare(`UPDATE ${t.chats} SET model = ? WHERE ${t.key} = ?`).run(model, id),
    /** The talks in the running state. */
    running: (db: DatabaseSync) =>
      (db.prepare(`SELECT ${t.key} AS id FROM ${t.chats} WHERE turn_state = 'running'`).all() as Array<{ id: number }>).map((r) => r.id),
    addMessage(db: DatabaseSync, id: number, role: ChatRole, text: string, data?: object): number {
      return Number(db.prepare(`INSERT INTO ${t.messages} (${t.key}, role, text, data_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, role, text, data ? JSON.stringify(data) : null, now()).lastInsertRowid);
    },
    messagesOf(db: DatabaseSync, id: number): ChatMessage[] {
      const rows = db.prepare(`SELECT id, role, text, data_json, created_at FROM ${t.messages} WHERE ${t.key} = ? ORDER BY id`).all(id) as unknown as
        Array<Omit<ChatMessage, 'data'> & { data_json: string | null }>;
      return rows.map(({ data_json, ...m }) => ({ ...m, data: data_json ? JSON.parse(data_json) as Record<string, unknown> : null }));
    },
    lastOwnerText(db: DatabaseSync, id: number): string | null {
      const row = db.prepare(`SELECT text FROM ${t.messages} WHERE ${t.key} = ? AND role = 'owner' ORDER BY id DESC LIMIT 1`).get(id) as { text: string } | undefined;
      return row?.text ?? null;
    },
    /** The notes that Claude has not read: each note after `told_message_id`. */
    notesSince: (db: DatabaseSync, id: number, told: number) =>
      db.prepare(`SELECT id, text FROM ${t.messages} WHERE ${t.key} = ? AND role = 'note' AND id > ? ORDER BY id`).all(id, told) as Array<{ id: number; text: string }>,
  };
}
export type ChatStore = ReturnType<typeof chatStore>;

export const deckChatStore = chatStore(DECK_CHAT);
export const { chatOf, ensureChat, setChat, setTurnState, setModel, addMessage, messagesOf, lastOwnerText } = deckChatStore;

/** The context of the newest turn that reported one. */
export const lastContext = (messages: readonly ChatMessage[]) =>
  (messages.findLast((m) => m.data?.['context'])?.data?.['context'] as ChatContext | undefined) ?? null;

/** Empty text removes the comment. A comment with no change stays read. */
export function saveComment(db: DatabaseSync, deckId: number, oracleId: string, text: string): void {
  if (text === '') {
    db.prepare('DELETE FROM deck_card_comments WHERE deck_id = ? AND oracle_id = ?').run(deckId, oracleId);
    return;
  }
  db.prepare(
    `INSERT INTO deck_card_comments (deck_id, oracle_id, text, unread, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (deck_id, oracle_id) DO UPDATE SET text = excluded.text, unread = 1, updated_at = excluded.updated_at
     WHERE deck_card_comments.text <> excluded.text`,
  ).run(deckId, oracleId, text, now());
}

export interface CommentRow { oracle_id: string; text: string; unread: number; updated_at: string }

export const commentsOf = (db: DatabaseSync, deckId: number) =>
  db.prepare('SELECT oracle_id, text, unread, updated_at FROM deck_card_comments WHERE deck_id = ?').all(deckId) as unknown as CommentRow[];

/** A comment that the owner changed after Claude got it stays "not yet read". */
export function markCommentsRead(db: DatabaseSync, deckId: number, comments: readonly CommentRow[]): void {
  const mark = db.prepare('UPDATE deck_card_comments SET unread = 0 WHERE deck_id = ? AND oracle_id = ? AND updated_at = ?');
  for (const c of comments) mark.run(deckId, c.oracle_id, c.updated_at);
}

/** What Claude must read with the next owner message: new notes and new comments. */
export function unreadFor(db: DatabaseSync, deckId: number, chat: ChatRow, view: DeckView) {
  const notes = deckChatStore.notesSince(db, deckId, chat.told_message_id);
  const inDeck = new Map(view.cards.map((c) => [c.oracle_id, c.name]));
  const comments = commentsOf(db, deckId).filter((c) => c.unread === 1 && inDeck.has(c.oracle_id));
  return { notes, comments, name: (id: string) => inDeck.get(id)! };
}

function inTransaction(db: DatabaseSync, job: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    job();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function swapBoxOf(db: DatabaseSync, deckId: number, messageId: number): SwapBox | null {
  const row = db.prepare("SELECT data_json FROM deck_chat_messages WHERE id = ? AND deck_id = ? AND role = 'swap'").get(messageId, deckId) as { data_json: string } | undefined;
  return row ? JSON.parse(row.data_json) as SwapBox : null;
}

const setBox = (db: DatabaseSync, messageId: number, box: SwapBox, status: SwapStatus) =>
  db.prepare('UPDATE deck_chat_messages SET data_json = ? WHERE id = ?').run(JSON.stringify({ ...box, status }), messageId);

export function refuseSwap(db: DatabaseSync, deckId: number, messageId: number, box: SwapBox): void {
  inTransaction(db, () => {
    setBox(db, messageId, box, 'refused');
    addMessage(db, deckId, 'note', `You said no to this swap: ${swapLine(box)}.`);
  });
}

/** The line of a swap for the chat and for Claude. */
export function swapLine(s: Swap): string {
  const part = (cards: Swap['out']) => cards.map((c) => `${c.copies} [[${c.name}]]`).join(', ');
  return `out ${part(s.out)}, in ${part(s.in)}`;
}

/** Stores the deck before the swap, then the new deck. */
export function storeSwap(db: DatabaseSync, deckId: number, messageId: number, box: SwapBox, view: DeckView): void {
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO deck_versions (deck_id, message_id, build_id, policy_sha, deck_json, created_at)
       SELECT id, ?, build_id, policy_sha, deck_json, ? FROM decks WHERE id = ?`,
    ).run(messageId, now(), deckId);
    db.prepare('UPDATE decks SET build_id = ?, policy_sha = ?, deck_json = ? WHERE id = ?').run(view.build_id, view.policy_sha, JSON.stringify(view), deckId);
    setBox(db, messageId, box, 'swapped');
    addMessage(db, deckId, 'note', `You swapped: ${swapLine(box)}. The deck has changed.`);
  });
}

/** The swap that "Undo" takes back: the newest stored version. */
export function lastVersion(db: DatabaseSync, deckId: number) {
  return db.prepare('SELECT id, message_id, build_id, policy_sha, deck_json FROM deck_versions WHERE deck_id = ? ORDER BY id DESC LIMIT 1').get(deckId) as
    { id: number; message_id: number; build_id: number; policy_sha: string; deck_json: string } | undefined;
}

/** Puts back the deck before the last swap, as it was stored. False when no swap remains. */
export function undoSwap(db: DatabaseSync, deckId: number): boolean {
  const v = lastVersion(db, deckId);
  if (!v) return false;
  const box = swapBoxOf(db, deckId, v.message_id)!;
  inTransaction(db, () => {
    db.prepare('UPDATE decks SET build_id = ?, policy_sha = ?, deck_json = ? WHERE id = ?').run(v.build_id, v.policy_sha, v.deck_json, deckId);
    db.prepare('DELETE FROM deck_versions WHERE id = ?').run(v.id);
    setBox(db, v.message_id, box, 'undone');
    addMessage(db, deckId, 'note', `You undid this swap: ${swapLine(box)}. The deck has changed.`);
  });
  return true;
}
