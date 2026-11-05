import { useEffect, useRef, useState } from 'react';
import { api, type ApplyRequestView, type LinkChangesPage, type OwnerAnswer, type SuggestionView } from '../api.js';
import { Named } from './DeckChat.js';
import { Icon } from './Icon.js';

/**
 * The tab "Link changes" of the Decisions page (link review design sec. 6 and 7). Each item is one
 * suggestion of a link check. An answer changes no link. "Apply link changes" makes an apply request
 * and opens a new session of the Claude desktop app with the prompt in the message box.
 */

type Filter = 'open' | 'answered' | 'done';

const KIND_TITLE: Record<SuggestionView['kind'], string> = {
  delete: 'Delete this link?',
  add: 'Add this link?',
  correct: 'Correct this link?',
};

const CHANGE_WORDS: Record<NonNullable<SuggestionView['change']>, string> = {
  weak: 'Claude says that this link is real but weak.',
  not_weak: 'Claude says that the weak mark is wrong: this is a full link.',
  wrong_reason: 'Claude says that the pair is a real link, but the reason of the app is false.',
};

const CHOICES: Record<SuggestionView['kind'], Array<{ answer: OwnerAnswer; label: string; hint: string; primary?: boolean }>> = {
  delete: [
    { answer: 'yes', label: 'Yes, no link', hint: 'The cards do not help each other. The apply session removes the link.', primary: true },
    { answer: 'weak', label: 'Weak, not false', hint: 'The link is real, but it has a high cost, a slow play or a small reward.' },
    { answer: 'no', label: 'No, keep the link', hint: 'The link is right. Nothing changes.' },
  ],
  add: [
    { answer: 'yes', label: 'Yes, add it', hint: 'The cards help each other (or are bad together). The apply session adds the link.', primary: true },
    { answer: 'weak', label: 'Add it as weak', hint: 'A real link, but with a high cost, a slow play or a small reward.' },
    { answer: 'no', label: 'No', hint: 'There is no link. Nothing changes.' },
  ],
  correct: [
    { answer: 'yes', label: 'Yes', hint: 'Claude is right. The apply session makes the change.', primary: true },
    { answer: 'no', label: 'No', hint: 'Claude is wrong. Nothing changes.' },
  ],
};

