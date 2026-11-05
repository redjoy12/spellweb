import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api, type AtomFace, type BuildScore, type CardSummary, type ClassMembers, type CyclesResponse, type CycleSearchView, type CycleView,
  type EdgeView, type GraphBuild, type GraphCardResponse, type UnresolvedCause,
} from '../api.js';
import { AtomSpans } from '../components/AtomSpans.js';
import { BroadMark, EdgeRow } from '../components/EdgeRow.js';
import { Icon } from '../components/Icon.js';
import { ManaCost } from '../components/ManaCost.js';
import { Term } from '../components/Term.js';
import { type TopCard } from '../components/BuildParts.js';
import { ABILITY_KIND, LOOP_KIND, scopeName, typeName, typeTitle, useTypeLabels } from '../lib/terms.js';

/**
 * The graph explorer (Phase 3 spec sec. 13.1, plan Task 7 Step 4), reworked for the owner (2026-10-18):
 * plain words, the card picture, tabs in place of one long page, a "best partners" summary, a switch
 * that hides the broad links (the known precision gap) and a name filter for the long lists.
 * Route `#/graph/:oracleId`; without an ID the page is a card picker. All edges come from the atoms of
 * the selected build (sec. 7.1).
 */

/** spec sec. 9.5: each tier label with its definition, so a person does not read a tier as a quality score. */
export const TIER_TEXT: Record<1 | 2 | 3, { label: string; definition: string }> = {
  3: { label: LOOP_KIND[3].label, definition: LOOP_KIND[3].plain },
  2: { label: LOOP_KIND[2].label, definition: LOOP_KIND[2].plain },
  1: { label: LOOP_KIND[1].label, definition: LOOP_KIND[1].plain },
};

const CAUSE_TEXT: Record<UnresolvedCause, string> = {
  unknown_amount: 'an amount is not known',
  unknown_limit: 'a limit is not known',
  unparsed_cost: 'a cost was not read',
  plausible_edge: 'a step is only a possible match',
  no_value_increase: 'nothing is shown to grow',
};

const PAGE = 25;
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const HOWTO_KEY = 'gx-howto-closed';

export function GraphExplorer({ oracleId, buildId }: { oracleId?: string; buildId?: number }) {
  const [builds, setBuilds] = useState<GraphBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.graphBuilds().then((r) => { setBuilds(r.builds); setError(null); }).catch((err: Error) => setError(err.message));
  }, []);

  const build = useMemo(() => {
    if (!builds || builds.length === 0) return null;
    return builds.find((b) => b.id === buildId) ?? builds[0]!;
  }, [builds, buildId]);

  if (error) return <div className="error-block">{error}</div>;
  if (!builds) return <p className="muted">Loading…</p>;
  if (!build) return <p className="muted empty-state">There is no graph yet. Run <code>npm run graph -- --build</code> first.</p>;

  return (
    <div className="gx">
      {oracleId
        ? <CardGraph key={`${build.id}|${oracleId}`} build={build} builds={builds} oracleId={oracleId} />
        : <CardPicker build={build} builds={builds} />}
    </div>
  );
}

/** The graph version selector, only when there is more than one version. */
function VersionSelect({ build, builds, oracleId }: { build: GraphBuild; builds: GraphBuild[]; oracleId?: string }) {
  if (builds.length < 2) return null;
  return (
    <label className="gx-version muted">
      <Term id="version" />
      <select className="gx-select" value={build.id} onChange={(e) => { window.location.hash = `#/graph/${oracleId ? encodeURIComponent(oracleId) : ''}?build=${e.target.value}`; }}>
        {builds.map((b, i) => <option key={b.id} value={b.id}>version {b.id}{i === 0 ? ' (newest)' : ''}</option>)}
      </select>
    </label>
  );
}

