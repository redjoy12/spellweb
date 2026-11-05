import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type DeckCardView, type DeckGames, type DeckView, type DeckWarning, type GameView, type LinkView } from '../api.js';
import { GradePill } from '../components/EdgeRow.js';
import { DeckChat, Named } from '../components/DeckChat.js';
import { Icon } from '../components/Icon.js';
import { ManaCost } from '../components/ManaCost.js';

/**
 * One deck (Phase 4 design sec. 9): the 60 cards by mana value, the land count, the colour sources
 * and the warnings. A deck with the card rate on shows the value of each spell, as stored with the
 * deck. Each spell opens to its role and its top links. The false link button writes to
 * `edge_reports`, as the graph explorer does. The weak link button writes an owner answer, which
 * the next deck reads. The server sends the marks with the deck, so they stay after a reload. A
 * link shows under both of its cards, so the page reads the deck again after each mark. The copy
 * button copies the import text. The chat panel and the comment of each card come from the deck
 * chat design: Claude reads a new comment with the next message. The Games panel comes from the game
 * review design: it reads the games again each 30 seconds, and its button sends a message to the
 * chat. Route `#/decks/:id`.
 */

const ROLE_TEXT: Record<DeckCardView['role'], string> = {
  seed: 'The goal asked for this card.',
  pin: 'The goal says that the deck must have this card.',
  quota: 'A quota of the goal chose this card by its links.',
  link: 'The search chose this card by its links.',
  swap: 'You chose this card in a swap.',
  land: 'The mana base chose this land.',
};
const WARNING_TEXT: Record<DeckWarning['kind'], string> = { quota: 'Goal', mana: 'Mana', no_link: 'No link', anti_link: 'Bad together' };
const WARNING_ORDER: Array<DeckWarning['kind']> = ['quota', 'mana', 'no_link', 'anti_link'];
const RATE_HINT = 'The value comes from card text. It is not a win rate.';
const COMMENT_PAUSE_MS = 700;
const GAMES_POLL_MS = 30_000;
const RESULT_TEXT: Record<GameView['result'], string> = { win: 'Win', loss: 'Loss', draw: 'Draw' };

/** The card rate of a spell. "no value" and "no group" are not a low rate. */
function rateText(r: NonNullable<DeckCardView['rate']>): string {
  if (r.rate === null) return 'no value';
  if (r.reason === 'no_group') return 'no group';
  return r.rate === 0 ? 'rate 0' : `rate ${r.rate > 0 ? '+' : ''}${r.rate.toFixed(1)}`;
}

