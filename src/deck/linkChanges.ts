/**
 * Link review (docs/superpowers/specs/2026-11-03-link-review-design.md): the suggestions of a link
 * check, the owner answers, the apply requests and the owner links.
 *
 * A suggestion and an owner answer change no link (design sec. 1). Only an owner link, which an
 * apply session writes with `npm run link-apply`, changes the pair table, through `withOwnerLinks`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { BuildIndex } from '../graph/buildIndex.js';
import { reasonLinks, reasonRules, typeLabels } from '../graph/fixRequests.js';
import { linkKind, type DeckView } from './justify.js';
import { clearWeakMark, saveWeakMark } from './marks.js';
import { OWNER_KEY, type PairLink, type PairTable } from './pairs.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The project folder: the apply session opens here (design sec. 7.2). */
export const PROJECT_ROOT = resolve(here, '../..');

export type SuggestionKind = 'delete' | 'add' | 'correct';
export type CorrectChange = 'weak' | 'not_weak' | 'wrong_reason';
export type Sign = '+' | '-';
export type SuggestionState = 'open' | 'answered' | 'in_request' | 'applied' | 'question' | 'rejected' | 'stale';
export type OwnerAnswer = 'yes' | 'weak' | 'no';

export class LinkChangeError extends Error {
  constructor(readonly kind: 'invalid' | 'not_found' | 'conflict', message: string) { super(message); }
}

interface SuggestionRow {
  id: number; deck_id: number; build_id: number; kind: SuggestionKind; change: CorrectChange | null; sign: Sign;
  supply_oracle: string; demand_oracle: string; edge_key: string | null; rule_hashes: string; reason: string;
  state: SuggestionState; answer: OwnerAnswer | null; owner_note: string; answered_at: string | null; apply_id: number | null;
  question: string | null; fix: string | null; applied_build: number | null; created_at: string; updated_at: string;
}

interface RequestRow {
  id: number; state: 'open' | 'done' | 'cancelled'; suggestion_ids: string; report_ids: string; prompt: string;
  results: string | null; created_at: string; done_at: string | null;
}

interface ReportRow { id: number; build_id: number; edge_key: string; supply_oracle: string; demand_oracle: string; rule_hashes: string; note: string; status: string; created_at: string }

interface OwnerLinkRow {
  id: number; supply_oracle: string; demand_oracle: string; effect: 'add' | 'block'; sign: Sign; weak: number;
  suggestion_id: number | null; note: string; created_at: string; removed_at: string | null;
}

const now = () => new Date().toISOString();

// ---------- owner links in the pair table ----------

/** The owner links that act now, the oldest first, so a newer link on the same pair wins. */
export function activeOwnerLinks(db: DatabaseSync): OwnerLinkRow[] {
  // A read-only database from before migration 26 (npm run deck) has no such table, and so no owner link.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner_links'").get()) return [];
  return db.prepare('SELECT * FROM owner_links WHERE removed_at IS NULL ORDER BY id').all() as unknown as OwnerLinkRow[];
}

/**
 * A copy of `t` with the owner links (design sec. 8): `add` puts a link with `weight` (a weak owner
 * link keeps `weakFactor` of it), and `block` removes the links of that direction. `t` does not
 * change, so the server can keep it in memory. An apply session writes owner links only between
 * spells of a deck, so both cards are in the scope of the table.
 */
export function withOwnerLinks(t: PairTable, links: readonly OwnerLinkRow[], weight: number, weakFactor: number): PairTable {
  if (links.length === 0) return t;
  const pos = new Map(t.pos);
  const anti = new Map(t.anti);
  const linked = new Map(t.linked);
  const set = (m: Map<string, Map<string, PairLink>>, a: string, b: string, l: PairLink | null) => {
    const row = new Map(m.get(a) ?? []);
    if (l) row.set(b, l); else row.delete(b);
    if (row.size > 0) m.set(a, row); else m.delete(a);
  };
  const relink = (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const s = new Set(linked.get(x) ?? []);
      if (pos.get(x)?.has(y) || pos.get(y)?.has(x)) s.add(y); else s.delete(y);
      if (s.size > 0) linked.set(x, s); else linked.delete(x);
    }
  };
  for (const o of links) {
    const [a, b] = [o.supply_oracle, o.demand_oracle];
    if (a === b) continue;
    const link: PairLink | null = o.effect === 'block' ? null : {
      supply: a, demand: b, weight: o.weak ? weight * weakFactor : weight, key: `${OWNER_KEY}${o.id}`, grade: 'confirmed',
      rule_hashes: [], atom_ids: [], demand_atom_id: 0, ...(o.weak ? { weak: true as const } : {}),
    };
    if (o.sign === '+') {
      set(pos, a, b, link);
      relink(a, b);
    } else {
      set(anti, a, b, link);
      set(anti, b, a, link && { ...link, supply: b, demand: a });
    }
  }
  return { ...t, pos, anti, linked };
}