const STATE_WORDS: Record<SuggestionView['state'], string> = {
  open: 'open', answered: 'answered', in_request: 'in an apply request', applied: 'applied', question: 'a question for you', rejected: 'you said no', stale: 'already true',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const inFilter = (s: SuggestionView, f: Filter) =>
  f === 'open' ? (s.state === 'open' || s.state === 'question') && !s.stale
    : f === 'answered' ? (s.state === 'answered' || s.state === 'rejected' || s.state === 'in_request') && !s.stale
      : s.state === 'applied' || s.state === 'stale' || s.stale;

function CardBox({ role, card }: { role: string; card: SuggestionView['supply'] }) {
  return (
    <div className="dc-text dc-lc-card">
      <div className="dc-text-k">{role}</div>
      <p><b data-card-id={card.oracle_id}>{card.name}</b></p>
      <p className="dc-lc-oracle">{card.text}</p>
    </div>
  );
}

function SuggestionCard({ s, buildId, onSaved }: { s: SuggestionView; buildId: number | null; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(s.owner_note);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canAnswer = ['open', 'answered', 'rejected', 'question'].includes(s.state) && !s.stale;
  const save = (answer: OwnerAnswer) => {
    setBusy(true); setErr(null);
    api.answerLinkChange(s.id, answer, note).then(onSaved).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const plus = s.sign === '+';
  const title = s.kind === 'add' && !plus ? 'Add a "bad together" link?' : s.kind === 'delete' && !plus ? 'Delete this "bad together" link?' : KIND_TITLE[s.kind];
  const chosen = CHOICES[s.kind].find((c) => c.answer === s.answer);
  return (
    <article className={`dc-card${s.answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>{title}</h3>
        <span className="dc-badge dc-badge-quiet">Deck {s.deck_id} · suggestion {s.id}</span>
        <span className="dc-badge">{s.stale ? `already true on build ${buildId}` : STATE_WORDS[s.state]}</span>
      </header>
      <div className="dc-pair">
        <CardBox role={plus ? 'Card A – gives' : 'Card A'} card={s.supply} />
        <div className="dc-vs" aria-hidden="true">{plus ? '→' : '×'}</div>
        <CardBox role={plus ? 'Card B – needs' : 'Card B'} card={s.demand} />
      </div>
      {s.link && (
        <div className="dc-rule">
          <p className="dc-meta">
            The app now says: {plus ? <>card A helps card B</> : <>the cards are bad together</>}
            {s.link.owner_link !== null ? ', from your answer (your link).' : <>, kind “{s.link.kind}”{s.link.rule_ids.length > 0 && <>, rule <span className="mono">{s.link.rule_ids.join(', ')}</span></>}{s.link.weak ? ', weak' : ''}.</>}
          </p>
          {(s.link.supply_quote || s.link.demand_quote) && <p className="dc-meta">“{s.link.supply_quote}” → “{s.link.demand_quote}”</p>}
        </div>
      )}
      {!s.link && s.kind === 'add' && <p className="dc-meta">The app has no link between these cards now.</p>}
      {s.change && <p className="dc-meta">{CHANGE_WORDS[s.change]}</p>}
      <p><b>Claude:</b> <Named text={s.reason} /></p>
      {s.question && s.state === 'question' && (
        <p className="dc-question"><Icon name="info" size={14} /> <b>Question of the apply session:</b> {s.question} Write your answer in the note, then press a button.</p>
      )}
      {s.fix && <p className="dc-meta"><b>Applied{s.applied_build ? ` in build ${s.applied_build}` : ''}:</b> {s.fix}</p>}
      {canAnswer ? (
        <div className="dc-answer">
          <div className="dc-buttons">
            {CHOICES[s.kind].map((c) => (
              <button key={c.answer} type="button" title={c.hint} className={`btn${c.primary ? ' btn-primary' : ''}${s.answer === c.answer ? ' dc-current' : ''}`} disabled={busy} onClick={() => save(c.answer)}>
                {c.label}
              </button>
            ))}
          </div>
          <textarea className="dc-note" rows={2} dir="auto" placeholder="Optional: why? The note is saved with your answer." value={note} onChange={(e) => setNote(e.target.value)} />
          {chosen && <span className="dc-chosen dc-chosen-set"><Icon name="check" size={13} /> Your answer: <b>{chosen.label}</b></span>}
          {err && <span className="error-inline">{err}</span>}
        </div>
      ) : chosen && <p className="dc-meta">Your answer: <b>{chosen.label}</b>{s.owner_note ? ` “${s.owner_note}”` : ''}</p>}
    </article>
  );
}

function ApplyBar({ page, onChanged }: { page: LinkChangesPage; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const open = page.open_request;
  const count = page.to_apply.suggestions + page.to_apply.reports;
  const launch = (r: ApplyRequestView) => { window.location.href = r.link; };
  const apply = () => {
    setBusy(true); setErr(null);
    api.linkApply().then(async (r) => { await onChanged(); launch(r); }).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const copy = (r: ApplyRequestView) => {
    setErr(null);
    // A browser can refuse the clipboard API. Then the text box with the prompt is selected and copied.
    const fallback = () => {
      const box = promptBox.current;
      box?.focus();
      box?.select();
      if (document.execCommand('copy')) setCopied(true);
      else setErr('The browser did not copy the prompt. Select the text in the box and copy it.');
    };
    if (navigator.clipboard) navigator.clipboard.writeText(r.prompt).then(() => setCopied(true)).catch(fallback);
    else fallback();
  };
  const cancel = (r: ApplyRequestView) => {
    setBusy(true); setErr(null);
    api.cancelLinkApply(r.id).then(onChanged).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  return (
    <section className="dc-intro dc-apply">
      {open ? (
        <>
          <p><b>Apply request {open.id} is open:</b> {plural(open.suggestions, 'suggestion', 'suggestions')} and {plural(open.reports, 'false link report', 'false link reports')}. A session in the Claude desktop app fixes them.</p>
          <div className="dc-buttons">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => launch(open)}>Open the apply session again</button>
            <button type="button" className="btn" disabled={busy} onClick={() => copy(open)}>{copied ? 'Copied' : 'Copy the prompt'}</button>
            <button type="button" className="gx-link" disabled={busy} onClick={() => cancel(open)}>Cancel the request</button>
          </div>
        </>
      ) : (
        <>
          <p>
            <b>{count === 0 ? 'Nothing to apply yet.' : `${plural(page.to_apply.suggestions, 'approved suggestion', 'approved suggestions')} and ${plural(page.to_apply.reports, 'false link report', 'false link reports')} wait.`}</b>{' '}
            “Apply link changes” opens a new session in the Claude desktop app, with the prompt in the message box.
            Confirm the folder, choose Opus, and press Send. The session shows its plan and asks for your yes before it changes a link.
          </p>
          <div className="dc-buttons">
            <button type="button" className="btn btn-primary" disabled={busy || count === 0} onClick={apply}>Apply link changes</button>
          </div>
        </>
      )}
      {open && (
        <>
          <p className="dc-meta">If the desktop app does not open, press “Copy the prompt”, open a new session in this project, and paste it.</p>
          <textarea ref={promptBox} className="dc-note" rows={2} readOnly value={open.prompt} aria-label="The prompt of the apply session" onFocus={(e) => e.currentTarget.select()} />
        </>
      )}
      {err && <p className="error-inline">{err}</p>}
      {page.requests.filter((r) => r.state !== 'open').length > 0 && (
        <details className="dc-lc-why">
          <summary>Earlier apply requests</summary>
          {page.requests.filter((r) => r.state !== 'open').map((r) => (
            <p key={r.id} className="dc-meta">Request {r.id}: {r.state}, {plural(r.suggestions, 'suggestion', 'suggestions')} and {plural(r.reports, 'report', 'reports')}, {new Date(r.created_at).toLocaleString()}{r.results ? `. Results: ${r.results}` : ''}</p>
          ))}
        </details>
      )}
    </section>
  );
}

export function LinkChanges({ onCounts }: { onCounts?: (open: number) => void }) {
  const [page, setPage] = useState<LinkChangesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const load = async () => {
    try {
      const p = await api.linkChanges();
      setPage(p);
      setError(null);
      onCounts?.(p.items.filter((s) => inFilter(s, 'open')).length);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    // The deck page links to `#/decisions?tab=link_changes`: show the tab, not the head of the page.
    void load().then(() => {
      if (window.location.hash.includes('tab=link_changes')) requestAnimationFrame(() => document.getElementById('dc-step')?.scrollIntoView({ block: 'start' }));
    });
  }, []);
  if (error) return <p className="error-inline">{error}</p>;
  if (!page) return <p className="muted">Loading…</p>;
  const shown = page.items.filter((s) => inFilter(s, filter));
  const n = (f: Filter) => page.items.filter((s) => inFilter(s, f)).length;
  return (
    <>
      <section className="dc-intro" id="dc-step">
        <h2>Link changes from Claude</h2>
        <p>
          On a deck page, “Check the links with Claude” reads the links of the deck. Claude suggests links to delete, to add and to correct.
          Answer each suggestion here. An answer changes no link. When you have many answers, press “Apply link changes”.
        </p>
      </section>
      <ApplyBar page={page} onChanged={load} />
      <div className="dc-filters">
        {(['open', 'answered', 'done'] as Filter[]).map((f) => (
          <button key={f} type="button" className={`btn${filter === f ? ' btn-primary' : ''}`} onClick={() => setFilter(f)}>
            {f === 'open' ? 'To answer' : f === 'answered' ? 'Answered' : 'Done'} ({n(f)})
          </button>
        ))}
      </div>
      {shown.length === 0
        ? <div className="dc-empty"><Icon name="check" size={18} /> {page.items.length === 0 ? 'No suggestion yet. Open a deck and press “Check the links with Claude”.' : 'Nothing here with this filter.'}</div>
        : <div className="dc-list">{shown.map((s) => <SuggestionCard key={s.id} s={s} buildId={page.build_id} onSaved={load} />)}</div>}
    </>
  );
}
