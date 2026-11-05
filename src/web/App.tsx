import { useEffect, useState } from 'react';
import { api } from './api.js';
import { CardBrowser } from './pages/CardBrowser.js';
import { CardDetail } from './pages/CardDetail.js';
import { PoolStatus } from './pages/PoolStatus.js';
import { GoldenQueue } from './pages/GoldenQueue.js';
import { ReviewQueue } from './pages/ReviewQueue.js';
import { ExtractionRuns } from './pages/ExtractionRuns.js';
import { EdgeGolden } from './pages/EdgeGolden.js';
import { GraphExplorer } from './pages/GraphExplorer.js';
import { EdgeRules } from './pages/EdgeRules.js';
import { GraphBuild } from './pages/GraphBuild.js';
import { Overview } from './pages/Overview.js';
import { Guide } from './pages/Guide.js';
import { Decisions } from './pages/Decisions.js';
import { DeckBuilder } from './pages/DeckBuilder.js';
import { DeckViewPage } from './pages/DeckView.js';
import { Icon, type IconName } from './components/Icon.js';
import { CardZoomLayer } from './components/CardZoom.js';

interface PoolStatusSummary {
  pool: number;
  corpus: { effective_date: string } | null;
}

type Route =
  | { page: 'overview' }
  | { page: 'decisions' }
  | { page: 'decks' }
  | { page: 'deck'; id: number }
  | { page: 'guide'; term?: string }
  | { page: 'cards' }
  | { page: 'card'; oracleId: string; findingId?: number }
  | { page: 'pool'; anchorKeyword?: string }
  | { page: 'golden' }
  | { page: 'review'; findingId?: number; domain?: 'atom' | 'edge' }
  | { page: 'runs' }
  | { page: 'edge-golden' }
  | { page: 'graph'; oracleId?: string; buildId?: number }
  | { page: 'edge-rules'; findingId?: number; tab?: 'rules' | 'roles' }
  | { page: 'graph-builds'; buildId?: number };

/** No router library: fifteen routes, parsed straight out of the hash. */
function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path, queryString] = raw.split('?');

  const query = new URLSearchParams(queryString ?? '');
  const finding = Number(query.get('finding'));
  const findingId = Number.isInteger(finding) && finding > 0 ? finding : undefined;
  const build = Number(query.get('build'));
  const buildId = Number.isInteger(build) && build > 0 ? build : undefined;

  if (path === '/graph' || (path && path.startsWith('/graph/'))) {
    const id = path.slice('/graph/'.length);
    return { page: 'graph', oracleId: id ? decodeURIComponent(id) : undefined, buildId };
  }
  if (path === '/edge-rules') {
    return { page: 'edge-rules', findingId, tab: query.get('tab') === 'roles' ? 'roles' : undefined };
  }
  if (path === '/decisions') {
    return { page: 'decisions' };
  }
  if (path === '/decks') {
    return { page: 'decks' };
  }
  if (path && path.startsWith('/decks/')) {
    const id = Number(path.slice('/decks/'.length));
    return Number.isInteger(id) && id > 0 ? { page: 'deck', id } : { page: 'decks' };
  }
  if (path === '/guide') {
    return { page: 'guide', term: query.get('term') ?? undefined };
  }
  if (path === '/graph-builds') {
    return { page: 'graph-builds', buildId };
  }

  if (path && path.startsWith('/card/')) {
    return { page: 'card', oracleId: decodeURIComponent(path.slice('/card/'.length)), findingId };
  }
  if (path === '/golden') {
    return { page: 'golden' };
  }
  if (path === '/review') {
    return { page: 'review', findingId, domain: query.get('domain') === 'edge' ? 'edge' : undefined };
  }
  if (path === '/runs') {
    return { page: 'runs' };
  }
  if (path === '/edge-golden') {
    return { page: 'edge-golden' };
  }
  if (path === '/cards') {
    return { page: 'cards' };
  }
  if (path === '/pool') {
    return { page: 'pool', anchorKeyword: query.get('keyword') ?? undefined };
  }
  return { page: 'overview' };
}

interface NavItem { href: string; label: string; icon: IconName; active: (r: Route) => boolean }
interface NavGroup { label: string | null; items: NavItem[]; collapsible?: boolean; hint?: string }

/**
 * The sidebar: first the guide and the pages for the demo, then the tools of the data work in a closed
 * group (owner request 2026-10-18: start point first, project tools out of the way).
 */
