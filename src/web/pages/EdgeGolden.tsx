import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type GoldenCardView, type GoldenClauseRef, type GoldenEvidence, type GoldenLabel, type GoldenPair, type GoldenProgress,
} from '../api.js';

/**
 * The edge golden page (Phase 3 spec sec. 13.5, plan Task 2 Step 7). The owner adjudicates the
 * sample of sec. 11.4 here: accept the labeler's pair, or correct it with a note. Texts are
 * redacted ("~"): the page never shows a card name. The server checks each chain quote of a
 * correction and refuses it verbatim when a quote fails.
 */

type Filter = 'sample' | 'disputed' | 'accepted' | 'owner_accepted' | 'owner_corrected' | '';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'sample', label: 'owner sample' },
  { value: 'disputed', label: 'disputed' },
  { value: 'accepted', label: 'accepted' },
  { value: 'owner_accepted', label: 'owner accepted' },
  { value: 'owner_corrected', label: 'owner corrected' },
  { value: '', label: 'all' },
];

const CHARACTERISTICS = ['type_line', 'mana_value', 'color_identity', 'power_toughness'] as const;

/** A clause reference as text. A raw pass answer can hold any JSON value, so test the shape first. */
function refText(c: unknown): string {
  if (c === null || c === undefined) return '—';
  if (typeof c !== 'object' || Array.isArray(c)) return JSON.stringify(c);
  const r = c as Record<string, unknown>;
  if ('characteristic' in r) return `characteristic: ${String(r['characteristic'])}`;
  if ('face_index' in r && 'clause_index' in r) return `clause ${String(r['face_index'])}.${String(r['clause_index'])}`;
  return JSON.stringify(c);
}

