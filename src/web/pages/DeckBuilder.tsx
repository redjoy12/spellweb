import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type BuildChatView, type BuildDraft, type CardSummary, type DeckGoal, type DeckSummary } from '../api.js';
import { BuildChat } from '../components/BuildChat.js';
import { Icon } from '../components/Icon.js';
import { ManaCost } from '../components/ManaCost.js';

/**
 * The goal form (Phase 4 design sec. 4): colours, seed cards, excluded cards, target turn, interaction,
 * minimum creatures and the card rate switch (card rate plan Task 5), with the "must have" cards and
 * the "never" tags of the build chat (build chat design sec. 3 and 4). The build chat panel fills
 * the form during a talk, and a field that Claude changed has a mark. An owner change goes to the
 * talk as a note. The server checks each card ID again. Route `#/decks`; a new deck opens at
 * `#/decks/:id`.
 */

const COLOURS: Array<[DeckGoal['colours'], string]> = [['BR', 'Black and red'], ['B', 'Black'], ['R', 'Red']];
const INTERACTION: Array<[DeckGoal['interaction'], string]> = [['none', 'None'], ['some', 'Some'], ['heavy', 'Heavy']];
const TURNS = [4, 5, 6, 7, 8];
const MAX_SEEDS = 4;
const MAX_PINNED = 8;
const RESULTS = 12;
const SAVE_MS = 600;

const fits = (c: Pick<CardSummary, 'color_identity'>, colours: DeckGoal['colours']) => c.color_identity.every((x) => colours.includes(x));
const isLand = (c: Pick<CardSummary, 'type_line'>) => /\bLand\b/.test(c.type_line.split(' // ')[0]!);

interface Picked { oracle_id: string; name: string; color_identity: string[] }

/** The mark of a field that Claude changed in the talk. */
const ClaudeMark = () => <span className="bc-mark" title="Claude changed this field">Claude</span>;

