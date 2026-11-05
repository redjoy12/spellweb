import { useEffect, useMemo, useState } from 'react';
import { api, type GapKind, type GapRow, type GraphBuild as Build } from '../api.js';
import { Icon } from '../components/Icon.js';
import { Term } from '../components/Term.js';
import { BuildState, Loading, ScopePips, ScoreMeters, TopCards, compact, fmt, useScore } from '../components/BuildParts.js';
import { scopeName, typeName, typePairName, useTypeLabels } from '../lib/terms.js';

/**
 * The graph-build page (Phase 3 spec sec. 13.3, plan Task 7 Step 5), shown as "Graph quality" in plain words
 * (owner request 2026-10-18). It shows the selected build (counts, score, the cards with the highest degree),
 * the gap panel and the list of all builds. The gap report is the input for the schema v15 decision
 * (checkpoint C5). It cannot show demand restrictions that the schema does not record (sec. 7.2).
 */

const GAP_TEXT: Record<GapKind, { name: string; text: string }> = {
  no_param_type: {
    name: 'needs with no details',
    text: 'A "needs" fact that has no details at all. Every link into it is a broad link. This is the largest cause of the known problem.',
  },
  unresolved_param: {
    name: 'missing detail',
    text: 'A detail of a fact that the card reading never fills. If the tag list adds it, these links can become exact.',
  },
  partial_param: { name: 'partly filled detail', text: 'A detail of a fact that the card reading fills for some cards only.' },
  trigger_without_demand: {
    name: 'trigger not read',
    text: 'Triggered abilities ("when", "whenever", "at") that have no "needs" fact. The format does not cover these triggers yet.',
  },
  trigger_word_inside: { name: 'trigger word inside', text: 'Abilities that contain a trigger word but do not start with it.' },
  test_decision: { name: 'project choice', text: 'For each text test that is a project choice: the number of abilities that it changes.' },
};
const KINDS = Object.keys(GAP_TEXT) as GapKind[];

type Counts = Record<string, unknown>;
const num = (c: Counts, k: string) => (typeof c[k] === 'number' ? (c[k] as number) : undefined);

