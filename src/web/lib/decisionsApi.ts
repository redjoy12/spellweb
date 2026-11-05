/**
 * The client of the "Your decisions" page (src/server/routes/decisions.ts). Its own fetch helpers,
 * so that the page does not depend on the large api.ts.
 */
import type { Decision, DecisionKind, DecisionPage } from '../../graph/ownerDecisions.js';

export type { ConflictItem, CrTextItem, Decision, DecisionKind, DecisionPage, TwinItem } from '../../graph/ownerDecisions.js';
export type { LinkCheckCard, LinkCheckItem } from '../../graph/linkCheck.js';
export type { TagCheckItem, TagCheckTag } from '../../atoms/tagCheck.js';
export type { TagMergeItem, TagMergeSide } from '../../atoms/tagMerge.js';
export type { GoldenCheckItem } from '../../graph/goldenCheck.js';
export type { LinkRuleItem } from '../../graph/linkRuleQuestions.js';
export type { Choice, ReadingItem, RoleItem, RolePair, WrongLinkItem } from '../../graph/ownerQuestions.js';

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} → HTTP ${res.status}`);
  return payload as T;
}

export const decisionsApi = {
  page: () => send<DecisionPage>('GET', '/api/decisions'),
  save: (kind: DecisionKind, itemKey: string, choice: string, note = '') =>
    send<{ decision: Decision }>('POST', '/api/decisions', { kind, item_key: itemKey, choice, note }),
  clear: (kind: DecisionKind, itemKey: string) =>
    send<{ removed: boolean }>('DELETE', `/api/decisions?kind=${encodeURIComponent(kind)}&item_key=${encodeURIComponent(itemKey)}`),
};

/** The words of a text, each marked when the other text does not have it (a word-level diff, by LCS). */
export function diffWords(text: string, other: string): Array<{ word: string; changed: boolean }> {
  const tok = (s: string) => s.split(/(\s+)/).filter((w) => w.length > 0);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const a = tok(text);
  const b = tok(other).filter((w) => !/^\s+$/.test(w)).map(norm).filter(Boolean);
  const aw = a.map((w, i) => ({ i, n: /^\s+$/.test(w) ? '' : norm(w) })).filter((x) => x.n);
  const L = Array.from({ length: aw.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = aw.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i]![j] = aw[i]!.n === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < aw.length && j < b.length;) {
    if (aw[i]!.n === b[j]) { kept.add(aw[i]!.i); i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++; else j++;
  }
  return a.map((word, i) => ({ word, changed: !/^\s+$/.test(word) && norm(word) !== '' && !kept.has(i) }));
}