const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { href: '#/guide', label: 'Start here', icon: 'info', active: (r) => r.page === 'guide' },
      { href: '#/', label: 'Overview', icon: 'home', active: (r) => r.page === 'overview' },
      { href: '#/decisions', label: 'Your decisions', icon: 'check', active: (r) => r.page === 'decisions' },
      { href: '#/decks', label: 'Build a deck', icon: 'deck', active: (r) => r.page === 'decks' || r.page === 'deck' },
    ],
  },
  {
    label: 'Explore',
    items: [
      { href: '#/graph', label: 'Explore cards', icon: 'graph', active: (r) => r.page === 'graph' },
      { href: '#/graph-builds', label: 'Graph quality', icon: 'layers', active: (r) => r.page === 'graph-builds' },
      { href: '#/cards', label: 'All cards', icon: 'cards', active: (r) => r.page === 'cards' || r.page === 'card' },
    ],
  },
  {
    label: 'Behind the scenes',
    collapsible: true,
    hint: 'Tools for the data work: you use them to make your links.',
    items: [
      { href: '#/edge-rules', label: 'Reasons (edge rules)', icon: 'rules', active: (r) => r.page === 'edge-rules' },
      { href: '#/review', label: 'Review queue', icon: 'inbox', active: (r) => r.page === 'review' },
      { href: '#/pool', label: 'Pool & rules text', icon: 'book', active: (r) => r.page === 'pool' },
      { href: '#/runs', label: 'Card-reading runs', icon: 'play', active: (r) => r.page === 'runs' },
      { href: '#/golden', label: 'Card-reading test set', icon: 'star', active: (r) => r.page === 'golden' },
      { href: '#/edge-golden', label: 'Link test pairs', icon: 'scale', active: (r) => r.page === 'edge-golden' },
    ],
  },
];

function NavGroupView({ g, route }: { g: NavGroup; route: Route }) {
  const inside = g.items.some((it) => it.active(route));
  const [open, setOpen] = useState(!g.collapsible || inside);
  useEffect(() => { if (inside) setOpen(true); }, [inside]);
  return (
    <div className="nav-group">
      {g.label && (g.collapsible
        ? <button type="button" className="nav-label nav-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevronRight" size={12} />{g.label}
          </button>
        : <div className="nav-label">{g.label}</div>)}
      {open && g.hint && <div className="nav-hint">{g.hint}</div>}
      {open && g.items.map((it) => {
        const active = it.active(route);
        return (
          <a key={it.href} href={it.href} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
            <Icon name={it.icon} />
            {it.label}
          </a>
        );
      })}
    </div>
  );
}

function Brand() {
  return (
    <a className="brand" href="#/">
      <span className="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <span className="brand-text">
        <span className="brand-name">Spellweb</span>
        <span className="brand-sub">Standard · Best-of-One</span>
      </span>
    </a>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [poolCount, setPoolCount] = useState<number | null>(null);
  const [effectiveDate, setEffectiveDate] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => { setRoute(parseHash(window.location.hash)); setMenuOpen(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    (api.poolStatus() as Promise<PoolStatusSummary>)
      .then((status) => {
        setPoolCount(status.pool);
        setEffectiveDate(status.corpus?.effective_date ?? null);
      })
      .catch(() => {
        setPoolCount(null);
        setEffectiveDate(null);
      });
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <button className="btn btn-ghost menu-btn" aria-label="Open the navigation" aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" size={20} />
        </button>
      </header>
      {menuOpen && <button className="scrim" aria-label="Close the navigation" onClick={() => setMenuOpen(false)} />}
      <aside id="sidebar" className={`sidebar${menuOpen ? ' open' : ''}`}>
        <Brand />
        <nav className="app-nav" aria-label="Main">
          {NAV.map((g, i) => <NavGroupView key={g.label ?? i} g={g} route={route} />)}
        </nav>
        <div className="sidebar-foot">
          <div className="foot-row"><span>Card pool</span><b>{poolCount === null ? '…' : poolCount.toLocaleString('en-US')}</b></div>
          {effectiveDate && <div className="foot-row"><span>Rules effective</span><b>{effectiveDate}</b></div>}
        </div>
      </aside>
      <main className="app-main">
        {route.page === 'overview' && <Overview />}
        {route.page === 'decisions' && <Decisions />}
        {route.page === 'decks' && <DeckBuilder />}
        {route.page === 'deck' && <DeckViewPage id={route.id} />}
        {route.page === 'guide' && <Guide key={route.term ?? ''} term={route.term} />}
        {route.page === 'cards' && <CardBrowser />}
        {route.page === 'card' && <CardDetail oracleId={route.oracleId} findingId={route.findingId} />}
        {route.page === 'pool' && <PoolStatus anchorKeyword={route.anchorKeyword} />}
        {route.page === 'golden' && <GoldenQueue />}
        {route.page === 'review' && <ReviewQueue key={`${route.domain ?? 'atom'}|${route.findingId ?? ''}`} initialFinding={route.findingId} initialDomain={route.domain} />}
        {route.page === 'runs' && <ExtractionRuns />}
        {route.page === 'edge-golden' && <EdgeGolden />}
        {route.page === 'graph' && <GraphExplorer oracleId={route.oracleId} buildId={route.buildId} />}
        {route.page === 'edge-rules' && <EdgeRules key={`${route.findingId ?? 0}|${route.tab ?? ''}`} findingId={route.findingId} initialTab={route.tab} />}
        {route.page === 'graph-builds' && <GraphBuild buildId={route.buildId} />}
      </main>
      <CardZoomLayer />
    </div>
  );
}