/** Removes an owner link (the false link button on the deck page). */
export function removeOwnerLink(db: DatabaseSync, id: number): boolean {
  return db.prepare('UPDATE owner_links SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now(), id).changes > 0;
}

// ---------- plain words ----------

interface CardInfo { oracle_id: string; name: string; text: string }

/** The name and the text of each card, all faces, in one line each. */
export function cardInfos(db: DatabaseSync, ids: Iterable<string>): Map<string, CardInfo> {
  const rows = db.prepare(
    `SELECT f.oracle_id, c.name AS card_name, f.name, f.mana_cost, f.type_line, f.oracle_text, f.power, f.toughness
       FROM card_faces f JOIN cards c ON c.oracle_id = f.oracle_id JOIN json_each(?) j ON j.value = f.oracle_id
      ORDER BY f.oracle_id, f.face_index`,
  ).all(JSON.stringify([...new Set(ids)])) as Array<{ oracle_id: string; card_name: string; name: string; mana_cost: string | null; type_line: string; oracle_text: string; power: string | null; toughness: string | null }>;
  const out = new Map<string, CardInfo>();
  for (const f of rows) {
    const body = f.power !== null ? ` ${f.power}/${f.toughness}` : '';
    const face = `${f.mana_cost ? `${f.mana_cost} ` : ''}${f.type_line}${body}: ${f.oracle_text.replace(/\n/g, ' / ')}`;
    const old = out.get(f.oracle_id);
    out.set(f.oracle_id, { oracle_id: f.oracle_id, name: f.card_name, text: old ? `${old.text} // ${f.name}: ${face}` : f.name === f.card_name ? face : `${f.name}: ${face}` });
  }
  return out;
}

const isOwner = (l: PairLink) => l.key.startsWith(OWNER_KEY);

/** The link kind with the plain tag names. */
function plainKind(idx: BuildIndex, l: PairLink, labels: Record<string, string>): string {
  if (isOwner(l)) return 'your link';
  return linkKind(idx, l).replace(/[A-Z_]+\.[A-Z_0-9]+/g, (t) => labels[t] ?? t);
}

function quotes(db: DatabaseSync, links: readonly PairLink[]): Map<number, string> {
  const ids = [...new Set(links.flatMap((l) => l.atom_ids))];
  return new Map((db.prepare('SELECT a.id, a.quote FROM atoms a JOIN json_each(?) j ON j.value = a.id').all(JSON.stringify(ids)) as Array<{ id: number; quote: string }>)
    .map((r) => [r.id, r.quote]));
}

/** The link of `t` in this direction and with this sign, or undefined. */
export function linkNow(t: PairTable, sign: Sign, a: string, b: string): PairLink | undefined {
  return sign === '+' ? t.pos.get(a)?.get(b) : t.anti.get(a)?.get(b);
}

export interface LinkNow {
  key: string; grade: string; weight: number; kind: string; rule_ids: string[];
  supply_quote: string; demand_quote: string; weak: boolean; owner_link: number | null;
}

function linkView(idx: BuildIndex, l: PairLink, q: Map<number, string>, labels: Record<string, string>): LinkNow {
  const supplyAtoms = l.atom_ids.filter((id) => id !== l.demand_atom_id);
  const quote = (ids: number[]) => [...new Set(ids.map((id) => q.get(id) ?? ''))].filter(Boolean).join(' / ');
  return {
    key: l.key, grade: l.grade, weight: Math.round(l.weight * 1000) / 1000, kind: plainKind(idx, l, labels),
    rule_ids: l.rule_hashes.map((h) => idx.ruleOf(h)?.rule_id ?? h.slice(0, 8)),
    supply_quote: quote(supplyAtoms), demand_quote: quote(isOwner(l) ? [] : [l.demand_atom_id]), weak: l.weak === true,
    owner_link: isOwner(l) ? Number(l.key.slice(OWNER_KEY.length)) : null,
  };
}

// ---------- the check (design sec. 5) ----------

/** The fixed message of the button "Check the links with Claude" (design sec. 2). */
export const LINK_CHECK_MESSAGE =
  'Check the links of this deck. Follow the section "Link check": call deck_links and deck_state, judge each link and the spell pairs with no link, and write each suggestion with propose_link_change, the most important first. Then give me the count of each kind and the 3 most important suggestions.';

const LIVE: readonly SuggestionState[] = ['open', 'answered', 'question', 'in_request'];

/** The spells of a deck view: the pair table holds only spells. */
const spellsOf = (view: DeckView) => view.cards.filter((c) => c.role !== 'land');

/** The text of the tool `deck_links`: all links between the spells of the deck, with their marks. */
export function deckLinksText(db: DatabaseSync, idx: BuildIndex, t: PairTable, view: DeckView, deckId: number): string {
  const labels = typeLabels(db);
  const spells = spellsOf(view).sort((a, b) => (a.name < b.name ? -1 : 1));
  const ids = spells.map((c) => c.oracle_id);
  const name = new Map(spells.map((c) => [c.oracle_id, c.name]));
  const good: PairLink[] = [];
  const bad: PairLink[] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const p = t.pos.get(a)?.get(b);
      if (p) good.push(p);
      const n = t.anti.get(a)?.get(b);
      if (n && a < b) bad.push(n);
    }
  }
  const q = quotes(db, [...good, ...bad]);
  const reports = new Map((db.prepare(`SELECT edge_key, id FROM edge_reports WHERE status = 'open' AND edge_key IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify([...good, ...bad].map((l) => l.key))) as Array<{ edge_key: string; id: number }>).map((r) => [r.edge_key, r.id]));
  const live = db.prepare(`SELECT id, kind, sign, supply_oracle, demand_oracle FROM link_suggestions WHERE deck_id = ? AND state IN (${LIVE.map(() => '?').join(',')})`)
    .all(deckId, ...LIVE) as Array<{ id: number; kind: string; sign: Sign; supply_oracle: string; demand_oracle: string }>;
  const openOn = (sign: Sign, a: string, b: string) => live.filter((s) => s.sign === sign && s.supply_oracle === a && s.demand_oracle === b).map((s) => `open suggestion ${s.id} (${s.kind})`);
  const line = (l: PairLink, sign: Sign) => {
    const v = linkView(idx, l, q, labels);
    const marks = [...(v.weak ? ['weak'] : []), ...(v.owner_link !== null ? [`owner link ${v.owner_link}`] : []),
      ...(reports.has(l.key) ? [`false link report ${reports.get(l.key)}`] : []), ...openOn(sign, l.supply, l.demand)];
    const head = sign === '+' ? `[[${name.get(l.supply)}]] helps [[${name.get(l.demand)}]]` : `[[${name.get(l.supply)}]] and [[${name.get(l.demand)}]] are bad together`;
    const words = [
      v.supply_quote ? `[[${name.get(l.supply)}]] gives: "${v.supply_quote}".` : '',
      v.demand_quote ? `[[${name.get(l.demand)}]] needs: "${v.demand_quote}".` : '',
    ].filter(Boolean).join(' ');
    return `- ${head} (${v.grade}, weight ${v.weight}). Kind: ${v.kind}.${words ? ` ${words}` : ''}${v.rule_ids.length ? ` Rules: ${v.rule_ids.join(', ')}.` : ''}${marks.length ? ` Marks: ${marks.join('; ')}.` : ''}`;
  };
  const unlinked = ids.flatMap((a, i) => ids.slice(i + 1).filter((b) => !t.linked.get(a)?.has(b)).map((b) => `[[${name.get(a)}]] / [[${name.get(b)}]]`));
  return [
    `Links of deck ${deckId} on build ${t.buildId}: ${good.length} good together and ${bad.length} bad together, between ${ids.length} spells. Lands are not in the links.`,
    '', 'Good together (the first card helps the second card):', ...(good.length ? good.map((l) => line(l, '+')) : ['None']),
    '', 'Bad together:', ...(bad.length ? bad.map((l) => line(l, '-')) : ['None']),
    '', `Spell pairs with no good together link in either direction (${unlinked.length}):`, unlinked.join(', ') || 'None',
  ].join('\n');
}

export const ProposeZ = z.object({
  kind: z.enum(['delete', 'add', 'correct']),
  change: z.enum(['weak', 'not_weak', 'wrong_reason']).optional(),
  sign: z.enum(['+', '-']).optional(),
  supply: z.string().min(1),
  demand: z.string().min(1),
  reason: z.string().trim().min(1).max(800),
}).strict();
export type ProposeInput = z.infer<typeof ProposeZ>;

/** The JSON schema of the tool `propose_link_change`. */
export const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['delete', 'add', 'correct'], description: 'delete: the link is false. add: the cards help each other (or are bad together), but the app has no link. correct: the link is real, but the app shows it wrong.' },
    change: { type: 'string', enum: ['weak', 'not_weak', 'wrong_reason'], description: 'Only for kind correct. weak: the link is weak. not_weak: the weak mark is wrong. wrong_reason: the pair is a real link, but the reason of the app is false.' },
    sign: { type: 'string', enum: ['+', '-'], description: '+ for good together (default), - for bad together' },
    supply: { type: 'string', description: 'The name of the card that helps (for + links), or the first card (for - links)' },
    demand: { type: 'string', description: 'The name of the card that gets the help, or the second card' },
    reason: { type: 'string', description: 'One or two sentences. Name the words of each card that make the link or that stop it.' },
  },
  required: ['kind', 'supply', 'demand', 'reason'],
  additionalProperties: false,
};

/** Checks and writes one suggestion (design sec. 5). The cards are oracle IDs. Gives the text for Claude. */
export function proposeLinkChange(
  db: DatabaseSync, c: { idx: BuildIndex; table: PairTable; view: DeckView; deckId: number; max: number; weakKeys: ReadonlySet<string> },
  input: Omit<ProposeInput, 'supply' | 'demand'> & { supply: string; demand: string },
): { id: number; text: string } {
  const sign: Sign = input.sign ?? '+';
  const spells = new Map(spellsOf(c.view).map((x) => [x.oracle_id, x.name]));
  for (const id of [input.supply, input.demand]) if (!spells.has(id)) throw new LinkChangeError('invalid', 'a card of the suggestion is not a spell of this deck. Lands are not in the links');
  if (input.supply === input.demand) throw new LinkChangeError('invalid', 'the two cards are the same card');
  if (input.kind === 'correct' && !input.change) throw new LinkChangeError('invalid', 'a correct suggestion needs a change: weak, not_weak or wrong_reason');
  if (input.kind !== 'correct' && input.change) throw new LinkChangeError('invalid', 'only a correct suggestion has a change');
  if (input.kind === 'correct' && sign === '-' && input.change !== 'wrong_reason') throw new LinkChangeError('invalid', 'a bad together link has no weak mark');
  // A bad together link has no direction, so the lower ID goes first.
  const [a, b] = sign === '-' && input.demand < input.supply ? [input.demand, input.supply] : [input.supply, input.demand];
  const link = linkNow(c.table, sign, a, b);
  const pair = `[[${spells.get(a)}]] ${sign === '+' ? '->' : 'and'} [[${spells.get(b)}]]`;
  if (input.kind === 'add' && link) throw new LinkChangeError('invalid', `${pair} already has a ${sign} link. Use kind correct or delete`);
  if (input.kind !== 'add' && !link) throw new LinkChangeError('invalid', `${pair} has no ${sign} link on the newest build. Use kind add`);
  const weak = link?.weak === true || c.weakKeys.has(`${a}>${b}`);
  if (input.change === 'weak' && weak) throw new LinkChangeError('invalid', `${pair} is already weak`);
  if (input.change === 'not_weak' && !weak) throw new LinkChangeError('invalid', `${pair} has no weak mark`);
  const dup = db.prepare(`SELECT id FROM link_suggestions WHERE kind = ? AND sign = ? AND supply_oracle = ? AND demand_oracle = ? AND state IN (${LIVE.map(() => '?').join(',')})`)
    .get(input.kind, sign, a, b, ...LIVE) as { id: number } | undefined;
  if (dup) throw new LinkChangeError('conflict', `suggestion ${dup.id} is already open on ${pair}`);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM link_suggestions WHERE deck_id = ? AND created_at > COALESCE((SELECT MAX(created_at) FROM deck_chat_messages WHERE deck_id = ? AND role = 'owner'), '')`)
    .get(c.deckId, c.deckId) as { n: number };
  if (n >= c.max) throw new LinkChangeError('conflict', `this check already wrote ${c.max} suggestions, the limit. Stop, and tell the owner`);
  const t = now();
  const id = Number(db.prepare(
    `INSERT INTO link_suggestions (deck_id, build_id, kind, change, sign, supply_oracle, demand_oracle, edge_key, rule_hashes, reason, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(c.deckId, c.table.buildId ?? 0, input.kind, input.change ?? null, sign, a, b, link?.key ?? null, JSON.stringify(link?.rule_hashes ?? []), input.reason, t, t).lastInsertRowid);
  return { id, text: `Suggestion ${id} is on the Decisions page: ${input.kind}${input.change ? ` (${input.change})` : ''} ${sign} ${pair}. ${n + 1} of at most ${c.max} in this check.` };
}

// ---------- the tab "Link changes" (design sec. 6) ----------

export interface SuggestionView {
  id: number; deck_id: number; kind: SuggestionKind; change: CorrectChange | null; sign: Sign;
  supply: CardInfo; demand: CardInfo; reason: string; state: SuggestionState; answer: OwnerAnswer | null; owner_note: string;
  question: string | null; fix: string | null; applied_build: number | null; apply_id: number | null; created_at: string;
  /** The link of the newest build in this direction and with this sign. */
  link: LinkNow | null;
  /** The newest build already has the change (design sec. 6). */
  stale: boolean;
}

export interface ApplyRequestView {
  id: number; state: RequestRow['state']; suggestions: number; reports: number; prompt: string; link: string;
  results: string | null; created_at: string; done_at: string | null;
}

export interface LinkChangesPage {
  build_id: number | null;
  items: SuggestionView[];
  /** What a new apply request takes now. */
  to_apply: { suggestions: number; reports: number };
  open_request: ApplyRequestView | null;
  requests: ApplyRequestView[];
}

/** True when the newest build already has the change of the suggestion. */
export function isStale(s: Pick<SuggestionRow, 'kind' | 'change' | 'sign' | 'supply_oracle' | 'demand_oracle'>, t: PairTable, weakKeys: ReadonlySet<string>): boolean {
  const link = linkNow(t, s.sign, s.supply_oracle, s.demand_oracle);
  if (s.kind === 'add') return link !== undefined;
  if (!link) return true;
  const weak = link.weak === true || weakKeys.has(`${s.supply_oracle}>${s.demand_oracle}`);
  if (s.change === 'weak') return weak;
  if (s.change === 'not_weak') return !weak;
  return false;
}

/** The link of a desktop app session with this prompt in this folder (design sec. 7.2). */
export const desktopLink = (prompt: string, folder = PROJECT_ROOT) => `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`;

export const applyPrompt = (id: number) =>
  `Apply link change request ${id} of the MTGA deck builder. Follow config/link-apply-procedure.md. Start with: npm run link-apply -- --show ${id}`;

function requestView(r: RequestRow): ApplyRequestView {
  return {
    id: r.id, state: r.state, suggestions: (JSON.parse(r.suggestion_ids) as number[]).length, reports: (JSON.parse(r.report_ids) as number[]).length,
    prompt: r.prompt, link: desktopLink(r.prompt), results: r.results, created_at: r.created_at, done_at: r.done_at,
  };
}

/** The open false link reports that no fix request and no live apply request holds (design sec. 7.1). */
export function freeReports(db: DatabaseSync): ReportRow[] {
  const held = new Set<number>();
  for (const r of db.prepare('SELECT report_ids FROM fix_requests').all() as Array<{ report_ids: string }>) for (const id of JSON.parse(r.report_ids) as number[]) held.add(id);
  for (const r of db.prepare("SELECT report_ids FROM link_apply_requests WHERE state <> 'cancelled'").all() as Array<{ report_ids: string }>) for (const id of JSON.parse(r.report_ids) as number[]) held.add(id);
  return (db.prepare("SELECT * FROM edge_reports WHERE status = 'open' ORDER BY id").all() as unknown as ReportRow[]).filter((r) => !held.has(r.id));
}

const ANSWERED_TO_APPLY = "state = 'answered' AND answer IN ('yes','weak')";

export function linkChangesPage(db: DatabaseSync, idx: BuildIndex, t: PairTable, weakKeys: ReadonlySet<string>): LinkChangesPage {
  // In the order of the checks, and in a check in the order that Claude wrote them: the most important first.
  const rows = db.prepare(`SELECT * FROM link_suggestions WHERE state <> 'applied' OR updated_at > ? ORDER BY id`)
    .all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as unknown as SuggestionRow[];
  const cards = cardInfos(db, rows.flatMap((r) => [r.supply_oracle, r.demand_oracle]));
  const links = rows.map((r) => linkNow(t, r.sign, r.supply_oracle, r.demand_oracle));
  const q = quotes(db, links.filter((l): l is PairLink => l !== undefined));
  const labels = typeLabels(db);
  const card = (id: string): CardInfo => cards.get(id) ?? { oracle_id: id, name: id, text: '' };
  const items = rows.map((r, i): SuggestionView => ({
    id: r.id, deck_id: r.deck_id, kind: r.kind, change: r.change, sign: r.sign, supply: card(r.supply_oracle), demand: card(r.demand_oracle),
    reason: r.reason, state: r.state, answer: r.answer, owner_note: r.owner_note, question: r.question, fix: r.fix, applied_build: r.applied_build,
    apply_id: r.apply_id, created_at: r.created_at, link: links[i] ? linkView(idx, links[i]!, q, labels) : null,
    stale: ['open', 'answered', 'rejected', 'question'].includes(r.state) && isStale(r, t, weakKeys),
  }));
  const requests = (db.prepare('SELECT * FROM link_apply_requests ORDER BY id DESC LIMIT 20').all() as unknown as RequestRow[]).map(requestView);
  const toApply = items.filter((s) => s.state === 'answered' && s.answer !== 'no' && !s.stale).length;
  return {
    build_id: t.buildId, items, to_apply: { suggestions: toApply, reports: freeReports(db).length },
    open_request: requests.find((r) => r.state === 'open') ?? null, requests,
  };
}

const ANSWERS: Record<SuggestionKind, readonly OwnerAnswer[]> = { delete: ['yes', 'weak', 'no'], add: ['yes', 'weak', 'no'], correct: ['yes', 'no'] };

/** Saves an owner answer and a note. An answer changes no link (design sec. 6). */
export function answerSuggestion(db: DatabaseSync, id: number, answer: OwnerAnswer, note: string): SuggestionRow {
  const r = db.prepare('SELECT * FROM link_suggestions WHERE id = ?').get(id) as unknown as SuggestionRow | undefined;
  if (!r) throw new LinkChangeError('not_found', `no suggestion ${id}`);
  if (!['open', 'answered', 'rejected', 'question'].includes(r.state)) throw new LinkChangeError('conflict', `suggestion ${id} is ${r.state.replace('_', ' ')}, so the answer cannot change`);
  if (!ANSWERS[r.kind].includes(answer)) throw new LinkChangeError('invalid', `a ${r.kind} suggestion takes the answers ${ANSWERS[r.kind].join(', ')}`);
  const t = now();
  db.prepare('UPDATE link_suggestions SET answer = ?, owner_note = ?, state = ?, answered_at = ?, updated_at = ? WHERE id = ?')
    .run(answer, note.trim(), answer === 'no' ? 'rejected' : 'answered', t, t, id);
  return db.prepare('SELECT * FROM link_suggestions WHERE id = ?').get(id) as unknown as SuggestionRow;
}

// ---------- apply requests (design sec. 7.1) ----------

/** Makes an apply request, or gives the open one. Stale items become `stale` and stay out. */
export function createApplyRequest(db: DatabaseSync, t: PairTable, weakKeys: ReadonlySet<string>): ApplyRequestView {
  const open = db.prepare("SELECT * FROM link_apply_requests WHERE state = 'open' ORDER BY id DESC LIMIT 1").get() as unknown as RequestRow | undefined;
  if (open) return requestView(open);
  db.exec('BEGIN IMMEDIATE');
  try {
    const ts = now();
    const answered = db.prepare(`SELECT * FROM link_suggestions WHERE ${ANSWERED_TO_APPLY} ORDER BY id`).all() as unknown as SuggestionRow[];
    const take: number[] = [];
    for (const s of answered) {
      if (isStale(s, t, weakKeys)) db.prepare("UPDATE link_suggestions SET state = 'stale', updated_at = ? WHERE id = ?").run(ts, s.id);
      else take.push(s.id);
    }
    const reports = freeReports(db).map((r) => r.id);
    if (take.length === 0 && reports.length === 0) {
      db.exec('COMMIT');
      throw new LinkChangeError('conflict', 'nothing to apply: no approved suggestion and no open false link report');
    }
    const id = Number(db.prepare("INSERT INTO link_apply_requests (state, suggestion_ids, report_ids, prompt, created_at) VALUES ('open', ?, ?, '', ?)")
      .run(JSON.stringify(take), JSON.stringify(reports), ts).lastInsertRowid);
    db.prepare('UPDATE link_apply_requests SET prompt = ? WHERE id = ?').run(applyPrompt(id), id);
    const mark = db.prepare("UPDATE link_suggestions SET state = 'in_request', apply_id = ?, updated_at = ? WHERE id = ?");
    for (const s of take) mark.run(id, ts, s);
    db.exec('COMMIT');
    return requestView(db.prepare('SELECT * FROM link_apply_requests WHERE id = ?').get(id) as unknown as RequestRow);
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Cancels an open request. Its items return to the tab (design sec. 7.1). */
export function cancelApplyRequest(db: DatabaseSync, id: number): void {
  const r = db.prepare('SELECT * FROM link_apply_requests WHERE id = ?').get(id) as unknown as RequestRow | undefined;
  if (!r) throw new LinkChangeError('not_found', `no apply request ${id}`);
  if (r.state !== 'open') throw new LinkChangeError('conflict', `apply request ${id} is ${r.state}`);
  const ts = now();
  db.prepare("UPDATE link_suggestions SET state = 'answered', apply_id = NULL, updated_at = ? WHERE apply_id = ? AND state = 'in_request'").run(ts, id);
  db.prepare("UPDATE link_apply_requests SET state = 'cancelled', done_at = ? WHERE id = ?").run(ts, id);
}

// ---------- the apply session (design sec. 7.3, npm run link-apply) ----------

function suggestionRow(db: DatabaseSync, id: number): SuggestionRow {
  const r = db.prepare('SELECT * FROM link_suggestions WHERE id = ?').get(id) as unknown as SuggestionRow | undefined;
  if (!r) throw new LinkChangeError('not_found', `no suggestion ${id}`);
  return r;
}

function requestRow(db: DatabaseSync, id: number): RequestRow {
  const r = db.prepare('SELECT * FROM link_apply_requests WHERE id = ?').get(id) as unknown as RequestRow | undefined;
  if (!r) throw new LinkChangeError('not_found', `no apply request ${id}`);
  return r;
}

const ANSWER_WORDS: Record<SuggestionKind, Record<OwnerAnswer, string>> = {
  delete: { yes: 'Yes, no link', weak: 'Weak, not false', no: 'No, keep the link' },
  add: { yes: 'Yes, add it', weak: 'Add it as weak', no: 'No' },
  correct: { yes: 'Yes', no: 'No', weak: 'Weak' },
};

/** The rules of a link, each with its sentence and the card pairs that it makes on the build. */
function ruleLines(db: DatabaseSync, idx: BuildIndex, buildId: number, hashes: readonly string[], labels: Record<string, string>): string[] {
  if (hashes.length === 0) return ['  Rules: none (an owner link or no link).'];
  const set = (db.prepare('SELECT rule_set_id FROM graph_builds WHERE id = ?').get(buildId) as { rule_set_id: number } | undefined)?.rule_set_id ?? null;
  return reasonRules(db, hashes, labels, set).map((r) => {
    const pairs = reasonLinks(db, idx, buildId, [r], 0).card_pairs;
    return `  - ${r.rule_id} (hash ${r.rule_hash.slice(0, 12)}, set ${r.rule_set_id}, ${r.status}, ${r.votes} votes): ${r.sentence} Card pairs of this rule on build ${buildId}: ${pairs.toLocaleString('en-US')}.`;
  });
}

/** The text of `npm run link-apply -- --show <id>` (design sec. 7.3 step 1). */
export function applyRequestText(db: DatabaseSync, idx: BuildIndex, t: PairTable, weakKeys: ReadonlySet<string>, id: number): string {
  const r = requestRow(db, id);
  const buildId = t.buildId ?? 0;
  const labels = typeLabels(db);
  const sids = JSON.parse(r.suggestion_ids) as number[];
  const rids = JSON.parse(r.report_ids) as number[];
  const sugs = sids.map((s) => suggestionRow(db, s));
  const reps = (db.prepare('SELECT * FROM edge_reports WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(rids)) as unknown as ReportRow[]);
  const cards = cardInfos(db, [...sugs, ...reps].flatMap((x) => [x.supply_oracle, x.demand_oracle]));
  const nameOf = (id2: string) => cards.get(id2)?.name ?? id2;
  const cardLine = (role: string, id2: string) => `  ${role}: [[${nameOf(id2)}]] ${cards.get(id2)?.text ?? ''}`;
  const nowLines = (sign: Sign, a: string, b: string) => {
    const l = linkNow(t, sign, a, b);
    if (!l) return [`  Link on build ${buildId}: none.`];
    const v = linkView(idx, l, quotes(db, [l]), labels);
    return [
      `  Link on build ${buildId}: ${v.grade}, weight ${v.weight}, kind ${v.kind}${v.weak ? ', weak' : ''}${v.owner_link !== null ? `, owner link ${v.owner_link}` : ''}.`,
      ...(v.supply_quote ? [`  Supply words: "${v.supply_quote}"`] : []), ...(v.demand_quote ? [`  Demand words: "${v.demand_quote}"`] : []),
      ...ruleLines(db, idx, buildId, l.rule_hashes, labels),
    ];
  };
  const out = [
    `Link change request ${r.id} (${r.state}), made ${r.created_at}.`,
    `Newest build: ${buildId}. Items: ${sugs.length} suggestion${sugs.length === 1 ? '' : 's'} and ${reps.length} false link report${reps.length === 1 ? '' : 's'}.`,
    'Follow config/link-apply-procedure.md. Show the plan to the owner and get one yes before a change.',
  ];
  for (const s of sugs) {
    const what = s.kind === 'correct' ? `correct (${s.change}) a ${s.sign} link` : `${s.kind} a ${s.sign} link`;
    out.push('', `## Suggestion ${s.id}: ${what} (state ${s.state}${isStale(s, t, weakKeys) ? ', STALE on this build' : ''})`,
      `  Deck ${s.deck_id}, written on build ${s.build_id}. Owner answer: "${s.answer ? ANSWER_WORDS[s.kind][s.answer] : 'none'}".${s.owner_note ? ` Owner note: "${s.owner_note}".` : ''}`,
      ...(s.question ? [`  Earlier question of an apply session: "${s.question}"`] : []),
      `  Reason of Claude: ${s.reason}`,
      cardLine(s.sign === '+' ? 'Supply' : 'Card 1', s.supply_oracle), cardLine(s.sign === '+' ? 'Demand' : 'Card 2', s.demand_oracle),
      ...nowLines(s.sign, s.supply_oracle, s.demand_oracle),
      ...(s.kind !== 'add' && s.rule_hashes !== '[]' && !linkNow(t, s.sign, s.supply_oracle, s.demand_oracle) ? ['  Rules when Claude wrote it:', ...ruleLines(db, idx, buildId, JSON.parse(s.rule_hashes) as string[], labels)] : []));
  }
  for (const p of reps) {
    out.push('', `## Report ${p.id}: false link (marked on build ${p.build_id}, ${p.created_at})`, `  Owner note: "${p.note}"`,
      cardLine('Supply', p.supply_oracle), cardLine('Demand', p.demand_oracle), ...nowLines('+', p.supply_oracle, p.demand_oracle),
      ...(!linkNow(t, '+', p.supply_oracle, p.demand_oracle) ? ['  Rules when the owner marked it:', ...ruleLines(db, idx, buildId, JSON.parse(p.rule_hashes) as string[], labels)] : []));
  }
  out.push('', 'Commands:',
    '  npm run link-apply -- --owner-link <suggestion> [--block | --add]',
    '  npm run link-apply -- --weak <suggestion> [--remove]',
    '  npm run link-apply -- --applied <suggestion>[,...] --how "<fix>" [--build <id>]',
    '  npm run link-apply -- --question <suggestion> --text "<question>"',
    '  npm run link-apply -- --report <id>[,...] --status accepted|rejected',
    `  npm run link-apply -- --done ${r.id} --results "<file and section>"`);
  return out.join('\n');
}

/** Writes an owner link from a suggestion: `block` for a delete, `add` for the others, unless `effect` says. */
export function writeOwnerLink(db: DatabaseSync, sid: number, effect?: 'add' | 'block'): number {
  const s = suggestionRow(db, sid);
  const e = effect ?? (s.kind === 'delete' ? 'block' : 'add');
  const weak = e === 'add' && (s.answer === 'weak' || s.change === 'weak') ? 1 : 0;
  return Number(db.prepare('INSERT INTO owner_links (supply_oracle, demand_oracle, effect, sign, weak, suggestion_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.supply_oracle, s.demand_oracle, e, s.sign, weak, sid, s.owner_note, now()).lastInsertRowid);
}

/** Writes (or removes) the weak mark of a suggestion, as the weak button of the deck page does. */
export function weakFromSuggestion(db: DatabaseSync, sid: number, remove: boolean): void {
  const s = suggestionRow(db, sid);
  if (s.sign !== '+') throw new LinkChangeError('invalid', 'a bad together link has no weak mark');
  if (remove) clearWeakMark(db, s.supply_oracle, s.demand_oracle);
  else saveWeakMark(db, s.supply_oracle, s.demand_oracle, `Link review suggestion ${sid}.${s.owner_note ? ` ${s.owner_note}` : ''}`);
}

export function markApplied(db: DatabaseSync, ids: readonly number[], how: string, build: number | null): void {
  for (const id of ids) {
    const s = suggestionRow(db, id);
    if (s.state !== 'in_request') throw new LinkChangeError('conflict', `suggestion ${id} is ${s.state}, not in a request`);
  }
  const mark = db.prepare("UPDATE link_suggestions SET state = 'applied', fix = ?, applied_build = ?, updated_at = ? WHERE id = ?");
  for (const id of ids) mark.run(how, build, now(), id);
}

/** Sends an item back to the tab with a question (design sec. 7.3). The next request takes the answer. */
export function sendQuestion(db: DatabaseSync, sid: number, text: string): void {
  const s = suggestionRow(db, sid);
  if (s.state !== 'in_request') throw new LinkChangeError('conflict', `suggestion ${sid} is ${s.state}, not in a request`);
  db.prepare("UPDATE link_suggestions SET state = 'question', question = ?, apply_id = NULL, updated_at = ? WHERE id = ?").run(text.trim(), now(), sid);
}

export function setReportStatus(db: DatabaseSync, ids: readonly number[], status: 'accepted' | 'rejected' | 'open'): number {
  const up = db.prepare('UPDATE edge_reports SET status = ? WHERE id = ?');
  return ids.reduce((n, id) => n + Number(up.run(status, id).changes), 0);
}

/** Closes a request. Each of its suggestions must be applied or sent back with a question. */
export function closeRequest(db: DatabaseSync, id: number, results: string): void {
  const r = requestRow(db, id);
  if (r.state !== 'open') throw new LinkChangeError('conflict', `apply request ${id} is ${r.state}`);
  const left = (db.prepare("SELECT id FROM link_suggestions WHERE apply_id = ? AND state = 'in_request'").all(id) as Array<{ id: number }>).map((x) => x.id);
  if (left.length > 0) throw new LinkChangeError('conflict', `suggestions ${left.join(', ')} are not applied and have no question`);
  db.prepare("UPDATE link_apply_requests SET state = 'done', results = ?, done_at = ? WHERE id = ?").run(results, now(), id);
}

/** The open reports whose link is not on the table (design sec. 10 step 2), and the reports that keep their link. */
export function fixedReports(db: DatabaseSync, t: PairTable): { fixed: ReportRow[]; kept: ReportRow[] } {
  const open = db.prepare("SELECT * FROM edge_reports WHERE status = 'open' ORDER BY id").all() as unknown as ReportRow[];
  const fixed = open.filter((r) => !t.pos.get(r.supply_oracle)?.has(r.demand_oracle));
  return { fixed, kept: open.filter((r) => !fixed.includes(r)) };
}
