import { useEffect, useMemo, useState } from 'react';
import { api, type EdgeRulesResponse } from '../api.js';
import { RuleEvidenceList } from '../components/EdgeRow.js';
import { sideText } from '../lib/plain.js';

/**
 * The edge-rules page (Phase 3 spec sec. 13.2, plan Task 7 Step 5): the current rule set and the
 * roles as tables. A disputed item links to its review-queue item. A debate verdict is shown as a
 * debate verdict, not as an owner decision (spec rev. 9 sec. 5.6).
 */

type Tab = 'rules' | 'roles';
type Status = 'all' | 'accepted' | 'disputed' | 'no_agreement';
const PAGE = 100;

const queueLink = (id: number) => `#/review?domain=edge&finding=${id}`;

export function EdgeRules({ findingId, initialTab }: { findingId?: number; initialTab?: Tab }) {
  const [data, setData] = useState<EdgeRulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'rules');
  const [status, setStatus] = useState<Status>('all');
  const [text, setText] = useState('');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => { api.edgeRules().then(setData).catch((err: Error) => setError(err.message)); }, []);

  // A deep link from the review queue: show the item of that finding.
  useEffect(() => {
    if (!data || findingId === undefined) return;
    const rule = data.rules.find((r) => r.queue?.id === findingId);
    const role = data.roles.find((r) => r.queue?.id === findingId);
    if (rule) { setTab('rules'); setText(rule.rule_id); setStatus('all'); }
    if (role) { setTab('roles'); setText(`${role.family}.${role.type_key}`); }
  }, [data, findingId]);

  const rules = useMemo(() => {
    if (!data) return [];
    const t = text.trim().toLowerCase();
    return data.rules.filter((r) => {
      if (status === 'no_agreement' ? r.debate?.outcome !== 'no_agreement' : status !== 'all' && r.status !== status) return false;
      if (!t) return true;
      return [r.rule_id, sideText(r.supply), sideText(r.demand)].some((x) => x.toLowerCase().includes(t));
    });
  }, [data, status, text]);

  const roles = useMemo(() => {
    if (!data) return [];
    const t = text.trim().toLowerCase();
    return data.roles.filter((r) => !t || `${r.family}.${r.type_key}`.toLowerCase().includes(t) || r.role.includes(t));
  }, [data, text]);

  if (error) return <div className="error-block">{error}</div>;
  if (!data) return <p className="muted">Loading the edge rules…</p>;
  if (!data.set) return <p className="muted empty-state">There is no accepted edge-rule set.</p>;

  const n = (f: (r: EdgeRulesResponse['rules'][number]) => boolean) => data.rules.filter(f).length;
  const counts = {
    all: data.rules.length, accepted: n((r) => r.status === 'accepted'), disputed: n((r) => r.status === 'disputed'),
    no_agreement: n((r) => r.debate?.outcome === 'no_agreement'),
  };
  const pendingDisputed = n((r) => r.status === 'disputed' && r.queue?.status === 'pending');

  return (
    <div className="gx">
      <div className="gq-header">
        <h1 className="page-title">Edge rules</h1>
        <div className="rq-tabs" role="tablist">
          {(['rules', 'roles'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`rq-tab${tab === t ? ' active' : ''}`} onClick={() => { setTab(t); setShown(PAGE); }}>
              {t === 'rules' ? `Rules (${data.rules.length})` : `Roles (${data.roles.length})`}
            </button>
          ))}
        </div>
        <div className="header-status">
          <span className="status-pill">set <b>{data.set.id}</b> v{data.set.version} · {data.set.status}</span>
          <span className="status-pill">schema <b>v{data.set.schema_version}</b></span>
        </div>
      </div>

      <div className="gx-notice">
        <p>
          The build uses the accepted rules only. A disputed rule stays out of the build (spec rev. 6 sec. 5.3). {pendingDisputed} disputed rules
          wait for the owner: {counts.no_agreement} of them had a debate without agreement, and the others had no debate, because only disputed rules
          with live types get debate items. The owner can adopt a disputed rule later; this makes a new set version (spec sec. 5.5).
        </p>
      </div>

      <div className="gx-controls">
        <input className="gx-search" placeholder={tab === 'rules' ? 'filter by rule ID or type' : 'filter by type or role'} value={text}
          onChange={(e) => { setText(e.target.value); setShown(PAGE); }} />
        {tab === 'rules' && (['all', 'accepted', 'disputed', 'no_agreement'] as const).map((s) => (
          <button key={s} className={`status-pill gq-filter${status === s ? ' active' : ''}`} onClick={() => { setStatus(s); setShown(PAGE); }}>
            {s === 'no_agreement' ? 'debate without agreement' : s} <b>{counts[s]}</b>
          </button>
        ))}
      </div>

      {tab === 'rules' && (
        <div className="table-scroll">
          <table className="data gx-rules-table">
            <thead>
              <tr><th>rule</th><th>polarity</th><th>supply</th><th>demand</th><th>links</th><th>implications</th><th>evidence</th><th>votes</th><th>status</th></tr>
            </thead>
            <tbody>
              {rules.slice(0, shown).map((r) => (
                <tr key={r.rule_hash} className={r.queue?.id === findingId ? 'gx-row-focus' : undefined}>
                  <td className="mono">{r.rule_id}</td>
                  <td>{r.polarity === '+' ? 'synergy' : 'anti'}</td>
                  <td className="mono">{sideText(r.supply)}</td>
                  <td className="mono">{sideText(r.demand)}</td>
                  <td className="mono">{r.param_links.length ? r.param_links.map((l) => `${String(l['supply'])} = ${String(l['demand'])}`).join('; ') : '-'}</td>
                  <td className="mono">{r.implications.length ? r.implications.map((i) => `${i.demand_param} = ${JSON.stringify(i.value)}`).join('; ') : '-'}</td>
                  <td><details><summary>{r.evidence.length} quotes</summary><RuleEvidenceList rule={r} /></details></td>
                  <td className="mono">{r.votes}</td>
                  <td>
                    <span className={`pill-status ${r.status === 'accepted' ? 'pill-ok' : 'pill-run'}`}>{r.status}</span>
                    {r.debate && <div className="muted">debate: {r.debate.outcome === 'agreed' ? `agreed "${r.debate.choice}" (round ${r.debate.round})` : r.debate.outcome.replace('_', ' ')}</div>}
                    {r.decision && <div className="muted">{r.decision.decided_by === 'debate' ? 'debate verdict' : 'owner decision'}: {r.decision.decision}</div>}
                    {r.queue && <div><a href={queueLink(r.queue.id)}>queue item {r.queue.id}</a> <span className="muted">({r.queue.status})</span></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'roles' && (
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>type</th><th>role</th><th>demand note</th><th>resources</th><th>evidence</th><th>votes</th><th>status</th></tr></thead>
            <tbody>
              {roles.slice(0, shown).map((r) => (
                <tr key={`${r.family}.${r.type_key}`} className={r.queue?.id === findingId ? 'gx-row-focus' : undefined}>
                  <td className="mono">{r.family}.{r.type_key}</td>
                  <td>{r.role}</td>
                  <td>{r.demand_note ?? '-'}</td>
                  <td className="mono">{r.resources.length ? r.resources.map((x) => `${x.resource} ${x.sign} ${x.kind}`).join('; ') : '-'}</td>
                  <td>
                    <details><summary>{r.evidence.length} quotes</summary>
                      <ul className="gx-evidence">{r.evidence.map((e, i) => <li key={i}><span className="mono">{e.source === 'rule' ? `CR ${e.ref}` : e.ref}</span> <span className="gr-quote">"{e.quote}"</span></li>)}</ul>
                    </details>
                  </td>
                  <td className="mono">{r.votes}</td>
                  <td>
                    <span className={`pill-status ${r.status === 'accepted' ? 'pill-ok' : 'pill-run'}`}>{r.status}</span>
                    {r.decision && <div className="muted">decided: {r.decision.decision}{r.decision.pass_index ? ` (pass ${r.decision.pass_index})` : ''}</div>}
                    {r.queue && <div><a href={queueLink(r.queue.id)}>queue item {r.queue.id}</a> <span className="muted">({r.queue.status})</span></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(tab === 'rules' ? rules.length : roles.length) > shown && (
        <p><button className="gx-link" onClick={() => setShown(shown + PAGE)}>show {PAGE} more of {(tab === 'rules' ? rules.length : roles.length) - shown}</button></p>
      )}
    </div>
  );
}
