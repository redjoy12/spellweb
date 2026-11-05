import { useEffect, useRef, useState } from 'react';
import { api, type BuildChatView, type ChatMessage } from '../api.js';
import { Named } from './DeckChat.js';
import { Icon } from './Icon.js';

/**
 * The talk before a deck (build chat design sec. 4). Claude asks questions and fills the form. The
 * page reads the talk once each second during a turn, and each read goes to `onTalk`, so the form
 * follows the draft. With no talk, the first message starts one with the form as it is.
 */

const POLL_MS = 1000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tokens = (n: number) => (n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function MessageRow({ message }: { message: ChatMessage }) {
  const cards = message.data?.['cards'] as Record<string, string> | undefined;
  return <div className={`dk-msg dk-msg-${message.role}`} dir="auto"><Named text={message.text} cards={cards} /></div>;
}

export function BuildChat({ talk, onTalk, start, onNew }: {
  talk: BuildChatView | null;
  onTalk: (t: BuildChatView) => void;
  /** Starts a talk with the form as it is now. */
  start: () => Promise<BuildChatView>;
  onNew: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const count = talk?.messages.length ?? 0;

  useEffect(() => {
    if (!talk?.running) return undefined;
    const timer = setTimeout(() => {
      // A failed read keeps the state, so the next read still runs after an API restart.
      api.buildChat(talk.id).then((t) => { onTalk(t); setError(null); }).catch((err: Error) => { setError(err.message); onTalk({ ...talk }); });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [talk, onTalk]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [count]);

  const act = (job: Promise<BuildChatView>, after?: () => void) => {
    setBusy(true);
    setError(null);
    job.then((t) => { onTalk(t); after?.(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const send = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    act((talk ? Promise.resolve(talk) : start()).then((x) => api.sendBuildChat(x.id, t)), () => setText(''));
  };

  const running = talk?.running ?? false;
  const flagged = talk?.flagged ?? false;
  const closed = talk?.deck_id != null;
  // The answer buttons of the newest reply, when the owner has not answered it yet.
  const last = talk?.messages.findLast((m) => m.role === 'claude' || m.role === 'owner');
  const answers = !running && !closed && last?.role === 'claude' ? (last.data?.['answers'] as string[] | undefined) ?? [] : [];

  return (
    <section className="panel dk-chat">
      <div className="panel-head">
        <h2>Describe your deck</h2>
        <span className="rule" />
        {talk?.context && <span className="muted dk-hint" title="What Claude holds of this talk after the newest turn, against the limit of the model">{tokens(talk.context.used)} of {tokens(talk.context.limit)} tokens</span>}
        {talk && <span className="muted dk-hint">Claude {cap(talk.model)}</span>}
        {talk && <button type="button" className="btn" disabled={running || busy} onClick={onNew} title="Start a new talk. This talk stays on the server.">New talk</button>}
      </div>
      <div className="dk-chat-log" ref={log} aria-live="polite">
        {count === 0 && (
          <p className="muted dk-hint">
            Tell Claude what deck you want. Claude asks hard questions until it knows the deck, and it fills the form while you talk. You can change the form at any time. Only you press "Build the deck". Each message uses your plan limit.
          </p>
        )}
        {talk?.messages.map((m) => <MessageRow key={m.id} message={m} />)}
        {running && <div className="dk-msg dk-msg-step">Claude is working…</div>}
        {answers.length > 0 && (
          <div className="bc-answers">
            {answers.map((a) => <button key={a} type="button" className="btn" disabled={busy} onClick={() => send(a)}>{a}</button>)}
          </div>
        )}
      </div>
      {flagged && talk && (
        <div className="dk-chat-flag">
          <p className="dk-hint">The safety filter flagged this talk, so it cannot continue on {cap(talk.model)}. You can continue the same talk on {cap(talk.fallback_model)}.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(api.continueBuildChat(talk.id))}>Continue with {cap(talk.fallback_model)}</button>
        </div>
      )}
      {closed
        ? <p className="dk-hint">This talk built <a href={`#/decks/${talk!.deck_id}`}>deck {talk!.deck_id}</a>. Press "New talk" to describe another deck.</p>
        : (
          <div className="dk-chat-send">
            <textarea
              className="gr-note dk-chat-input" rows={2} dir="auto" placeholder={talk ? 'Answer Claude' : 'Describe the deck that you want'} aria-label="Message to Claude" value={text} disabled={flagged}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (!running && !busy) send(text);
              }}
            />
            {running
              ? <button type="button" className="btn" onClick={() => act(api.stopBuildChat(talk!.id).then(() => api.buildChat(talk!.id)))}><Icon name="x" />Stop</button>
              : <button type="button" className="btn btn-primary" disabled={busy || flagged || !text.trim()} onClick={() => send(text)}><Icon name="arrowRight" />Send</button>}
          </div>
        )}
      {error && <p className="error-inline">{error}</p>}
    </section>
  );
}