export function EdgeGolden() {
  const [filter, setFilter] = useState<Filter>('sample');
  const [pairs, setPairs] = useState<GoldenPair[] | null>(null);
  const [progress, setProgress] = useState<GoldenProgress | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const [p, g] = await Promise.all([api.goldenPairs(filter), api.goldenProgress()]);
      if (mine !== request.current) return;           // a newer load has started: drop this one
      setPairs(p.pairs);
      setProgress(g);
      setError(null);
    } catch (err) {
      if (mine === request.current) setError((err as Error).message);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!pairs || pairs.length === 0) return;
    if (selected === null || !pairs.some((p) => p.id === selected)) setSelected(pairs[0]!.id);
  }, [pairs, selected]);

  const current = useMemo(() => pairs?.find((p) => p.id === selected) ?? null, [pairs, selected]);

  return (
    <div className="gq">
      <div className="gq-header">
        <h1 className="page-title">Edge golden set</h1>
        <div className="header-status">
          {FILTERS.map((f) => (
            <button key={f.label} className={`status-pill gq-filter${filter === f.value ? ' active' : ''}`} onClick={() => { setFilter(f.value); setSelected(null); }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-block">{error}</div>}
      {progress && <ProgressPanel progress={progress} />}

      <div className="gq-body">
        <aside className="gq-list">
          {pairs && pairs.length === 0 && (
            <p className="muted empty-state">
              {filter === 'sample' ? 'No owner sample yet. Run npm run edge-golden -- --owner-sample.' : 'No pairs here.'}
            </p>
          )}
          {(pairs ?? []).map((p) => (
            <button key={p.id} className={`gq-item${selected === p.id ? ' selected' : ''}`} onClick={() => setSelected(p.id)}>
              <div className="gq-item-top">
                <span className={`eg-label eg-label-${p.label ?? 'disputed'}`}>{p.label ?? 'disputed'}</span>
                <span className="gq-item-name">pair {p.id}</span>
              </div>
              <div className="gq-item-meta muted">
                {p.stratum} · round {p.round} · {p.status.replace('_', ' ')}{p.in_sample ? ' · in sample' : ''}
              </div>
            </button>
          ))}
        </aside>

        <main className="gq-pane">
          {!current && <p className="muted empty-state">Select a pair.</p>}
          {current && <PairPane key={current.id} pair={current} onDone={() => void load()} />}
        </main>
      </div>
    </div>
  );
}

function ProgressPanel({ progress }: { progress: GoldenProgress }) {
  const a = progress.agreement;
  return (
    <section className="eg-progress">
      <div className="eg-progress-head">
        <span className="status-pill">labelled <b>{progress.labelled}</b> / cap {progress.cap}</span>
        <span className="status-pill">{progress.met ? 'all targets met' : 'targets open'}</span>
        <span className="status-pill">
          owner sample {a.sample || '—'}: <b>{a.decided}/{a.sampled}</b> decided · {a.corrected} corrected
          {a.corrected >= progress.owner_correction_limit ? ' (limit reached)' : ''} · agreement{' '}
          <b>{a.rate === null ? '—' : `${Math.round(a.rate * 100)}%`}</b>
        </span>
        {progress.review.reviewed > 0 && (
          <span className="status-pill" title="the isolated reviewer (spec rev. 8 sec. 11.4)">
            reviewer: <b>{progress.review.agree + progress.review.clause_differs}/{progress.review.reviewed - progress.review.invalid}</b> same label
            · {progress.review.label_differs} other label{progress.review.label_differs >= progress.owner_correction_limit ? ' (limit reached)' : ''}
            · {progress.review.invalid} invalid
          </span>
        )}
      </div>
      <div className="eg-targets">
        {progress.targets.map((t) => (
          <span key={t.target} className={`eg-target${t.have >= t.want ? ' met' : ''}`}>
            {t.target.replace('synergy:CARES_ABOUT.', 'synergy · ')} <b>{t.have}/{t.want}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

function CardPanel({ title, card, clause, atomId }: {
  title: string; card: GoldenCardView; clause: GoldenClauseRef | null; atomId: number | null;
}) {
  const isClause = (f: number, c: number) => !!clause && !('characteristic' in clause) && clause.face_index === f && clause.clause_index === c;
  const charOn = (k: string) => !!clause && 'characteristic' in clause && clause.characteristic === k;
  return (
    <div className="eg-card">
      <h3 className="eg-card-title">{title}</h3>
      {card.unavailable && <div className="error-block">The text is not available: {card.unavailable}</div>}
      <div className="muted eg-chars">
        <span className={charOn('mana_value') ? 'eg-hit' : undefined}>mana value {card.mana_value}</span> ·{' '}
        <span className={charOn('color_identity') ? 'eg-hit' : undefined}>color identity {card.color_identity.join(', ') || '(none)'}</span>
      </div>
      {card.faces.map((f) => (
        <div key={f.face_index} className="eg-face">
          <div className={`eg-typeline${charOn('type_line') ? ' eg-hit' : ''}`}>face {f.face_index} · {f.type_line}</div>
          {(f.power !== null || f.toughness !== null) && (
            <div className={`eg-typeline${charOn('power_toughness') ? ' eg-hit' : ''}`}>power/toughness {f.power ?? '-'}/{f.toughness ?? '-'}</div>
          )}
          <ol className="eg-clauses">
            {f.clauses.map((c) => (
              <li key={c.clause_index} className={isClause(c.face_index, c.clause_index) ? 'eg-hit' : undefined}>
                <span className="mono muted">{c.face_index}.{c.clause_index}</span> {c.text}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <ul className="eg-atoms">
        {card.atoms.map((a) => (
          <li key={a.id} className={a.id === atomId ? 'eg-hit' : undefined}>
            <span className="mono">{a.id}</span> {a.family} {a.type_key}
            {Object.keys(a.params).length > 0 && <span className="mono muted"> {JSON.stringify(a.params)}</span>}
            <span className="muted"> · {a.clauses.length ? `clause ${a.clauses.join(', ')}` : 'type line'}</span>
            {a.quote && <div className="muted eg-quote"><q>{a.quote}</q></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PairPane({ pair, onDone }: { pair: GoldenPair; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const decided = pair.status === 'owner_accepted' || pair.status === 'owner_corrected';

  const send = async (v: Parameters<typeof api.goldenVerdict>[1]) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.goldenVerdict(pair.id, v);
      setMessage({ ok: true, text: 'Saved.' });
      onDone();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rq-pane">
      <div className="rq-head">
        <span className={`eg-label eg-label-${pair.label ?? 'disputed'}`}>{pair.label ?? 'disputed'}</span>
        <h2 className="rq-card">pair {pair.id}</h2>
      </div>
      <div className="rq-meta muted">
        {pair.stratum} · round {pair.round} · {pair.status.replace('_', ' ')} · {pair.votes} of 3 votes
        {pair.owner_note && <> · owner note: {pair.owner_note}</>}
      </div>
      <p className="rq-summary">
        supply {refText(pair.supply_clause)} (atom {pair.supply_atom_id ?? 'null'}) → demand {refText(pair.demand_clause)} (atom {pair.demand_atom_id ?? 'null'})
      </p>

      <div className="eg-cards">
        <CardPanel title="Supply card S" card={pair.supply} clause={pair.supply_clause} atomId={pair.supply_atom_id} />
        <CardPanel title="Demand card D" card={pair.demand} clause={pair.demand_clause} atomId={pair.demand_atom_id} />
      </div>

      <h3 className="eg-section">CR chain</h3>
      {pair.cr_chain.length === 0 ? <p className="muted">(none)</p> : (
        <ul className="eg-chain">
          {pair.cr_chain.map((e, i) => (
            <li key={i}><span className="mono">{e.source === 'rule' ? e.ref : `glossary: ${e.ref}`}</span> <q>{e.quote}</q></li>
          ))}
        </ul>
      )}

      <h3 className="eg-section">Votes</h3>
      <ul className="eg-passes">
        {pair.passes.map((p) => {
          const a = p.answer !== null && typeof p.answer === 'object' && !Array.isArray(p.answer) ? p.answer as Record<string, unknown> : null;
          return (
            <li key={p.pass_index}>
              <span className="mono">pass {p.pass_index}</span>{' '}
              {a ? `${String(a['label'] ?? '?')} · supply ${refText(a['supply'])} · demand ${refText(a['demand'])}`
                : p.answer === null ? 'no answer' : JSON.stringify(p.answer)}
              {p.fault && <span className="eg-fault"> · {p.fault}</span>}
            </li>
          );
        })}
      </ul>

      {pair.review && (() => {
        const r = pair.review.answer !== null && typeof pair.review.answer === 'object' && !Array.isArray(pair.review.answer)
          ? pair.review.answer as Record<string, unknown> : null;
        return (
          <p className="muted">
            <span className="mono">reviewer</span> {pair.review.outcome.replace('_', ' ')}
            {r && ` · ${String(r['label'] ?? '?')} · supply ${refText(r['supply'])} · demand ${refText(r['demand'])}`}
            {pair.review.fault && <span className="eg-fault"> · {pair.review.fault}</span>}
          </p>
        );
      })()}

      {message && <div className={message.ok ? 'gr-note' : 'error-block'}>{message.text}</div>}
      {!decided && pair.status !== 'stale' && !pair.supply.unavailable && !pair.demand.unavailable && (
        <>
          <div className="rq-actions">
            <button className="rq-action rq-action-accept" disabled={busy || pair.label === null} onClick={() => void send({ accept: true })}
              title={pair.label === null ? 'A disputed pair has no label to accept: give a correction.' : undefined}>
              Accept the labeler's pair
            </button>
          </div>
          <CorrectionForm pair={pair} busy={busy} onSend={(v) => void send(v)} />
        </>
      )}
    </div>
  );
}

function clauseOptions(card: GoldenCardView, withCharacteristics: boolean): Array<{ value: string; label: string }> {
  return [
    ...card.faces.flatMap((f) => f.clauses.map((c) => ({ value: `${c.face_index}.${c.clause_index}`, label: `clause ${c.face_index}.${c.clause_index}: ${c.text.slice(0, 60)}` }))),
    ...(withCharacteristics ? CHARACTERISTICS.map((k) => ({ value: `char:${k}`, label: `characteristic: ${k}` })) : []),
  ];
}

function parseRef(v: string): GoldenClauseRef | null {
  if (v === '') return null;
  if (v.startsWith('char:')) return { characteristic: v.slice(5) as (typeof CHARACTERISTICS)[number] };
  const [f, c] = v.split('.').map(Number);
  return { face_index: f!, clause_index: c! };
}

const refValue = (c: GoldenClauseRef | null) =>
  !c ? '' : 'characteristic' in c ? `char:${c.characteristic}` : `${c.face_index}.${c.clause_index}`;

function CorrectionForm({ pair, busy, onSend }: {
  pair: GoldenPair; busy: boolean; onSend: (v: Parameters<typeof api.goldenVerdict>[1]) => void;
}) {
  const [label, setLabel] = useState<GoldenLabel>(pair.label ?? 'none');
  const [supply, setSupply] = useState(refValue(pair.supply_clause));
  const [demand, setDemand] = useState(refValue(pair.demand_clause));
  const [supplyAtom, setSupplyAtom] = useState(pair.supply_atom_id === null ? '' : String(pair.supply_atom_id));
  const [demandAtom, setDemandAtom] = useState(pair.demand_atom_id === null ? '' : String(pair.demand_atom_id));
  const [chain, setChain] = useState(JSON.stringify(pair.cr_chain, null, 2));
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const polar = label !== 'none';

  const submit = () => {
    let crChain: GoldenEvidence[];
    try {
      crChain = JSON.parse(chain || '[]') as GoldenEvidence[];
      if (!Array.isArray(crChain)) throw new Error('not an array');
    } catch {
      setLocal('The CR chain must be a JSON array of {"source", "ref", "quote"} items.');
      return;
    }
    setLocal(null);
    onSend({
      accept: false, label, note,
      supply_clause: polar ? parseRef(supply) : null,
      demand_clause: polar ? parseRef(demand) : null,
      supply_atom_id: polar && supplyAtom !== '' && !supply.startsWith('char:') ? Number(supplyAtom) : null,
      demand_atom_id: polar && demandAtom !== '' ? Number(demandAtom) : null,
      cr_chain: crChain,
    });
  };

  return (
    <div className="rq-form eg-form">
      <label>Label
        <select className="select-input" value={label} onChange={(e) => setLabel(e.target.value as GoldenLabel)}>
          <option value="synergy">synergy</option><option value="anti">anti</option><option value="none">none</option>
        </select>
      </label>
      {polar && (
        <>
          <label>Supply clause
            <select className="select-input" value={supply} onChange={(e) => setSupply(e.target.value)}>
              <option value="">—</option>
              {clauseOptions(pair.supply, true).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>Supply atom
            <select className="select-input" value={supplyAtom} onChange={(e) => setSupplyAtom(e.target.value)} disabled={supply.startsWith('char:')}>
              <option value="">null (no atom)</option>
              {pair.supply.atoms.map((a) => <option key={a.id} value={a.id}>{a.id} {a.family} {a.type_key}</option>)}
            </select>
          </label>
          <label>Demand clause
            <select className="select-input" value={demand} onChange={(e) => setDemand(e.target.value)}>
              <option value="">—</option>
              {clauseOptions(pair.demand, false).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>Demand atom
            <select className="select-input" value={demandAtom} onChange={(e) => setDemandAtom(e.target.value)}>
              <option value="">null (no atom)</option>
              {pair.demand.atoms.map((a) => <option key={a.id} value={a.id}>{a.id} {a.family} {a.type_key}</option>)}
            </select>
          </label>
        </>
      )}
      <label className="rq-wide">CR chain (JSON: source "rule" or "glossary", ref, quote)
        <textarea className="rq-input mono" rows={5} value={chain} onChange={(e) => setChain(e.target.value)} />
      </label>
      <label className="rq-wide">Note (required)
        <textarea className="rq-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {local && <div className="error-block rq-wide">{local}</div>}
      <div className="rq-actions rq-wide">
        <button className="rq-action rq-action-primary" disabled={busy || note.trim() === ''} onClick={submit}>Save the correction</button>
      </div>
    </div>
  );
}
