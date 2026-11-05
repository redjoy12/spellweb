import { useEffect, useState } from 'react';
import { api, type RunStats, type RunsResponse } from '../api.js';

/**
 * The extraction-runs dashboard (plan Task 9 Step 6; spec sec. 11.3). One panel per run.
 *
 * The missing-rule report rate leads each panel: it is sec. 3.6's leading indicator, the one
 * measurement that says whether the relevance gate is dropping rules in production. Token
 * counts are shown as unmeasured rather than estimated - the subagent protocol has no provider
 * usage to read (sec. 7.1 amendment) - and packet size is given in exact characters instead.
 */

const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en'));

function bucketLabel(b: { from: number; to: number | null }): string {
  if (b.to === null) return pct(b.from);
  if (b.from === 0) return `<${pct(b.to)}`;
  return `${pct(b.from)}–${Math.round(b.to * 100) - 1}%`;
}

function duration(ms: number | null): string {
  if (ms === null) return 'still running';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const METRICS: Array<[keyof NonNullable<RunStats['golden']>, string]> = [
  ['atom_recall', 'recall'], ['atom_precision', 'precision'], ['coverage', 'coverage'],
  ['span_validity', 'span validity'], ['citation_validity', 'citation (in-packet)'],
];

export function ExtractionRuns() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.runs().then(setData).catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <div className="error-block">Couldn't load runs: {error}</div>;
  if (!data) return <p className="muted">Loading runs…</p>;

  const extractor = data.runs.filter((r) => r.provider !== 'human');
  const golden = extractor.filter((r) => r.golden);

  return (
    <div className="runs">
      <h1 className="page-title">Extraction runs</h1>

      {golden.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Golden-set runs</h2>
            <span className="count">sec. 8.2 scores against the bars</span>
            <span className="rule"></span>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>run</th>
                  {METRICS.map(([k, l]) => <th key={k} style={{ textAlign: 'right' }}>{l} <span className="muted">≥ {pct(data.bars[k], 0)}</span></th>)}
                  <th style={{ textAlign: 'right' }}>missing-rule / card</th>
                  <th>verdict</th>
                </tr>
              </thead>
              <tbody>
                {golden.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.id}</td>
                    {METRICS.map(([k]) => {
                      const v = r.golden![k] as number | null;
                      const ok = v !== null && v >= (data.bars[k] ?? 0);
                      return <td key={k} className={`num ${ok ? 'rr-ok' : 'rr-bad'}`}>{pct(v, 1)}</td>;
                    })}
                    <td className="num">{r.golden!.missing_rule_rate.toFixed(3)}</td>
                    <td>
                      <span className={`pill-status ${r.golden!.acceptable ? 'pill-ok' : 'rr-pill-bad'}`}>
                        {r.golden!.acceptable ? 'acceptable' : `below: ${r.golden!.failed.join(', ')}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {extractor.length === 0 && <p className="muted empty-state">No extraction run yet. Start one with <code>npm run extract -- --prepare</code>.</p>}
      {extractor.map((r) => <RunPanel key={r.id} run={r} releaseBar={data.release_bar} />)}
    </div>
  );
}

function RunPanel({ run: r, releaseBar }: { run: RunStats; releaseBar: number }) {
  const judged = r.coverage.buckets.reduce((s, b) => s + b.cards, 0);
  const unfinalised = r.cards_attempted - r.finalised;
  const passOk = r.pass_rate !== null && r.pass_rate >= releaseBar;

  return (
    <section className="panel" id={`run-${r.id}`}>
      <div className="panel-head">
        <h2>Run #{r.id}</h2>
        <span className="count">{r.batch_kind}</span>
        <span className="count">{r.status}</span>
        <span className="muted rr-when">{r.started_at.replace('T', ' ').slice(0, 16)} · {duration(r.wall_clock_ms)}</span>
        <span className="rule"></span>
      </div>

      {unfinalised > 0 && (
        <div className="warning-block">
          {unfinalised} of {r.cards_attempted} attempted card(s) have no verdict — this run was submitted before verdicts
          existed. Run <code>npm run extract -- --finalise {r.id}</code>.
        </div>
      )}

      <div className="stat-row">
        <div className={`stat-tile ${r.missing_rule.cards > 0 ? 'accent-amber' : 'accent-gold'} rr-lead`}>
          <div className="stat-num">{pct(r.missing_rule.rate, 1)}</div>
          <div className="stat-label">missing-rule report rate</div>
          <div className="rr-sub muted">
            {r.missing_rule.reports} report(s) on {r.missing_rule.cards} card(s) · {r.missing_rule.open} open
          </div>
        </div>
        <div className={`stat-tile ${passOk ? 'accent-gold' : 'accent-amber'}`}>
          <div className="stat-num">{pct(r.pass_rate)}</div>
          <div className="stat-label">passed unflagged</div>
          <div className="rr-sub muted">
            {r.outcomes.passed} passed · {r.outcomes.flagged} flagged · {r.outcomes.failed} failed — bar {pct(releaseBar)}
          </div>
        </div>
        <div className="stat-tile accent-blue">
          <div className="stat-num">{pct(r.coverage.mean, 1)}</div>
          <div className="stat-label">mean clause coverage</div>
          <div className="rr-sub muted">over {judged} judged card(s)</div>
        </div>
        <div className="stat-tile accent-muted">
          <div className="stat-num">{num(r.cards_attempted)}</div>
          <div className="stat-label">cards attempted</div>
          <div className="rr-sub muted">{r.voted_cards} voted · {num(r.atoms)} atoms · {r.unclassified} unclassified</div>
        </div>
      </div>

      <div className="rr-bar" title="coverage distribution over judged cards">
        {r.coverage.buckets.map((b, i) => b.cards > 0 && (
          <span key={i} className={`rr-seg rr-seg-${i}`} style={{ flexGrow: b.cards }}>
            {bucketLabel(b)} · {b.cards}
          </span>
        ))}
        {judged === 0 && <span className="rr-seg rr-seg-empty">no verdicts yet</span>}
      </div>

      <dl className="rr-grid">
        <dt>extractor</dt><dd>{r.provider} · <span className="mono">{r.model}</span></dd>
        <dt>schema</dt><dd>v{r.schema_version} · splitter v{r.splitter_version} · corpus {r.corpus_id}</dd>
        <dt>packet policy</dt>
        <dd>
          <span className="mono">{r.packet_policy_sha.slice(0, 12)}</span>{' '}
          <span className={r.policy_hash === 'changed' ? 'rr-warn' : 'muted'}>
            {r.policy_hash === 'current' ? "(today's packet)"
              : r.policy_hash === 'changed' ? '(the kernel or policy has changed since)'
              : '(policy file only - recorded before the kernel was hashed)'}
          </span>
        </dd>
        <dt>kernel (current)</dt>
        <dd>{r.kernel ? <>{r.kernel.rules} rules · {num(r.kernel.chars)} chars</> : '—'}</dd>
        <dt>packet per card</dt>
        <dd>
          {r.packet_chars.cards > 0
            ? <>p50 {num(r.packet_chars.p50)} · p90 {num(r.packet_chars.p90)} · max {num(r.packet_chars.max)} chars</>
            : '—'}
        </dd>
        <dt>tokens</dt>
        <dd>
          {r.tokens.measured
            ? <>{num(r.tokens.input)} in · {num(r.tokens.output)} out</>
            : <span className="muted">not measured — subagent extraction reports no usage (packet size above is exact)</span>}
        </dd>
        <dt>review</dt>
        <dd>{r.findings_pending > 0 ? <a href="#/review">{r.findings_pending} pending finding(s) →</a> : <span className="muted">nothing pending</span>}</dd>
      </dl>
    </section>
  );
}
