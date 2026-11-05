import type { EdgeView, GraphCardView } from '../api.js';

/**
 * A small ego graph (Phase 3 spec sec. 13.1 item 7): the centre card and its strongest
 * neighbours, as an SVG with no new dependency. The lists are the verification surface; the
 * diagram is a help only. The weight of a neighbour is its highest card-pair weight.
 */

interface Neighbour { id: string; weight: number; out: boolean; in: boolean }

export function strongestNeighbours(centre: string, out: EdgeView[], inn: EdgeView[], n: number): Neighbour[] {
  const m = new Map<string, Neighbour>();
  const add = (id: string, w: number, dir: 'out' | 'in') => {
    if (id === centre) return;
    const x = m.get(id) ?? { id, weight: 0, out: false, in: false };
    x.weight = Math.max(x.weight, w);
    x[dir] = true;
    m.set(id, x);
  };
  for (const e of out) add(e.demand.oracle_id, e.weight.total, 'out');
  for (const e of inn) if (e.supply) add(e.supply.oracle_id, e.weight.total, 'in');
  return [...m.values()].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)).slice(0, n);
}

const W = 560;
const H = 380;

export function EgoGraph({ centre, out, inn, cards, buildId }: {
  centre: string; out: EdgeView[]; inn: EdgeView[]; cards: Record<string, GraphCardView>; buildId: number;
}) {
  const ns = strongestNeighbours(centre, out, inn, 12);
  if (ns.length === 0) return <p className="muted">This card has no explicit synergy neighbours in this build.</p>;
  const max = ns[0]!.weight || 1;
  const cx = W / 2;
  const cy = H / 2;
  const name = (id: string, len = 22) => {
    const s = cards[id]?.name ?? id;
    return s.length > len ? `${s.slice(0, len - 1)}…` : s;
  };
  return (
    <svg className="gx-ego" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="strongest neighbours of the centre card">
      {ns.map((x, i) => {
        const a = (i / ns.length) * 2 * Math.PI - Math.PI / 2;
        const px = cx + Math.cos(a) * 200;
        const py = cy + Math.sin(a) * 140;
        const dir = x.out && x.in ? 'both' : x.out ? 'out' : 'in';
        return (
          <g key={x.id}>
            <line x1={cx} y1={cy} x2={px} y2={py} className={`gx-ego-line gx-ego-${dir}`} strokeWidth={1 + 4 * (x.weight / max)}>
              <title>{`${dir === 'out' ? 'this card supplies' : dir === 'in' ? 'this card demands' : 'both directions'} · weight ${x.weight.toFixed(3)}`}</title>
            </line>
            <a href={`#/graph/${encodeURIComponent(x.id)}?build=${buildId}`}>
              <circle cx={px} cy={py} r={6} className={`gx-ego-node gx-ego-${dir}`} />
              <text x={px} y={py + (py < cy ? -11 : 18)} textAnchor="middle" className="gx-ego-label">{name(x.id)}</text>
            </a>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={10} className="gx-ego-centre" />
      <text x={cx} y={cy + 26} textAnchor="middle" className="gx-ego-label gx-ego-label-centre">{name(centre, 30)}</text>
      <g className="gx-ego-legend" transform={`translate(8, ${H - 44})`}>
        <line x1={0} y1={6} x2={18} y2={6} className="gx-ego-line gx-ego-out" strokeWidth={2} /><text x={24} y={10}>this card supplies</text>
        <line x1={0} y1={22} x2={18} y2={22} className="gx-ego-line gx-ego-in" strokeWidth={2} /><text x={24} y={26}>this card demands</text>
        <line x1={0} y1={38} x2={18} y2={38} className="gx-ego-line gx-ego-both" strokeWidth={2} /><text x={24} y={42}>both</text>
      </g>
    </svg>
  );
}