export function GraphBuild({ buildId }: { buildId?: number }) {
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.graphBuilds().then((r) => setBuilds(r.builds)).catch((err: Error) => setError(err.message)); }, []);
  const build = useMemo(() => (builds ? builds.find((b) => b.id === buildId) ?? builds[0] ?? null : null), [builds, buildId]);

  if (error) return <div className="error-block">{error}</div>;
  if (!builds) return <Loading text="Loading…" />;
  if (!build) return <div className="panel empty-state">There is no graph yet. Run <code>npm run graph -- --build</code> first.</div>;

  const c = build.counts as Counts;
  const syn = build.counts.merged_edges?.['+'];
  const anti = build.counts.merged_edges?.['-'];
  const withEdges = num(c, 'rules_with_edges');
  const withoutEdges = num(c, 'rules_without_edges');
  return (
    <div className="gx">
      <div className="page-head">
        <div>
          <div className="eyebrow">Graph quality</div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s3)', flexWrap: 'wrap' }}>
            <Term id="version">Graph version</Term> {build.id} <ScopePips scope={build.scope} /> <BuildState build={build} />
          </h1>
          <p className="page-sub">
            All {scopeName(build.scope)} cards · made {build.built_at.slice(0, 16).replace('T', ' ')} · card-reading format v{build.schema_version} · reasons set {build.rule_set_id}
          </p>
        </div>
        <div className="page-actions">
          {builds.length > 1 && (
            <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s2)' }}>
              Version
              <select className="gx-select" value={build.id} onChange={(e) => { window.location.hash = `#/graph-builds?build=${e.target.value}`; }}>
                {builds.map((b, i) => <option key={b.id} value={b.id}>version {b.id}{i === 0 ? ' (newest)' : ''}</option>)}
              </select>
            </label>
          )}
          <a className="btn btn-primary" href={`#/graph?build=${build.id}`}><Icon name="graph" size={15} />Explore the cards</a>
        </div>
      </div>

      <div className="callout callout-info">
        <Icon name="info" size={18} />
        <div>
          <p><b>This page shows how good the links are.</b> The app links {scopeName(build.scope)} cards that help each other. It does not make decks yet.</p>
          <p>To see the links of one card, push <b>Explore the cards</b>. New here? Read <a href="#/guide">Start here</a>.</p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Cards</div><div className="kpi-value">{fmt(build.counts.scope_cards)}</div>
          <div className="kpi-note">{fmt(num(c, 'cards_with_atoms'))} with read text</div></div>
        <div className="kpi"><div className="kpi-label"><Term id="marked">Marked texts</Term></div><div className="kpi-value">{fmt(build.counts.atoms)}</div>
          <div className="kpi-note">{fmt(num(c, 'classes'))} card kinds</div></div>
        <div className="kpi"><div className="kpi-label">Card pairs that help</div><div className="kpi-value" title={fmt(build.counts.synergy_pairs)}>{compact(build.counts.synergy_pairs)}</div>
          <div className="kpi-note">{fmt(num(c, 'self_pairs'))} cards that help themselves</div></div>
        <div className="kpi"><div className="kpi-label"><Term id="link">Links</Term></div><div className="kpi-value" title={syn ? fmt(syn.confirmed + syn.plausible) : ''}>{syn ? compact(syn.confirmed + syn.plausible) : '-'}</div>
          {syn && <div className="kpi-note">{compact(syn.confirmed)} strong · {compact(syn.plausible)} possible</div>}</div>
        <div className="kpi"><div className="kpi-label"><Term id="conflict">Card pairs in conflict</Term></div><div className="kpi-value" title={fmt(build.counts.anti_pairs)}>{compact(build.counts.anti_pairs)}</div>
          {anti && <div className="kpi-note">{compact(anti.confirmed)} strong · {compact(anti.plausible)} possible</div>}</div>
        <div className="kpi"><div className="kpi-label"><Term id="reason">Reasons</Term> in use</div><div className="kpi-value">{fmt(withEdges)}</div>
          {withEdges !== undefined && withoutEdges !== undefined && <div className="kpi-note">of {fmt(withEdges + withoutEdges)} accepted reasons</div>}</div>
      </div>

      <div className="grid-2">
        <ScorePanel buildId={build.id} />
        <section className="panel">
          <div className="panel-head">
            <h2>Cards with the most links</h2>
            <a className="more" href={`#/graph?build=${build.id}`}>All cards <Icon name="arrowRight" size={14} /></a>
          </div>
          <p className="panel-sub">Push a name to open the card.</p>
          <TopCards buildId={build.id} limit={15} />
        </section>
      </div>

      <details className="disclosure">
        <summary><Icon name="chevronRight" />What a new card-reading format could fix <span className="muted">(technical)</span></summary>
        <div className="disclosure-body"><GapPanel buildId={build.id} /></div>
      </details>

      <details className="disclosure">
        <summary><Icon name="chevronRight" />All graph versions <span className="muted">({builds.length})</span></summary>
        <div className="disclosure-body">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr><th>version</th><th>colours</th><th>reasons set</th><th>made</th><th>cards</th><th>marked texts</th><th>card pairs that help</th><th>pairs in conflict</th>
                  <th>links (strong / possible)</th><th>state</th><th></th></tr>
              </thead>
              <tbody>
                {builds.map((b) => {
                  const p = b.counts.merged_edges?.['+'];
                  return (
                    <tr key={b.id} className={b.id === build.id ? 'gx-row-focus' : undefined}>
                      <td className="mono"><a href={`#/graph-builds?build=${b.id}`}>{b.id}</a></td>
                      <td>{scopeName(b.scope)}</td>
                      <td className="mono">{b.rule_set_id} (v{b.rule_set_version})</td>
                      <td className="mono">{b.built_at.slice(0, 16).replace('T', ' ')}</td>
                      <td className="mono">{fmt(b.counts.scope_cards)}</td>
                      <td className="mono">{fmt(b.counts.atoms)}</td>
                      <td className="mono">{fmt(b.counts.synergy_pairs)}</td>
                      <td className="mono">{fmt(b.counts.anti_pairs)}</td>
                      <td className="mono">{p ? `${fmt(p.confirmed)} / ${fmt(p.plausible)}` : '-'}</td>
                      <td><BuildState build={b} /></td>
                      <td><a href={`#/graph?build=${b.id}`}>explore</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <details className="disclosure">
        <summary><Icon name="chevronRight" />Technical details</summary>
        <div className="disclosure-body">
          <dl className="kv">
            <dt>build key</dt><dd className="mono">{build.build_key}</dd>
            <dt>atom set</dt><dd className="mono">{build.atom_set_sha}</dd>
            <dt>text tests version</dt><dd>{build.tests_version}</dd>
            <dt>atom edges</dt><dd>{fmt(num(c, 'merges'))} merges · {fmt(num(c, 'multi_rule_edges'))} edges with more than one rule</dd>
            <dt>ambiguous atoms</dt><dd>{fmt(num(c, 'ambiguous_atoms'))}</dd>
            {typeof c['timings_ms'] === 'object' && c['timings_ms'] !== null && (
              <><dt>build time</dt><dd>{fmt((c['timings_ms'] as Record<string, number>)['total'])} ms</dd></>
            )}
          </dl>
        </div>
      </details>
    </div>
  );
}

function ScorePanel({ buildId }: { buildId: number }) {
  const { score, error } = useScore(buildId);
  const labels = useTypeLabels();
  const pairs = score?.wrong_confirmed.type_pairs ?? [];
  const max = Math.max(1, ...pairs.map((t) => t.items));
  return (
    <section className="panel">
      <div className="panel-head"><h2>Accuracy test</h2></div>
      <p className="panel-sub">
        The graph is compared with the <Term id="testPairs">test pairs</Term>: card pairs with a known answer.
        The white line on each bar is the target.
      </p>
      {error && <div className="error-block">{error}</div>}
      {!score && !error && <Loading text="Calculating (this can take some seconds)…" />}
      {score && (
        <>
          <ScoreMeters score={score} />
          <div className="callout callout-warn" style={{ marginTop: 'var(--s5)' }}>
            <Icon name="alert" size={18} />
            <div>
              <p><b>Known problem: <Term id="broad">broad links</Term>.</b> {score.wrong_confirmed.only_demand_without_params} of the {score.wrong_confirmed.items} wrong strong matches are only broad links.</p>
              <p>A broad link connects every card that gives a thing to every card that needs it, for example every mana card to every card with an activated ability.</p>
            </div>
          </div>
          {pairs.length > 0 && (
            <>
              <h3 className="sub-h">The reasons behind the wrong strong matches</h3>
              <div className="table-scroll">
                <table className="data" style={{ minWidth: 0 }}>
                  <thead><tr><th>reason</th><th>wrong test pairs</th></tr></thead>
                  <tbody>{pairs.map((t) => (
                    <tr key={t.type_pair}>
                      <td style={{ wordBreak: 'break-word' }}>{typePairName(t.type_pair, labels)}<div className="muted mono" style={{ fontSize: 11 }}>{t.type_pair}</div></td>
                      <td><div className="cell-bar"><span>{t.items}</span><i style={{ width: `${(t.items / max) * 80}px` }} /></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function GapPanel({ buildId }: { buildId: number }) {
  const [gaps, setGaps] = useState<GapRow[] | null>(null);
  const [kind, setKind] = useState<GapKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const labels = useTypeLabels();
  useEffect(() => { api.graphGaps(buildId).then((r) => setGaps(r.gaps)).catch((err: Error) => setError(err.message)); }, [buildId]);
  if (error) return <div className="error-block">{error}</div>;
  if (!gaps) return <Loading text="Loading…" />;
  const rows = gaps.filter((g) => kind === 'all' || g.gap_kind === kind);
  const count = (k: GapKind) => gaps.filter((g) => g.gap_kind === k).length;
  const max = Math.max(1, ...rows.map((g) => g.count));
  return (
    <>
      <p className="panel-sub">
        Each row is a gap in the current card-reading format, with the number of links or abilities that it touches, largest first.
        Use this list to select changes of the tag list. It cannot show limits that the format does not record at all.
      </p>
      <div className="seg" role="group" aria-label="Gap kind">
        <button className={kind === 'all' ? 'active' : undefined} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>all <b>{gaps.length}</b></button>
        {KINDS.map((k) => (
          <button key={k} className={kind === k ? 'active' : undefined} aria-pressed={kind === k} title={GAP_TEXT[k].text} onClick={() => setKind(k)}>
            {GAP_TEXT[k].name} <b>{count(k)}</b>
          </button>
        ))}
      </div>
      {kind !== 'all' && <p className="gx-notice">{GAP_TEXT[kind].text}</p>}
      {rows.length === 0 ? <p className="muted">No rows of this kind.</p> : (
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>gap</th><th>fact</th><th>detail</th><th>count</th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={`${g.gap_kind}|${g.type_key}|${g.param}`}>
                  <td title={GAP_TEXT[g.gap_kind].text}>{GAP_TEXT[g.gap_kind].name}</td>
                  <td>{g.type_key.includes('.') ? typeName(g.type_key, labels) : g.type_key}<div className="muted mono" style={{ fontSize: 11 }}>{g.type_key}</div></td>
                  <td className="mono">{g.param ? g.param.replace(/_/g, ' ') : '-'}</td>
                  <td><div className="cell-bar"><span>{fmt(g.count)}</span><i style={{ width: `${Math.max(2, (g.count / max) * 120)}px` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
