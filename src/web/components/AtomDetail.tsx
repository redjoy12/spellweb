import type { AtomRow } from '../api.js';
import { ATOM_FAMILY_COLOR } from './AtomSpans.js';

/**
 * Minimal detail panel for the currently-selected atom. Family is shown in its own
 * family colour, matching AtomSpans' underline, so the two views are visually linked.
 */
export function AtomDetail({ atom }: { atom: AtomRow | null }) {
  if (!atom) {
    return <p className="muted atom-detail-empty">Select a covered span to inspect its atom.</p>;
  }
  return (
    <div className="atom-detail">
      <div className="ad-row">
        <span className="ad-k">family</span>
        <span className="ad-v" style={{ color: ATOM_FAMILY_COLOR[atom.family] }}>{atom.family}</span>
      </div>
      <div className="ad-row">
        <span className="ad-k">type</span>
        <span className="ad-v mono">{atom.type_key}</span>
      </div>
      <div className="ad-row">
        <span className="ad-k">span</span>
        <span className="ad-v mono">{atom.span_start}–{atom.span_end}</span>
      </div>
      <div className="ad-row">
        <span className="ad-k">quote</span>
        <span className="ad-v ad-quote">“{atom.quote}”</span>
      </div>
      <div className="ad-row">
        <span className="ad-k">rules</span>
        <span className="ad-v mono">{atom.rule_numbers.length > 0 ? atom.rule_numbers.join(', ') : '—'}</span>
      </div>
      <div className="ad-row">
        <span className="ad-k">confidence</span>
        <span className="ad-v">
          {atom.confidence.toFixed(2)}{atom.span_ambiguous ? ' · ambiguous span' : ''}
        </span>
      </div>
      <div className="ad-row">
        <span className="ad-k">params</span>
        <pre className="ad-params">{JSON.stringify(atom.params, null, 2)}</pre>
      </div>
    </div>
  );
}