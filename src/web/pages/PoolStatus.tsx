import { Fragment, useEffect, useState } from 'react';
import { api, type KeywordMapping } from '../api.js';
import { KeywordTable } from '../components/KeywordTable.js';

interface SnapshotRow {
  id: number;
  ingested_at: string;
  source_updated_at: string;
  printings_seen: number;
  cards_kept: number;
  status: string;
}

interface CorpusRow {
  effective_date: string;
}

interface PoolStatusData {
  pool: number;
  rotated: number;
  faces: number;
  queued: number;
  snapshots: SnapshotRow[];
  corpus: CorpusRow | null;
}

interface DiffRow {
  id: number;
  created_at: string;
  added_count: number;
  changed_count: number;
  rotated_count: number;
  returned_count: number;
}

type DiffChange = 'added' | 'oracle_changed' | 'rotated' | 'returned';

interface DiffEntryRow {
  oracle_id: string;
  change: DiffChange;
  old_oracle_hash: string | null;
  new_oracle_hash: string | null;
  name: string;
}

const CHANGE_ORDER: DiffChange[] = ['added', 'oracle_changed', 'rotated', 'returned'];

const GROUP_CLASS: Record<DiffChange, string> = {
  added: 'g-added',
  oracle_changed: 'g-changed',
  rotated: 'g-rotated',
  returned: 'g-returned',
};

const COUNT_CLASS: Record<DiffChange, string> = {
  added: 'count-added',
  oracle_changed: 'count-changed',
  rotated: 'count-rotated',
  returned: 'count-returned',
};

function truncateHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : '—';
}

function countCellClass(change: DiffChange, count: number): string {
  return `num count-cell ${count === 0 ? 'count-zero' : COUNT_CLASS[change]}`;
}

function statusPillClass(status: string): string {
  return status === 'complete' ? 'pill-ok' : 'pill-run';
}

export function PoolStatus({ anchorKeyword }: { anchorKeyword?: string }) {
  const [status, setStatus] = useState<PoolStatusData | null>(null);
  const [diffs, setDiffs] = useState<DiffRow[]>([]);
  const [expandedDiffId, setExpandedDiffId] = useState<number | null>(null);
  const [diffEntries, setDiffEntries] = useState<DiffEntryRow[]>([]);
  const [keywordCounts, setKeywordCounts] = useState<Record<string, number>>({});
  const [keywordItems, setKeywordItems] = useState<KeywordMapping[]>([]);
  const [loadingDiffEntries, setLoadingDiffEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .poolStatus()
      .then((res) => setStatus(res as PoolStatusData))
      .catch((e) => setError((e as Error).message));

    api
      .diffs()
      .then((res) => setDiffs(res.items as DiffRow[]))
      .catch((e) => setError((e as Error).message));

    api
      .keywords()
      .then((res) => {
        setKeywordCounts(res.counts);
        setKeywordItems(res.items);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const toggleDiff = (id: number) => {
    if (expandedDiffId === id) {
      setExpandedDiffId(null);
      setDiffEntries([]);
      return;
    }
    setExpandedDiffId(id);
    setLoadingDiffEntries(true);
    api
      .diff(id)
      .then((res) => setDiffEntries(res.entries as DiffEntryRow[]))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingDiffEntries(false));
  };

  const grouped = CHANGE_ORDER.map((change) => ({
    change,
    entries: diffEntries.filter((e) => e.change === change),
  })).filter((g) => g.entries.length > 0);

  const pendingAccent = (status?.queued ?? 0) > 0 ? 'accent-amber' : 'accent-muted';

  return (
    <div className="pool-status">
      <h1 className="page-title">Pool &amp; Rules</h1>

      {error && <div className="error-block">{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2>Pool</h2>
          <span className="rule"></span>
        </div>
        <div className="stat-row">
          <div className="stat-tile accent-gold">
            <div className="stat-num">{status?.pool ?? '…'}</div>
            <div className="stat-label">cards in pool</div>
          </div>
          <div className="stat-tile accent-muted">
            <div className="stat-num">{status?.rotated ?? '…'}</div>
            <div className="stat-label">rotated</div>
          </div>
          <div className="stat-tile accent-blue">
            <div className="stat-num">{status?.faces ?? '…'}</div>
            <div className="stat-label">faces</div>
          </div>
          <div className={`stat-tile ${pendingAccent}`}>
            <div className="stat-num">{status?.queued ?? '…'}</div>
            <div className="stat-label">pending extraction</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Snapshots</h2>
          <span className="count">{status?.snapshots.length ?? 0} ingests</span>
          <span className="rule"></span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>id</th>
                <th>ingested_at</th>
                <th>source_updated_at</th>
                <th style={{ textAlign: 'right' }}>printings_seen</th>
                <th style={{ textAlign: 'right' }}>cards_kept</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {(status?.snapshots ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td className="mono">{s.ingested_at}</td>
                  <td className="mono">{s.source_updated_at}</td>
                  <td className="num">{s.printings_seen}</td>
                  <td className="num">{s.cards_kept}</td>
                  <td>
                    <span className={`pill-status ${statusPillClass(s.status)}`}>{s.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Rotation diffs</h2>
          <span className="count">click a row to expand</span>
          <span className="rule"></span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>id</th>
                <th>created_at</th>
                <th style={{ textAlign: 'right' }}>added</th>
                <th style={{ textAlign: 'right' }}>changed</th>
                <th style={{ textAlign: 'right' }}>rotated</th>
                <th style={{ textAlign: 'right' }}>returned</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map((d) => (
                <Fragment key={d.id}>
                  <tr className={`diff-row${expandedDiffId === d.id ? ' open' : ''}`} onClick={() => toggleDiff(d.id)}>
                    <td className="mono">
                      <span className="expander">▶</span> {d.id}
                    </td>
                    <td className="mono">{d.created_at}</td>
                    <td className={countCellClass('added', d.added_count)}>{d.added_count}</td>
                    <td className={countCellClass('oracle_changed', d.changed_count)}>{d.changed_count}</td>
                    <td className={countCellClass('rotated', d.rotated_count)}>{d.rotated_count}</td>
                    <td className={countCellClass('returned', d.returned_count)}>{d.returned_count}</td>
                  </tr>
                  {expandedDiffId === d.id && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 14px 14px' }}>
                        <div className="diff-detail">
                          {loadingDiffEntries ? (
                            <p className="muted">loading…</p>
                          ) : (
                            grouped.map((g) => (
                              <div className={`diff-group ${GROUP_CLASS[g.change]}`} key={g.change}>
                                <h4>
                                  {g.change} · {g.entries.length}
                                </h4>
                                <ul>
                                  {g.entries.map((entry) => (
                                    <li key={entry.oracle_id}>
                                      <span data-card-id={entry.oracle_id}>{entry.name}</span>
                                      {entry.change === 'oracle_changed' && (
                                        <span className="hash">
                                          {' '}
                                          ({truncateHash(entry.old_oracle_hash)} → {truncateHash(entry.new_oracle_hash)})
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Keyword resolution</h2>
          <span className="count">{keywordItems.length} keywords</span>
          <span className="rule"></span>
        </div>
        <KeywordTable items={keywordItems} counts={keywordCounts} anchorKeyword={anchorKeyword} />
      </section>
    </div>
  );
}
