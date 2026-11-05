import { useEffect, useState } from 'react';
import type { KeywordMapping } from '../api.js';

type ResolutionFilter = 'all' | KeywordMapping['resolution'];

const RESOLUTIONS: KeywordMapping['resolution'][] = [
  'subsection_title',
  'glossary_crossref',
  'ability_word_no_rule',
  'unresolved',
];

const BUCKET_CLASS: Record<KeywordMapping['resolution'], string> = {
  subsection_title: 'b-title',
  glossary_crossref: 'b-glossary',
  ability_word_no_rule: 'b-ability',
  unresolved: 'b-unres',
};

const BUCKET_DOT: Record<KeywordMapping['resolution'], string> = {
  subsection_title: 'var(--res-title)',
  glossary_crossref: 'var(--res-glossary)',
  ability_word_no_rule: 'var(--res-ability)',
  unresolved: 'var(--res-unresolved)',
};

const RES_TAG_CLASS: Record<KeywordMapping['resolution'], string> = {
  subsection_title: 'res-title',
  glossary_crossref: 'res-glossary',
  ability_word_no_rule: 'res-ability',
  unresolved: 'res-unres',
};

export function KeywordTable({
  items,
  counts,
  anchorKeyword,
}: {
  items: KeywordMapping[];
  counts: Record<string, number>;
  anchorKeyword?: string;
}) {
  const [filter, setFilter] = useState<ResolutionFilter>(() => (anchorKeyword ? 'all' : 'unresolved'));

  useEffect(() => {
    if (!anchorKeyword) return;
    setFilter('all');
  }, [anchorKeyword]);

  useEffect(() => {
    if (!anchorKeyword) return;
    const el = document.getElementById(`kw-${anchorKeyword}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [anchorKeyword, filter, items]);

  const filtered = items.filter((i) => filter === 'all' || i.resolution === filter);

  return (
    <div className="keyword-table">
      <div className="bucket-row">
        {RESOLUTIONS.map((r) => (
          <div
            key={r}
            className={`bucket ${BUCKET_CLASS[r]}${filter === r ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => setFilter(filter === r ? 'all' : r)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setFilter(filter === r ? 'all' : r);
              }
            }}
          >
            <div className="b-top">
              <i style={{ background: BUCKET_DOT[r] }}></i>
              <span className="b-name">{r}</span>
            </div>
            <div className="b-num">{counts[r] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="kw-toolbar">
        <span className="note">Ability words having no rule section is the correct outcome, not a defect.</span>
        <label className="filter">
          Filter:{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as ResolutionFilter)}>
            <option value="all">all</option>
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>keyword</th>
              <th>resolution</th>
              <th>rule_number</th>
              <th>evidence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr
                id={`kw-${item.keyword_key}`}
                key={item.keyword_key}
                className={item.keyword_key === anchorKeyword ? 'highlight' : undefined}
              >
                <td style={{ color: 'var(--fg)', fontWeight: 600 }}>{item.keyword}</td>
                <td>
                  <span className={`res-tag ${RES_TAG_CLASS[item.resolution]}`}>{item.resolution}</span>
                </td>
                <td className="mono">{item.rule_number ?? '—'}</td>
                <td className="evidence">{item.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
