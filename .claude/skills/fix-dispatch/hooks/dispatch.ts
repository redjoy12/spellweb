/**
 * The delivery of "Fix this reason" requests (MTGA deck builder, owner request 2026-10-18).
 *
 * One poll: ask the API for the lease; the holder gets the due queued requests, finds the Claude
 * session with each request's title, sends the brief, and marks the request sent. When no open
 * session has the title, it records why, and the API gives the request again after one minute.
 *
 * This file has no engine import, so the project's Vitest tests it against the real routes
 * (tests/fix-dispatch-mod.test.ts). register.ts gives it the engine's calls.
 */

export const API = 'http://127.0.0.1:8787/api/fix-requests';

/** What a poll needs from the engine. */
export interface Port {
  /** An HTTP request through the host. Rejects when the API is down. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: string }>;
  /** The Claude sessions, this one first with `self: true`, then the others by last activity, archived ones too. */
  sessions(): Promise<Session[]>;
  /** Sends a message to another session; resolves the tool's text ("... (delivery: delivered; ...)"). */
  send(sessionId: string, message: string): Promise<string>;
  /** Queues a prompt in this session (when the request names this session). */
  submit(text: string): Promise<void>;
}

export interface Session { sessionId: string; title: string; isArchived: boolean; self?: boolean }

export interface Item { id: number; session_name: string; brief_path: string }

/** The same test as src/web/lib/fixDelivery.ts: no case, no outer spaces. */
export const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The first line of the message, before the brief. */
export function messageHead(item: Item): string {
  return `Fix request ${item.id}: the owner used "Fix this reason" in the MTGA deck builder UI and named this session ` +
    `("${item.session_name}"). Do the work in the brief below. The brief file is ${item.brief_path}.`;
}

async function post(port: Port, url: string, body: unknown): Promise<void> {
  await port.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Delivers one request, or records why it could not. Resolves what happened, for a log line. */
export async function deliver(port: Port, item: Item, list: Session[]): Promise<string> {
  const hits = list.filter((s) => sameTitle(s.title, item.session_name));
  const open = hits.find((s) => !s.isArchived);
  if (!open) {
    const error = hits.length
      ? `The session "${item.session_name}" is archived. Unarchive it in the Claude app.`
      : `No Claude session has the title "${item.session_name}".`;
    await post(port, `${API}/${item.id}/failed`, { error });
    return `request ${item.id}: ${error}`;
  }
  try {
    const brief = await port.fetch(`${API}/${item.id}/brief`);
    const text = `${messageHead(item)}\n\n---\n\n${brief.ok ? brief.text : `Read the brief file: ${item.brief_path}`}`;
    if (open.self) await port.submit(text);
    else {
      const out = await port.send(open.sessionId, text);
      if (!/delivery: (delivered|queued)/.test(out)) throw new Error(out.slice(0, 300));
    }
  } catch (err) {
    const error = `Claude could not send the brief to the session "${item.session_name}": ${(err as Error).message}`;
    await post(port, `${API}/${item.id}/failed`, { error });
    return `request ${item.id}: ${error}`;
  }
  await post(port, `${API}/${item.id}/sent`, { session_id: open.sessionId });
  return `request ${item.id}: sent to "${open.title}"`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 900);

/**
 * One poll. `holds` says this dispatcher held the lease at its last poll: then it reports the
 * session titles, so the form can warn about a title that no open session has. When the session
 * list fails, the poll reports the error, and the UI shows it on each waiting request.
 * Resolves whether it holds the lease now, and a line for each request.
 */
export async function poll(port: Port, me: string, holds: boolean): Promise<{ holds: boolean; log: string[] }> {
  let known: Session[] | undefined;
  let error: string | undefined;
  if (holds) {
    try { known = await port.sessions(); } catch (err) { error = `Claude cannot read the session list: ${message(err)}`; }
  }
  const r = await port.fetch(`${API}/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dispatcher: me,
      ...(known ? { sessions: known.map((s) => ({ title: s.title, archived: s.isArchived })) } : {}),
      ...(error ? { error } : {}),
    }),
  });
  if (!r.ok) return { holds: false, log: [`dispatch: HTTP ${r.status}`] };
  const d = JSON.parse(r.text) as { lease: boolean; items: Item[] };
  if (!d.lease) return { holds: false, log: [] };
  if (error) return { holds: true, log: [error] };
  if (d.items.length === 0) return { holds: true, log: [] };
  let list = known;
  if (!list) {
    // The first poll with the lease: read the list now; an error shows at the next poll.
    try { list = await port.sessions(); } catch (err) { return { holds: true, log: [`Claude cannot read the session list: ${message(err)}`] }; }
  }
  const log: string[] = [];
  for (const item of d.items) log.push(await deliver(port, item, list));
  return { holds: true, log };
}

/** The JSON in a tool's text: from its first `[` or `{`. */
export function jsonOf<T>(text: string): T {
  const i = text.search(/[[{]/);
  if (i < 0) throw new Error(`no JSON in: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(i)) as T;
}