function CardPicker({ label, hint, colours, picked, max, spells, marked, onChange }: {
  label: string; hint: string; colours: DeckGoal['colours']; picked: Picked[]; max?: number; spells: boolean; marked?: boolean; onChange: (p: Picked[]) => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setItems([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      api.searchCards(new URLSearchParams({ q: text, limit: '60' }))
        .then((r) => { if (live) { setItems(r.items); setError(null); } })
        .catch((err: Error) => { if (live) setError(err.message); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  const full = max !== undefined && picked.length >= max;
  const inputId = `pick-${label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')}`;
  const shown = items
    .filter((c) => c.arena_id !== null && fits(c, colours) && !picked.some((p) => p.oracle_id === c.oracle_id) && (!spells || !isLand(c)))
    .slice(0, RESULTS);

  return (
    <div className={`dk-field dk-field-wide${marked ? ' bc-marked' : ''}`}>
      <label className="dk-label" htmlFor={inputId}>{label}{marked && <ClaudeMark />}</label>
      <p className="muted dk-hint">{hint}</p>
      {picked.length > 0 && (
        <div className="dk-picked">
          {picked.map((p) => (
            <span key={p.oracle_id} className="filter-tag" data-card-id={p.oracle_id}>
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(picked.filter((x) => x.oracle_id !== p.oracle_id))}>×</button>
            </span>
          ))}
        </div>
      )}
      <input id={inputId} className="dk-input" type="search" autoComplete="off" disabled={full}
        placeholder={full ? `${max} cards is the limit` : 'Type a card name or card text'} value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error-inline">{error}</p>}
      {!full && shown.length > 0 && (
        <ul className="dk-results">
          {shown.map((c) => (
            <li key={c.oracle_id}>
              <button type="button" className="dk-result" data-card-id={c.oracle_id} onClick={() => {
                onChange([...picked, { oracle_id: c.oracle_id, name: c.name, color_identity: c.color_identity }]);
                setQ('');
              }}>
                <span className="dk-result-name">{c.name}</span>
                <ManaCost cost={c.mana_cost} />
                <span className="muted dk-result-type">{c.type_line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && q.trim().length >= 2 && shown.length === 0 && items.length > 0 && <p className="muted">No card here fits the colours, or it is not on Arena.</p>}
    </div>
  );
}

function TagPicker({ picked, marked, onChange }: { picked: string[]; marked: boolean; onChange: (t: string[]) => void }) {
  const [tags, setTags] = useState<Array<{ tag: string; label: string }>>([]);
  const [q, setQ] = useState('');
  useEffect(() => { api.buildTags().then((r) => setTags(r.tags)).catch(() => setTags([])); }, []);
  const label = (t: string) => tags.find((x) => x.tag === t)?.label ?? t;
  const add = (raw: string) => {
    const t = raw.trim().split(' ')[0]!;
    if (tags.some((x) => x.tag === t) && !picked.includes(t)) onChange([...picked, t]);
    setQ('');
  };
  return (
    <div className={`dk-field dk-field-wide${marked ? ' bc-marked' : ''}`}>
      <label className="dk-label" htmlFor="dk-never-tags">Never tags{marked && <ClaudeMark />}</label>
      <p className="muted dk-hint">A card with one of these tags stays out, unless it is a seed or a "must have" card.</p>
      {picked.length > 0 && (
        <div className="dk-picked">
          {picked.map((t) => (
            <span key={t} className="filter-tag" title={t}>
              {label(t)}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(picked.filter((x) => x !== t))}>×</button>
            </span>
          ))}
        </div>
      )}
      <input id="dk-never-tags" className="dk-input" list="dk-tag-list" autoComplete="off" placeholder="Type a tag, for example discard" value={q}
        onChange={(e) => {
          const v = e.target.value;
          if (tags.some((x) => `${x.tag} ${x.label}` === v)) add(v);
          else setQ(v);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(q); } }} />
      <datalist id="dk-tag-list">{tags.map((t) => <option key={t.tag} value={`${t.tag} ${t.label}`} />)}</datalist>
    </div>
  );
}

function SavedDecks() {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  useEffect(() => { api.decks().then((r) => setDecks(r.decks)).catch(() => setDecks([])); }, []);
  if (!decks || decks.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Saved decks</h2><span className="count">{decks.length}</span></div>
      <ul className="dk-saved">
        {decks.map((d) => (
          <li key={d.id}>
            <a href={`#/decks/${d.id}`}>{d.seeds.length === 0 ? `Deck ${d.id}, no seed cards` : d.seeds.map((s, i) => <Fragment key={s}>{i > 0 && ', '}<span data-card-name={s}>{s}</span></Fragment>)}</a>
            <span className="muted"> · {d.colours} · turn {d.target_turn} · {d.land_count} lands · {d.warnings} warning{d.warnings === 1 ? '' : 's'} · card rate {d.use_rate ? 'on' : 'off'} · graph build {d.build_id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The form on the page. Each card list has the names, so the form can show them. */
interface Form {
  colours: DeckGoal['colours']; seeds: Picked[]; pinned: Picked[]; excluded: Picked[]; excluded_tags: string[];
  target_turn: number; interaction: DeckGoal['interaction']; min_creatures: number; use_rate: boolean;
}
type Field = keyof Form | 'brief';

const START: Form = { colours: 'BR', seeds: [], pinned: [], excluded: [], excluded_tags: [], target_turn: 6, interaction: 'some', min_creatures: 14, use_rate: false };

const goalOf = (f: Form): DeckGoal => ({
  colours: f.colours, seeds: f.seeds.map((s) => s.oracle_id), pinned: f.pinned.map((s) => s.oracle_id), excluded: f.excluded.map((s) => s.oracle_id),
  excluded_tags: f.excluded_tags, target_turn: f.target_turn, interaction: f.interaction, min_creatures: f.min_creatures, use_rate: f.use_rate,
});
const formOf = (d: BuildDraft): Form => ({ ...d });
const sameGoal = (a: DeckGoal, b: DeckGoal) => JSON.stringify(a) === JSON.stringify(b);

/** The fields that differ between two forms. */
function changedFields(a: Form, b: Form): Field[] {
  const ga = goalOf(a) as unknown as Record<string, unknown>;
  const gb = goalOf(b) as unknown as Record<string, unknown>;
  return (Object.keys(ga) as Field[]).filter((k) => JSON.stringify(ga[k]) !== JSON.stringify(gb[k]));
}

export function DeckBuilder() {
  const [form, setForm] = useState<Form>(START);
  const [brief, setBrief] = useState('');
  const [talk, setTalk] = useState<BuildChatView | null>(null);
  const [marked, setMarked] = useState<Set<Field>>(new Set());
  const [rateReady, setRateReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The draft that the server holds, as the page knows it. A new draft from the server goes into the form. */
  const server = useRef<{ goal: DeckGoal; brief: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const briefRef = useRef(brief);
  briefRef.current = brief;

  useEffect(() => { api.rateStatus().then((r) => setRateReady(r.ready)).catch(() => setRateReady(false)); }, []);

  /** A talk from the server. A draft that Claude changed goes into the form, with a mark on each changed field. */
  const takeTalk = useCallback((t: BuildChatView) => {
    setTalk(t);
    const goal = goalOf(formOf(t.draft));
    const known = server.current;
    if (known && sameGoal(known.goal, goal) && known.brief === t.brief) return;
    server.current = { goal, brief: t.brief };
    // An owner change that waits to save wins: its save sends the whole form.
    if (saveTimer.current) return;
    const next = formOf(t.draft);
    if (known) {
      const fields = changedFields(formRef.current, next);
      if (briefRef.current !== t.brief) fields.push('brief');
      if (fields.length > 0) setMarked((m) => new Set([...m, ...fields]));
    }
    setForm(next);
    setBrief(t.brief);
  }, []);

  // The newest open talk comes back after a reload.
  useEffect(() => {
    api.buildChats().then((r) => {
      const open = r.talks.find((x) => x.deck_id === null);
      return open ? api.buildChat(open.id).then(takeTalk) : undefined;
    }).catch(() => undefined);
  }, [takeTalk]);

  /** The owner changed the form or the brief. With a talk open, the change saves after a short wait. */
  const ownerChange = (next: Form, nextBrief: string, fields: Field[]) => {
    setForm(next);
    setBrief(nextBrief);
    formRef.current = next;
    briefRef.current = nextBrief;
    setMarked((m) => new Set([...m].filter((f) => !fields.includes(f))));
    if (!talk || talk.deck_id !== null) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = talk.id;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const goal = goalOf(formRef.current);
      server.current = { goal, brief: briefRef.current };
      api.saveBuildDraft(id, goal, briefRef.current).then(takeTalk).catch((err: Error) => setError(err.message));
    }, SAVE_MS);
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => ownerChange({ ...form, [k]: v }, brief, [k]);

  const changeColours = (c: DeckGoal['colours']) => ownerChange(
    { ...form, colours: c, seeds: form.seeds.filter((x) => fits(x, c)), pinned: form.pinned.filter((x) => fits(x, c)) }, brief, ['colours', 'seeds', 'pinned'],
  );

  const startTalk = () => api.newBuildChat(goalOf(form)).then((t) => {
    server.current = { goal: goalOf(formOf(t.draft)), brief: t.brief };
    setTalk(t);
    return t;
  });
  const newTalk = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setTalk(null);
    setMarked(new Set());
    setBrief('');
    server.current = null;
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    const open = talk && talk.deck_id === null ? talk.id : undefined;
    // A change that waits to save goes first, so the stored brief is the one on the page.
    let flush: Promise<unknown> = Promise.resolve();
    if (saveTimer.current && open !== undefined) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      flush = api.saveBuildDraft(open, goalOf(form), brief);
    }
    flush.then(() => api.makeDeck({ ...goalOf(form), ...(open !== undefined ? { build_chat_id: open } : {}) }))
      .then((r) => { window.location.hash = `#/decks/${r.id}`; })
      .catch((err: Error) => { setError(err.message); setBusy(false); });
  };

  const fieldClass = (f: Field) => `dk-field${marked.has(f) ? ' bc-marked' : ''}`;
  const label = (f: Field, text: string, htmlFor: string) => <label className="dk-label" htmlFor={htmlFor}>{text}{marked.has(f) && <ClaudeMark />}</label>;

  return (
    <div className="dk">
      <div className="page-head">
        <div>
          <h1 className="page-title">Build a deck</h1>
          <p className="page-sub">Describe the deck to Claude, or fill the form yourself. The search builds the deck from the form and the card links, and each card shows why it is there.</p>
        </div>
      </div>
      <div className="dk-layout">
        <form className="panel dk-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className={fieldClass('colours')}>
            {label('colours', 'Colours', 'dk-colours')}
            <select id="dk-colours" className="dk-input" value={form.colours} onChange={(e) => changeColours(e.target.value as DeckGoal['colours'])}>
              {COLOURS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className={fieldClass('target_turn')}>
            {label('target_turn', 'Target turn', 'dk-turn')}
            <select id="dk-turn" className="dk-input" value={form.target_turn} onChange={(e) => set('target_turn', Number(e.target.value))}>
              {TURNS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <p className="muted dk-hint">A card with a higher mana value stays out, unless it is a seed or a "must have" card.</p>
          </div>
          <div className={fieldClass('interaction')}>
            {label('interaction', 'Interaction', 'dk-interaction')}
            <select id="dk-interaction" className="dk-input" value={form.interaction} onChange={(e) => set('interaction', e.target.value as DeckGoal['interaction'])}>
              {INTERACTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className={fieldClass('min_creatures')}>
            {label('min_creatures', 'Minimum creatures', 'dk-creatures')}
            <input id="dk-creatures" className="dk-input" type="number" min={0} max={30} value={form.min_creatures}
              onChange={(e) => set('min_creatures', Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
          </div>
          <CardPicker label="Seed cards (optional)" hint="Up to 4 spells. The deck has at least 1 copy of each, and the search builds the deck around them. The search sets the copies from the links." colours={form.colours} picked={form.seeds} max={MAX_SEEDS} spells marked={marked.has('seeds')} onChange={(p) => set('seeds', p)} />
          <CardPicker label="Must have cards" hint="Up to 8 spells. Each one is in the deck, with at least 1 copy. Its links count as usual." colours={form.colours} picked={form.pinned} max={MAX_PINNED} spells marked={marked.has('pinned')} onChange={(p) => set('pinned', p)} />
          <CardPicker label="Excluded cards" hint="The search does not use these cards." colours={form.colours} picked={form.excluded} spells={false} marked={marked.has('excluded')} onChange={(p) => set('excluded', p)} />
          <TagPicker picked={form.excluded_tags} marked={marked.has('excluded_tags')} onChange={(t) => set('excluded_tags', t)} />
          <div className="dk-field dk-field-wide">
            <label className="dk-label dk-check">
              <input type="checkbox" checked={form.use_rate} disabled={!rateReady} onChange={(e) => set('use_rate', e.target.checked)} />
              Card rate
            </label>
            <p className="muted dk-hint">{rateReady === false ? 'Run npm run rate-fit' : 'The value comes from card text. It is not a win rate. The switch is off by default.'}</p>
          </div>
          {talk && (
            <div className={`${fieldClass('brief')} bc-brief`}>
              {label('brief', 'Brief', 'dk-brief')}
              <p className="muted dk-hint">The plan in words. Claude writes it, and you can change it. The deck chat reads it after the build. The search does not read it.</p>
              <textarea id="dk-brief" className="dk-input" rows={4} dir="auto" value={brief} disabled={talk.deck_id !== null}
                onChange={(e) => ownerChange(form, e.target.value, ['brief'])} />
            </div>
          )}
          <div className="dk-submit">
            <button type="submit" className="btn btn-primary" disabled={busy || talk?.running === true}><Icon name="deck" />{busy ? 'Building…' : 'Build the deck'}</button>
            {busy && <span className="muted">The first deck after a server start takes about 30 seconds.</span>}
            {!busy && talk?.running && <span className="muted">Wait until Claude stops working.</span>}
            {!busy && !talk?.running && form.seeds.length === 0 && form.pinned.length === 0 && <span className="muted">With no seed card, the search starts at the card with the highest link score.</span>}
          </div>
          {error && <div className="error-block dk-field-wide">{error}</div>}
        </form>
        <BuildChat talk={talk} onTalk={takeTalk} start={startTalk} onNew={newTalk} />
      </div>
      <SavedDecks />
    </div>
  );
}
