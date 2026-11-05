/**
 * The delivery state of a fix request, in plain words (owner request 2026-10-18). The fix-dispatch
 * mod (.claude/skills/fix-dispatch) runs in each Claude session of this project, polls the server
 * every 20 seconds and sends each queued brief to the session with the request's title.
 */

export type FixStatus = 'queued' | 'sent' | 'done';

export interface FixDeliveryInput {
  status: FixStatus; session_name: string; delivery_error: string | null;
}

export interface FixDispatcherInput {
  seen_at: string;
  sessions: Array<{ title: string; archived: boolean }> | null;
  /** The error of the mod's last poll, for example when it cannot read the session list. */
  error?: string | null;
}

/** A dispatcher that has not polled for this long is gone (the mod polls every 20 seconds). */
export const DISPATCHER_GONE_MS = 2 * 60_000;

export interface FixDeliveryState {
  /** The pill text and its CSS class suffix. */
  label: string; tone: 'queued' | 'failed' | 'sent' | 'done';
  /** The pill tooltip. */
  title: string;
  /** A line to show under the request when the owner must act; null when all is well. */
  problem: string | null;
}

export const NO_DISPATCHER =
  'No Claude session delivers fix requests now. Open a Claude Code session in this project. Its fix-dispatch mod sends the request within a minute.';

/** Two session titles are the same when they agree without case and outer spaces. The mod uses the same test. */
export const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function fixDeliveryState(f: FixDeliveryInput, d: FixDispatcherInput | null, now = Date.now()): FixDeliveryState {
  if (f.status === 'sent') return { label: 'sent', tone: 'sent', title: 'The session has the brief and works on it.', problem: null };
  if (f.status === 'done') return { label: 'done', tone: 'done', title: 'The session wrote its report.', problem: null };
  if (f.delivery_error) {
    return { label: 'not delivered', tone: 'failed', title: f.delivery_error, problem: `${f.delivery_error} Claude tries again each minute.` };
  }
  if (!d || now - Date.parse(d.seen_at) > DISPATCHER_GONE_MS) {
    return { label: 'waiting', tone: 'queued', title: NO_DISPATCHER, problem: NO_DISPATCHER };
  }
  if (d.error) return { label: 'not delivered', tone: 'failed', title: d.error, problem: `${d.error} Claude tries again at the next poll.` };
  return { label: 'waiting', tone: 'queued', title: 'Saved. Claude sends it to the session within a minute.', problem: null };
}

/**
 * A warning for the session name in the form, from the session titles that the mod saw; null when
 * an open session has the title, or when the titles are not known.
 */
export function sessionNameWarning(name: string, d: FixDispatcherInput | null): string | null {
  if (!d?.sessions || !name.trim()) return null;
  const hits = d.sessions.filter((s) => sameTitle(s.title, name));
  if (hits.some((s) => !s.archived)) return null;
  if (hits.length) return `The session "${name.trim()}" is archived. Unarchive it in the Claude app, or use the title of an open session.`;
  return `No open Claude session has the title "${name.trim()}". Give a session this title in the Claude app, or use the title of an open session. Until then, the request waits.`;
}