function LinkRow({ link, self, names, buildId, deckId, onMarked }: {
  link: LinkView; self: DeckCardView; names: Map<string, string>; buildId: number; deckId: number; onMarked: () => Promise<void>;
}) {
  const [open, setOpen] = useState<'false' | 'weak' | null>(null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const other = names.get(link.other) ?? link.other;
  const [supply, demand] = link.direction === 'gives' ? [self, { oracle_id: link.other, name: other }] : [{ oracle_id: link.other, name: other }, self];

  const act = (job: Promise<unknown>) => {
    setState({ busy: true, error: null });
    job.then(onMarked)
      .then(() => { setState({ busy: false, error: null }); setOpen(null); setNote(''); })
      .catch((err: Error) => setState({ busy: false, error: err.message }));
  };
  const send = () => act(open === 'weak'
    ? api.markWeak(supply.oracle_id, demand.oracle_id, note.trim() || `Weak link, marked in deck ${deckId}.`)
    : api.reportEdge(buildId, link.edge_key, note.trim() || `False link, marked in deck ${deckId}.`));

  return (
    <div className="dk-link">
      <div className="dk-link-head">
        <a className="gx-other" href={`#/graph/${encodeURIComponent(link.other)}?build=${buildId}`} data-card-id={link.other}>{other}</a>
        <GradePill grade={link.grade} unresolved={[]} />
        {link.weak && <span className="dk-weak" title="You said that this link is real but weak, so it counts for less in the next deck.">Weak</span>}
        {link.owner_link !== undefined
          ? <span className="dk-weak" title="An apply session added this link from your answer on the Decisions page. It has no rule.">Your link</span>
          : <span className="mono dk-rule" title="The rule of this link">{link.rule_ids.join(', ')}</span>}
      </div>
      {link.owner_link !== undefined && (
        <div className="gx-report">
          <span className="muted"><b data-card-id={supply.oracle_id}>{supply.name}</b> helps <b data-card-id={demand.oracle_id}>{demand.name}</b>, from your answer.</span>
          {link.owner_removed
            ? <span className="pill-status pill-ok">Removed. A new deck does not have this link.</span>
            : <button type="button" className="gx-link" disabled={state.busy} onClick={() => act(api.removeOwnerLink(link.owner_link!))}>Remove your link</button>}
          {state.error && <span className="error-inline">{state.error}</span>}
        </div>
      )}
      {link.owner_link === undefined && <>
      <div className="dk-quotes">
        <div className="dk-quote"><div className="dk-quote-k"><b data-card-id={supply.oracle_id}>{supply.name}</b> gives</div><span className="gr-quote">"{link.supply_quote}"</span></div>
        <div className="dk-quote"><div className="dk-quote-k"><b data-card-id={demand.oracle_id}>{demand.name}</b> needs</div><span className="gr-quote">"{link.demand_quote}"</span></div>
      </div>
      <div className="gx-report">
        {link.report && <span className="pill-status pill-ok" title={link.report.note}>Marked false. Report {link.report.id} is in the review queue.</span>}
        {!link.report && !open && <button type="button" className="gx-link" onClick={() => setOpen('false')}>This link is false</button>}
        {!link.report && !link.weak && !open && <button type="button" className="gx-link" onClick={() => setOpen('weak')}>This link is weak</button>}
        {link.weak_mark && !open && <button type="button" className="gx-link" disabled={state.busy} onClick={() => act(api.clearWeak(supply.oracle_id, demand.oracle_id))}>Remove the weak mark</button>}
        {open && (
          <div className="gx-report-form">
            <textarea className="gr-note" rows={2} dir="auto" placeholder="Why? You can leave this empty." value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="gr-btn" disabled={state.busy} onClick={send}>{open === 'weak' ? 'Mark as weak' : 'Mark as false'}</button>
            <button type="button" className="gx-link" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        )}
        {state.error && <span className="error-inline">{state.error}</span>}
      </div>
      </>}
    </div>
  );
}

/**
 * The comment of one card. It saves by itself, after a short pause and when it loses the focus. It
 * is outside the `<details>`, because a click or a space in a field inside `<summary>` opens the row.
 */
function CommentField({ deckId, card, saved }: { deckId: number; card: DeckCardView; saved: string }) {
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const stored = useRef(saved);
  const latest = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = () => {
    clearTimeout(timer.current);
    const value = latest.current.trim();
    if (value === stored.current) return;
    stored.current = value;
    api.saveDeckComment(deckId, card.oracle_id, value).then(() => setError(null)).catch((err: Error) => setError(err.message));
  };
  useEffect(() => save, []); // a comment that is still waiting saves when the row leaves the page
  return (
    <div className="dk-comment">
      <input
        className="dk-comment-input" type="text" dir="auto" placeholder="Comment" aria-label={`Comment on ${card.name}`} value={text}
        onChange={(e) => {
          setText(e.target.value);
          latest.current = e.target.value;
          clearTimeout(timer.current);
          timer.current = setTimeout(save, COMMENT_PAUSE_MS);
        }}
        onBlur={save}
      />
      {error && <span className="error-inline">{error}</span>}
    </div>
  );
}

function CardRow({ card, names, buildId, deckId, comment, onMarked }: {
  card: DeckCardView; names: Map<string, string>; buildId: number; deckId: number; comment: string; onMarked: () => Promise<void>;
}) {
  const spell = card.role !== 'land';
  return (
    <div className="dk-row">
      <details className="dk-card">
        <summary>
          <span className="dk-copies">{card.copies}</span>
          <span className="dk-name"><span data-card-id={card.oracle_id}>{card.name}</span></span>
          <ManaCost cost={card.mana_cost} />
          <span className={`dk-role dk-role-${card.role}`}>{card.role}</span>
          {card.rate && <span className="dk-rate" title={RATE_HINT}>{rateText(card.rate)}</span>}
          {spell && <span className="muted dk-count">{card.deck_links} of the deck</span>}
        </summary>
        <div className="dk-card-body">
          {card.image && <img className="dk-image" src={card.image} alt={card.name} loading="lazy" data-card-id={card.oracle_id} />}
          <div className="dk-card-text">
            <p className="muted">{card.type_line}</p>
            <p>{ROLE_TEXT[card.role]}{spell && ` It links to ${card.deck_links} other deck card${card.deck_links === 1 ? '' : 's'}.`}</p>
            {card.links.map((l) => <LinkRow key={l.edge_key} link={l} self={card} names={names} buildId={buildId} deckId={deckId} onMarked={onMarked} />)}
            {spell && card.links.length === 0 && <p className="muted">This card has no link to the deck.</p>}
          </div>
        </div>
      </details>
      <CommentField deckId={deckId} card={card} saved={comment} />
    </div>
  );
}

/** A warning text with the names of its cards marked for the hover zoom. */
function WarningText({ warning, names }: { warning: DeckWarning; names: Map<string, string> }) {
  const parts: ReactNode[] = [];
  let rest = warning.text;
  for (const id of warning.cards) {
    const name = names.get(id) ?? '';
    const at = name ? rest.indexOf(name) : -1;
    if (at < 0) continue;
    parts.push(rest.slice(0, at), <span key={id} data-card-id={id}>{name}</span>);
    rest = rest.slice(at + name.length);
  }
  return <>{parts}{rest}</>;
}

function Warnings({ warnings, names }: { warnings: DeckWarning[]; names: Map<string, string> }) {
  if (warnings.length === 0) return <section className="panel"><div className="panel-head"><h2>Warnings</h2><span className="count">0</span></div><p className="muted">No warnings.</p></section>;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Warnings</h2><span className="count">{warnings.length}</span></div>
      <ul className="dk-warnings">
        {WARNING_ORDER.flatMap((k) => warnings.filter((w) => w.kind === k)).map((w, i) => (
          <li key={i}><span className="dk-warning-kind">{WARNING_TEXT[w.kind]}</span> <WarningText warning={w} names={names} /></li>
        ))}
      </ul>
    </section>
  );
}

