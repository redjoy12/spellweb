import { useEffect, useState } from 'react';
import {
  api, type CardFace, type CardSummary, type KeywordMapping, type AtomsResponse, type QueueFinding,
} from '../api.js';
import { PacketView } from '../components/PacketView.js';
import { AtomSpans, type AtomSelection } from '../components/AtomSpans.js';
import { AtomDetail } from '../components/AtomDetail.js';
import { IdentityPips, ManaCost } from '../components/ManaCost.js';
import { getArtClass } from '../lib/cardArt.js';

/**
 * `GET /api/cards/:id` selects `SELECT * FROM cards`, which includes `arena_id` and
 * `oracle_text` — but api.ts's declared return type only adds `oracle_text` to
 * `CardSummary`. Widening locally here (not touching api.ts) to consume the field the
 * server actually sends.
 */
interface CardDetailData extends CardSummary {
  oracle_text: string | null;
  arena_id: number | null;
}

const RARITY_DOT: Record<string, string> = {
  common: 'rarity-common',
  uncommon: 'rarity-uncommon',
  rare: 'rarity-rare',
  mythic: 'rarity-mythic',
};

function normalizeKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function KeywordChip({ keyword, mapping }: { keyword: string; mapping: KeywordMapping | undefined }) {
  if (!mapping) return <span className="chip chip-neutral">{keyword}</span>;

  switch (mapping.resolution) {
    case 'subsection_title':
      return (
        <a className="chip chip-resolved" href={`#/pool?keyword=${encodeURIComponent(mapping.keyword_key)}`}>
          {keyword} <span className="rn">{mapping.rule_number}</span>
        </a>
      );
    case 'glossary_crossref':
      return (
        <a className="chip chip-glossary" href={`#/pool?keyword=${encodeURIComponent(mapping.keyword_key)}`}>
          {keyword} <span className="rn">{mapping.rule_number}</span>
        </a>
      );
    case 'ability_word_no_rule':
      return (
        <span className="chip chip-ability" title="ability word — no rules meaning">
          {keyword}
        </span>
      );
    case 'unresolved':
      return (
        <span className="chip chip-unresolved" title="no rule section found — see Pool & Rules">
          {keyword}
        </span>
      );
  }
}

const SEVERITY_LABEL: Record<QueueFinding['severity'], string> = {
  coverage_miss: 'Coverage miss',
  missing_rule: 'Missing rule',
  vote_disagreement: 'Vote disagreement',
  unclassified: 'Unclassified clause',
  splitter_disagreement: 'Splitter disagreement',
};

