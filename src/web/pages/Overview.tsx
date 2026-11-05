import { useEffect, useState } from 'react';
import { api, type GraphBuild, type RunStats } from '../api.js';
import { Icon } from '../components/Icon.js';
import { BuildState, Loading, ScopePips, ScoreMeters, TopCards, compact, fmt, useScore } from '../components/BuildParts.js';
import { Term } from '../components/Term.js';
import { decisionsApi } from '../lib/decisionsApi.js';
import { scopeName } from '../lib/terms.js';

/**
 * The start page: where the pipeline is, and the latest result, in plain words (owner request 2026-10-18).
 * Phase 3 ends with a synergy graph build, not with a deck. Deck assembly is Phase 4 (parent spec sec. 7),
 * so the deck step shows "not started". The first link points to the guide.
 */

interface PoolSummary { pool: number; corpus: { effective_date: string } | null }
interface Pending { atom: number; edge: number }

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

export function Overview() {
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [runs, setRuns] = useState<RunStats[] | null>(null);
  const [builds, setBuilds] = useState<GraphBuild[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDecisions, setOpenDecisions] = useState<number | null>(null);
  const [openHigh, setOpenHigh] = useState<number | null>(null);

  useEffect(() => {
    (api.poolStatus() as Promise<PoolSummary>).then(setPool).catch(() => setPool(null));
    api.runs().then((r) => setRuns(r.runs)).catch(() => setRuns([]));
    api.graphBuilds().then((r) => setBuilds(r.builds)).catch((err: Error) => setError(err.message));
    Promise.all([api.reviewQueue('pending'), api.edgeQueue('pending')])
      .then(([a, e]) => setPending({ atom: sum(a.counts), edge: sum(e.counts) }))
      .catch(() => setPending(null));
    // The questions of the "Your decisions" page that have no answer yet.
    decisionsApi.page().then((p) => {
      const answered = new Set(p.decisions.map((d) => `${d.kind}|${d.item_key}`));
      // A rules-text pair on which the isolated debate agreed needs no answer.
      const agreed = (i: { debate?: { verdict: string } }) => i.debate?.verdict === 'same' || i.debate?.verdict === 'different';
      const items = [...p.items.cr_text.filter((i) => !agreed(i)).map((i) => `cr_text|${i.key}`), ...p.items.rule_conflict.map((i) => `rule_conflict|${i.key}`),
        ...p.items.supply_twin.map((i) => `supply_twin|${i.key}`)];
      setOpenDecisions(items.filter((k) => !answered.has(k)).length);
      const high = [...p.items.type_role.map((i) => `type_role|${i.key}`), ...p.items.reading.map((i) => `reading|${i.key}`),
        ...p.items.wrong_link.map((i) => `wrong_link|${i.key}`), ...p.items.golden_check.map((i) => `golden_check|${i.key}`),
        ...p.items.link_rule.map((i) => `link_rule|${i.key}`)];
      setOpenHigh(high.filter((k) => !answered.has(k)).length);
    }).catch(() => setOpenDecisions(null));
  }, []);

  const build = builds?.[0] ?? null;
  const latestRun = runs && runs.length > 0 ? runs.reduce((a, b) => (b.id > a.id ? b : a)) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="page-title">Synergy deck builder</h1>
          <p className="page-sub">Standard Best-of-One on MTG Arena. The app reads card text and the Comprehensive Rules, and finds which cards help each other.</p>
        </div>
      </div>

      <a className="start-here" href="#/guide">
        <span className="start-here-icon"><Icon name="info" size={22} /></span>
        <span>
          <b>New here? Start here.</b>
          <span>A short guide: how to check your links, and what each word means.</span>
        </span>
        <Icon name="arrowRight" size={18} />
      </a>

      {openHigh !== null && openHigh > 0 && (
        <a className="start-here" href="#/decisions">
          <span className="start-here-icon"><Icon name="star" size={22} /></span>
          <span>
            <b>{openHigh} important question{openHigh === 1 ? '' : 's'} wait for you (about {Math.max(1, Math.round(openHigh * 1.2))} minutes).</b>
            <span>Your answers help the app most now. Each question shows real cards and has one-click answers.</span>
          </span>
          <Icon name="arrowRight" size={18} />
        </a>
      )}

      {openDecisions !== null && openDecisions > 0 && (
        <a className="start-here" href="#/decisions">
          <span className="start-here-icon"><Icon name="check" size={22} /></span>
          <span>
            <b>{openDecisions} optional question{openDecisions === 1 ? '' : 's'} wait for your answer.</b>
            <span>Rules texts and reasons that the app cannot decide alone. Each answer takes one click.</span>
          </span>
          <Icon name="arrowRight" size={18} />
        </a>
      )}

      <div className="pipeline" aria-label="Progress">
        <a className="step done" href="#/cards">
          <div className="step-top"><span className="step-num"><Icon name="check" size={13} /></span><span className="step-phase">Phase 1</span></div>
          <div className="step-title">Card pool</div>
          <div className="step-fact">{pool ? `${fmt(pool.pool)} cards` : '…'}</div>
          <div className="step-fact muted">{pool?.corpus ? `rules effective ${pool.corpus.effective_date}` : 'cards and rules text'}</div>
          <span className="badge badge-ok"><Icon name="check" size={13} />done</span>
        </a>
        <a className="step done" href="#/runs">
          <div className="step-top"><span className="step-num"><Icon name="check" size={13} /></span><span className="step-phase">Phase 2</span></div>
          <div className="step-title">Card reading</div>
          <div className="step-fact">{runs ? `${runs.length} runs` : '…'}{build ? ` · ${fmt(build.counts.atoms)} marked texts` : ''}</div>
          <div className="step-fact muted">{latestRun ? `latest run ${latestRun.id} · ${latestRun.model}` : 'facts read from each card'}</div>
          <span className="badge badge-ok"><Icon name="check" size={13} />done</span>
        </a>
        <a className="step current" href="#/graph">
          <div className="step-top"><span className="step-num">3</span><span className="step-phase">Phase 3</span></div>
          <div className="step-title">Card links</div>
          <div className="step-fact">{build ? `version ${build.id} · ${scopeName(build.scope)} · ${compact(build.counts.synergy_pairs)} card pairs` : builds ? 'not made yet' : '…'}</div>
          <div className="step-fact muted">cards that work together</div>
          {build
            ? <span className="badge badge-warn"><Icon name="check" size={13} />made</span>
            : <span className="badge badge-idle"><Icon name="clock" size={13} />not made</span>}
        </a>
        <a className="step" href="#/decks">
          <div className="step-top"><span className="step-num">4</span><span className="step-phase">Phase 4</span></div>
          <div className="step-title">Deck</div>
          <div className="step-fact muted">Build 60-card decks and export them to Arena.</div>
          <span className="badge badge-idle"><Icon name="arrowRight" size={13} />open</span>
        </a>
      </div>

      <div className="callout callout-info">
        <Icon name="info" size={18} />
        <div>
          <p><b>The app makes a map of card links, and builds decks from it.</b> Each <Term id="link" /> says that one card gives something that another card needs, with the card text as proof.</p>
          <p>Use <b>Explore cards</b> to see which cards work together, and <b>Build a deck</b> to make a 60-card deck.</p>
        </div>
      </div>

      {error && <div className="error-block">{error}</div>}
      {!builds && !error && <Loading text="Loading…" />}
      {builds && !build && (
        <div className="panel empty-state">There is no graph yet. Run <code>npm run graph -- --build</code> first.</div>
      )}
      {build && <LatestBuild build={build} />}

      {build && (
        <div className="grid-3-2">
          <section className="panel">
            <div className="panel-head">
              <h2>Cards with the most links</h2>
              <a className="more" href={`#/graph?build=${build.id}`}>Explore cards <Icon name="arrowRight" size={14} /></a>
            </div>
            <p className="panel-sub">Push a name to see its partners, the card text behind each link, and its loops.</p>
            <TopCards buildId={build.id} limit={10} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Open items for you</h2></div>
            <p className="panel-sub">These wait for you.</p>
            <ol className="rank">
              <li><span className="rank-n"><Icon name="rules" size={14} /></span><a className="rank-name" href="#/review?domain=edge">Questions about links and reasons</a><span className="rank-val">{pending ? fmt(pending.edge) : '…'}</span></li>
              <li><span className="rank-n"><Icon name="inbox" size={14} /></span><a className="rank-name" href="#/review">Questions about the card reading</a><span className="rank-val">{pending ? fmt(pending.atom) : '…'}</span></li>
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}

function LatestBuild({ build }: { build: GraphBuild }) {
  const { score, error } = useScore(build.id);
  const syn = build.counts.merged_edges?.['+'];
  return (
    <section className="hero" aria-labelledby="latest-build">
      <div className="hero-head">
        <div>
          <div className="eyebrow">Latest result</div>
          <h2 className="hero-title" id="latest-build">Graph version {build.id} <ScopePips scope={build.scope} /></h2>
          <div className="hero-meta">
            <BuildState build={build} />
            <span className="badge">{scopeName(build.scope)} cards</span>
            <span className="badge">card-reading format v{build.schema_version}</span>
            <span className="badge"><Icon name="clock" size={13} />{build.built_at.slice(0, 16).replace('T', ' ')}</span>
          </div>
        </div>
        <div className="hero-actions">
          <a className="btn btn-primary" href={`#/graph?build=${build.id}`}><Icon name="graph" size={15} />Explore cards</a>
          <a className="btn" href={`#/graph-builds?build=${build.id}`}>Graph quality <Icon name="arrowRight" size={15} /></a>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Cards</div><div className="kpi-value">{fmt(build.counts.scope_cards)}</div></div>
        <div className="kpi"><div className="kpi-label">Marked texts</div><div className="kpi-value">{fmt(build.counts.atoms)}</div></div>
        <div className="kpi"><div className="kpi-label">Card pairs that help</div><div className="kpi-value" title={fmt(build.counts.synergy_pairs)}>{compact(build.counts.synergy_pairs)}</div></div>
        <div className="kpi"><div className="kpi-label">Card pairs in conflict</div><div className="kpi-value" title={fmt(build.counts.anti_pairs)}>{compact(build.counts.anti_pairs)}</div></div>
        <div className="kpi"><div className="kpi-label">Links</div><div className="kpi-value" title={syn ? `${fmt(syn.confirmed)} strong, ${fmt(syn.plausible)} possible` : ''}>{syn ? compact(syn.confirmed + syn.plausible) : '-'}</div>
          {syn && <div className="kpi-note">{compact(syn.confirmed)} strong · {compact(syn.plausible)} possible</div>}</div>
      </div>
      <div className="hero-body">
        <div>
          <h3>Accuracy test</h3>
          {error && <div className="error-block">{error}</div>}
          {!score && !error && <Loading text="Calculating (this can take some seconds)…" />}
          {score && <ScoreMeters score={score} />}
        </div>
        <div>
          <h3>What it means</h3>
          {score ? (
            <p className="muted" style={{ margin: 0 }}>
              The graph finds most known synergies, but it also makes many <Term id="broad">broad links</Term>:
              {' '}{score.wrong_confirmed.only_demand_without_params} of the {score.wrong_confirmed.items} wrong strong matches are broad links.
              A broad link connects, for example, every mana card to every card with an activated ability.
            </p>
          ) : <p className="muted" style={{ margin: 0 }}>The graph is compared with card pairs that have a known answer.</p>}
        </div>
      </div>
    </section>
  );
}