/** The known precision gap of the build, in one short plain line. The graph-quality page has the full score. */
export function PrecisionNotice({ buildId }: { buildId: number }) {
  const [score, setScore] = useState<BuildScore | null>(null);
  useEffect(() => { api.graphScore(buildId).then(setScore).catch(() => setScore(null)); }, [buildId]);
  return (
    <div className="callout callout-warn gx-known">
      <Icon name="alert" size={18} />
      <p>
        <b>Known problem:</b> many links are too general (<BroadMark />).
        {score && score.confirmed_precision !== null && <> In the accuracy test, only {pct(score.confirmed_precision)} of the strong matches were real synergies.</>}
        {' '}Use <b>Hide broad links</b> to see the rest. <a href={`#/graph-builds?build=${buildId}`}>Details</a>
      </p>
    </div>
  );
}

function CardPicker({ build, builds }: { build: GraphBuild; builds: GraphBuild[] }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CardSummary[]>([]);
  const [top, setTop] = useState<TopCard[] | null>(null);
  useEffect(() => { api.graphTop(build.id, 12).then((r) => setTop(r.cards)).catch(() => setTop([])); }, [build.id]);
  useEffect(() => {
    if (!q.trim()) { setItems([]); return; }
    const t = setTimeout(() => {
      api.searchCards(new URLSearchParams({ q, limit: '24' })).then((r) => setItems(r.items)).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const link = (id: string) => `#/graph/${encodeURIComponent(id)}?build=${build.id}`;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Explore cards</div>
          <h1 className="page-title">Pick a card</h1>
          <p className="page-sub">See which {scopeName(build.scope)} cards help it, which cards it helps, and why. New here? Read <a href="#/guide">Start here</a> first.</p>
        </div>
        <div className="page-actions"><VersionSelect build={build} builds={builds} /></div>
      </div>
      <label className="search-box gx-search">
        <span className="sr-only">Search the cards by name or text</span>
        <span className="icon" aria-hidden="true"><Icon name="search" size={16} /></span>
        <input type="search" placeholder="Search by card name or rules text" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </label>
      {q.trim() ? (
        items.length === 0 ? <p className="muted">No card found.</p> : (
          <div className="gx-tiles">
            {items.map((c) => <CardTile key={c.oracle_id} id={c.oracle_id} href={link(c.oracle_id)} name={c.name} image={c.image_normal} sub={c.type_line} />)}
          </div>
        )
      ) : (
        <>
          <h2 className="sub-h gx-tiles-h">The cards with the most links</h2>
          {!top ? <p className="muted">Loading…</p> : (
            <div className="gx-tiles">
              {top.map((c) => <CardTile key={c.oracle_id} id={c.oracle_id} href={link(c.oracle_id)} name={c.name} image={c.image ?? null}
                sub={`${(c.out_degree + c.in_degree).toLocaleString('en-US')} links`} />)}
            </div>
          )}
        </>
      )}
    </>
  );
}

function CardTile({ id, href, name, image, sub, children }: { id: string; href: string; name: string; image: string | null; sub?: string; children?: ReactNode }) {
  return (
    <a className="gx-tile" href={href} data-card-id={id}>
      {image ? <img src={image} alt={name} loading="lazy" /> : <span className="gx-tile-noimg">{name}</span>}
      <span className="gx-tile-name">{name}</span>
      {sub && <span className="gx-tile-sub">{sub}</span>}
      {children}
    </a>
  );
}

// ---------- the card page ----------

type Tab = 'partners' | 'helps' | 'helped' | 'kinds' | 'conflicts' | 'loops' | 'read';

interface Partner {
  id: string; weight: number; links: number; broad: number; helps: boolean; helped: boolean; best: EdgeView;
}

/** The other cards of the explicit edges, strongest first, with the number of broad links of each. */
function partners(centre: string, out: EdgeView[], inn: EdgeView[]): Partner[] {
  const m = new Map<string, Partner>();
  const add = (id: string, e: EdgeView, dir: 'helps' | 'helped') => {
    if (id === centre) return;
    const p = m.get(id) ?? { id, weight: 0, links: 0, broad: 0, helps: false, helped: false, best: e };
    p.links += 1;
    if (e.demand_without_params) p.broad += 1;
    if (e.weight.total > p.weight) { p.weight = e.weight.total; p.best = e; }
    p[dir] = true;
    m.set(id, p);
  };
  for (const e of out) add(e.demand.oracle_id, e, 'helps');
  for (const e of inn) if (e.supply) add(e.supply.oracle_id, e, 'helped');
  return [...m.values()].sort((a, b) => b.weight - a.weight || b.links - a.links || (a.id < b.id ? -1 : 1));
}

function CardGraph({ build, builds, oracleId }: { build: GraphBuild; builds: GraphBuild[]; oracleId: string }) {
  const [data, setData] = useState<GraphCardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('partners');
  const [hideBroad, setHideBroad] = useState(false);
  const [filter, setFilter] = useState('');
  const labels = useTypeLabels();

  useEffect(() => {
    api.graphCard(build.id, oracleId).then((d) => { setData(d); setError(null); }).catch((err: Error) => setError(err.message));
  }, [build.id, oracleId]);

  const view = useMemo(() => {
    if (!data) return null;
    const keep = (l: EdgeView[]) => (hideBroad ? l.filter((e) => !e.demand_without_params) : l);
    const e = data.edges;
    const out = keep(e.out);
    const inn = keep(e.in);
    return {
      out, inn, classes: keep(e.classes), anti: keep(e.anti),
      partners: partners(oracleId, out, inn),
      broadTotal: [...e.out, ...e.in, ...e.classes, ...e.anti].filter((x) => x.demand_without_params).length,
      total: e.out.length + e.in.length + e.classes.length + e.anti.length,
    };
  }, [data, hideBroad, oracleId]);

  if (error) return <div className="error-block">{error}</div>;
  if (!data || !view) return <div className="loading-line" role="status"><span className="spinner" aria-hidden="true" />Finding the links of this card…</div>;

  const card = data.cards[oracleId]!;
  const goTo = (t: Tab, name = '') => { setTab(t); setFilter(name); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'partners', label: 'Best partners', count: view.partners.length },
    { id: 'helps', label: 'Helps', count: view.out.length },
    { id: 'helped', label: 'Helped by', count: view.inn.length },
    { id: 'kinds', label: 'Card kinds', count: view.classes.length },
    { id: 'conflicts', label: 'Conflicts', count: view.anti.length },
    { id: 'loops', label: 'Loops' },
    { id: 'read', label: 'How it was read' },
  ];

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href={`#/graph?build=${build.id}`}>Explore cards</a><span className="sep">/</span>
        <span data-card-id={oracleId}>{card.name}</span>
      </nav>

      <CardHero card={card} oracleId={oracleId} build={build} builds={builds} counts={{
        helps: data.edges.out.length, helped: data.edges.in.length, kinds: data.edges.classes.length, conflicts: data.edges.anti.length,
      }} />

      <HowToRead />
      <PrecisionNotice buildId={build.id} />

      <div className="gx-toolbar">
        <div className="gx-tabs" role="tablist" aria-label="Parts of the card page">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : undefined} onClick={() => goTo(t.id)}>
              {t.label}{t.count !== undefined && <b>{t.count.toLocaleString('en-US')}</b>}
            </button>
          ))}
        </div>
        <label className="gx-switch" title="Hide the links that every card of a kind gets (the known problem)">
          <input type="checkbox" checked={hideBroad} onChange={(e) => setHideBroad(e.target.checked)} />
          <span>Hide broad links</span>
          <span className="muted">({view.broadTotal.toLocaleString('en-US')} of {view.total.toLocaleString('en-US')})</span>
        </label>
      </div>

      {tab === 'partners' && <Partners list={view.partners} data={data} buildId={build.id} labels={labels} onShow={goTo} />}
      {tab === 'helps' && (
        <EdgeList edges={view.out} data={data} buildId={build.id} labels={labels} filter={filter} setFilter={setFilter}
          intro={<>Cards that <Term id="needs">need</Term> something that <b data-card-id={oracleId}>{card.name}</b> <Term id="gives">gives</Term>. Grouped by <Term id="reason">reason</Term>, strongest first.</>} />
      )}
      {tab === 'helped' && (
        <EdgeList edges={view.inn} data={data} buildId={build.id} labels={labels} filter={filter} setFilter={setFilter}
          intro={<>Cards that <Term id="gives">give</Term> something that <b data-card-id={oracleId}>{card.name}</b> <Term id="needs">needs</Term>. Grouped by <Term id="reason">reason</Term>, strongest first.</>} />
      )}
      {tab === 'kinds' && <ClassEdges edges={view.classes} data={data} buildId={build.id} labels={labels} name={card.name} />}
      {tab === 'conflicts' && (
        <EdgeList edges={view.anti} data={data} buildId={build.id} labels={labels} filter={filter} setFilter={setFilter}
          intro={<>Cards that work against <b data-card-id={oracleId}>{card.name}</b>, or that <b data-card-id={oracleId}>{card.name}</b> works against. See <Term id="conflict" />.</>} />
      )}
      {tab === 'loops' && <Cycles buildId={build.id} oracleId={oracleId} labels={labels} />}
      {tab === 'read' && <CentreCard data={data} labels={labels} />}
    </>
  );
}

