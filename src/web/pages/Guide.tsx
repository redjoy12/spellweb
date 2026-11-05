import { useEffect, useState } from 'react';
import { api, type GraphBuild } from '../api.js';
import { Icon } from '../components/Icon.js';
import { GLOSSARY, LOOP_KIND, scopeName, type GlossaryEntry, type TermId } from '../lib/terms.js';

/**
 * The "Start here" page: what the app does, the demo steps, how to read a card page, the known
 * problem, and all project words in plain language (owner request, 2026-10-18).
 */

const ORDER: TermId[] = [
  'link', 'gives', 'needs', 'reason', 'strong', 'possible', 'broad', 'strength', 'kind', 'conflict', 'loop',
  'marked', 'version', 'outdated', 'testPairs', 'rightStrong', 'found', 'format',
];

export function Guide({ term }: { term?: string }) {
  const [build, setBuild] = useState<GraphBuild | null>(null);
  const [top, setTop] = useState<{ oracle_id: string; name: string } | null>(null);

  useEffect(() => {
    api.graphBuilds().then((r) => {
      const b = r.builds[0] ?? null;
      setBuild(b);
      if (b) api.graphTop(b.id, 1).then((t) => setTop(t.cards[0] ?? null)).catch(() => setTop(null));
    }).catch(() => setBuild(null));
  }, []);

  useEffect(() => {
    if (!term) return;
    const t = setTimeout(() => document.getElementById(`term-${term}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    return () => clearTimeout(t);
  }, [term]);

  const explore = build ? `#/graph?build=${build.id}` : '#/graph';
  const firstCard = top && build ? `#/graph/${encodeURIComponent(top.oracle_id)}?build=${build.id}` : explore;
  const scope = build ? scopeName(build.scope) : 'Black-Red';

  return (
    <div className="guide">
      <div className="page-head">
        <div>
          <div className="eyebrow">Start here</div>
          <h1 className="page-title">How to use this app</h1>
          <p className="page-sub">
            The app reads the rules text of each MTG Arena Standard card and finds which cards help each other. It shows each link with the
            card text that causes it. It builds 60-card decks from these links.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Check your links, step by step</h2><span className="count">about 20 minutes</span></div>
        <ol className="guide-steps">
          <li>
            <div>
              <b>Open a card.</b> Start with {top ? <b data-card-id={top.oracle_id}>{top.name}</b> : 'the card with the most links'}, then try 3 or 4 {scope} cards that you know well.
            </div>
            <div className="guide-actions">
              <a className="btn btn-primary" href={firstCard}>Open {top ? top.name : 'the first card'} <Icon name="arrowRight" size={14} /></a>
              <a className="btn" href={explore}><Icon name="search" size={14} />Find another card</a>
            </div>
          </li>
          <li>
            <div>
              <b>Look at "Best partners".</b> These are the cards with the strongest links to your card. Ask yourself: would I put these cards
              in a deck with it?
            </div>
          </li>
          <li>
            <div>
              <b>Open some links.</b> Each link shows the text that one card <i>gives</i> and the text that the other card <i>needs</i>.
              Ask yourself: is this a real synergy, or only something that every card does (like "uses mana")?
            </div>
          </li>
          <li>
            <div>
              <b>Report the wrong links.</b> Push <b>Report this link</b> under a link and write one sentence. Your reports go to a list for
              later work.
            </div>
          </li>
          <li>
            <div>
              <b>Optional: find loops.</b> On the <b>Loops</b> tab of a card, push <b>Find loops</b>. A loop is a chain of cards that can repeat.
            </div>
          </li>
          <li>
            <div>
              <b>Tell Claude what you think</b> in one or two sentences. For example: "most links are noise", "the links are good but the order
              is wrong", or "card X is missing obvious partners".
            </div>
          </li>
        </ol>
      </section>

      <div className="callout callout-warn">
        <Icon name="alert" size={18} />
        <div>
          <p><b>Known problem: broad links.</b> Many links are too general. For example, every card that makes mana links to every card
            with an activated ability. These links have this mark: <span className="gx-wide">broad link</span>.</p>
          <p>On a card page you can hide them with <b>Hide broad links</b>, to see what is left.</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>What a card page shows</h2></div>
        <div className="guide-map">
          <div><span className="guide-n">1</span><b>The card</b>: its picture, its text, and how many links it has.</div>
          <div><span className="guide-n">2</span><b>Best partners</b>: the cards with the strongest links, with the reason in one line. Start here.</div>
          <div><span className="guide-n">3</span><b>Helps</b>: the cards that need something that this card gives.</div>
          <div><span className="guide-n">4</span><b>Helped by</b>: the cards that give something that this card needs.</div>
          <div><span className="guide-n">5</span><b>Card kinds</b>: whole groups that help this card, for example "every creature card".</div>
          <div><span className="guide-n">6</span><b>Conflicts</b>: cards that work against this card.</div>
          <div><span className="guide-n">7</span><b>Loops</b>: chains of cards that come back to this card.</div>
          <div><span className="guide-n">8</span><b>How it was read</b>: the card text split into the parts that the system read. For checks only.</div>
        </div>
        <p className="muted">The small <span className="term-q term-q-static">?</span> next to a word opens its meaning.</p>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Words used in this app</h2><span className="count">{ORDER.length}</span></div>
        <p className="panel-sub">Magic terms (token, activated ability, mana value) keep their official meaning. The words below are words of this app.</p>
        <dl className="guide-terms">
          {ORDER.map((id) => {
            const g: GlossaryEntry = GLOSSARY[id];
            return (
              <div key={id} id={`term-${id}`} className={term === id ? 'guide-term focus' : 'guide-term'}>
                <dt>{g.term}</dt>
                <dd>
                  {g.plain}{g.more && <> {g.more}</>}
                  {g.project && <span className="muted guide-old"> In the technical documents: {g.project}.</span>}
                </dd>
              </div>
            );
          })}
          <div id="term-loopKinds" className="guide-term">
            <dt>Loop kinds</dt>
            <dd>
              {([3, 2, 1] as const).map((k) => <span key={k} className="guide-loop"><b>{LOOP_KIND[k].label}:</b> {LOOP_KIND[k].plain}</span>)}
              <span className="muted guide-old"> A loop kind is not a quality score. In the technical documents: tier 3, 2 and 1.</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Good to know</h2></div>
        <ul className="guide-list">
          <li>To build a 60-card deck and export it to Arena, open <b>Build a deck</b>.</li>
          <li>Only the {scope} cards are linked. The graph and the deck search support only black, red and black-red cards.</li>
          <li>The pages under <b>Behind the scenes</b> in the menu are tools for the data work. You use them to make your links.</li>
        </ul>
      </section>
    </div>
  );
}
