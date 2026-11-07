import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type ChatMessage, type DeckChatView, type SwapBox } from '../api.js';
import { Icon } from './Icon.js';
import { ManaCost } from './ManaCost.js';

/**
 * The talk about one deck (deck chat design sec. 2). The page reads new messages once each second
 * during a turn, so a reload does not stop the turn. Only the "Swap" and "Undo" buttons change the
 * deck. A card name in a message is `[[Name]]`, and it shows with the hover zoom.
 */

const POLL_MS = 1000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tokens = (n: number) => (n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** The parts of a message: `[[Name]]`, a Markdown link `[text](https://...)`, or a run of mana symbols `{1}{R}`. */
const PARTS = /(\[\[[^[\]]+\]\]|\[[^[\]]+\]\(https?:\/\/[^\s()]+\)|(?:\{[^{}\s]{1,8}\})+)/;
const LINK = /^\[([^[\]]+)\]\((https?:\/\/[^\s()]+)\)$/;
const MANA = /^(?:\{[^{}\s]{1,8}\})+$/;

/** A text with each `[[Name]]` marked for the hover zoom, each Markdown link as a link, and mana symbols as pips. */
export function Named({ text, cards }: { text: string; cards?: Record<string, string> | undefined }) {
  const parts: ReactNode[] = text.split(PARTS).map((p, i) => {
    const name = /^\[\[(.+)\]\]$/.exec(p)?.[1];
    if (name) {
      const id = cards?.[name];
      return <span key={i} className="dk-chat-card" {...(id ? { 'data-card-id': id } : { 'data-card-name': name })}>{name}</span>;
    }
    const link = LINK.exec(p);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
    if (MANA.test(p)) return <ManaCost key={i} cost={p} />;
    return p;
  });
  return <>{parts}</>;
}

function SwapCards({ label, cards }: { label: string; cards: SwapBox['in'] }) {
  return (
    <div className="dk-swap-side">
      <span className="muted">{label}</span>
      {cards.map((c) => <span key={c.oracle_id}>{c.copies} <span className="dk-chat-card" data-card-id={c.oracle_id}>{c.name}</span></span>)}
    </div>
  );
}

const SWAP_STATE: Record<Exclude<SwapBox['status'], 'open'>, string> = { swapped: 'Swapped', refused: 'You said no', undone: 'Undone' };

function SwapBoxRow({ message, deckId, canUndo, onChanged }: { message: ChatMessage; deckId: number; canUndo: boolean; onChanged: () => Promise<void> }) {
  const box = message.data as unknown as SwapBox;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (job: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    job.then(onChanged).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  return (
    <div className="dk-swap">
      <SwapCards label="Out" cards={box.out} />
      <SwapCards label="In" cards={box.in} />
      {box.reason && <p className="dk-swap-reason" dir="auto"><Named text={box.reason} /></p>}
      <div className="dk-swap-acts">
        {box.status === 'open' && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(api.deckSwap(deckId, message.id, 'swap'))}>{busy ? 'Working…' : 'Swap'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => act(api.deckSwap(deckId, message.id, 'refuse'))}>No</button>
          </>
        )}
        {box.status !== 'open' && <span className="muted">{SWAP_STATE[box.status]}</span>}
        {canUndo && <button type="button" className="btn" disabled={busy} onClick={() => act(api.deckUndo(deckId))}>Undo</button>}
      </div>
      {error && <p className="error-inline">{error}</p>}
    </div>
  );
}

function MessageRow({ message, deckId, undoId, onChanged }: { message: ChatMessage; deckId: number; undoId: number | null; onChanged: () => Promise<void> }) {
  if (message.role === 'swap') return <SwapBoxRow message={message} deckId={deckId} canUndo={undoId === message.id} onChanged={onChanged} />;
  const cards = message.data?.['cards'] as Record<string, string> | undefined;
  return <div className={`dk-msg dk-msg-${message.role}`} dir="auto"><Named text={message.text} cards={cards} /></div>;
}

export function DeckChat({ deckId, onDeckChanged }: { deckId: number; onDeckChanged: () => Promise<void> }) {
  const [chat, setChat] = useState<DeckChatView | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const count = chat?.messages.length ?? 0;

  useEffect(() => {
    api.deckChat(deckId).then(setChat).catch((err: Error) => setError(err.message));
  }, [deckId]);

  useEffect(() => {
    if (!chat?.running) return undefined;
    const timer = setTimeout(() => {
      // A failed read keeps the state, so the next read still runs after an API restart.
      api.deckChat(deckId).then((c) => { setChat(c); setError(null); }).catch((err: Error) => { setError(err.message); setChat({ ...chat }); });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [chat, deckId]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [count]);

  const act = (job: Promise<DeckChatView>, after?: () => void) => {
    setBusy(true);
    setError(null);
    job.then((c) => { setChat(c); after?.(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const send = () => {
    const t = text.trim();
    if (t) act(api.sendDeckChat(deckId, t), () => setText(''));
  };
  const changed = async () => {
    await onDeckChanged();
    setChat(await api.deckChat(deckId));
  };
  const running = chat?.running ?? false;
  const flagged = chat?.flagged ?? false;

  return (
    <section className="panel dk-chat">
      <div className="panel-head">
        <h2>Talk about this deck</h2>
        <span className="rule" />
        {chat?.context && <span className="muted dk-hint" title="What Claude holds of this talk after the newest turn, against the limit of the model">{tokens(chat.context.used)} of {tokens(chat.context.limit)} tokens</span>}
        {chat && <span className="muted dk-hint">Claude {cap(chat.model)}</span>}
      </div>
      <div className="dk-chat-log" ref={log} aria-live="polite">
        {count === 0 && <p className="muted dk-hint">Tell Claude what is wrong with this deck. Claude reads the deck, suggests real cards, and you choose. Each message uses your plan limit.</p>}
        {chat?.messages.map((m) => <MessageRow key={m.id} message={m} deckId={deckId} undoId={chat.undo_message_id} onChanged={changed} />)}
        {running && <div className="dk-msg dk-msg-step">Claude is working…</div>}
      </div>
      {flagged && chat && (
        <div className="dk-chat-flag">
          <p className="dk-hint">The safety filter flagged this talk, so it cannot continue on {cap(chat.model)}. You can continue the same talk on {cap(chat.fallback_model)}.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(api.continueDeckChat(deckId))}>Continue with {cap(chat.fallback_model)}</button>
        </div>
      )}
      <div className="dk-chat-tools">
        <button
          type="button" className="btn" disabled={busy || running || flagged}
          title="Claude reads each link of this deck and writes suggestions: links to correct, to delete and to add. You answer them on the Decisions page, tab Link changes. No link changes before you apply your answers."
          onClick={() => act(api.linkCheck(deckId))}
        >Check the links with Claude</button>
        <a className="gx-link" href="#/decisions?tab=link_changes">Link changes on the Decisions page</a>
      </div>
      <div className="dk-chat-send">
        <textarea
          className="gr-note dk-chat-input" rows={2} dir="auto" placeholder="Write to Claude" aria-label="Message to Claude" value={text} disabled={flagged}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!running && !busy) send();
          }}
        />
        {running
          ? <button type="button" className="btn" onClick={() => act(api.stopDeckChat(deckId).then(() => api.deckChat(deckId)))}><Icon name="x" />Stop</button>
          : <button type="button" className="btn btn-primary" disabled={busy || flagged || !text.trim()} onClick={send}><Icon name="arrowRight" />Send</button>}
      </div>
      {error && <p className="error-inline">{error}</p>}
    </section>
  );
}