function CardHero({ card, oracleId, build, builds, counts }: {
  card: GraphCardResponse['cards'][string]; oracleId: string; build: GraphBuild; builds: GraphBuild[];
  counts: { helps: number; helped: number; kinds: number; conflicts: number };
}) {
  const faceImages = card.faces.map((f) => f.image).filter((x): x is string => !!x);
  const images = faceImages.length > 1 ? faceImages : card.image ? [card.image] : faceImages;
  return (
    <section className="gx-hero">
      <div className={`gx-hero-img${images.length > 1 ? ' two' : ''}`} data-card-id={oracleId}>
        {images.length === 0 && <div className="gx-tile-noimg">{card.name}</div>}
        {images.map((src, i) => <img key={i} src={src} alt={i === 0 ? card.name : `${card.name}, other face`} />)}
      </div>
      <div className="gx-hero-body">
        <div className="gx-hero-top">
          <h1 className="page-title gx-hero-name"><span data-card-id={oracleId}>{card.name}</span> <ManaCost cost={card.mana_cost} /></h1>
          <VersionSelect build={build} builds={builds} oracleId={oracleId} />
        </div>
        <div className="muted">{card.type_line}</div>
        {card.faces.map((f) => (
          <div key={f.face_index} className="gx-hero-text">
            {card.faces.length > 1 && <div className="gx-quote-k"><span data-card-id={oracleId}>{f.name}</span></div>}
            {f.oracle_text.split('\n').map((line, i) => <p key={i}>{line}</p>)}
          </div>
        ))}
        <div className="gx-hero-stats">
          <span><b>{counts.helps.toLocaleString('en-US')}</b> cards it helps</span>
          <span><b>{counts.helped.toLocaleString('en-US')}</b> cards that help it</span>
          <span><b>{counts.kinds.toLocaleString('en-US')}</b> card kinds</span>
          <span><b>{counts.conflicts.toLocaleString('en-US')}</b> conflicts</span>
        </div>
        <a className="gx-link" href={`#/card/${encodeURIComponent(oracleId)}`}>Full card details <Icon name="arrowRight" size={13} /></a>
      </div>
    </section>
  );
}

