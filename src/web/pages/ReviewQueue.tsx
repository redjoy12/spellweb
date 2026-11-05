import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api, type FixDispatcher, type AtomFamily, type AtomTypeOption, type AtomsResponse, type EdgeFinding, type EdgeQueueResponse, type EdgeSeverity,
  type QueueFinding, type ReasonGroup, type ReviewQueueResponse, type RoleProposal, type RoleProposals, type RuleEvidence, type Severity,
} from '../api.js';
import { AtomSpans } from '../components/AtomSpans.js';
import { RuleEvidenceList } from '../components/EdgeRow.js';
import { FixReasonForm, FixRequestList, FixStatusPill } from '../components/FixReason.js';
import { Term } from '../components/Term.js';
import { plainSide, useTypeLabels } from '../lib/terms.js';

/**
 * The review queue (plan Task 9 Step 5; spec sec. 7.4, 11.2). Findings arrive ranked by the
 * server - severity_rank, then rank_score (the card degree since Phase 3 sec. 14.2) - and this page keeps that order: the
 * text label sorts the lowest-severity bucket second, so nothing here sorts by it.
 *
 * Every action is one of sec. 11.2's five. Accepting a missing-rule report is the one with the
 * most reach: it fixes the packet of every card sharing the text shape, not only this one.
 *
 * Phase 3 sec. 10.1 adds a second domain to the same queue: edge findings (roles, rules and
 * reported edges). Each domain has its own tab and its own ranks; the two never sort together.
 * The reported links show as one item for each reason, with the report count (owner request
 * 2026-10-18), before the other edge findings.
 */

const SEVERITIES: Severity[] = ['coverage_miss', 'missing_rule', 'vote_disagreement', 'unclassified', 'splitter_disagreement'];

const LABEL: Record<Severity, string> = {
  coverage_miss: 'coverage miss',
  missing_rule: 'missing rule',
  vote_disagreement: 'vote disagreement',
  unclassified: 'unclassified',
  splitter_disagreement: 'splitter',
};

const FAMILIES: AtomFamily[] = ['PRODUCES', 'CARES_ABOUT', 'ENABLES', 'COMBAT', 'INTERACTION', 'CONSTRAINTS'];

type Filter = Severity | 'all';

type Domain = 'atom' | 'edge';

export function ReviewQueue({ initialFinding, initialDomain }: { initialFinding?: number; initialDomain?: Domain }) {
  const [domain, setDomain] = useState<Domain>(initialDomain ?? 'atom');
  const tabs = (
    <div className="rq-tabs" role="tablist">
      {(['atom', 'edge'] as const).map((d) => (
        <button key={d} role="tab" aria-selected={domain === d} className={`rq-tab${domain === d ? ' active' : ''}`} onClick={() => setDomain(d)}>
          {d === 'atom' ? 'Atoms' : 'Edges'}
        </button>
      ))}
    </div>
  );
  return domain === 'atom'
    ? <AtomQueue tabs={tabs} initialFinding={initialDomain === 'edge' ? undefined : initialFinding} />
    : <EdgeQueue tabs={tabs} initialFinding={initialDomain === 'edge' ? initialFinding : undefined} />;
}