export function CardDetail({ oracleId, findingId }: { oracleId: string; findingId?: number }) {
  const [card, setCard] = useState<CardDetailData | null>(null);
  const [faces, setFaces] = useState<CardFace[]>([]);
  const [keywordMap, setKeywordMap] = useState<Map<string, KeywordMapping>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [atomsRes, setAtomsRes] = useState<AtomsResponse | null>(null);
  const [atomsError, setAtomsError] = useState<string | null>(null);
  const [selection, setSelection] = useState<AtomSelection | null>(null);
  const [finding, setFinding] = useState<QueueFinding | null>(null);

  // A review-queue deep link (sec. 11.2): name the finding and outline its spans. A finding
  // for a different card (a hand-edited URL) is ignored rather than drawn over this one.
  useEffect(() => {
    setFinding(null);
    if (findingId === undefined) return;
    api.finding(findingId)
      .then((f) => setFinding(f.oracle_id === oracleId ? f : null))
      .catch(() => setFinding(null));
  }, [oracleId, findingId]);

  useEffect(() => {
    setCard(null);
    setFaces([]);
    setError(null);
    api
      .card(oracleId)
      .then((res) => {
        setCard(res.card as CardDetailData);
        setFaces(res.faces);
      })
      .catch((e) => setError((e as Error).message));
  }, [oracleId]);

  useEffect(() => {
    // Reset the inspector state for every card, then fetch its atoms/clauses. The
    // payload is correct with zero atoms in the DB (on-the-fly clause splitting),
    // so this panel ships before any extraction has run. A fetch failure is surfaced
    // via atomsError so a server hiccup is distinguishable from "no atoms yet".
    setAtomsRes(null);
    setAtomsError(null);
    setSelection(null);
    api
      .atoms(oracleId)
      .then((res) => { setAtomsRes(res); setAtomsError(null); })
      .catch((e) => { setAtomsRes(null); setAtomsError((e as Error).message); });
  }, [oracleId]);

  useEffect(() => {
    api
      .keywords()
      .then((res) => {
        setKeywordMap(new Map(res.items.map((item) => [normalizeKey(item.keyword_key), item])));
      })
      .catch(() => setKeywordMap(new Map()));
  }, []);

  if (error) return <div className="error-block">Failed to load card: {error}</div>;
  if (!card) return <p className="muted">Loading card…</p>;

  const rarityDotClass = RARITY_DOT[card.rarity] ?? 'rarity-common';

  return (
    <div className="card-detail">
      <div className="breadcrumb">
        <a href="#/cards">Cards</a>
        <span className="sep">›</span>
        <span data-card-id={card.oracle_id}>{card.name}</span>
      </div>

      <div className="detail-grid">
        <div className="card-figure">
          <div className="card-image">
            {card.image_normal ? (
              <img src={card.image_normal} alt={card.name} data-card-id={card.oracle_id} />
            ) : (
              <div className={`card-image-fallback ${getArtClass(card.color_identity)}`}>
                <span className="frame-note">no card art available</span>
              </div>
            )}
          </div>
        </div>

        <div className="detail-main">
          <h1 className="detail-title">
            <span data-card-id={card.oracle_id}>{card.name}</span>
            {card.rotated === 1 && <span className="badge-rotated">ROTATED</span>}
          </h1>

          <div className="meta-strip">
            <div className="meta-item">
              <span className="meta-k">Set · No.</span>
              <span className="meta-v mono">
                {card.set_code.toUpperCase()} #{card.collector_number}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-k">Rarity</span>
              <span className="meta-v">
                <span className={`rarity-dot ${rarityDotClass}`}></span>
                {card.rarity}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-k">Mana cost</span>
              <span className="meta-v">{card.mana_cost ? <ManaCost cost={card.mana_cost} /> : '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-k">CMC</span>
              <span className="meta-v mono">{card.cmc}</span>
            </div>
            <div className="meta-item">
              <span className="meta-k">Identity</span>
              <span className="meta-v">
                <IdentityPips identity={card.color_identity} />
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-k">Arena id</span>
              <span className="meta-v mono">
                {card.arena_id !== null ? card.arena_id : <span className="muted">no arena_id</span>}
              </span>
            </div>
          </div>

          <div className="section-head">
            <h2>Faces</h2>
            <span className="rule"></span>
          </div>

          {faces.map((face) => (
            <section className="face" key={face.face_index}>
              <div className="face-index">Face {face.face_index}</div>
              <div className="face-titlerow">
                <span className="face-name" data-card-id={card.oracle_id}>{face.name}</span>
                <ManaCost cost={face.mana_cost} />
                <span className="face-type">{face.type_line}</span>
                {(face.power !== null || face.toughness !== null) && (
                  <span className="face-pt">
                    {face.power ?? '—'} / {face.toughness ?? '—'}
                  </span>
                )}
              </div>
              <pre className="face-text">{face.oracle_text}</pre>
            </section>
          ))}

          <div className="section-head">
            <h2>Keywords</h2>
            <span className="rule"></span>
          </div>

          {card.keywords.length === 0 ? (
            <p className="muted">No keywords.</p>
          ) : (
            <>
              <div className="chips">
                {card.keywords.map((kw) => (
                  <KeywordChip key={kw} keyword={kw} mapping={keywordMap.get(normalizeKey(kw))} />
                ))}
              </div>
              <div className="chips-legend">
                <span>
                  <i style={{ background: 'var(--res-title)' }}></i> resolved · rule section
                </span>
                <span>
                  <i style={{ background: 'var(--res-glossary)' }}></i> resolved · glossary
                </span>
                <span>
                  <i style={{ background: 'var(--res-ability)' }}></i> ability word · no rule
                </span>
                <span>
                  <i style={{ background: 'var(--res-unresolved)' }}></i> unresolved
                </span>
              </div>
            </>
          )}

          <div className="section-head">
            <h2>Atoms</h2>
            <span className="rule"></span>
          </div>

          <section className="atoms-panel">
            {finding && (
              <div className={`finding-callout finding-callout--${finding.severity}`} id="finding">
                <div className="finding-callout-head">
                  <span className="finding-sev">{SEVERITY_LABEL[finding.severity]}</span>
                  <span className="muted">run {finding.run_id} · {finding.status}</span>
                  <a className="finding-back" href={`#/review?finding=${finding.id}`}>back to the review queue</a>
                </div>
                <div className="finding-summary">{finding.summary}</div>
                {finding.focus.length > 0 && (
                  <div className="muted finding-hint">The outlined text below is what this finding is about.</div>
                )}
              </div>
            )}
            {atomsError && (
              <div className="error-block">Couldn't load atoms: {atomsError}</div>
            )}
            {atomsRes && atomsRes.coverage === null && (
              <div className="atom-empty">
                This card has not been extracted yet — clauses are split on the fly from
                the oracle text, but no atoms exist because no extraction run has covered
                this card. Every non-reminder clause is shown as an uncovered finding below.
              </div>
            )}

            {atomsRes && atomsRes.faces.map((face) => (
              <div className="atoms-face" key={face.face_index}>
                <div className="atoms-face-head">
                  <span className="atoms-face-index">Face {face.face_index}</span>
                  <span className="muted atoms-face-counts">
                    {face.clauses.length} clauses · {face.atoms.length} atoms
                    {face.unclassified.length > 0 && ` · ${face.unclassified.length} unclassified`}
                    {face.missingRules.length > 0 && ` · ${face.missingRules.length} missing-rule reports`}
                  </span>
                </div>
                <AtomSpans face={face} onSelect={setSelection} focus={finding?.focus} />
              </div>
            ))}

            {selection?.kind === 'atom' && (
              <AtomDetail
                atom={
                  atomsRes?.faces.flatMap((f) => f.atoms).find((a) => a.id === selection.id) ?? null
                }
              />
            )}
            {selection?.kind === 'clause' && (
              <div className="atom-detail atom-detail--clause">
                <div className="ad-row">
                  <span className="ad-k">clause</span>
                  <span className="ad-v">
                    Face {selection.faceIndex} · clause {selection.clauseIndex}
                  </span>
                </div>
                <p className="muted">
                  Uncovered — no atom covers this clause. This is a coverage finding, not an
                  absence: the card has either not been extracted or no extractor agreed on a
                  label for this span.
                </p>
              </div>
            )}
          </section>

          <div className="section-head">
            <h2>Rules packet</h2>
            <span className="rule"></span>
          </div>

          <PacketView oracleId={oracleId} />
        </div>
      </div>
    </div>
  );
}