/** A short "how to read this page" box. A person can close it; the choice stays in this browser. */
function HowToRead() {
  const [closed, setClosed] = useState(() => { try { return localStorage.getItem(HOWTO_KEY) === '1'; } catch { return false; } });
  const set = (v: boolean) => { setClosed(v); try { localStorage.setItem(HOWTO_KEY, v ? '1' : '0'); } catch { /* no storage */ } };
  if (closed) return <button className="gx-link gx-howto-open" onClick={() => set(false)}><Icon name="info" size={14} /> How to read this page</button>;
  return (
    <div className="callout callout-info gx-howto">
      <Icon name="info" size={18} />
      <div>
        <p><b>How to read this page.</b> A <Term id="link" /> means one card <Term id="gives">gives</Term> something that another card <Term id="needs">needs</Term>.</p>
        <ol>
          <li>Start with <b>Best partners</b>: the cards with the strongest links. Would you play them together?</li>
          <li>Push <b>See the links</b> on a partner to read the card text on both sides.</li>
          <li>If a link is wrong, push <b>Report this link</b>.</li>
        </ol>
        <button className="gx-link" onClick={() => set(true)}>Close this help</button>
      </div>
    </div>
  );
}

function Partners({ list, data, buildId, labels, onShow }: {
  list: Partner[]; data: GraphCardResponse; buildId: number; labels: Record<string, string>; onShow: (t: Tab, name: string) => void;
}) {
  const [shown, setShown] = useState(12);
  if (list.length === 0) return <div className="panel"><p className="muted">This card has no links to other cards with these settings.</p></div>;
  return (
    <section className="panel">
      <p className="panel-sub">
        The cards with the strongest <Term id="link">links</Term> to this card, strongest first. Each card shows its strongest reason.
        A <BroadMark /> mark means that the reason shown is a broad link.
      </p>
      <div className="gx-partners">
        {list.slice(0, shown).map((p) => {
          const c = data.cards[p.id];
          const e = p.best;
          const give = typeName(e.supply?.types[0] ?? '', labels);
          const need = typeName(e.demand.type, labels);
          const giver = e.supply ? data.cards[e.supply.oracle_id]?.name : '';
          const needer = data.cards[e.demand.oracle_id]?.name;
          const bestDir: Tab = e.demand.oracle_id === data.centre.oracle_id ? 'helped' : 'helps';
          return (
            <div key={p.id} className="gx-partner">
              <a className="gx-partner-img" href={`#/graph/${encodeURIComponent(p.id)}?build=${buildId}`} title={`Open ${c?.name ?? p.id}`} data-card-id={p.id}>
                {c?.image ? <img src={c.image} alt={c.name} loading="lazy" /> : <span className="gx-tile-noimg">{c?.name ?? p.id}</span>}
              </a>
              <div className="gx-partner-body">
                <a className="gx-partner-name" href={`#/graph/${encodeURIComponent(p.id)}?build=${buildId}`} data-card-id={p.id}>{c?.name ?? p.id}</a>
                <div className="gx-partner-dir">
                  {p.helps && p.helped ? 'helps each other' : p.helps ? 'this card helps it' : 'it helps this card'} · {p.links} {p.links === 1 ? 'link' : 'links'}{p.broad > 0 && <> ({p.broad} broad)</>}
                </div>
                <p className="gx-partner-why" title={`${typeTitle(e.supply?.types[0] ?? '', labels)} → ${typeTitle(e.demand.type, labels)}`}>
                  <b data-card-id={e.supply?.oracle_id}>{giver}</b> gives “{give}”, <b data-card-id={e.demand.oracle_id}>{needer}</b> needs “{need}”.
                </p>
                <div className="gx-partner-marks">
                  <span className={`gx-grade gx-grade-${e.grade}`}>{e.grade === 'confirmed' ? 'strong match' : 'possible match'}</span>
                  {e.demand_without_params && <BroadMark />}
                </div>
                <div className="gx-partner-actions">
                  <button className="gx-link" onClick={() => onShow(bestDir, c?.name ?? '')}>See the links</button>
                  {p.helps && p.helped && <button className="gx-link" onClick={() => onShow(bestDir === 'helps' ? 'helped' : 'helps', c?.name ?? '')}>Other direction</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {shown < list.length && <button className="btn gx-more" onClick={() => setShown(shown + 12)}>Show 12 more ({list.length - shown} left)</button>}
    </section>
  );
}

/** A list of edges with a name filter, grouped by rule, strongest group first. */
function EdgeList({ edges, data, buildId, labels, filter, setFilter, intro }: {
  edges: EdgeView[]; data: GraphCardResponse; buildId: number; labels: Record<string, string>;
  filter: string; setFilter: (s: string) => void; intro: ReactNode;
}) {
  const centre = data.centre.oracle_id;
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!q) return edges;
    return edges.filter((e) => {
      const other = e.supply && e.supply.oracle_id !== centre ? e.supply.oracle_id : e.demand.oracle_id;
      return (data.cards[other]?.name ?? '').toLowerCase().includes(q);
    });
  }, [edges, q, data, centre]);
  const groups = useMemo(() => {
    const m = new Map<string, EdgeView[]>();
    for (const e of rows) {
      const k = e.rule_hashes.join(',');
      const l = m.get(k);
      if (l) l.push(e); else m.set(k, [e]);
    }
    for (const l of m.values()) l.sort((a, b) => b.weight.total - a.weight.total || (a.key < b.key ? -1 : 1));
    const top = (l: EdgeView[]) => l[0]!.weight.total;
    return [...m.entries()].sort((a, b) => top(b[1]) - top(a[1]) || b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  }, [rows]);
  return (
    <section className="panel">
      <p className="panel-sub">{intro}</p>
      <label className="search-box gx-filter">
        <span className="sr-only">Find a card in this list</span>
        <span className="icon" aria-hidden="true"><Icon name="search" size={16} /></span>
        <input type="search" placeholder="Find a card in this list" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <p className="muted">{rows.length.toLocaleString('en-US')} links · {groups.length} reasons</p>
      {groups.length === 0 && <p className="muted">None.</p>}
      {groups.map(([k, list], i) => <RuleGroup key={k} list={list} data={data} buildId={buildId} labels={labels} startOpen={i === 0 || !!q} />)}
    </section>
  );
}

function RuleGroup({ list, data, buildId, labels, startOpen }: {
  list: EdgeView[]; data: GraphCardResponse; buildId: number; labels: Record<string, string>; startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [shown, setShown] = useState(Math.min(PAGE, 10));
  const first = list[0]!;
  const rules = first.rule_hashes.map((h) => data.rules[h]);
  const strong = list.filter((e) => e.grade === 'confirmed').length;
  const broad = list.filter((e) => e.demand_without_params).length;
  const give = first.supply ? typeName(first.supply.types[0] ?? '', labels) : '';
  const need = typeName(first.demand.type, labels);
  return (
    <div className="gx-rgroup">
      <button className="gx-rgroup-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="gx-caret">{open ? '▾' : '▸'}</span>
        <span className="gx-rgroup-why">gives “{give}” → needs “{need}”</span>
        <span className="count">{list.length} {list.length === 1 ? 'link' : 'links'} · {strong} strong{broad ? ` · ${broad} broad` : ''}</span>
        <span className="muted mono gx-rgroup-id">{rules.map((r) => r?.rule_id ?? '?').join(', ')}</span>
      </button>
      {open && (
        <div className="gx-rgroup-body">
          {list.slice(0, shown).map((e) => <EdgeRow key={e.key} edge={e} centre={data.centre.oracle_id} cards={data.cards} rules={data.rules} buildId={buildId} labels={labels} />)}
          {shown < list.length && <button className="gx-link" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}</button>}
        </div>
      )}
    </div>
  );
}

/** Class edges (sec. 13.1 item 4): one row for each class, which opens to show the members. */
function ClassEdges({ edges, data, buildId, labels, name }: {
  edges: EdgeView[]; data: GraphCardResponse; buildId: number; labels: Record<string, string>; name: string;
}) {
  return (
    <section className="panel">
      <p className="panel-sub">Whole groups of cards that help <b data-card-name={name}>{name}</b>, for example “every creature card”. See <Term id="kind" />.</p>
      {edges.length === 0 && <p className="muted">None.</p>}
      {edges.map((e) => <ClassRow key={e.key} edge={e} data={data} buildId={buildId} labels={labels} />)}
    </section>
  );
}

function ClassRow({ edge, data, buildId, labels }: { edge: EdgeView; data: GraphCardResponse; buildId: number; labels: Record<string, string> }) {
  const [members, setMembers] = useState<ClassMembers | null>(null);
  const [open, setOpen] = useState(false);
  const load = (offset: number) => {
    api.graphClass(buildId, edge.class!.id, offset, 50).then((m) => setMembers((old) => (old && offset > 0 ? { ...m, members: [...old.members, ...m.members] } : m)));
  };
  return (
    <div className="gx-rgroup">
      <EdgeRow edge={edge} centre={data.centre.oracle_id} cards={data.cards} rules={data.rules} buildId={buildId} labels={labels} />
      <button className="gx-link" onClick={() => { setOpen(!open); if (!members) load(0); }}>
        {open ? 'Hide the cards' : `Show the ${edge.class!.member_count} cards of this kind`}
      </button>
      {open && members && (
        <div>
          <ul className="gx-members">
            {members.members.map((m) => <li key={m.oracle_id}><a href={`#/graph/${encodeURIComponent(m.oracle_id)}?build=${buildId}`} data-card-id={m.oracle_id}>{m.name}</a></li>)}
          </ul>
          {members.members.length < members.total && <button className="gx-link" onClick={() => load(members.members.length)}>Show more</button>}
        </div>
      )}
    </div>
  );
}

function CycleCard({ c, names, labels }: { c: CycleView; names: Map<string, string>; labels: Record<string, string> }) {
  const t = TIER_TEXT[c.tier];
  const broad = c.steps.filter((s) => s.demand_without_params).length;
  return (
    <div className="gx-cycle">
      <div className="gx-edge-head">
        <span className={`gx-tier gx-tier-${c.tier}`} title={t.definition}>{t.label}</span>
        {broad > 0 && <span className="gx-wide">{broad} of {c.steps.length} steps are broad links</span>}
        {c.unresolved.length > 0 && <span className="gx-flag">not sure: {c.unresolved.map((u) => CAUSE_TEXT[u]).join('; ')}</span>}
        {c.tier === 2 && c.per_turn_limit && <span className="gx-flag">once per turn</span>}
        <span className="gx-weight mono" title="Puts the loops in order. Not a quality score.">strength {c.score.toFixed(3)}</span>
      </div>
      <p className="muted gx-tier-def">{t.definition} The loop kind is not a quality score.</p>
      <ol className="gx-steps">
        {c.steps.map((s, i) => {
          const from = c.groups.find((g) => g.key === s.from);
          const to = c.groups.find((g) => g.key === s.to);
          const give = s.supply_types.map((x) => typeName(x, labels)).join(', ') || 'its card kind';
          return (
            <li key={i}>
              <b>{from?.name ?? names.get(s.from)}</b> <span className="muted">({ABILITY_KIND[from?.kind ?? 'other'] ?? from?.kind})</span>
              {' gives “'}{give}{'” → '}
              <b>{to?.name ?? names.get(s.to)}</b> <span className="muted">({ABILITY_KIND[to?.kind ?? 'other'] ?? to?.kind})</span>
              {' needs “'}{typeName(s.demand_type, labels)}{'”'}
              <span className="muted"> · {s.grade === 'confirmed' ? 'strong' : 'possible'} match</span>
              {s.demand_without_params && <> <BroadMark /></>}
            </li>
          );
        })}
      </ol>
      {c.balance.length > 0 && (
        <details className="gx-rules">
          <summary>What the loop uses and makes</summary>
          <table className="data gx-balance">
            <thead><tr><th>resource</th><th>kind</th><th>net per turn of the loop</th><th>counts as growth</th></tr></thead>
            <tbody>{c.balance.map((b) => <tr key={b.resource}><td className="mono">{b.resource}</td><td>{b.kind}</td><td className="mono">{String(b.net)}</td><td>{b.value ? 'yes' : 'no'}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function SearchList({ title, s, names, labels, extra }: { title: string; s: CycleSearchView; names: Map<string, string>; labels: Record<string, string>; extra?: string }) {
  return (
    <div className="gx-search-list">
      <h3>{title} <span className="count">{s.cycles.length}</span>
        {!s.exact && <span className="gx-mark gx-mark-budget" title="The search stopped at its time limit. More loops can exist.">search stopped early</span>}</h3>
      {extra && <p className="gx-flag">{extra}</p>}
      {s.cycles.length === 0 && <p className="muted">No loop found.</p>}
      {s.cycles.map((c, i) => <CycleCard key={i} c={c} names={names} labels={labels} />)}
    </div>
  );
}

function Cycles({ buildId, oracleId, labels }: { buildId: number; oracleId: string; labels: Record<string, string> }) {
  const [confirmed, setConfirmed] = useState(false);
  const [r, setR] = useState<CyclesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true); setError(null);
    api.graphCycles(buildId, oracleId, confirmed).then(setR).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const names = useMemo(() => new Map(r ? [...r.engine.cycles, ...r.full.cycles].flatMap((c) => c.groups.map((g) => [g.key, g.name] as const)) : []), [r]);
  const all = r ? [...r.engine.cycles, ...r.full.cycles] : [];
  const broadCycles = all.filter((c) => c.steps.some((s) => s.demand_without_params)).length;
  return (
    <section className="panel">
      <p className="panel-sub">
        A <Term id="loop" /> is a chain of links that comes back to this card. The search takes some seconds, so it runs only when you push the button.
        Loop kinds: <b>{LOOP_KIND[3].label}</b>, <b>{LOOP_KIND[2].label}</b> and <b>{LOOP_KIND[1].label}</b> (see the guide).
      </p>
      <div className="gx-controls">
        <button className="btn btn-primary" disabled={busy} onClick={run}>{busy ? 'Searching…' : 'Find loops'}</button>
        <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> strong matches only</label>
      </div>
      {error && <div className="error-block">{error}</div>}
      {r && (
        <>
          {all.length > 0 && broadCycles > 0 && (
            <p className="gx-notice gx-notice-warn">
              {broadCycles} of {all.length} loops have one or more broad links. Such a step only says “a card of this kind”, not this specific card.
              Read these loops as ideas, not as proved combos.
            </p>
          )}
          <SearchList title="Engines (only triggered and activated abilities)" s={r.engine} names={names} labels={labels}
            extra={r.more_engine ? 'The list shows only the strongest engines. More can exist.' : undefined} />
          <SearchList title="Other loops" s={r.full} names={names} labels={labels} />
        </>
      )}
    </section>
  );
}

/** The faces of the centre card, with each ability marked and the facts that the system read (sec. 13.1 item 2). */
function CentreCard({ data, labels }: { data: GraphCardResponse; labels: Record<string, string> }) {
  const card = data.cards[data.centre.oracle_id]!;
  return (
    <section className="panel">
      <p className="panel-sub">
        This tab is for checks. It shows the card text split into abilities, with the <Term id="marked">marked text</Term> that the system read,
        and the name of each fact under it.
      </p>
      {card.faces.map((f) => {
        const groups = data.centre.groups.filter((g) => g.face_index === f.face_index);
        const atoms = data.centre.atoms.filter((a) => a.face_index === f.face_index);
        return (
          <div key={f.face_index} className="gx-face">
            {card.faces.length > 1 && <p className="gx-quote-k"><span data-card-id={data.centre.oracle_id}>{f.name}</span></p>}
            {groups.length === 0 && <p className="muted">The system read no fact on this face.</p>}
            {groups.map((g) => {
              const inGroup = atoms.filter((a) => a.span_start >= g.span_start && a.span_start < g.span_end);
              const face: AtomFace = {
                face_index: f.face_index, oracle_text: f.oracle_text.slice(g.span_start, g.span_end), clauses: [], unclassified: [], missingRules: [],
                atoms: inGroup.map((a) => ({
                  id: a.id, face_index: f.face_index, schema_version: 0, family: a.family, type_key: a.type_key, params: a.params,
                  span_start: a.span_start - g.span_start, span_end: Math.min(a.span_end, g.span_end) - g.span_start, quote: a.quote,
                  span_ambiguous: false, rule_numbers: [], confidence: 1,
                })),
              };
              return (
                <div key={g.group_index} className="gx-group">
                  <div className="gx-group-k">
                    <span className={`gx-kind gx-kind-${g.kind}`}>{ABILITY_KIND[g.kind] ?? g.kind}</span>
                    {g.per_turn_limit === 1 && <span className="gx-flag">once per turn</span>}
                    {g.unknown_limit === 1 && <span className="gx-flag">limit not known</span>}
                    {g.cost_unparsed === 1 && <span className="gx-flag">cost not read</span>}
                  </div>
                  <AtomSpans face={face} />
                  {inGroup.length > 0 && (
                    <ul className="gx-facts">
                      {inGroup.map((a) => {
                        const k = `${a.family}.${a.type_key}`;
                        return <li key={a.id} title={typeTitle(k, labels)}>{typeName(k, labels)} <span className="muted mono">{k}</span></li>;
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
