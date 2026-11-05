import { useEffect, useState } from 'react';
import { api, type CardSummary } from '../api.js';
import { CardGrid } from '../components/CardGrid.js';

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
const COLOR_NAMES: Record<(typeof COLORS)[number], string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];
const LIMIT = 60;

export function CardBrowser() {
  const [qInput, setQInput] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [colors, setColors] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [cmcMin, setCmcMin] = useState<string>('');
  const [cmcMax, setCmcMax] = useState<string>('');
  const [rarity, setRarity] = useState('');
  const [includeRotated, setIncludeRotated] = useState(false);
  const [offset, setOffset] = useState(0);

  const [total, setTotal] = useState<number | null>(null);
  const [items, setItems] = useState<CardSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box 250ms. The offset reset is batched into the same
  // callback as the debounced value update (React batches both into one render),
  // so the fetch effect below never observes a stale (pre-reset) offset.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQDebounced(qInput);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (qDebounced.trim()) qs.set('q', qDebounced.trim());
    if (colors.size > 0) qs.set('colors', [...colors].join(','));
    if (types.size > 0) qs.set('types', [...types].join(','));
    if (cmcMin !== '') qs.set('cmcMin', cmcMin);
    if (cmcMax !== '') qs.set('cmcMax', cmcMax);
    if (rarity) qs.set('rarity', rarity);
    if (includeRotated) qs.set('includeRotated', 'true');
    qs.set('limit', String(LIMIT));
    qs.set('offset', String(offset));

    setLoading(true);
    setError(null);
    api
      .searchCards(qs)
      .then((res) => {
        if (cancelled) return;
        setTotal(res.total);
        setItems(res.items);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [qDebounced, colors, types, cmcMin, cmcMax, rarity, includeRotated, offset]);

  // Non-search filter changes reset pagination to page 1 in the same event/render
  // as the filter change itself, so the fetch effect above never runs with a
  // stale offset from before the reset.
  const toggleInSet = (set: Set<string>, setter: (s: Set<string>) => void, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
    setOffset(0);
  };

  const clearRarity = () => {
    setRarity('');
    setOffset(0);
  };
  const clearCmcMin = () => {
    setCmcMin('');
    setOffset(0);
  };
  const clearCmcMax = () => {
    setCmcMax('');
    setOffset(0);
  };
  const clearIncludeRotated = () => {
    setIncludeRotated(false);
    setOffset(0);
  };
  const clearSearch = () => {
    setQInput('');
    setQDebounced('');
    setOffset(0);
  };

  const hasAnyFilter =
    qDebounced.trim() !== '' ||
    colors.size > 0 ||
    types.size > 0 ||
    cmcMin !== '' ||
    cmcMax !== '' ||
    rarity !== '' ||
    includeRotated;

  const activeTags: { key: string; label: string; onRemove: () => void }[] = [];
  for (const c of COLORS) {
    if (colors.has(c)) {
      activeTags.push({ key: `color-${c}`, label: COLOR_NAMES[c], onRemove: () => toggleInSet(colors, setColors, c) });
    }
  }
  for (const t of TYPES) {
    if (types.has(t)) {
      activeTags.push({ key: `type-${t}`, label: t, onRemove: () => toggleInSet(types, setTypes, t) });
    }
  }
  if (rarity) activeTags.push({ key: 'rarity', label: rarity, onRemove: clearRarity });
  if (cmcMin !== '') activeTags.push({ key: 'cmcMin', label: `CMC ≥ ${cmcMin}`, onRemove: clearCmcMin });
  if (cmcMax !== '') activeTags.push({ key: 'cmcMax', label: `CMC ≤ ${cmcMax}`, onRemove: clearCmcMax });
  if (includeRotated) activeTags.push({ key: 'includeRotated', label: 'Include rotated', onRemove: clearIncludeRotated });
  if (qDebounced.trim() !== '') {
    activeTags.push({ key: 'q', label: `"${qDebounced.trim()}"`, onRemove: clearSearch });
  }

  const page = Math.floor(offset / LIMIT) + 1;
  const totalPages = total !== null && total > 0 ? Math.ceil(total / LIMIT) : null;

  return (
    <div className="card-browser">
      <h1 className="page-title">Cards</h1>
      <section className="filters" aria-label="Filters">
        <div className="filters-row">
          <label className="search-box">
            <span className="icon" aria-hidden="true">
              ⌕
            </span>
            <input
              type="search"
              placeholder="Search name or oracle text…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>

          <div className="fgroup">
            <span className="flabel">Colors</span>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`mana-toggle ${c.toLowerCase()}`}
                aria-pressed={colors.has(c)}
                title={COLOR_NAMES[c]}
                onClick={() => toggleInSet(colors, setColors, c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="fgroup">
            <span className="flabel">Rarity</span>
            <select
              className="select-input"
              value={rarity}
              onChange={(e) => {
                setRarity(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">any</option>
              {RARITIES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="filters-row">
          <div className="fgroup">
            <span className="flabel">Types</span>
            {TYPES.map((t) => (
              <label key={t} className={`type-chk${types.has(t) ? ' on' : ''}`}>
                <input type="checkbox" checked={types.has(t)} onChange={() => toggleInSet(types, setTypes, t)} />
                {t}
              </label>
            ))}
          </div>

          <div className="fgroup">
            <span className="flabel">CMC</span>
            <input
              className="num-input"
              type="number"
              min={0}
              placeholder="min"
              value={cmcMin}
              onChange={(e) => {
                setCmcMin(e.target.value);
                setOffset(0);
              }}
            />
            <span className="dash">–</span>
            <input
              className="num-input"
              type="number"
              min={0}
              placeholder="max"
              value={cmcMax}
              onChange={(e) => {
                setCmcMax(e.target.value);
                setOffset(0);
              }}
            />
          </div>

          <label className={`type-chk${includeRotated ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={includeRotated}
              onChange={(e) => {
                setIncludeRotated(e.target.checked);
                setOffset(0);
              }}
            />
            Include rotated
          </label>
        </div>
      </section>

      {error && <div className="error-block">Search failed: {error}</div>}

      <div className="result-header">
        <span className="result-count">
          {total === null ? '…' : <b>{total.toLocaleString()}</b>} cards
        </span>
        {totalPages !== null && (
          <span className="result-sub">
            page {page} of {totalPages}
          </span>
        )}
        {loading && <span className="muted">loading…</span>}
        {activeTags.length > 0 && (
          <div className="active-filters">
            {activeTags.map((tag) => (
              <span className="filter-tag" key={tag.key}>
                {tag.label}{' '}
                <button type="button" aria-label="remove" onClick={tag.onRemove}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {!loading && total === 0 ? (
        <div className="empty-state">
          {hasAnyFilter ? (
            <p>No results for this query.</p>
          ) : (
            <p>
              The pool is empty — run <code>npm run sync:cards</code>.
            </p>
          )}
        </div>
      ) : (
        <CardGrid items={items} />
      )}

      <nav className="pagination">
        <button type="button" className="page-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
          ← Prev
        </button>
        <span className="page-range">
          {total !== null && total > 0 ? `${offset + 1}–${Math.min(offset + LIMIT, total)} of ${total}` : null}
        </span>
        <button
          type="button"
          className="page-btn"
          disabled={total === null || offset + LIMIT >= total}
          onClick={() => setOffset(offset + LIMIT)}
        >
          Next →
        </button>
      </nav>
    </div>
  );
}
