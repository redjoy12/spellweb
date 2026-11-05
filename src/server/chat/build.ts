/**
 * The build chat (build chat design sec. 4 to 8): a talk before a deck exists. The talk holds a
 * draft of the goal form and a brief. Claude writes the draft with a tool, the owner writes it on
 * the page, and only the owner builds the deck. The search does not read the brief.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { COLOUR_CHOICES, INTERACTION_LEVELS, MAX_PINNED, type Goal } from '../../deck/goal.js';
import type { DeckPolicy } from '../../deck/policy.js';
import type { ChatSpace } from './turn.js';
import { BUILD_CHAT, chatStore, type ChatRow } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
export const BUILD_PROMPT = resolve(here, '../../../config/build-chat-prompt.md');

export const buildChatStore = chatStore(BUILD_CHAT);

/** The goal form of a talk. It has the fields of the goal, so `checkGoal` reads it with no change. */
export type Draft = Goal;

/** The form that a new talk starts with, as the page starts. */
export const emptyDraft = (p: DeckPolicy): Draft => ({
  colours: 'BR', seeds: [], excluded: [], target_turn: 6, interaction: 'some', min_creatures: p.quotas.min_creatures_default,
  use_rate: false, pinned: [], excluded_tags: [],
});

/** A draft from the page or from the database. `checkGoal` tests it again before a build or a test build. */
export const DraftZ = z.object({
  colours: z.enum(COLOUR_CHOICES),
  seeds: z.array(z.string().min(1)).max(4),
  excluded: z.array(z.string().min(1)),
  target_turn: z.number().int().min(4).max(8),
  interaction: z.enum(INTERACTION_LEVELS),
  min_creatures: z.number().int().min(0).max(30),
  use_rate: z.boolean(),
  pinned: z.array(z.string().min(1)).max(MAX_PINNED),
  excluded_tags: z.array(z.string().min(1)),
}).strict();

export interface BuildChatRow extends ChatRow { chat_id: number; draft: Draft; brief: string; deck_id: number | null; created_at: string }

interface RawRow extends ChatRow { chat_id: number; draft_json: string; brief: string; deck_id: number | null; created_at: string }

export function talkOf(db: DatabaseSync, id: number, p: DeckPolicy): BuildChatRow | null {
  const r = db.prepare('SELECT * FROM build_chats WHERE chat_id = ?').get(id) as unknown as RawRow | undefined;
  if (!r) return null;
  const { draft_json, ...rest } = r;
  const stored = DraftZ.partial().safeParse(JSON.parse(draft_json));
  return { ...rest, draft: { ...emptyDraft(p), ...(stored.success ? stored.data : {}) } };
}

/** A new talk with a new session ID. */
export function createTalk(db: DatabaseSync, model: string, draft: Draft): number {
  return Number(db.prepare('INSERT INTO build_chats (session_id, model, draft_json, created_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), model, JSON.stringify(draft), new Date().toISOString()).lastInsertRowid);
}

/** The talks, newest first, with the first owner message as a title. */
export function talkList(db: DatabaseSync) {
  return db.prepare(
    `SELECT b.chat_id AS id, b.created_at, b.deck_id,
            (SELECT m.text FROM build_chat_messages m WHERE m.chat_id = b.chat_id AND m.role = 'owner' ORDER BY m.id LIMIT 1) AS first_message
       FROM build_chats b ORDER BY b.chat_id DESC LIMIT 30`,
  ).all() as Array<{ id: number; created_at: string; deck_id: number | null; first_message: string | null }>;
}

export function saveDraft(db: DatabaseSync, id: number, draft: Draft, brief: string): void {
  db.prepare('UPDATE build_chats SET draft_json = ?, brief = ? WHERE chat_id = ?').run(JSON.stringify(draft), brief, id);
}

/** After a build, the talk holds the deck ID and takes no new message (design sec. 6). */
export function closeTalk(db: DatabaseSync, id: number, deckId: number): void {
  db.prepare('UPDATE build_chats SET deck_id = ? WHERE chat_id = ?').run(deckId, id);
}

/** The names of the cards of a draft. */
export function namesOf(db: DatabaseSync, ids: readonly string[]): Map<string, { name: string; color_identity: string[] }> {
  const rows = db.prepare('SELECT c.oracle_id, c.name, c.color_identity FROM cards c JOIN json_each(?) j ON j.value = c.oracle_id')
    .all(JSON.stringify([...new Set(ids)])) as Array<{ oracle_id: string; name: string; color_identity: string }>;
  return new Map(rows.map((r) => [r.oracle_id, { name: r.name, color_identity: JSON.parse(r.color_identity) as string[] }]));
}

const INTERACTION_TEXT: Record<Draft['interaction'], string> = { none: 'none', some: 'some', heavy: 'heavy' };

/** The draft as lines of text, with each card name in `[[ ]]`. */
export function draftText(db: DatabaseSync, d: Draft, brief: string): string[] {
  const names = namesOf(db, [...d.seeds, ...d.pinned, ...d.excluded]);
  const list = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `[[${names.get(id)?.name ?? id}]]`).join(', '));
  return [
    `Colours ${d.colours}. Target turn ${d.target_turn}. Interaction ${INTERACTION_TEXT[d.interaction]}. At least ${d.min_creatures} creatures. Card rate ${d.use_rate ? 'on' : 'off'}.`,
    `Seed cards: ${list(d.seeds)}.`,
    `Must have: ${list(d.pinned)}.`,
    `Never cards: ${list(d.excluded)}.`,
    `Never tags: ${d.excluded_tags.length === 0 ? 'none' : d.excluded_tags.join(', ')}.`,
    `Brief: ${brief.trim() || 'empty'}`,
  ];
}