function CopyPanel({ text }: { text: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const box = useRef<HTMLTextAreaElement>(null);
  const copy = () => {
    const done = () => { setCopied('yes'); setTimeout(() => setCopied('no'), 2500); };
    const fallback = () => {
      box.current?.select();
      if (document.execCommand('copy')) done(); else setCopied('failed');
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(fallback);
    else fallback();
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Import text</h2>
        <span className="rule" />
        <button type="button" className="btn btn-primary" onClick={copy}><Icon name={copied === 'yes' ? 'check' : 'deck'} />{copied === 'yes' ? 'Copied' : 'Copy for Arena'}</button>
      </div>
      {copied === 'failed' && <p className="error-inline">The browser refused the copy. Select the text and copy it by hand.</p>}
      <textarea ref={box} className="gr-note dk-export" readOnly rows={Math.min(14, text.split('\n').length)} value={text} aria-label="Import text" />
    </section>
  );
}

/** One game: its facts, its list of turns and the button that starts a review. */
function GameRow({ game, cardIds, talk }: { game: GameView; cardIds: DeckGames['card_ids']; talk: (game: GameView) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = () => {
    setBusy(true);
    setError(null);
    talk(game).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const copies = (l: GameView['link']['in']) => l.map((c) => `${c.copies} ${c.name}`).join(', ');
  return (
    <details className="dk-game">
      <summary>
        <span className={`dk-game-result dk-game-${game.result}`}>{RESULT_TEXT[game.result]}</span>
        <span>{game.played_at.slice(0, 16)}</span>
        <span className="muted">{game.on_play ? 'play' : 'draw'}, {game.turn_count} turns, opponent {game.opponent_colours.join('') || '?'}</span>
      </summary>
      <p className="muted dk-hint">
        {game.mulligans} mulligans. {game.missed_land_drops} missed land drops.
        {game.link.older && ' You played an earlier version of this deck.'}
        {game.link.kind === 'close' && ` Close to this deck, ${game.link.differ} copies differ. Only in the game: ${copies(game.link.in)}. Only in the deck: ${copies(game.link.out)}.`}
      </p>
      <div className="dk-game-lines">{game.lines.map((l, i) => <p key={i}><Named text={l} cards={cardIds} /></p>)}</div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={press}>{busy ? 'Working…' : 'Talk about this game'}</button>
      {error && <p className="error-inline">{error}</p>}
    </details>
  );
}

function Games({ deckId, talk }: { deckId: number; talk: (game: GameView) => Promise<void> }) {
  const [data, setData] = useState<DeckGames | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => api.deckGames(deckId).then((d) => { if (live) { setData(d); setError(null); } }).catch((err: Error) => { if (live) setError(err.message); });
    void read();
    const timer = setInterval(() => void read(), GAMES_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [deckId]);

  const s = data?.status;
  const t = data?.totals;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Games</h2><span className="count">{data?.games.length ?? 0}</span></div>
      {s?.detailed === false && (
        <p className="dk-game-warning">The Arena log has no game data, so the app cannot see your games. In Arena, select the gear icon, then View Account, then Detailed Logs (Plugin Support). Then restart Arena.</p>
      )}
      {s?.error && <p className="error-inline">The log scan failed: {s.error}</p>}
      {s?.scanned_at && !s.log_found && <p className="muted dk-hint">The app found no Arena log on this computer.</p>}
      {t && data.games.length > 0 && (
        <p className="muted dk-hint">Wins-losses {t.wins}-{t.losses}{t.draws > 0 ? `, ${t.draws} draws` : ''}. On the play {t.on_play.wins}-{t.on_play.losses}. On the draw {t.on_draw.wins}-{t.on_draw.losses}.</p>
      )}
      {data?.games.length === 0 && s?.detailed !== false && <p className="muted dk-hint">No game links to this deck. A game shows here when it ends.</p>}
      {data?.games.map((g) => <GameRow key={g.id} game={g} cardIds={data.card_ids} talk={talk} />)}
      {data && data.cards.length > 0 && (
        <details className="dk-game">
          <summary>Counts of each card</summary>
          <div className="dk-game-table">
            <table>
              <thead><tr><th>Card</th><th title="Games with the card drawn">Drawn</th><th title="Times cast">Cast</th><th title="Games with the card left in hand at the end">In hand</th><th title="Wins with the card drawn">Wins</th></tr></thead>
              <tbody>{data.cards.map((c) => <tr key={c.oracle_id ?? c.name}><td {...(c.oracle_id ? { 'data-card-id': c.oracle_id } : {})}>{c.name}</td><td>{c.drawn}</td><td>{c.cast}</td><td>{c.left}</td><td>{c.wins}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      {s && (s.other_games > 0 || s.unreadable_games > 0) && (
        <p className="muted dk-hint">{s.other_games > 0 && `${s.other_games} other games link to no deck. `}{s.unreadable_games > 0 && `The app could not read ${s.unreadable_games} games.`}</p>
      )}
      {error && <p className="error-inline">{error}</p>}
    </section>
  );
}

export function DeckViewPage({ id }: { id: number }) {
  const [deck, setDeck] = useState<DeckView | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);

  useEffect(() => {
    let live = true;
    setDeck(null);
    setError(null);
    api.deck(id).then((r) => { if (live) { setDeck(r.deck); setComments(r.comments ?? {}); } }).catch((err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [id]);

  const names = useMemo(() => new Map((deck?.cards ?? []).map((c) => [c.oracle_id, c.name])), [deck]);
  const groups = useMemo(() => {
    const m = new Map<number, DeckCardView[]>();
    for (const c of deck?.cards ?? []) {
      if (c.role === 'land') continue;
      const k = Math.floor(c.mana_value);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m].sort((a, b) => a[0] - b[0]);
  }, [deck]);

  if (error) return <div className="error-block">{error}</div>;
  if (!deck) return <p className="muted">Loading…</p>;

  const seeds = deck.cards.filter((c) => c.role === 'seed');
  const lands = deck.cards.filter((c) => c.role === 'land');
  const spells = deck.cards.filter((c) => c.role !== 'land');
  const spellCopies = spells.reduce((s, c) => s + c.copies, 0);
  const colours = deck.goal.colours === 'BR' ? (['B', 'R'] as const) : [deck.goal.colours];
  const reload = () => api.deck(id).then((r) => { setDeck(r.deck); setComments(r.comments ?? {}); });
  const row = (c: DeckCardView) => <CardRow key={c.oracle_id} card={c} names={names} buildId={deck.build_id} deckId={id} comment={comments[c.oracle_id] ?? ''} onMarked={reload} />;
  // The chat panel reads the talk when it mounts, so a new key shows this message and the running turn.
  const talk = async (g: GameView) => {
    await api.sendDeckChat(id, `Talk about game ${g.id}: ${RESULT_TEXT[g.result].toLowerCase()}, ${g.played_at.slice(0, 16)}. Does the deck need a change, or was a play the problem?`);
    setChatKey((k) => k + 1);
  };

  return (
    <div className="dk">
      <div className="page-head">
        <div>
          <h1 className="page-title">Deck {id}{seeds.length > 0 && ': '}{seeds.map((c, i) => <Fragment key={c.oracle_id}>{i > 0 && ', '}<span data-card-id={c.oracle_id}>{c.name}</span></Fragment>)}</h1>
          <p className="page-sub">Colours {deck.goal.colours}, target turn {deck.goal.target_turn}, interaction {deck.goal.interaction}, at least {deck.goal.min_creatures} creatures. Card rate {deck.goal.use_rate ? 'on' : 'off'}. Graph build {deck.build_id}.</p>
          {deck.goal.use_rate && <p className="muted dk-hint">{spells.filter((c) => c.rate?.rate).length} of {spells.length} spells have a rate that is not 0. {RATE_HINT}</p>}
        </div>
        <div className="page-actions"><a className="btn" href="#/decks">Build another deck</a></div>
      </div>
      <section className="dk-stats">
        <div className="dk-stat"><b>{deck.mana.land_count + spellCopies}</b><span>cards</span></div>
        <div className="dk-stat"><b>{spellCopies}</b><span>spells</span></div>
        <div className="dk-stat"><b>{deck.mana.land_count}</b><span>lands</span></div>
        {colours.map((c) => (
          <div key={c} className="dk-stat"><b>{deck.mana.sources[c]}</b><span>{c} sources, need {deck.mana.needs[c]}</span></div>
        ))}
      </section>
      <div className="dk-layout">
        <div>
          {groups.map(([mv, cards]) => (
            <section key={mv} className="panel dk-group">
              <div className="panel-head"><h2>Mana value {mv}</h2><span className="count">{cards.reduce((s, c) => s + c.copies, 0)}</span></div>
              {cards.map(row)}
            </section>
          ))}
          <section className="panel dk-group">
            <div className="panel-head"><h2>Lands</h2><span className="count">{deck.mana.land_count}</span></div>
            {lands.map(row)}
          </section>
        </div>
        <div>
          <DeckChat key={`${id}-${chatKey}`} deckId={id} onDeckChanged={reload} />
          <Games deckId={id} talk={talk} />
          <Warnings warnings={deck.warnings} names={names} />
          <CopyPanel text={deck.export_text} />
        </div>
      </div>
    </div>
  );
}
