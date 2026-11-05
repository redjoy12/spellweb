import { useEffect, useState } from 'react';
import { api, type BuildScore, type GraphBuild } from '../api.js';
import { Icon } from './Icon.js';

/** Shared parts of the overview and the graph-build page: score meters, the degree ranking and small helpers. */

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));
export const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** A compact count: 1,131,633 -> 1.13M. The exact count goes in the title. */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

export function Loading({ text }: { text: string }) {
  return <div className="loading-line" role="status"><span className="spinner" aria-hidden="true" />{text}</div>;
}

/** The colours of a build scope ("BR") as mana pips. */
export function ScopePips({ scope }: { scope: string }) {
  const colours = [...scope].filter((c) => 'WUBRG'.includes(c));
  if (colours.length === 0) return <span className="mono">{scope}</span>;
  return (
    <span className="mana" title={`scope ${scope}`}>
      {colours.map((c) => <span key={c} className={`pip pip-${c.toLowerCase()}`}>{c}</span>)}
    </span>
  );
}

export function BuildState({ build }: { build: GraphBuild }) {
  return build.stale
    ? <span className="badge badge-warn" title="The card reading changed after this graph version was made. Make a new version."><Icon name="alert" size={13} />out of date</span>
    : <span className="badge badge-ok" title="The card reading did not change after this graph version was made."><Icon name="check" size={13} />up to date</span>;
}

function Meter({ name, value, bar, detail }: { name: string; value: number | null; bar: number; detail: string }) {
  const below = value !== null && value < bar;
  const width = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-name">{name}</span>
        <span className={`meter-val ${value === null ? '' : below ? 'below' : 'met'}`}>{pct(value)}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 1000) / 10}>
        <div className={`meter-fill${below ? ' below' : ''}`} style={{ width: `${width}%` }} />
        <div className="meter-bar" style={{ left: `calc(${bar * 100}% - 1px)` }} title={`target ${pct(bar)}`} />
      </div>
      <div className="meter-foot">
        <span>{detail}</span>
        <span>{value === null ? 'no data' : below ? <>target {pct(bar)} · <b className="rr-warn">not reached</b></> : <>target {pct(bar)} · <b className="rr-ok">reached</b></>}</span>
      </div>
    </div>
  );
}

/** The score of a build against the golden pairs (spec sec. 12.2), as meters with the target line, in plain words. */
export function ScoreMeters({ score }: { score: BuildScore }) {
  const c = score.counts;
  return (
    <div className="meters">
      <Meter name="Strong matches that are right" value={score.confirmed_precision} bar={score.bar}
        detail={`${fmt(c['confirmed_correct'])} of ${fmt(c['confirmed_items'])} strong matches are real synergies`} />
      <Meter name="Synergies found" value={score.synergy_recall} bar={score.bar} detail={`${fmt(c['synergy_found'])} of ${fmt(c['synergy'])} known synergies have a link`} />
      <Meter name="All matches that are right" value={score.all_precision} bar={score.bar} detail={`${fmt(c['all_correct'])} of ${fmt(c['all_items'])} linked test pairs are real synergies`} />
    </div>
  );
}

export function useScore(buildId: number) {
  const [score, setScore] = useState<BuildScore | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setScore(null);
    api.graphScore(buildId).then(setScore).catch((err: Error) => setError(err.message));
  }, [buildId]);
  return { score, error };
}

export interface TopCard {
  oracle_id: string; name: string; type_line?: string; image?: string | null; out_degree: number; in_degree: number; class_edges: number; anti_degree: number;
}

/** The cards with the most links of a build, with a helps / helped-by bar. Each name opens the card in the explorer. */
export function TopCards({ buildId, limit, cards: given }: { buildId: number; limit: number; cards?: TopCard[] }) {
  const [cards, setCards] = useState<TopCard[] | null>(given ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (given) { setCards(given); return; }
    api.graphTop(buildId, limit).then((r) => setCards(r.cards)).catch((err: Error) => setError(err.message));
  }, [buildId, limit, given]);
  if (error) return <div className="error-block">{error}</div>;
  if (!cards) return <Loading text="Loading the cards with the most links…" />;
  if (cards.length === 0) return <p className="muted">This graph version has no links.</p>;
  const max = Math.max(...cards.map((c) => c.out_degree + c.in_degree), 1);
  return (
    <>
      <ol className="rank">
        {cards.map((c, i) => {
          const total = c.out_degree + c.in_degree;
          return (
            <li key={c.oracle_id}>
              <span className="rank-n">{i + 1}</span>
              <a className="rank-name" href={`#/graph/${encodeURIComponent(c.oracle_id)}?build=${buildId}`} title={c.name} data-card-id={c.oracle_id}>{c.name}</a>
              <span className="rank-val" title={`helps ${fmt(c.out_degree)} · helped by ${fmt(c.in_degree)} · card kinds ${fmt(c.class_edges)} · conflicts ${fmt(c.anti_degree)}`}>{fmt(total)}</span>
              <span className="rank-bar" aria-hidden="true">
                <i className="out" style={{ width: `${(c.out_degree / max) * 100}%` }} />
                <i className="in" style={{ width: `${(c.in_degree / max) * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      <div className="legend">
        <span><i style={{ background: 'var(--g-deep)' }} />cards it helps</span>
        <span><i style={{ background: 'var(--u-deep)' }} />cards that help it</span>
      </div>
    </>
  );
}