/** The changes between two drafts, as short text for a note. Empty when nothing changed. */
export function draftChanges(db: DatabaseSync, before: Draft, after: Draft, briefBefore: string, briefAfter: string): string[] {
  const out: string[] = [];
  const names = namesOf(db, [...before.seeds, ...before.pinned, ...before.excluded, ...after.seeds, ...after.pinned, ...after.excluded]);
  const name = (id: string) => `[[${names.get(id)?.name ?? id}]]`;
  const value = (k: 'colours' | 'target_turn' | 'interaction' | 'min_creatures' | 'use_rate', label: string) => {
    if (before[k] !== after[k]) out.push(`${label} ${String(before[k])} -> ${String(after[k])}`);
  };
  value('colours', 'colours');
  value('target_turn', 'target turn');
  value('interaction', 'interaction');
  value('min_creatures', 'minimum creatures');
  value('use_rate', 'card rate');
  const list = (k: 'seeds' | 'pinned' | 'excluded', label: string) => {
    const added = after[k].filter((x) => !before[k].includes(x));
    const removed = before[k].filter((x) => !after[k].includes(x));
    if (added.length > 0) out.push(`${label} added: ${added.map(name).join(', ')}`);
    if (removed.length > 0) out.push(`${label} removed: ${removed.map(name).join(', ')}`);
  };
  list('seeds', 'seed cards');
  list('pinned', 'must have');
  list('excluded', 'never cards');
  const tagsAdded = after.excluded_tags.filter((x) => !before.excluded_tags.includes(x));
  const tagsRemoved = before.excluded_tags.filter((x) => !after.excluded_tags.includes(x));
  if (tagsAdded.length > 0) out.push(`never tags added: ${tagsAdded.join(', ')}`);
  if (tagsRemoved.length > 0) out.push(`never tags removed: ${tagsRemoved.join(', ')}`);
  if (briefBefore.trim() !== briefAfter.trim()) out.push('the brief changed');
  return out;
}

/** The build chat space: the notes since the last reply, and the form as it is now, go before the owner text. */
export function buildSpace(db: DatabaseSync, policy: () => DeckPolicy): ChatSpace {
  return {
    name: 'build', folder: 'build-chat', store: buildChatStore, prompt: BUILD_PROMPT,
    unread(id, chat) {
      const talk = talkOf(db, id, policy())!;
      const notes = buildChatStore.notesSince(db, id, chat.told_message_id);
      const lines = [
        ...(notes.length > 0 ? ['What the owner did since your last reply:', ...notes.map((n) => `- ${n.text}`), ''] : []),
        'The form now:', ...draftText(db, talk.draft, talk.brief), '',
      ];
      const last = notes.at(-1)?.id ?? null;
      return { lines, done: () => { if (last !== null) buildChatStore.setChat(db, id, 'told_message_id', last); } };
    },
  };
}