function AtomQueue({ tabs, initialFinding }: { tabs: ReactNode; initialFinding?: number }) {
  const [queue, setQueue] = useState<ReviewQueueResponse | null>(null);
  const [status, setStatus] = useState<'pending' | 'resolved'>('pending');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(initialFinding ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQueue(await api.reviewQueue(status));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => (queue?.items ?? []).filter((f) => filter === 'all' || f.severity === filter),
    [queue, filter],
  );

  useEffect(() => {
    if (visible.length === 0) return;
    if (selected === null || !visible.some((f) => f.id === selected)) setSelected(visible[0]!.id);
  }, [visible, selected]);

  // j/k walk the ranked list, as on the golden-set page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = visible.findIndex((v) => v.id === selected);
      const next = e.key === 'j' ? Math.min(i + 1, visible.length - 1) : Math.max(i - 1, 0);
      if (visible[next]) setSelected(visible[next]!.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected]);

  /** After an action that resolved the finding: refresh, and move to the next one down. */
  const afterResolve = useCallback(async () => {
    const i = visible.findIndex((v) => v.id === selected);
    const fresh = await api.reviewQueue(status).catch(() => null);
    if (!fresh) return;
    setQueue(fresh);
    const rest = fresh.items.filter((f) => filter === 'all' || f.severity === filter);
    setSelected(rest[Math.min(Math.max(i, 0), rest.length - 1)]?.id ?? null);
  }, [visible, selected, status, filter]);

  const current = visible.find((f) => f.id === selected) ?? null;
  const total = queue ? Object.values(queue.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="gq">
      <div className="gq-header">
        <h1 className="page-title">Review queue</h1>
        {tabs}
        <div className="header-status">
          <button className={`status-pill gq-filter${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            all <b>{total}</b>
          </button>
          {SEVERITIES.map((s) => (
            <button key={s} className={`status-pill gq-filter rq-sev-${s}${filter === s ? ' active' : ''}`} onClick={() => setFilter(s)}>
              {LABEL[s]} <b>{queue?.counts[s] ?? 0}</b>
            </button>
          ))}
          <button
            className="status-pill gq-filter"
            title="pending findings, or ones already decided"
            onClick={() => { setStatus(status === 'pending' ? 'resolved' : 'pending'); setSelected(null); }}
          >
            showing <b>{status}</b>
          </button>
        </div>
      </div>

      {error && <div className="error-block">{error}</div>}

      <div className="gq-body">
        <aside className="gq-list">
          {visible.length === 0 && (
            <p className="muted empty-state">
              {status === 'pending' ? 'Nothing to review here. Findings arrive when an extraction batch is submitted.' : 'Nothing resolved yet.'}
            </p>
          )}
          {visible.map((f) => (
            <button key={f.id} className={`gq-item${selected === f.id ? ' selected' : ''}`} onClick={() => setSelected(f.id)}>
              <div className="gq-item-top">
                <span className={`gq-dot rq-dot-${f.severity}`} title={LABEL[f.severity]} />
                <span className="gq-item-name" data-card-id={f.oracle_id}>{f.name}</span>
              </div>
              <div className="gq-item-meta muted">
                {LABEL[f.severity]} · {f.rank_score} {f.rank_key === 'degree' ? 'degree' : 'connective'} · run {f.run_id}
              </div>
            </button>
          ))}
        </aside>

        <main className="gq-pane">
          {!current && <p className="muted empty-state">Select a finding.</p>}
          {current && <FindingPane key={current.id} finding={current} onResolved={() => void afterResolve()} />}
        </main>
      </div>
    </div>
  );
}

function FindingPane({ finding, onResolved }: { finding: QueueFinding; onResolved: () => void }) {
  const [atoms, setAtoms] = useState<AtomsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.atoms(finding.oracle_id).then(setAtoms).catch(() => setAtoms(null));
  }, [finding.oracle_id]);

  const act = async (fn: () => Promise<string>, resolves: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      setMessage({ ok: true, text });
      if (resolves) onResolved();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const d = finding.detail ?? {};
  const pending = finding.status === 'pending';
  const focusText = (() => {
    const f = finding.focus[0];
    const face = f && atoms?.faces.find((x) => x.face_index === f.face_index);
    return face ? face.oracle_text.slice(f.span_start, f.span_end) : String(d['quote'] ?? '');
  })();

  return (
    <div className="rq-pane">
      <div className="rq-head">
        <span className={`rq-sev rq-sev-${finding.severity}`}>{LABEL[finding.severity]}</span>
        <h2 className="rq-card"><span data-card-id={finding.oracle_id}>{finding.name}</span></h2>
        <a className="rq-open" href={`#/card/${finding.oracle_id}?finding=${finding.id}`}>open in inspector →</a>
      </div>
      <p className="rq-summary">{finding.summary}</p>
      <div className="rq-meta muted">
        run {finding.run_id} · rank {finding.severity_rank} · {finding.rank_key === 'degree'
          ? <span title="out-degree + in-degree + class edges in the latest graph build (Phase 3 sec. 14.2)">degree {finding.rank_score}</span>
          : <>{finding.rank_score} connective atom{finding.rank_score === 1 ? '' : 's'}</>}
        {finding.detail_table && <> · {finding.detail_table} #{finding.detail_id}</>} · {finding.status}
      </div>

      {(finding.severity === 'missing_rule' || finding.severity === 'unclassified' || finding.severity === 'splitter_disagreement') && (
        <div className="rq-detail">
          {d['quote'] !== undefined && <blockquote className="gr-quote">{String(d['quote'])}</blockquote>}
          {d['statement'] !== undefined && <p><span className="ad-k">extractor said</span> {String(d['statement'])}</p>}
          {d['proposed_label'] !== undefined && <p><span className="ad-k">proposed label</span> <code>{String(d['proposed_label'])}</code></p>}
          {d['rationale'] !== undefined && <p><span className="ad-k">rationale</span> {String(d['rationale'])}</p>}
          {d['note'] !== undefined && <p><span className="ad-k">note</span> {String(d['note'])}</p>}
          {d['resolved_rule'] ? <p><span className="ad-k">resolved rule</span> {String(d['resolved_rule'])}</p> : null}
        </div>
      )}

      {atoms?.faces.map((face) => (
        <div className="atoms-face" key={face.face_index}>
          <div className="atoms-face-head">
            <span className="atoms-face-index">Face {face.face_index}</span>
            <span className="muted atoms-face-counts">{face.atoms.length} current atoms</span>
          </div>
          <AtomSpans face={face} focus={finding.focus} />
        </div>
      ))}

      {message && <div className={message.ok ? 'rq-ok' : 'error-block'}>{message.text}</div>}

      {pending && (
        <div className="rq-actions">
          {finding.severity === 'missing_rule' && <MissingRuleAction busy={busy} onSubmit={(rule) => act(async () => {
            const r = await api.acceptMissingRule(finding.id, rule);
            return `Rule ${rule} ${r.kernelAdded ? 'joined the kernel' : 'was already in the kernel'}; ` +
              `${r.requeued} extracted card(s) requeued (kernel_changed; ${r.phrases.length > 0 ? `phrases: ${r.phrases.map((p) => `"${p}"`).join(', ')}` : 'reporting cards only'}). Packet hash ${r.policySha.before.slice(0, 8)} → ${r.policySha.after.slice(0, 8)}.`;
          }, true)} />}

          {finding.severity === 'unclassified' && <PromoteAction busy={busy} detail={d} onSubmit={(req) => act(async () => {
            const r = await api.promoteFinding(finding.id, req);
            return `${req.family} ${req.type_key} published in schema v${r.schemaVersion}; ${r.requeued} card(s) requeued (schema_promoted).`;
          }, true)} />}

          {finding.severity === 'splitter_disagreement' && (
            <div className="rq-action">
              <h3>Adjudicate the split</h3>
              <p className="muted">Accepting records a splitter bug. Nothing changes until the splitter is fixed and its version bumped; then every affected card is re-split and requeued.</p>
              <button className="gr-btn gr-btn-accept" disabled={busy}
                onClick={() => void act(async () => { await api.acceptSplitter(finding.id); return 'Marked as a splitter bug.'; }, true)}>
                Accept: the split is wrong
              </button>
            </div>
          )}

          <CorrectAction busy={busy} finding={finding} atoms={atoms} defaultQuote={focusText} onSubmit={(req) => act(async () => {
            const r = await api.correctFinding(finding.id, req);
            return `Golden atom #${r.golden_atom_id} written (source = review_correction). The finding stays open until you accept it.`;
          }, false)} />

          <div className="rq-action rq-action-accept">
            <button className="gr-btn" disabled={busy}
              onClick={() => void act(async () => { await api.acceptFinding(finding.id); return 'Accepted as correct.'; }, true)}>
              Accept as correct
            </button>
            <span className="muted">
              {finding.severity === 'missing_rule' ? 'The extraction stands; the report is closed as not needed.'
                : finding.severity === 'unclassified' ? 'No new type; the clause stays unclassified, closed.'
                : finding.severity === 'splitter_disagreement' ? 'The split is fine; the disagreement is closed.'
                : 'The extraction stands as it is.'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function MissingRuleAction({ busy, onSubmit }: { busy: boolean; onSubmit: (rule: string) => void }) {
  const [rule, setRule] = useState('');
  return (
    <div className="rq-action rq-action-primary">
      <h3>Promote the missing rule into the kernel</h3>
      <p className="muted">
        The rule joins every card's packet from now on, so this fixes every card with the same text shape. Name the
        rule the packet lacked, exactly as numbered in the Comprehensive Rules.
      </p>
      <div className="gr-buttons">
        <input className="rq-input mono" placeholder="e.g. a rule number" value={rule} onChange={(e) => setRule(e.target.value)} />
        <button className="gr-btn gr-btn-accept" disabled={busy || !rule.trim()} onClick={() => onSubmit(rule.trim())}>
          Accept report and promote
        </button>
      </div>
    </div>
  );
}

function PromoteAction({ busy, detail, onSubmit }: {
  busy: boolean; detail: Record<string, unknown>;
  onSubmit: (req: { family: AtomFamily; type_key: string; label: string; evidence: string }) => void;
}) {
  const proposed = String(detail['proposed_label'] ?? '');
  const [family, setFamily] = useState<AtomFamily>('ENABLES');
  const [typeKey, setTypeKey] = useState(proposed.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  const [label, setLabel] = useState('');
  const [evidence, setEvidence] = useState('');
  return (
    <div className="rq-action">
      <h3>Promote into the vocabulary</h3>
      <p className="muted">
        Publishes a new schema version with this type added, and requeues every card holding an open
        unclassified clause with the same proposed label. The subject of an atom is a param, never part of its type key.
      </p>
      <div className="rq-form">
        <label>family
          <select className="select-input" value={family} onChange={(e) => setFamily(e.target.value as AtomFamily)}>
            {FAMILIES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>type_key <input className="rq-input mono" value={typeKey} onChange={(e) => setTypeKey(e.target.value)} /></label>
        <label>label <input className="rq-input" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="rq-wide">evidence <textarea className="gr-note" rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)}
          placeholder="why this is a mechanism of its own" /></label>
      </div>
      <button className="gr-btn gr-btn-accept" disabled={busy || !typeKey || !label.trim() || !evidence.trim()}
        onClick={() => onSubmit({ family, type_key: typeKey, label: label.trim(), evidence: evidence.trim() })}>
        Promote type
      </button>
    </div>
  );
}

function CorrectAction({ busy, finding, atoms, defaultQuote, onSubmit }: {
  busy: boolean; finding: QueueFinding; atoms: AtomsResponse | null; defaultQuote: string;
  onSubmit: (req: { face_index: number; family: string; type_key: string; params: Record<string, unknown>;
    quote: string; span_start?: number; rule_numbers: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<AtomTypeOption[]>([]);
  const [face, setFace] = useState(finding.focus[0]?.face_index ?? 0);
  const [type, setType] = useState('');
  const [quote, setQuote] = useState(defaultQuote);
  const [spanStart, setSpanStart] = useState('');
  const [rules, setRules] = useState('');
  const [params, setParams] = useState('{}');
  const [paramsError, setParamsError] = useState<string | null>(null);

  useEffect(() => { setQuote(defaultQuote); }, [defaultQuote]);
  useEffect(() => {
    if (open && types.length === 0) api.atomTypes().then((r) => setTypes(r.types)).catch(() => setTypes([]));
  }, [open, types.length]);

  if (!open) {
    return (
      <div className="rq-action">
        <button className="gr-btn gr-btn-ghost" onClick={() => setOpen(true)}>Correct an atom…</button>
        <span className="muted"> writes a permanent golden atom the next scoring run measures against</span>
      </div>
    );
  }

  const submit = () => {
    let p: Record<string, unknown>;
    try {
      const v = JSON.parse(params) as unknown;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('params must be a JSON object');
      p = v as Record<string, unknown>;
    } catch (err) {
      setParamsError((err as Error).message);
      return;
    }
    setParamsError(null);
    const [family, typeKey] = type.split(' ');
    onSubmit({
      face_index: face, family: family!, type_key: typeKey!, params: p, quote,
      ...(spanStart.trim() ? { span_start: Number(spanStart) } : {}),
      rule_numbers: rules.split(/[\s,]+/).filter(Boolean),
    });
  };

  const selected = types.find((t) => `${t.family} ${t.type_key}` === type);
  return (
    <div className="rq-action">
      <h3>Correct an atom</h3>
      <p className="muted">Recorded as a golden atom with <code>source = review_correction</code>; the card gets a partial golden record if it has none.</p>
      <div className="rq-form">
        <label>face
          <select className="select-input" value={face} onChange={(e) => setFace(Number(e.target.value))}>
            {(atoms?.faces ?? [{ face_index: 0 }]).map((f) => <option key={f.face_index} value={f.face_index}>{f.face_index}</option>)}
          </select>
        </label>
        <label className="rq-wide">type
          <select className="select-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">choose…</option>
            {types.map((t) => <option key={`${t.family} ${t.type_key}`} value={`${t.family} ${t.type_key}`}>{t.family} {t.type_key} — {t.label}</option>)}
          </select>
        </label>
        <label className="rq-wide">quote (verbatim) <textarea className="gr-note" rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} /></label>
        <label>span_start <input className="rq-input mono" placeholder="if repeated" value={spanStart} onChange={(e) => setSpanStart(e.target.value)} /></label>
        <label>rules <input className="rq-input mono" placeholder="cited rule numbers" value={rules} onChange={(e) => setRules(e.target.value)} /></label>
        <label className="rq-wide">params (JSON) <textarea className="gr-note mono" rows={2} value={params} onChange={(e) => setParams(e.target.value)} /></label>
        {selected && <div className="rq-wide muted rq-schema">params schema: <code>{selected.params_schema}</code></div>}
      </div>
      {paramsError && <div className="error-block">{paramsError}</div>}
      <div className="gr-buttons">
        <button className="gr-btn gr-btn-accept" disabled={busy || !type || !quote || !rules.trim()} onClick={submit}>Write correction</button>
        <button className="gr-btn gr-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- the edge domain (Phase 3 sec. 10.1) ----------

const EDGE_SEVERITIES: EdgeSeverity[] = ['edge_role_disagreement', 'edge_rule_disagreement', 'edge_report'];

const EDGE_LABEL: Record<EdgeSeverity, string> = {
  edge_role_disagreement: 'role disagreement',
  edge_rule_disagreement: 'rule disagreement',
  edge_report: 'link reports',
};

/** What rank_score counts for each edge severity (spec sec. 10.1, rank table). */
const EDGE_SCORE: Record<EdgeSeverity, string> = {
  edge_role_disagreement: 'Stage B rules',
  edge_rule_disagreement: 'atom edges',
  edge_report: 'card degree',
};

/** The id of a list item: a finding (`f:<id>`) or a reason group of reports (`g:<reason key>`). */
type ItemId = string;

function EdgeQueue({ tabs, initialFinding }: { tabs: ReactNode; initialFinding?: number }) {
  const [queue, setQueue] = useState<EdgeQueueResponse | null>(null);
  const [groups, setGroups] = useState<ReasonGroup[] | null>(null);
  const [dispatcher, setDispatcher] = useState<FixDispatcher | null>(null);
  const [status, setStatus] = useState<'pending' | 'resolved'>('pending');
  const [filter, setFilter] = useState<EdgeSeverity | 'all'>('all');
  const [selected, setSelected] = useState<ItemId | null>(initialFinding !== undefined ? `f:${initialFinding}` : null);
  // A deep link (the edge-rules page) can name a resolved finding: look in the other list once.
  const [looked, setLooked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = useTypeLabels();

  const load = useCallback(() => {
    api.edgeQueue(status).then((q) => { setQueue(q); setError(null); }).catch((err: Error) => setError(err.message));
    api.reportGroups(status === 'pending' ? 'open' : 'closed').then((g) => { setGroups(g.groups); setDispatcher(g.dispatcher); })
      .catch((err: Error) => setError(err.message));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  // While a fix request waits for delivery, read the groups again, so its status changes without a reload.
  const waiting = useMemo(() => (groups ?? []).some((g) => g.fix_requests.some((f) => f.status === 'queued')), [groups]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api.reportGroups(status === 'pending' ? 'open' : 'closed').then((g) => { setGroups(g.groups); setDispatcher(g.dispatcher); }).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(t);
  }, [waiting, status]);

  // The reports show by reason, so the report findings themselves are not in the list.
  const findings = useMemo(
    () => (queue?.items ?? []).filter((f) => f.severity !== 'edge_report' && (filter === 'all' || f.severity === filter)),
    [queue, filter],
  );
  const shownGroups = useMemo(() => (filter === 'all' || filter === 'edge_report' ? groups ?? [] : []), [groups, filter]);
  const ids = useMemo(() => [...shownGroups.map((g) => `g:${g.key}`), ...findings.map((f) => `f:${f.id}`)], [shownGroups, findings]);

  useEffect(() => {
    if (!queue || !groups) return;
    // A report finding opens the group of its reason.
    const hit = selected?.startsWith('f:') ? queue.items.find((f) => `f:${f.id}` === selected) : undefined;
    if (hit?.severity === 'edge_report') {
      const g = groups.find((x) => x.reports.some((r) => r.id === hit.detail_id));
      if (g) { setSelected(`g:${g.key}`); return; }
    }
    if (initialFinding !== undefined && !looked && selected === `f:${initialFinding}` && !queue.items.some((f) => f.id === initialFinding)) {
      setLooked(true);
      setStatus(status === 'pending' ? 'resolved' : 'pending');
      return;
    }
    if (ids.length === 0) return;
    if (selected === null || !ids.includes(selected)) setSelected(ids[0]!);
  }, [queue, groups, ids, selected, initialFinding, looked, status]);

  const current = findings.find((f) => `f:${f.id}` === selected) ?? null;
  const group = shownGroups.find((g) => `g:${g.key}` === selected) ?? null;
  const total = queue ? Object.values(queue.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="gq">
      <div className="gq-header">
        <h1 className="page-title">Review queue</h1>
        {tabs}
        <div className="header-status">
          <button className={`status-pill gq-filter${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            all <b>{total}</b>
          </button>
          {EDGE_SEVERITIES.map((s) => (
            <button key={s} className={`status-pill gq-filter${filter === s ? ' active' : ''}`} onClick={() => setFilter(s)}
              title={s === 'edge_report' ? 'your reports on links, one item for each reason' : undefined}>
              {EDGE_LABEL[s]} <b>{queue?.counts[s] ?? 0}</b>
            </button>
          ))}
          <button
            className="status-pill gq-filter"
            title="pending findings, or ones already decided"
            onClick={() => { setStatus(status === 'pending' ? 'resolved' : 'pending'); setSelected(null); }}
          >
            showing <b>{status}</b>
          </button>
        </div>
      </div>

      {error && <div className="error-block">{error}</div>}

      <div className="gq-body">
        <aside className="gq-list">
          {ids.length === 0 && (
            <p className="muted empty-state">
              {status === 'pending'
                ? 'No edge findings. They arrive when the edge rules are derived and when a person reports an edge.'
                : 'Nothing resolved yet.'}
            </p>
          )}
          {shownGroups.map((g) => (
            <button key={g.key} className={`gq-item${selected === `g:${g.key}` ? ' selected' : ''}`} onClick={() => setSelected(`g:${g.key}`)}>
              <div className="gq-item-top">
                <span className="gq-dot rq-dot-edge_report" title="link reports" />
                <span className="gq-item-name">{groupTitle(g, labels)}</span>
                <span className="fx-count" title="reports on this reason">{g.report_count}</span>
              </div>
              <div className="gq-item-meta muted">
                {g.report_count} report{g.report_count === 1 ? '' : 's'} · reason {g.rules.map((r) => r.rule_id).join(', ')}
                {g.links && <> · {g.links.count.toLocaleString()} links</>}
                {g.fix_requests.length > 0 && <> · fix <FixStatusPill request={g.fix_requests[g.fix_requests.length - 1]!} dispatcher={dispatcher} /></>}
              </div>
            </button>
          ))}
          {findings.map((f) => (
            <button key={f.id} className={`gq-item${selected === `f:${f.id}` ? ' selected' : ''}`} onClick={() => setSelected(`f:${f.id}`)}>
              <div className="gq-item-top">
                <span className={`gq-dot rq-dot-${f.severity}`} title={EDGE_LABEL[f.severity]} />
                <span className="gq-item-name" data-card-name={f.name ?? undefined}>{f.name ?? f.summary}</span>
              </div>
              <div className="gq-item-meta muted">
                {EDGE_LABEL[f.severity]} · {f.rank_score} {EDGE_SCORE[f.severity]} · set {f.rule_set_id}
              </div>
            </button>
          ))}
        </aside>

        <main className="gq-pane">
          {!current && !group && <p className="muted empty-state">Select a finding.</p>}
          {current && <EdgeFindingPane key={current.id} finding={current} onDecided={load} />}
          {group && <ReasonGroupPane key={group.key} group={group} labels={labels} dispatcher={dispatcher} onChanged={load} />}
        </main>
      </div>
    </div>
  );
}

/** The short name of a reason: "gives X → needs Y". */
function groupTitle(g: ReasonGroup, labels: Record<string, string>): string {
  return g.rules.map((r) => `${r.polarity === '-' ? 'conflict: ' : ''}gives “${plainSide(r.supply, labels)}” → needs “${plainSide(r.demand, labels)}”`).join(' + ')
    || g.rule_hashes.join(', ');
}

/** The reports on one reason, the links of the reason, its fix requests and the "Fix this reason" form. */
function ReasonGroupPane({ group: g, labels, dispatcher, onChanged }: {
  group: ReasonGroup; labels: Record<string, string>; dispatcher: FixDispatcher | null; onChanged: () => void;
}) {
  const [fixing, setFixing] = useState(false);
  const ruleIds = g.rules.map((r) => r.rule_id);
  const graphHref = (oracle: string, build: number) => `#/graph/${encodeURIComponent(oracle)}?build=${build}`;
  return (
    <div className="rq-pane fx-pane">
      <div className="rq-head">
        <h2 className="rq-card">{groupTitle(g, labels)}</h2>
        <span className="rq-sev rq-sev-edge_report">{g.report_count} report{g.report_count === 1 ? '' : 's'}</span>
      </div>
      {g.rules.map((r) => (
        <p key={r.rule_hash} className="rq-summary"><Term id="reason" /> <span className="mono">{r.rule_id}</span>: {r.sentence}</p>
      ))}
      {g.links && (
        <p className="fx-links">
          In <Term id="version">graph version</Term> {g.links.build_id}, this reason makes <b>{g.links.count.toLocaleString()}</b> links
          ({g.links.strong.toLocaleString()} <Term id="strong">strong matches</Term>) between {g.links.card_pairs.toLocaleString()} card pairs.
        </p>
      )}

      <div className="fx-actions">
        {!fixing && <button className="gr-btn gr-btn-accept" onClick={() => setFixing(true)}>Fix this reason</button>}
        {fixing && (
          <FixReasonForm ruleHashes={g.rule_hashes} ruleIds={ruleIds} {...(g.links ? { buildId: g.links.build_id } : {})}
            onSaved={() => onChanged()} onCancel={() => setFixing(false)} />
        )}
      </div>

      <h3 className="fx-h">Fix requests</h3>
      <FixRequestList items={g.fix_requests} dispatcher={dispatcher} />

      <h3 className="fx-h">Your reports ({g.report_count})</h3>
      <ul className="fx-reports">
        {g.reports.map((r) => (
          <li key={r.id}>
            <div className="fx-report-head">
              <a href={graphHref(r.demand_oracle, r.build_id)}><b data-card-name={r.supply_name}>{r.supply_name}</b> → <b data-card-id={r.demand_oracle}>{r.demand_name}</b></a>
              <span className="muted">report {r.id} · {r.created_at.slice(0, 16).replace('T', ' ')} · graph version {r.build_id}{r.status !== 'open' ? ` · ${r.status}` : ''}</span>
            </div>
            <blockquote className="fx-quote" dir="auto">{r.note}</blockquote>
          </li>
        ))}
      </ul>

      {g.links && g.links.examples.length > 0 && (
        <>
          <h3 className="fx-h">Example links of this reason</h3>
          <ul className="fx-examples">
            {g.links.examples.map((e) => (
              <li key={e.key}>
                <a href={graphHref(e.demand_oracle, g.links!.build_id)}><b data-card-name={e.supply_name}>{e.supply_name}</b> → <b data-card-id={e.demand_oracle}>{e.demand_name}</b></a>
                <span className="muted"> gives “{e.supply_quote || 'no text marked'}” → needs “{e.demand_quote || 'no text marked'}”</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="gx-rules">
        <summary>Technical form and evidence</summary>
        {g.rules.map((r) => (
          <div key={r.rule_hash} className="gx-rule">
            <p className="muted">
              <span className="mono">{r.rule_id}</span> · {r.votes} of 3 runs wrote this reason · {r.status} · rule set {r.rule_set_id} ·{' '}
              <span className="mono">{r.technical}</span>
            </p>
            <RuleEvidenceList rule={r} />
          </div>
        ))}
      </details>
    </div>
  );
}

/** The link of a finding to its page (plan Task 7 Step 5): a rule or a role to the edge-rules page, a report to the explorer. */
function findingLink(f: EdgeFinding): { href: string; label: string } {
  if (f.severity === 'edge_report' && f.oracle_id) {
    return { href: `#/graph/${encodeURIComponent(f.oracle_id)}${f.build_id !== null ? `?build=${f.build_id}` : ''}`, label: 'open the demand card in the graph explorer' };
  }
  if (f.severity === 'edge_role_disagreement') return { href: `#/edge-rules?tab=roles&finding=${f.id}`, label: 'open the role on the edge-rules page' };
  return { href: `#/edge-rules?finding=${f.id}`, label: 'open the rule on the edge-rules page' };
}

function EdgeFindingPane({ finding, onDecided }: { finding: EdgeFinding; onDecided: () => void }) {
  const link = findingLink(finding);
  return (
    <div className="rq-pane">
      <div className="rq-head">
        <h2 className="rq-card"><span data-card-name={finding.role_type ? undefined : finding.name ?? undefined}>{finding.role_type ?? finding.name ?? EDGE_LABEL[finding.severity]}</span></h2>
        <span className={`rq-sev rq-sev-${finding.severity}`}>{EDGE_LABEL[finding.severity]}</span>
      </div>
      <p className="rq-summary">{finding.summary}</p>
      <div className="rq-detail">
        <p><span className="ad-k">rule set</span>{finding.rule_set_id}</p>
        {finding.build_id !== null && <p><span className="ad-k">build</span>{finding.build_id}</p>}
        <p><span className="ad-k">rank</span>{finding.rank_score} {EDGE_SCORE[finding.severity]}</p>
        <p><span className="ad-k">detail</span>{finding.detail_table ?? '-'} #{finding.detail_id ?? '-'}</p>
        <p><span className="ad-k">page</span><a href={link.href}>{link.label}</a></p>
        <p className="muted rq-meta">{finding.status} · enqueued {finding.enqueued_at}</p>
      </div>
      {finding.severity === 'edge_role_disagreement' && finding.role_type && (
        <RoleDecision setId={finding.rule_set_id} typeId={finding.role_type} pending={finding.status === 'pending'} onDecided={onDecided} />
      )}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: RuleEvidence[] }) {
  if (evidence.length === 0) return <p className="muted">no evidence</p>;
  return (
    <ul>
      {evidence.map((e, i) => <li key={i}><span className="mono">{e.source === 'rule' ? `CR ${e.ref}` : e.ref}</span> <span className="gr-quote">"{e.quote}"</span></li>)}
    </ul>
  );
}

function ProposalCard({ pass, item }: { pass: number; item: RoleProposal }) {
  return (
    <div className="rq-action">
      <h3>Pass {pass}: {item.role}</h3>
      {item.demand_note && <p><span className="ad-k">demand note</span>{item.demand_note}</p>}
      <p><span className="ad-k">resources</span>{item.resources.length === 0 ? 'none' : ''}</p>
      {item.resources.map((r, i) => (
        <div key={i}>
          <p className="mono">{r.resource} {r.sign} {r.kind}{r.note ? ` (${r.note})` : ''}</p>
          <EvidenceList evidence={r.evidence} />
        </div>
      ))}
      <p><span className="ad-k">evidence</span></p>
      <EvidenceList evidence={item.evidence} />
    </div>
  );
}

/**
 * Plan Task 3 Step 7 and D13: a person decides a disputed role. The proposals of the passes are
 * shown next to each other. "Use this pass" copies the role, the note, the resource effects and
 * the verified evidence of that pass; "keep none" keeps the role none; "keep the voted role"
 * (an accepted role with an `other` resource item) changes nothing. Each needs a note.
 */
function RoleDecision({ setId, typeId, pending, onDecided }: { setId: number; typeId: string; pending: boolean; onDecided: () => void }) {
  const [data, setData] = useState<RoleProposals | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.roleProposals(setId, typeId).then(setData).catch((err: Error) => setError(err.message));
  }, [setId, typeId]);
  const [family, typeKey] = [typeId.slice(0, typeId.indexOf('.')), typeId.slice(typeId.indexOf('.') + 1)];
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => { setError(null); onDecided(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  if (error && !data) return <div className="error-block">{error}</div>;
  if (!data) return <p className="muted">Loading the proposals…</p>;
  return (
    <div className="rq-actions">
      <p>
        <span className="ad-k">current role</span>{data.role.role} ({data.role.status}, {data.role.votes} votes)
        {data.role.decision && <> · decided: {data.role.decision.decision === 'pass' ? `pass ${data.role.decision.pass_index}`
          : data.role.decision.decision === 'keep' ? 'keep the voted role' : 'keep none'} - {data.role.decision.note}</>}
      </p>
      {data.role.resources.length > 0 && (
        <p><span className="ad-k">voted resources</span>{data.role.resources.map((r) => `${r.resource} ${r.sign} ${r.kind}`).join(', ')}</p>
      )}
      {data.proposals.length === 0 && <p className="muted">No pass proposed a valid role for this type.</p>}
      <div className="rq-form">
        {data.proposals.map((p) => <ProposalCard key={p.pass_index} pass={p.pass_index} item={p.item} />)}
      </div>
      {pending && (
        <div className="rq-action rq-action-primary">
          <h3>Decide the role</h3>
          <p className="muted">Decide from the proposals and their CR quotes only. The note records why.</p>
          <textarea className="gr-note" rows={2} placeholder="note (required)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="gr-buttons">
            {data.proposals.map((p) => (
              <button key={p.pass_index} className="gr-btn gr-btn-accept" disabled={busy || !note.trim()}
                onClick={() => act(api.decideRole(setId, { family, type_key: typeKey, pass_index: p.pass_index, note: note.trim() }))}>
                Use pass {p.pass_index} ({p.item.role})
              </button>
            ))}
            {data.role.status === 'accepted' && (
              <button className="gr-btn gr-btn-accept" disabled={busy || !note.trim()}
                onClick={() => act(api.keepVotedRole(setId, { family, type_key: typeKey, note: note.trim() }))}>
                Keep the voted role ({data.role.role})
              </button>
            )}
            <button className="gr-btn gr-btn-ghost" disabled={busy || !note.trim()}
              onClick={() => act(api.keepRoleNone(setId, { family, type_key: typeKey, note: note.trim() }))}>
              Keep none
            </button>
          </div>
          {error && <div className="error-block">{error}</div>}
        </div>
      )}
    </div>
  );
}
