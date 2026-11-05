import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DraftDetail, type QueueEntry, type QueueResponse } from '../api.js';
import { DraftReview } from '../components/DraftReview.js';

/**
 * The golden-set adjudication queue (plan Task 6 Step 5, amended).
 *
 * This page exists to decouple drafting from reviewing. Before it, the drafter
 * could not run ahead of the owner: every card was a round trip through the
 * terminal. Here the drafter fills `data/golden-drafts/` at its own pace and the
 * owner drains the `drafted` bucket at theirs.
 *
 * What it deliberately does NOT have is an "accept all" button. Accepting is a
 * per-card claim about a reading — and, with `complete`, a claim about coverage
 * that sec. 8.2's precision metric depends on. One click standing for fifty of
 * those claims would reproduce, in the UI, exactly the rubber-stamping the read
 * gate and the rationale requirement exist to prevent.
 */

const STAGE_ORDER = ['drafted', 'rejected', 'accepted', 'packet', 'not-started'] as const;
type Filter = (typeof STAGE_ORDER)[number] | 'all';

function StageDot({ stage }: { stage: QueueEntry['stage'] }) {
  const cls =
    stage === 'accepted' ? 'gq-dot-accepted'
    : stage === 'rejected' ? 'gq-dot-rejected'
    : stage === 'drafted' ? 'gq-dot-drafted'
    : 'gq-dot-idle';
  return <span className={`gq-dot ${cls}`} title={stage} />;
}

export function GoldenQueue() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [filter, setFilter] = useState<Filter>('drafted');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.goldenQueue());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const visible = useMemo(() => {
    const items = queue?.items ?? [];
    const filtered = filter === 'all' ? items : items.filter((i) => i.stage === filter);
    // Cards that need a decision first, then by name: the queue is a worklist.
    return [...filtered].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.name.localeCompare(b.name),
    );
  }, [queue, filter]);

  // Select the first reviewable card once, on load, so the page opens on work.
  useEffect(() => {
    if (selected === null && visible.length > 0) setSelected(visible[0]!.oracle_id);
  }, [visible, selected]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setLoadingDetail(true);
    setDetail(null);
    api
      .goldenDraft(selected)
      .then((d) => { setDetail(d); setError(null); })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingDetail(false));
  }, [selected]);

  /** After a decision: refresh the ledger and move to the next card still awaiting one. */
  const afterDecision = useCallback(async () => {
    const fresh = await api.goldenQueue().catch(() => null);
    if (fresh) setQueue(fresh);
    const pending = (fresh?.items ?? []).filter((i) => i.stage === 'drafted' && i.oracle_id !== selected);
    setSelected(pending[0]?.oracle_id ?? null);
  }, [selected]);

  // j/k walk the visible list. Kept here rather than in the review pane because
  // it is navigation, not adjudication.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = visible.findIndex((v) => v.oracle_id === selected);
      const next = e.key === 'j' ? Math.min(i + 1, visible.length - 1) : Math.max(i - 1, 0);
      if (visible[next]) setSelected(visible[next]!.oracle_id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected]);

  const counts = queue?.counts;

  return (
    <div className="gq">
      <div className="gq-header">
        <h1 className="page-title">Golden set — adjudication</h1>
        <div className="header-status">
          {counts && STAGE_ORDER.map((s) => (
            <button
              key={s}
              className={`status-pill gq-filter${filter === s ? ' active' : ''}`}
              onClick={() => { setFilter(s); setSelected(null); }}
            >
              {s} <b>{counts[s]}</b>
            </button>
          ))}
          <button
            className={`status-pill gq-filter${filter === 'all' ? ' active' : ''}`}
            onClick={() => { setFilter('all'); setSelected(null); }}
          >
            all <b>{queue?.candidates ?? 0}</b>
          </button>
          {queue && (
            <span className="status-pill" title="rows in golden_cards; the second number is those you marked complete">
              in DB <b>{queue.written.total}</b> / complete <b>{queue.written.complete}</b>
            </span>
          )}
        </div>
      </div>

      {error && <div className="error-block">{error}</div>}

      <div className="gq-body">
        <aside className="gq-list">
          {visible.length === 0 && <p className="muted empty-state">Nothing in this bucket.</p>}
          {visible.map((item) => (
            <button
              key={item.oracle_id}
              className={`gq-item${selected === item.oracle_id ? ' selected' : ''}`}
              onClick={() => setSelected(item.oracle_id)}
            >
              <div className="gq-item-top">
                <StageDot stage={item.stage} />
                <span className="gq-item-name" data-card-id={item.oracle_id}>{item.name}</span>
              </div>
              <div className="gq-item-meta muted">
                {item.stage === 'drafted' ? (
                  <>
                    {item.atoms}a
                    {item.unclassified > 0 && ` · ${item.unclassified}u`}
                    {item.errors > 0 && <span className="gq-flag gq-flag-err"> {item.errors} err</span>}
                    {item.warnings > 0 && <span className="gq-flag gq-flag-warn"> {item.warnings} warn</span>}
                    {item.has_notes && <span className="gq-flag gq-flag-note"> note</span>}
                  </>
                ) : (
                  item.stage
                )}
              </div>
            </button>
          ))}
        </aside>

        <main className="gq-pane">
          {loadingDetail && <p className="muted">loading…</p>}
          {!loadingDetail && !detail && (
            <p className="muted empty-state">
              {visible.length === 0 && filter === 'drafted'
                ? 'No drafts awaiting a decision. The drafter fills this queue with `npm run golden:draft`.'
                : 'Select a card.'}
            </p>
          )}
          {detail && <DraftReview key={detail.oracle_id} detail={detail} onDecided={() => void afterDecision()} />}
        </main>
      </div>
    </div>
  );
}
