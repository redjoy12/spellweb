import { useEffect, useState } from 'react';
import { api, reasonKey, type AtomFace, type AtomFamily, type EdgeRuleView, type EdgeView, type GraphCardView } from '../api.js';
import { kindName, plainSide, sideText, typeName, typeTitle } from '../lib/terms.js';
import { mergeQuotes } from '../lib/quoteMerge.js';
import { AtomSpans } from './AtomSpans.js';
import { FixReasonForm } from './FixReason.js';
import { appendText, MicButton } from './MicButton.js';
import { Term } from './Term.js';

/**
 * One merged edge of the graph explorer (Phase 3 spec sec. 13.1 item 3), in plain words (owner request
 * 2026-10-18): the other card, the text that one card gives and the text that the other card needs
 * (both marked in their oracle texts), the match, the broad-link mark and the strength. The reason,
 * the Comprehensive Rules quotes and the strength parts are in a closed "why" section. The
 * "report this link" control writes an edge report (sec. 13.4); its note can be spoken (MicButton).
 * "Fix this reason" hands the reason of the link to a named Claude session (FixReason.tsx).
 */

const FAMILIES = new Set<AtomFamily>(['PRODUCES', 'CARES_ABOUT', 'ENABLES', 'COMBAT', 'INTERACTION', 'CONSTRAINTS']);

/** A face of a card with one span marked: the AtomSpans input for one quote. */
export function markedFace(text: string, faceIndex: number, mark: { id: number; type: string; span: [number, number] } | null): AtomFace {
  const family = mark ? mark.type.slice(0, mark.type.indexOf('.')) as AtomFamily : 'PRODUCES';
  return {
    face_index: faceIndex, oracle_text: text, clauses: [], unclassified: [], missingRules: [],
    atoms: mark ? [{
      id: mark.id, face_index: faceIndex, schema_version: 0, family: FAMILIES.has(family) ? family : 'PRODUCES',
      type_key: mark.type.slice(mark.type.indexOf('.') + 1), params: {}, span_start: mark.span[0], span_end: mark.span[1],
      quote: text.slice(mark.span[0], mark.span[1]), span_ambiguous: false, rule_numbers: [], confidence: 1,
    }] : [],
  };
}

function Quote({ card, faceIndex, span, mark }: {
  card: GraphCardView | undefined; faceIndex: number; span: [number, number]; mark: { id: number; type: string };
}) {
  const face = card?.faces.find((f) => f.face_index === faceIndex);
  if (!face) return <p className="muted">card text missing</p>;
  if (span[0] === span[1]) {
    return (
      <>
        <p className="gx-flag">No text is marked on this side, so this side has no text evidence.</p>
        <AtomSpans face={markedFace(face.oracle_text, faceIndex, null)} />
      </>
    );
  }
  return (
    <AtomSpans
      face={markedFace(face.oracle_text, faceIndex, { ...mark, span })}
      focus={[{ face_index: faceIndex, span_start: span[0], span_end: span[1] }]}
    />
  );
}

