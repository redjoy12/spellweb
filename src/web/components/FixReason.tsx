import { useEffect, useId, useState } from 'react';
import { api, reasonKey, type FixDispatcher, type FixRequest } from '../api.js';
import { fixDeliveryState, sessionNameWarning } from '../lib/fixDelivery.js';
import { appendText, MicButton } from './MicButton.js';
import { Term } from './Term.js';

/**
 * "Fix this reason" (owner request 2026-10-18): the owner hands one reason to a named Claude session.
 * The form saves a fix request; the server writes the brief file, and the fix-dispatch mod in the
 * Claude sessions of this project sends it to the open session with that title. The suggestions
 * are the session names of earlier requests and the open session titles that the mod saw.
 */

export function FixStatusPill({ request, dispatcher }: { request: FixRequest; dispatcher: FixDispatcher | null }) {
  const s = fixDeliveryState(request, dispatcher);
  return <span className={`fx-status fx-status-${s.tone}`} title={s.title}>{s.label}</span>;
}

/** The fix requests of one reason, with their status, and the problem when one waits for the owner. */
export function FixRequestList({ items, dispatcher }: { items: FixRequest[]; dispatcher: FixDispatcher | null }) {
  if (items.length === 0) return <p className="muted">No fix request on this reason yet.</p>;
  return (
    <ul className="fx-list">
      {items.map((f) => (
        <li key={f.id}>
          <FixStatusPill request={f} dispatcher={dispatcher} />
          <span>Session <b>{f.session_name}</b></span>
          <span className="muted">request {f.id} · {f.created_at.slice(0, 16).replace('T', ' ')}{f.sent_at ? ` · sent ${f.sent_at.slice(0, 16).replace('T', ' ')}` : ''}</span>
          {f.note && <span className="fx-note">“{f.note}”</span>}
          {(() => { const p = fixDeliveryState(f, dispatcher).problem; return p && <span className="fx-problem">{p}</span>; })()}
        </li>
      ))}
    </ul>
  );
}

export function FixReasonForm({ ruleHashes, ruleIds, buildId, edgeKey, onSaved, onCancel }: {
  ruleHashes: string[]; ruleIds: string[]; buildId?: number; edgeKey?: string;
  onSaved?: (r: FixRequest) => void; onCancel: () => void;
}) {
  const listId = useId();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [earlier, setEarlier] = useState<FixRequest[]>([]);
  const [dispatcher, setDispatcher] = useState<FixDispatcher | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<FixRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = reasonKey(ruleHashes);

  useEffect(() => {
    let live = true;
    api.fixRequests().then((r) => {
      if (!live) return;
      setNames(r.session_names);
      setDispatcher(r.dispatcher);
      setEarlier(r.items.filter((f) => reasonKey(f.rule_hashes) === key));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);

  // The default name: the session of the last request on this reason, else one from the rule IDs.
  useEffect(() => {
    if (touched) return;
    setName(earlier.length ? earlier[earlier.length - 1]!.session_name : `fix ${ruleIds.join(' ')}`.toLowerCase());
  }, [earlier, ruleIds, touched]);

  const save = () => {
    setBusy(true);
    setError(null);
    api.saveFixRequest({
      session_name: name.trim(), rule_hashes: ruleHashes, note: note.trim(),
      ...(buildId !== undefined ? { build_id: buildId } : {}), ...(edgeKey ? { edge_key: edgeKey } : {}),
    })
      .then((r) => { setSaved(r); onSaved?.(r); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const open = (dispatcher?.sessions ?? []).filter((s) => !s.archived).map((s) => s.title);
  const warning = sessionNameWarning(name, dispatcher);

  if (saved) {
    const problem = fixDeliveryState(saved, dispatcher).problem ?? sessionNameWarning(saved.session_name, dispatcher);
    return (
      <div className="fx-saved">
        <span className="pill-status pill-ok">Saved. Claude sends it to the session {saved.session_name} within a minute.</span>
        {problem && <span className="fx-problem">{problem}</span>}
        <button className="gx-link" onClick={onCancel}>Close</button>
      </div>
    );
  }

  const pick = (n: string) => { setName(n); setTouched(true); };
  return (
    <div className="fx-form">
      <p className="fx-intro">
        <Term id="fix">Fix this reason</Term>: a Claude session reads all reports on this reason and writes a short report with the smallest fix.
        {earlier.length > 0 && <> This reason already has {earlier.length} fix request{earlier.length === 1 ? '' : 's'}.</>}
      </p>
      <label className="fx-field">
        <span>Session name</span>
        <input className="rq-input" list={listId} value={name} maxLength={80} placeholder="for example: fix mana links"
          onChange={(e) => pick(e.target.value)} />
        <datalist id={listId}>{[...new Set([...names, ...open])].map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      {warning && <span className="fx-problem">{warning}</span>}
      {names.length > 0 && (
        <div className="fx-names">
          <span className="muted">Use an earlier session:</span>
          {names.slice(0, 8).map((n) => (
            <button key={n} type="button" className={`fx-chip${n === name ? ' active' : ''}`} onClick={() => pick(n)}>{n}</button>
          ))}
        </div>
      )}
      <p className="muted fx-hint">The name is the title of a Claude session in this project. Claude sends the brief to that session. The same name gives the work to the same session.</p>
      <label className="fx-field">
        <span>Note for Claude (optional)</span>
        <div className="fx-note-row">
          <textarea className="gr-note" rows={2} dir="auto" placeholder="Anything to add to your reports" value={note} onChange={(e) => setNote(e.target.value)} />
          <MicButton onText={(t) => setNote((n) => appendText(n, t))} disabled={busy} />
        </div>
      </label>
      <div className="fx-buttons">
        <button className="gr-btn gr-btn-accept" disabled={busy || !/[A-Za-z0-9]/.test(name)} onClick={save}>Save fix request</button>
        <button className="gx-link" onClick={onCancel}>Cancel</button>
      </div>
      {error && <span className="error-inline">{error}</span>}
    </div>
  );
}