/** The quotes of a reason. A quote that repeats another (quoteMerge.ts) shows once, with all its sources. */
export function RuleEvidenceList({ rule }: { rule: EdgeRuleView }) {
  return (
    <ul className="gx-evidence">
      {mergeQuotes(rule.evidence).map((q, i) => (
        <li key={i}>
          <span className="mono">{q.sources.join(' · ')}</span> <span className="gr-quote">"{q.quote}"</span>
          {q.variants.length > 0 && (
            <details className="gx-variants">
              <summary>{q.variants.length === 1 ? 'other wording' : `${q.variants.length} other wordings`}</summary>
              {q.variants.map((v, j) => <span key={j} className="gr-quote">"{v}"</span>)}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "1 reason, 3 quotes": the reasons of a link and their distinct quotes. */
function whyCount(rules: Array<EdgeRuleView | undefined>): string {
  const found = rules.filter((r): r is EdgeRuleView => r !== undefined);
  const quotes = found.reduce((s, r) => s + mergeQuotes(r.evidence).length, 0);
  return `${found.length} reason${found.length === 1 ? '' : 's'}, ${quotes} quote${quotes === 1 ? '' : 's'}`;
}

export function GradePill({ grade, unresolved }: { grade: 'confirmed' | 'plausible'; unresolved: string[] }) {
  const open = unresolved.map((u) => u.replace(/_/g, ' '));
  return (
    <span className={`gx-grade gx-grade-${grade}`} title={grade === 'plausible' ? `not known from the card text: ${open.join(', ')}` : 'all conditions are true'}>
      {grade === 'confirmed' ? 'strong match' : 'possible match'}{grade === 'plausible' && open.length > 0 && <> · open: {open.join(', ')}</>}
    </span>
  );
}

/** The orange mark of the known problem. */
export function BroadMark() {
  return <span className="gx-wide" title="Every card that gives this thing links to every card that needs it. Many broad links are not real synergies.">broad link</span>;
}

export function EdgeRow({ edge, centre, cards, rules, buildId, labels }: {
  edge: EdgeView; centre: string; cards: Record<string, GraphCardView>; rules: Record<string, EdgeRuleView>; buildId: number;
  labels: Record<string, string>;
}) {
  const [reporting, setReporting] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState<{ busy: boolean; done: number | null; error: string | null }>({ busy: false, done: null, error: null });
  // The open reports on the reason of this link: the report form tells the owner about them.
  const [already, setAlready] = useState(0);
  useEffect(() => {
    if (!reporting) return;
    let live = true;
    api.reportCounts().then((r) => { if (live) setAlready(r.counts[reasonKey(edge.rule_hashes)] ?? 0); }).catch(() => undefined);
    return () => { live = false; };
  }, [reporting, edge.rule_hashes]);

  const other = edge.supply && edge.supply.oracle_id !== centre ? edge.supply.oracle_id : edge.demand.oracle_id;
  const otherCard = cards[other];
  const otherName = otherCard?.name ?? other;
  const self = edge.supply?.oracle_id === edge.demand.oracle_id;
  const w = edge.weight;
  const anti = edge.polarity === '-';
  const supplyName = edge.supply ? cards[edge.supply.oracle_id]?.name ?? '' : '';
  const demandName = cards[edge.demand.oracle_id]?.name ?? '';
  const giveType = edge.supply?.types[0] ?? '';

  const submit = () => {
    setState({ busy: true, done: null, error: null });
    api.reportEdge(buildId, edge.key, note.trim())
      .then((r) => { setState({ busy: false, done: r.report_id, error: null }); setReporting(false); })
      .catch((err: Error) => setState({ busy: false, done: null, error: err.message }));
  };

  return (
    <div className="gx-edge">
      <div className="gx-edge-head">
        {edge.class
          ? <span className="gx-other">{kindName(edge.class.intrinsic, edge.class.value)} <span className="muted">({edge.class.member_count} cards)</span></span>
          : (
            <a className="gx-other gx-other-card" href={`#/graph/${encodeURIComponent(other)}?build=${buildId}`} data-card-id={other}>
              {otherCard?.image && <img src={otherCard.image} alt="" loading="lazy" className="gx-thumb" />}
              <span>{self ? `${otherName} (this card itself)` : otherName}</span>
            </a>
          )}
        {anti && <span className="gx-pol gx-pol-anti">conflict</span>}
        <GradePill grade={edge.grade} unresolved={edge.unresolved} />
        {edge.demand_without_params && <BroadMark />}
        <span className="gx-weight mono" title="Strength: puts the links in order. Not a quality score.">strength {w.total.toFixed(2)}</span>
      </div>
      <div className="gx-quotes">
        <div className="gx-quote">
          <div className="gx-quote-k">
            {edge.supply
              ? <><b data-card-id={edge.supply.oracle_id}>{supplyName}</b> {anti ? 'does' : 'gives'}: <span title={typeTitle(giveType, labels)}>{typeName(giveType, labels)}</span></>
              : <><b>{edge.class ? kindName(edge.class.intrinsic, edge.class.value) : 'a card kind'}</b> gives what this card needs</>}
          </div>
          {edge.supply
            ? <Quote card={cards[edge.supply.oracle_id]} faceIndex={edge.supply.face_index} span={edge.supply.span}
                mark={{ id: edge.supply.atom_ids[0] ?? -1, type: giveType || 'PRODUCES.X' }} />
            : <p className="muted">Each card of this kind helps this card. Open the list of cards below.</p>}
        </div>
        <div className="gx-quote">
          <div className="gx-quote-k">
            <b data-card-id={edge.demand.oracle_id}>{demandName}</b> {anti ? 'is hurt by it' : 'needs'}: <span title={typeTitle(edge.demand.type, labels)}>{typeName(edge.demand.type, labels)}</span>
          </div>
          <Quote card={cards[edge.demand.oracle_id]} faceIndex={edge.demand.face_index} span={edge.demand.span}
            mark={{ id: edge.demand.atom_id, type: edge.demand.type }} />
        </div>
      </div>
      <details className="gx-rules">
        <summary>Why the system made this link <span className="gx-why-count">{whyCount(edge.rule_hashes.map((h) => rules[h]))}</span></summary>
        {edge.rule_hashes.map((h) => {
          const r = rules[h];
          if (!r) return <p key={h} className="muted">reason {h} missing</p>;
          return (
            <div key={h} className="gx-rule">
              <p>
                <Term id="reason" /> <span className="mono">{r.rule_id}</span>: a card that gives <b>{plainSide(r.supply, labels)}</b>{' '}
                {r.polarity === '-' ? 'works against' : 'helps'} a card that needs <b>{plainSide(r.demand, labels)}</b>.
              </p>
              <p className="muted">{r.votes} of 3 runs wrote this reason · {r.status === 'accepted' ? 'accepted' : 'disputed'} · technical form: <span className="mono">{sideText(r.supply)} → {sideText(r.demand)}</span></p>
              <p className="muted">Evidence from the Comprehensive Rules and the card text:</p>
              <RuleEvidenceList rule={r} />
            </div>
          );
        })}
        <p className="muted">
          <Term id="strength" /> {w.total.toFixed(3)} = match {w.grade} × repeat {w.repeat} × cost {w.cost.toFixed(3)} × size {w.size.toFixed(3)}
        </p>
      </details>
      <div className="gx-report">
        {state.done !== null && <span className="pill-status pill-ok">Reported. Report {state.done} is in the review queue.</span>}
        {state.done === null && !reporting && <button className="gx-link" onClick={() => setReporting(true)}>Report this link</button>}
        {!fixing && <button className="gx-link" onClick={() => setFixing(true)}>Fix this reason</button>}
        {reporting && (
          <div className="gx-report-form">
            {already > 0 && (
              <p className="fx-already">{already} report{already === 1 ? ' is' : 's are'} already on this reason. <a href="#/review?domain=edge">See them in the review queue</a>.</p>
            )}
            <textarea className="gr-note" rows={2} dir="auto" placeholder="One sentence: what is wrong with this link?" value={note} onChange={(e) => setNote(e.target.value)} />
            <MicButton onText={(t) => setNote((n) => appendText(n, t))} disabled={state.busy} />
            <button className="gr-btn" disabled={state.busy || !note.trim()} onClick={submit}>Send report</button>
            <button className="gx-link" onClick={() => setReporting(false)}>Cancel</button>
          </div>
        )}
        {state.error && <span className="error-inline">{state.error}</span>}
        {fixing && (
          <FixReasonForm ruleHashes={edge.rule_hashes} ruleIds={edge.rule_hashes.map((h) => rules[h]?.rule_id ?? h.slice(0, 8))}
            buildId={buildId} edgeKey={edge.key} onCancel={() => setFixing(false)} />
        )}
      </div>
    </div>
  );
}
