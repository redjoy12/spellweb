import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import { decisionsApi, diffWords, type ConflictItem, type CrTextItem, type Decision, type DecisionKind, type DecisionPage, type GoldenCheckItem, type LinkRuleItem, type LinkCheckCard as CheckCard, type LinkCheckItem, type ReadingItem, type RoleItem, type TagCheckItem, type TagCheckTag, type TagMergeItem, type TwinItem, type WrongLinkItem } from '../lib/decisionsApi.js';
import { LinkChanges } from '../components/LinkChanges.js';
import { api } from '../api.js';
import { kindName, typeName, typeTitle, type PlainSide } from '../lib/plain.js';
import { useTypeLabels } from '../lib/terms.js';
import type { Round2Item, Round2Page } from '../../rate/ownerRound2.js';
import type { RateFollowUpItem, RateFollowUpPage, RateRoundItem, RateRoundPage, RoundCard, RoundJob } from '../../rate/ownerRound.js';
import '../decisions.css';

/**
 * "Your decisions" (owner request 2026-10-18): the items that only the owner can answer, in one
 * place, in plain words. Each answer is saved at once in `owner_decisions` and can be changed. An
 * answer changes nothing else: a later step applies the answers. Items that wait on other pages
 * (the review queue) have links at the end.
 */

const PAGE = 25;

/** What the newest round tests, before its first pair (owner request 2026-11-01). It names no pair, so it steers no answer. */
const LINK_RULE_ROUND = {
  prefix: 'lr6:',
  tests: 'Round 6 has 16 pairs. It tests the test set of the app, not a kind of link. The app links each of these pairs now, and the test set says "no link". 11 of these labels are your answers of 2026-10-24. A labeler model gave the other 5, and you never saw those pairs. You set the line "no means no link at all" after those answers, so this round asks each pair again. The page does not show which pair had which label, and you can give the same answer as before.',
  answers: '"Yes" or "Yes, but weak" changes the label of the pair to a real link. "No" keeps the label. "Works against" changes the label to bad together. "Not sure" changes nothing. In this round, no link of the app goes out or comes back. Claude shows you the result before any change. If no button fits, press "Other" and write your own answer.',
};

/**
 * The round of the card rate (card rate plan Task 6) has its own tab, because it asks about quality,
 * not about links. It has no `DecisionKind`: the answers use the kind `link_rule` with the key prefix
 * `rr1:` (src/rate/ownerRound.ts). The API gives only the job and the cards, so the round stays blind.
 */
const RATE_ROUND_TITLE = 'Which card is better at this job?';
const RATE_FOLLOW_UP_TITLE = 'Why did you choose that card?';
const ROUND2_TITLE = 'Which is the better whole card?';
type Tab = DecisionKind | 'elsewhere' | 'rate_round' | 'rate_follow_up' | 'rate_round_2' | 'link_changes';

/** `high`: the questions that help the app most (owner request 2026-10-19). `minutes`: about one item. */
interface KindInfo { title: string; short: string; icon: IconName; what: string; effect: string; help: 'high' | 'optional'; minutes: number }
const KINDS: Record<DecisionKind, KindInfo> = {
  link_rule: {
    title: 'Is this link real?',
    short: 'One pair at a time: real card pairs, linked now or in an earlier build.',
    icon: 'deck',
    what: 'The app links each of these pairs now, or it linked them in an earlier build. Read the two full card texts, and say if card A helps card B. Use your own Magic knowledge. You answer only about this pair, not about a rule. The page shows no reason, so nothing steers you. Your link rule: card A must make the event of card B happen more often, for you. "No" means no link at all. "Weak" means a real link with a high cost, a slow play or a small reward.',
    effect: 'Claude counts your answers for each kind of link. The kinds that you mostly mark "No" are the links to remove. Claude shows you that result before any change. If no button fits, press "Other" and write your own answer.',
    help: 'high', minutes: 1,
  },
  golden_check: {
    title: 'Does card A help card B?',
    short: 'The test pairs that measure the app.',
    icon: 'deck',
    what: 'The app uses these pairs as tests. Your link rule: card A must make the event of card B happen more often, for you. A card that is only a creature, or only has power, is not a link. Read the two full card texts. Use your own Magic knowledge.',
    effect: '"Yes" and "Yes, but weak" make the pair a link test. "No" makes the pair a "no link" test. The app then uses your answer as the test. Write a note if a pair is close.',
    help: 'high', minutes: 1,
  },
  tag_check: {
    title: 'Are the meaning tags of this card correct?',
    short: 'Real cards, with the tags that the app gave them.',
    icon: 'cards',
    what: 'The app cannot read a card like a player. So an AI reads each card and gives it "meaning tags", for example "Sacrifice outlet" or "Produces +1/+1 counters". The app finds the cards that work together only from these tags. These cards are a random sample. Read the card text, then read its tags. Use your own Magic knowledge.',
    effect: '"Correct" means every tag is right and no tag is missing. "Needs fixing" means one or more tags are wrong, or a tag is missing: write which one in the note. Your marks tell us how good the tags are, and which kinds of tags to fix first.',
    help: 'high', minutes: 1.5,
  },
  tag_merge: {
    title: 'Are these two tags one meaning?',
    short: 'Pairs of tags that the rules text shows are the same thing.',
    icon: 'layers',
    what: 'Some pairs of tags are almost always on the same card text. Claude checked each pair against the rules text that the app has. Round 1: the rules text shows one meaning. Round 2: the pairs from your notes. For these, the card gives the facts for one meaning and for two meanings, and the change in the links, measured on a copy of the data. Read the card, then choose.',
    effect: '"Merge" approves the change that the card states. Claude then makes one tag of the two in the next tag list, and changes the link rules to match. "Keep both" keeps the two tags as they are. Some round 2 pairs have their own answers.',
    help: 'high', minutes: 1,
  },
  type_role: {
    title: 'Can this text work both ways?',
    short: 'Types of card text that the app uses in one direction only.',
    icon: 'graph',
    what: 'The app puts each card text into a type. Each type has a direction: it gives help to other cards, it needs help from other cards, or both. An earlier check found pairs of cards that work together, but the app cannot link them, because one type has only one direction. Look at the examples and at the pair. Then say if the type can also work in the other direction.',
    effect: '"Yes – both ways" lets the app look for links in both directions for this type. Then it can find the missed pair, and pairs like it. "No" keeps the type as it is.',
    help: 'high', minutes: 1.5,
  },
  reading: {
    title: 'How must the app read this text?',
    short: 'Card texts that the app reads differently on different cards.',
    icon: 'cards',
    what: 'The app reads each card text as one or more types, for example "Mass removal" or "Attach". For these texts, the reading is not the same on all cards, or the app lost a reading that an earlier check needs. Look at the card examples. Then say how the app must read this text on all cards.',
    effect: 'Your answer becomes one reading rule for all cards with this text. Claude then reads these cards again. If you choose "Only sometimes", write a short note that says when.',
    help: 'high', minutes: 1,
  },
  wrong_link: {
    title: 'Check a disputed card pair',
    short: 'Pairs where the app and an earlier check do not agree.',
    icon: 'alert',
    what: 'For each of these pairs, the app and an earlier check (three isolated subagents) do not agree. Use your own Magic knowledge, and say if card A helps card B. Card A is the card on the left.',
    effect: 'Your answer shows which side is right. If the app is wrong, Claude corrects the reason that links the cards. If the earlier check is wrong, Claude corrects the test pair. Both make the score more correct.',
    help: 'high', minutes: 1,
  },
  link_check: {
    title: 'Do these cards work together?',
    short: 'Real pairs of cards that the app links now.',
    icon: 'deck',
    what: 'The app links each of these pairs now. You decided the rule for a link: card A must make the event of card B happen more often, for you. Mark each pair with your own Magic knowledge. Ten pairs come from the reasons that link the most cards. Ten pairs are random.',
    effect: 'Your marks show whether the written rule gives your answers. They can become test pairs for the next reasons. "Yes, but weak" means a real link with a small effect, for example an expensive card.',
    help: 'optional', minutes: 1,
  },
  cr_text: {
    title: 'Rules texts that look the same',
    short: 'Two sentences of the Comprehensive Rules with nearly the same words.',
    icon: 'book',
    what: 'The Comprehensive Rules say some things two times. The app found these pairs by their words only. The marked words are different. Sometimes the different word changes the rule, sometimes not. The app cannot know which, so you decide.',
    effect: '"Same" lets the app keep one text and point the other to it. "Different" keeps both texts. Pairs with the most uses in the reasons are first.',
    help: 'optional', minutes: 0.5,
  },
  rule_conflict: {
    title: 'Reasons that disagree',
    short: 'Two reasons for the same kind of link, with different conditions.',
    icon: 'scale',
    what: 'Each reason says when one card helps another. Here two reasons cover the same pair of card texts, but their conditions are different, and neither one includes the other. Both are in use now.',
    effect: '"Keep both" keeps the app as it is. "Keep only" removes the other reason in the next version of the reasons.',
    help: 'optional', minutes: 1,
  },
  supply_twin: {
    title: 'Card-text types that look the same',
    short: 'Two types of card text that have exactly the same reasons.',
    icon: 'layers',
    what: 'The app sorts card text into types. These two types have the same reasons for every card that they help. Maybe they are one thing with two names, maybe not.',
    effect: '"Same" joins the two types in the next card-reading schema. "Different" keeps them apart.',
    help: 'optional', minutes: 0.5,
  },
};

/** The high-help kinds, in the order of the steps. */
const HIGH = (Object.keys(KINDS) as DecisionKind[]).filter((k) => KINDS[k].help === 'high');

const CHOICE_TEXT: Record<string, string> = {
  same: 'Same', different: 'Different', unsure: 'Not sure', keep_both: 'Keep both',
  link: 'Yes, they work together', weak_link: 'Yes, but weak', no_link: 'No',
  anti: 'No, card A works against card B', both: 'Yes – both ways', keep: 'No – keep one direction',
  yes: 'Yes', no: 'No', depends: 'Only sometimes', opponent: 'Opponent loses life', none: 'Neither',
};
const choiceText = (c: string) => CHOICE_TEXT[c] ?? (c.startsWith('keep:') ? `Keep only ${c.slice(5)}` : c);

const sourceName = (s: { source: 'rule' | 'glossary'; ref: string }) => (s.source === 'rule' ? `Rule ${s.ref}` : `Glossary: ${s.ref}`);

const DIFFERS: Record<string, string> = {
  'supply where': 'the conditions on the card that gives',
  'demand where': 'the conditions on the card that needs',
  'param links': 'the values that must match',
  implications: 'the values that the reason takes as known',
};

type Filter = 'open' | 'debate' | 'answered' | 'all';

/** True when an isolated debate agreed on the item (same or different): it needs no answer, but the owner can still give one. */
const debateAgreed = (i: { debate?: { verdict: string } }) => i.debate?.verdict === 'same' || i.debate?.verdict === 'different';

/** A value in words: a list joined with commas, a text without quotes. */
const valueWords = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : String(v));
const OP_WORDS: Record<string, string> = { eq: 'is', in: 'is one of', overlaps: 'includes one of', disjoint: 'is none of' };

/** A rule side in plain words, with its conditions ("only if controller is one of any, you"). */
function sideWords(s: PlainSide, labels: Record<string, string>): string {
  if ('intrinsic' in s) return kindName(s.intrinsic, s.value);
  const name = typeName(`${s.family}.${s.type_key}`, labels);
  const where = s.where.map((p) => `${p.param.replace(/_/g, ' ')} ${OP_WORDS[p.op] ?? p.op} ${valueWords(p.value)}`).join('; ');
  return where ? `${name} (only if ${where})` : name;
}

export function Decisions() {
  const [data, setData] = useState<DecisionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Map<string, Decision>>(new Map());
  const [tab, setTab] = useState<Tab>('type_role');
  const [rateRound, setRateRound] = useState<RateRoundPage | null>(null);
  const [rateFollowUp, setRateFollowUp] = useState<RateFollowUpPage | null>(null);
  const [round2, setRound2] = useState<Round2Page | null>(null);
  const [linkOpen, setLinkOpen] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ kind: DecisionKind; key: string; label: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const labels = useTypeLabels();

  useEffect(() => {
    decisionsApi.page().then((p) => {
      setData(p);
      const done = new Set(p.decisions.map((d) => `${d.kind}|${d.item_key}`));
      setAnswers(new Map(p.decisions.map((d) => [`${d.kind}|${d.item_key}`, d])));
      // Open on the first high-help step that has an open question.
      const first = HIGH.find((k) => (p.items[k] as Array<{ key: string }>).some((i) => !done.has(`${k}|${i.key}`)));
      // Link review design sec. 2: the deck page links to `#/decisions?tab=link_changes`.
      const asked = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab');
      setTab(asked === 'link_changes' ? 'link_changes' : first ?? 'link_check');
    }).catch((e: Error) => setError(e.message));
    // An API from before this round has no such route: the page then shows no tab for it.
    fetch('/api/decisions/rate-round').then((r) => (r.ok ? r.json() as Promise<RateRoundPage> : null)).then(setRateRound).catch(() => setRateRound(null));
    fetch('/api/decisions/rate-follow-up').then((r) => (r.ok ? r.json() as Promise<RateFollowUpPage> : null)).then(setRateFollowUp).catch(() => setRateFollowUp(null));
    api.linkChanges().then((p) => setLinkOpen(p.items.filter((i) => (i.state === 'open' || i.state === 'question') && !i.stale).length)).catch(() => setLinkOpen(null));
    fetch('/api/decisions/rate-round-2').then((r) => (r.ok ? r.json() as Promise<Round2Page> : null)).then(setRound2).catch(() => setRound2(null));
  }, []);
  useEffect(() => { setShown(PAGE); setSaved(null); }, [tab, filter, search]);

  const answerOf = (kind: DecisionKind, key: string) => answers.get(`${kind}|${key}`);
  const onSaved = (d: Decision | null, kind: DecisionKind, key: string, label?: string) => {
    setAnswers((m) => {
      const n = new Map(m);
      if (d) n.set(`${kind}|${key}`, d); else n.delete(`${kind}|${key}`);
      return n;
    });
    setSaved(d && label ? { kind, key, label } : null);
  };
  const undo = () => {
    if (!saved) return;
    const s = saved;
    decisionsApi.clear(s.kind, s.key).then(() => onSaved(null, s.kind, s.key)).catch((e: Error) => setError(e.message));
  };

  const counts = useMemo(() => {
    const out = {} as Record<DecisionKind, { total: number; answered: number; debated: number; open: number }>;
    if (!data) return out;
    for (const k of Object.keys(KINDS) as DecisionKind[]) {
      const items = data.items[k] as Array<{ key: string; debate?: { verdict: string } }>;
      const answered = items.filter((i) => answers.has(`${k}|${i.key}`)).length;
      const debated = items.filter((i) => !answers.has(`${k}|${i.key}`) && debateAgreed(i)).length;
      out[k] = { total: items.length, answered, debated, open: items.length - answered - debated };
    }
    return out;
  }, [data, answers]);

  if (error) return <div className="error-box">The decisions did not load: {error}</div>;
  if (!data) return <div className="empty-state">Loading your decisions…</div>;

  const open = (Object.keys(KINDS) as DecisionKind[]).reduce((s, k) => s + counts[k].open, 0);
  const elsewhere = data.elsewhere.review_atom + data.elsewhere.review_edge_rules + data.elsewhere.edge_reports + data.elsewhere.fix_requests;

  const visible = <T extends { key: string; debate?: { verdict: string } }>(kind: DecisionKind, items: T[], text: (i: T) => string): T[] => items.filter((i) => {
    const a = answers.has(`${kind}|${i.key}`);
    if (filter === 'open' && (a || debateAgreed(i))) return false;
    if (filter === 'debate' && (a || !debateAgreed(i))) return false;
    if (filter === 'answered' && !a) return false;
    return !search.trim() || text(i).toLowerCase().includes(search.trim().toLowerCase());
  });
  const roundNote = tab === 'link_rule' && data.items.link_rule.some((i) => i.key.startsWith(LINK_RULE_ROUND.prefix));
  const ratePairs = rateRound?.items ?? [];
  const rateAnswered = ratePairs.filter((i) => answers.has(`link_rule|${i.key}`)).length;
  const whyItems = rateFollowUp?.items ?? [];
  const whyAnswered = whyItems.filter((i) => answers.has(`link_rule|${i.key}`)).length;
  const round2Items = round2?.items ?? [];
  const round2Answered = round2Items.filter((i) => answers.has(`link_rule|${i.key}`)).length;

  return (
    <div className="dc">
      <div className="page-head">
        <div>
          <div className="eyebrow">Your decisions</div>
          <h1 className="page-title">Questions that only you can answer</h1>
          <p className="page-sub">
            The app found these items with its own checks, but it cannot decide them from the words alone.
            Each answer is saved at once, and you can change it later. An answer changes nothing in the app yet:
            Claude applies your answers in a later step.
          </p>
        </div>
      </div>

      <StartHere counts={counts} tab={tab} setTab={setTab} />

      {linkOpen !== null && (
        <>
          <h2 className="dc-section-title">Link changes <span>Suggestions of Claude from the deck pages. You apply them in one step.</span></h2>
          <div className="dc-tiles">
            <button type="button" className={`dc-tile${tab === 'link_changes' ? ' active' : ''}`} onClick={() => setTab('link_changes')}>
              <span className="dc-tile-icon"><Icon name="graph" size={18} /></span>
              <span className="dc-tile-title">Link changes from Claude</span>
              <span className="dc-tile-num">{linkOpen === 0 ? <><Icon name="check" size={14} /> nothing open</> : <><b>{linkOpen}</b> open</>}</span>
              <span className="dc-tile-sub">Delete, add or correct a link · apply when you are ready</span>
            </button>
          </div>
        </>
      )}

      {ratePairs.length > 0 && (
        <>
          <h2 className="dc-section-title">Card quality round <span>A round of its own. It asks about quality, not about links.</span></h2>
          <div className="dc-tiles">
            {round2Items.length > 0 && (
              <button type="button" className={`dc-tile${tab === 'rate_round_2' ? ' active' : ''}`} onClick={() => setTab('rate_round_2')}>
                <span className="dc-tile-icon"><Icon name="scale" size={18} /></span>
                <span className="dc-tile-title">{ROUND2_TITLE}</span>
                <span className="dc-tile-num">{round2Answered === round2Items.length ? <><Icon name="check" size={14} /> all answered</> : <><b>{round2Items.length - round2Answered}</b> open</>}</span>
                <span className="dc-meter" aria-hidden="true"><i style={{ width: `${(100 * round2Answered) / round2Items.length}%` }} /></span>
                <span className="dc-tile-sub">{round2Answered} answered by you · {round2Items.length} in all</span>
              </button>
            )}
            <button type="button" className={`dc-tile${tab === 'rate_round' ? ' active' : ''}`} onClick={() => setTab('rate_round')}>
              <span className="dc-tile-icon"><Icon name="scale" size={18} /></span>
              <span className="dc-tile-title">{RATE_ROUND_TITLE}</span>
              <span className="dc-tile-num">{rateAnswered === ratePairs.length ? <><Icon name="check" size={14} /> all answered</> : <><b>{ratePairs.length - rateAnswered}</b> open</>}</span>
              <span className="dc-meter" aria-hidden="true"><i style={{ width: `${(100 * rateAnswered) / ratePairs.length}%` }} /></span>
              <span className="dc-tile-sub">{rateAnswered} answered by you · {ratePairs.length} in all</span>
            </button>
            {whyItems.length > 0 && (
              <button type="button" className={`dc-tile${tab === 'rate_follow_up' ? ' active' : ''}`} onClick={() => setTab('rate_follow_up')}>
                <span className="dc-tile-icon"><Icon name="scale" size={18} /></span>
                <span className="dc-tile-title">{RATE_FOLLOW_UP_TITLE}</span>
                <span className="dc-tile-num">{whyAnswered === whyItems.length ? <><Icon name="check" size={14} /> all answered</> : <><b>{whyItems.length - whyAnswered}</b> open</>}</span>
                <span className="dc-meter" aria-hidden="true"><i style={{ width: `${(100 * whyAnswered) / whyItems.length}%` }} /></span>
                <span className="dc-tile-sub">{whyAnswered} answered by you · {whyItems.length} in all</span>
              </button>
            )}
          </div>
        </>
      )}

      <h2 className="dc-section-title">Optional questions <span>They help less. Answer them when you have time.</span></h2>
      <div className="dc-tiles">
        {(Object.keys(KINDS) as DecisionKind[]).filter((k) => KINDS[k].help === 'optional').map((k) => {
          const c = counts[k];
          const left = c.open;
          return (
            <button key={k} type="button" className={`dc-tile${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
              <span className="dc-tile-icon"><Icon name={KINDS[k].icon} size={18} /></span>
              <span className="dc-tile-title">{KINDS[k].title}</span>
              <span className="dc-tile-num">{left === 0 ? <><Icon name="check" size={14} /> all answered</> : <><b>{left}</b> open</>}</span>
              <span className="dc-meter" aria-hidden="true"><i style={{ width: `${c.total ? (100 * (c.total - c.open)) / c.total : 100}%` }} /></span>
              <span className="dc-tile-sub">{c.answered} answered by you{c.debated ? `, ${c.debated} decided by a debate` : ''} · {c.total} in all</span>
            </button>
          );
        })}
        <button type="button" className={`dc-tile dc-tile-other${tab === 'elsewhere' ? ' active' : ''}`} onClick={() => setTab('elsewhere')}>
          <span className="dc-tile-icon"><Icon name="inbox" size={18} /></span>
          <span className="dc-tile-title">On other pages</span>
          <span className="dc-tile-num"><b>{elsewhere.toLocaleString('en-US')}</b> waiting</span>
          <span className="dc-tile-sub">Review queue items, link reports and fixes</span>
        </button>
      </div>
      {open === 0 && <p className="dc-done"><Icon name="check" size={16} /> You answered every question on this page.</p>}

      {tab !== 'elsewhere' && tab !== 'rate_round' && tab !== 'rate_follow_up' && tab !== 'rate_round_2' && tab !== 'link_changes' && (
        <>
          <section className="dc-intro" id="dc-step">
            {KINDS[tab].help === 'high' && <div className="dc-step-k">Step {HIGH.indexOf(tab) + 1} of {HIGH.length}</div>}
            <h2>{KINDS[tab].title}</h2>
            <p>{KINDS[tab].what}</p>
            {roundNote && <p>{LINK_RULE_ROUND.tests}</p>}
            <p className="dc-effect"><Icon name="info" size={14} /> {roundNote ? LINK_RULE_ROUND.answers : KINDS[tab].effect}</p>
          </section>
          <div className="dc-toolbar">
            <div className="dc-seg" role="tablist" aria-label="Show">
              {(['open', 'debate', 'answered', 'all'] as Filter[]).filter((f) => f !== 'debate' || counts[tab].debated > 0).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {f === 'open' ? `Open (${counts[tab].open})` : f === 'debate' ? `Decided by debate (${counts[tab].debated})` : f === 'answered' ? `Answered by you (${counts[tab].answered})` : `All (${counts[tab].total})`}
                </button>
              ))}
            </div>
            <label className="dc-search">
              <Icon name="search" size={14} />
              <input type="search" placeholder={tab === 'cr_text' ? 'Find a rule number or a word' : 'Find a word'} value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>
        </>
      )}

      {saved && saved.kind === tab && (
        <div className="dc-saved" role="status">
          <Icon name="check" size={15} />
          <span>
            Saved: <b>{saved.label}</b>.
            {counts[tab].open > 0 ? ` ${counts[tab].open} open question${counts[tab].open === 1 ? '' : 's'} left in this step.` : ' This step is done.'}
          </span>
          <button type="button" className="gx-link" onClick={undo}>Undo</button>
        </div>
      )}
      {tab !== 'elsewhere' && tab !== 'rate_round' && tab !== 'rate_follow_up' && tab !== 'rate_round_2' && tab !== 'link_changes' && KINDS[tab].help === 'high' && counts[tab].open === 0 && filter === 'open' && (() => {
        const next = HIGH.find((k) => counts[k].open > 0);
        return (
          <div className="dc-next">
            <Icon name="check" size={18} /> You answered every question in this step. Thank you.
            {next
              ? <button type="button" className="btn btn-primary" onClick={() => setTab(next)}>Next: {KINDS[next].title} <Icon name="arrowRight" size={14} /></button>
              : <span>All the important questions are answered.</span>}
          </div>
        );
      })()}
      {tab === 'link_rule' && (() => {
        const items = visible('link_rule', data.items.link_rule, (i) => `${i.supply.name} ${i.demand.name} ${i.supply.oracle_text} ${i.demand.oracle_text}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <BlindPairCard key={i.key} kind="link_rule" item={i} n={data.items.link_rule.indexOf(i) + 1} answer={answerOf('link_rule', i.key)} onSaved={(d, l) => onSaved(d, 'link_rule', i.key, l)} />
        )} />;
      })()}
      {tab === 'golden_check' && (() => {
        const items = visible('golden_check', data.items.golden_check, (i) => `${i.supply.name} ${i.demand.name} ${i.supply.oracle_text} ${i.demand.oracle_text}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <BlindPairCard key={i.key} kind="golden_check" item={i} badge={`test pair ${i.pair_id}`} n={data.items.golden_check.indexOf(i) + 1} answer={answerOf('golden_check', i.key)} onSaved={(d, l) => onSaved(d, 'golden_check', i.key, l)} />
        )} />;
      })()}
      {tab === 'tag_merge' && (() => {
        const items = visible('tag_merge', data.items.tag_merge, (i) => `${i.a.type} ${i.b.type} ${i.a.label ?? ''} ${i.b.label ?? ''} ${i.why}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <TagMergeCard key={i.key} item={i} n={data.items.tag_merge.indexOf(i) + 1} answer={answerOf('tag_merge', i.key)} onSaved={(d, l) => onSaved(d, 'tag_merge', i.key, l)} />
        )} />;
      })()}
      {tab === 'tag_check' && (() => {
        const items = visible('tag_check', data.items.tag_check, (i) => `${i.card.name} ${i.card.oracle_text} ${i.tags.map((t) => `${t.label ?? ''} ${t.quote}`).join(' ')}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <TagCheckCard key={i.key} item={i} n={data.items.tag_check.indexOf(i) + 1} answer={answerOf('tag_check', i.key)} onSaved={(d, l) => onSaved(d, 'tag_check', i.key, l)} />
        )} />;
      })()}
      {tab === 'type_role' && (() => {
        const items = visible('type_role', data.items.type_role, (i) => `${i.type} ${typeName(i.type, labels)} ${i.examples.map((e) => `${e.name} ${e.quote}`).join(' ')}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <RoleCard key={i.key} item={i} labels={labels} answer={answerOf('type_role', i.key)} onSaved={(d, l) => onSaved(d, 'type_role', i.key, l)} />
        )} />;
      })()}
      {tab === 'reading' && (() => {
        const items = visible('reading', data.items.reading, (i) => `${i.words} ${i.question} ${i.examples.map((e) => e.name).join(' ')}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <ReadingCard key={i.key} item={i} labels={labels} answer={answerOf('reading', i.key)} onSaved={(d, l) => onSaved(d, 'reading', i.key, l)} />
        )} />;
      })()}
      {tab === 'wrong_link' && (() => {
        const items = visible('wrong_link', data.items.wrong_link, (i) => `${i.supply.name} ${i.demand.name}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <WrongLinkCard key={i.key} item={i} n={data.items.wrong_link.indexOf(i) + 1} answer={answerOf('wrong_link', i.key)} onSaved={(d, l) => onSaved(d, 'wrong_link', i.key, l)} />
        )} />;
      })()}
      {tab === 'link_check' && (() => {
        const items = visible('link_check', data.items.link_check, (i) => `${i.supply.name} ${i.demand.name}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <LinkCheckCardView key={i.key} item={i} n={data.items.link_check.indexOf(i) + 1} answer={answerOf('link_check', i.key)} onSaved={(d) => onSaved(d, 'link_check', i.key)} />
        )} />;
      })()}
      {tab === 'cr_text' && (() => {
        const items = visible('cr_text', data.items.cr_text, (i) => `${sourceName(i.main)} ${sourceName(i.member)} ${i.main.text} ${i.member.text}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <CrTextCard key={i.key} item={i} answer={answerOf('cr_text', i.key)} onSaved={(d) => onSaved(d, 'cr_text', i.key)} />
        )} />;
      })()}
      {tab === 'rule_conflict' && (() => {
        const items = visible('rule_conflict', data.items.rule_conflict, (i) => `${i.supply} ${i.demand} ${i.rules.map((r) => r.rule_id).join(' ')}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <ConflictCard key={i.key} item={i} labels={labels} answer={answerOf('rule_conflict', i.key)} onSaved={(d) => onSaved(d, 'rule_conflict', i.key)} />
        )} />;
      })()}
      {tab === 'supply_twin' && (() => {
        const items = visible('supply_twin', data.items.supply_twin, (i) => `${i.types.join(' ')} ${i.types.map((t) => typeName(t, labels)).join(' ')}`);
        return <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
          <TwinCard key={i.key} item={i} labels={labels} answer={answerOf('supply_twin', i.key)} onSaved={(d) => onSaved(d, 'supply_twin', i.key)} />
        )} />;
      })()}
      {tab === 'elsewhere' && <Elsewhere e={data.elsewhere} />}
      {tab === 'link_changes' && <LinkChanges onCounts={setLinkOpen} />}
      {tab === 'rate_round' && rateRound?.rule && (
        <RateRoundStep round={rateRound} labels={labels} answerOf={(key) => answerOf('link_rule', key)} onSaved={(d, key, l) => onSaved(d, 'link_rule', key, l)} />
      )}
      {tab === 'rate_round_2' && round2?.rule && (
        <Round2Step round={round2} answerOf={(key) => answerOf('link_rule', key)} onSaved={(d, key, l) => onSaved(d, 'link_rule', key, l)} />
      )}
      {tab === 'rate_follow_up' && rateFollowUp && (
        <>
          <section className="dc-intro" id="dc-step">
            <h2>{RATE_FOLLOW_UP_TITLE}</h2>
            {rateFollowUp.intro.map((p) => <p key={p}>{p}</p>)}
          </section>
          {rateFollowUp.items.map((i, n) => (
            <RateFollowUpCard key={i.key} item={i} n={n + 1} answer={answerOf('link_rule', i.key)} onSaved={(d, l) => onSaved(d, 'link_rule', i.key, l)} />
          ))}
        </>
      )}
    </div>
  );
}

function List<T>({ items, shown, more, render }: { items: T[]; shown: number; more: () => void; render: (i: T) => ReactNode }) {
  if (items.length === 0) return <div className="dc-empty"><Icon name="check" size={18} /> Nothing here with this filter.</div>;
  return (
    <>
      <div className="dc-list">{items.slice(0, shown).map(render)}</div>
      {items.length > shown && (
        <button type="button" className="btn dc-more" onClick={more}>Show {Math.min(PAGE, items.length - shown)} more ({items.length - shown} left)</button>
      )}
    </>
  );
}

/** The answer buttons, the saved answer and an optional note. A `needsNote` choice saves only with a note. */
function Answer({ kind, itemKey, choices, answer, onSaved, showNote = false }: {
  kind: DecisionKind; itemKey: string; choices: Array<{ choice: string; label: string; hint: string; primary?: boolean; needsNote?: boolean }>;
  answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void; showNote?: boolean;
}) {
  const labelOf = (c: string) => choices.find((x) => x.choice === c)?.label ?? choiceText(c);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(answer?.note ?? '');
  const [noteOpen, setNoteOpen] = useState(showNote || Boolean(answer?.note));
  const save = (choice: string) => {
    if (choices.find((x) => x.choice === choice)?.needsNote && !note.trim()) {
      setNoteOpen(true); setErr('Write your answer in the box, then press the button again.');
      return;
    }
    setBusy(true); setErr(null);
    decisionsApi.save(kind, itemKey, choice, note).then((r) => { onSaved(r.decision, labelOf(choice)); setEditing(false); })
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const clear = () => {
    setBusy(true); setErr(null);
    decisionsApi.clear(kind, itemKey).then(() => { onSaved(null); setEditing(true); })
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  if (answer && !editing) {
    return (
      <div className="dc-answer dc-answered">
        <span className={`dc-chosen dc-chosen-${answer.choice === 'unsure' ? 'unsure' : 'set'}`}><Icon name="check" size={13} /> Your answer: <b>{labelOf(answer.choice)}</b></span>
        {answer.note && <span className="dc-note-text">“{answer.note}”</span>}
        <span className="dc-when">{new Date(answer.decided_at).toLocaleString()}</span>
        <button type="button" className="gx-link" disabled={busy} onClick={() => setEditing(true)}>Change</button>
        <button type="button" className="gx-link" disabled={busy} onClick={clear}>Remove</button>
        {err && <span className="error-inline">{err}</span>}
      </div>
    );
  }
  return (
    <div className="dc-answer">
      <div className="dc-buttons">
        {choices.map((c) => (
          <button key={c.choice} type="button" title={c.hint} className={`btn${c.primary ? ' btn-primary' : ''}${answer?.choice === c.choice ? ' dc-current' : ''}`} disabled={busy} onClick={() => save(c.choice)}>
            {c.label}
          </button>
        ))}
        {!noteOpen && <button type="button" className="gx-link" onClick={() => setNoteOpen(true)}>Add a note</button>}
        {answer && <button type="button" className="gx-link" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      {noteOpen && (
        <textarea className="dc-note" rows={2} dir="auto" placeholder="Optional: why? The note is saved with your answer." value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      {err && <span className="error-inline">{err}</span>}
    </div>
  );
}

function Marked({ text, other }: { text: string; other: string }) {
  return <>{diffWords(text, other).map((w, i) => (w.changed ? <mark key={i}>{w.word}</mark> : <span key={i}>{w.word}</span>))}</>;
}

/** The verdict of the isolated debate (three subagents, text only), not an owner decision. */
function DebateBadge({ d }: { d: NonNullable<CrTextItem['debate']> }) {
  const agreed = d.verdict === 'same' || d.verdict === 'different';
  const text = agreed
    ? `Debate: ${d.verdict} (all 3 agreed, round ${d.round})`
    : `Debate: no agreement (${d.votes.same} same, ${d.votes.different} different)`;
  return <span className={`dc-badge dc-debate dc-debate-${agreed ? d.verdict : 'none'}`} title="Three isolated subagents read only the two texts. Your answer, if you give one, replaces this verdict.">{text}</span>;
}

function CrTextCard({ item, answer, onSaved }: { item: CrTextItem; answer: Decision | undefined; onSaved: (d: Decision | null) => void }) {
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Do these two texts say the same thing?</h3>
        {item.debate && <DebateBadge d={item.debate} />}
        {item.quotes > 0
          ? <span className="dc-badge">used {item.quotes} time{item.quotes === 1 ? '' : 's'} in the reasons</span>
          : <span className="dc-badge dc-badge-quiet">not used in the reasons yet</span>}
      </header>
      <div className="dc-pair">
        <div className="dc-text">
          <div className="dc-text-k">Main text · {sourceName(item.main)}</div>
          <p><Marked text={item.main.text} other={item.member.text} /></p>
        </div>
        <div className="dc-vs" aria-hidden="true">≈</div>
        <div className="dc-text">
          <div className="dc-text-k">Also stated in? · {sourceName(item.member)}</div>
          <p><Marked text={item.member.text} other={item.main.text} /></p>
        </div>
      </div>
      <p className="dc-legend"><mark>Marked</mark> words are only in one of the two texts.</p>
      <Answer kind="cr_text" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'same', label: 'Same – keep one text', hint: 'The two texts state the same rule.', primary: true },
        { choice: 'different', label: 'Different – keep both', hint: 'The marked words change the rule.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

function ConflictCard({ item, labels, answer, onSaved }: {
  item: ConflictItem; labels: Record<string, string>; answer: Decision | undefined; onSaved: (d: Decision | null) => void;
}) {
  const supply = item.supply.startsWith('INTRINSIC.') ? item.supply.slice('INTRINSIC.'.length) : typeName(item.supply, labels);
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>A card that gives <b title={typeTitle(item.supply, labels)}>“{supply}”</b> {item.polarity === '-' ? 'works against' : 'helps'} a card that needs <b title={typeTitle(item.demand, labels)}>“{typeName(item.demand, labels)}”</b> – but when?</h3>
      </header>
      <p className="dc-sub">The reasons differ in {item.differs.map((d) => DIFFERS[d] ?? d).join(' and ')}.</p>
      <div className="dc-rules">
        {item.rules.map((r) => (
          <div key={r.rule_hash} className="dc-rule">
            <div className="dc-rule-id mono">{r.rule_id}</div>
            <p>A card that gives <b>{sideWords(r.supply, labels)}</b> {r.polarity === '-' ? 'works against' : 'helps'} a card that needs <b>{sideWords(r.demand, labels)}</b>.</p>
            {r.implications.length > 0 && (
              <p className="dc-assume">It takes as known: {r.implications.map((i) => `${i.demand_param.replace(/_/g, ' ')} is ${valueWords(i.value)}`).join('; ')}.</p>
            )}
            <p className="dc-meta">{r.votes} of 3 runs wrote this reason.</p>
          </div>
        ))}
      </div>
      <Answer kind="rule_conflict" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'keep_both', label: 'Keep both', hint: 'Both reasons stay. The app does not change.', primary: true },
        ...item.rules.map((r) => ({ choice: `keep:${r.rule_id}`, label: `Keep only ${r.rule_id}`, hint: `Remove the other reason in the next version.` })),
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

function TwinCard({ item, labels, answer, onSaved }: {
  item: TwinItem; labels: Record<string, string>; answer: Decision | undefined; onSaved: (d: Decision | null) => void;
}) {
  const [a, b] = item.types;
  const head = item.demands.slice(0, 6);
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Are these two types of card text one thing?</h3>
      </header>
      <div className="dc-pair">
        <div className="dc-text"><div className="dc-text-k mono">{a}</div><p><b>{typeName(a, labels)}</b></p>{labels[a] && labels[a] !== typeName(a, labels) && <p className="dc-meta">{labels[a]}</p>}</div>
        <div className="dc-vs" aria-hidden="true">≈</div>
        <div className="dc-text"><div className="dc-text-k mono">{b}</div><p><b>{typeName(b, labels)}</b></p>{labels[b] && labels[b] !== typeName(b, labels) && <p className="dc-meta">{labels[b]}</p>}</div>
      </div>
      <p className="dc-sub">Each type has {item.rules[0]} reasons, and all of them are the same for both types. Both help cards that need:</p>
      <ul className="dc-chips">
        {head.map((d) => <li key={d} title={typeTitle(d, labels)}>{typeName(d, labels)}</li>)}
        {item.demands.length > head.length && (
          <li className="dc-chip-more">
            <details><summary>+{item.demands.length - head.length} more</summary>
              {item.demands.slice(head.length).map((d) => <span key={d} title={typeTitle(d, labels)}>{typeName(d, labels)}</span>)}
            </details>
          </li>
        )}
      </ul>
      <Answer kind="supply_twin" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'same', label: 'Same – join them', hint: 'Join the two types in the next version of the tag list.', primary: true },
        { choice: 'different', label: 'Different – keep apart', hint: 'The two types are different things.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

/** The oracle text with the quote of the reason marked. */
function QuoteIn({ text, quote }: { text: string; quote: string }) {
  const i = quote ? text.indexOf(quote) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{quote}</mark>{text.slice(i + quote.length)}</>;
}

function CheckCardBox({ role, card, quote }: { role: string; card: CheckCard; quote: string }) {
  return (
    <div className="dc-text dc-lc-card">
      <div className="dc-text-k">{role}</div>
      <div className="dc-lc-body">
        {card.image && <img className="dc-lc-img" src={card.image} alt={card.name} loading="lazy" data-card-name={card.name} />}
        <div>
          <p><b data-card-name={card.name}>{card.name}</b> {card.mana_cost && <span className="mono dc-meta">{card.mana_cost}</span>}</p>
          <p className="dc-meta">{card.type_line}</p>
          <p className="dc-lc-oracle"><QuoteIn text={card.oracle_text} quote={quote} /></p>
        </div>
      </div>
    </div>
  );
}

function LinkCheckCardView({ item, n, answer, onSaved }: { item: LinkCheckItem; n: number; answer: Decision | undefined; onSaved: (d: Decision | null) => void }) {
  const first = item.reasons[0];
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Pair {n}: does card A help card B?</h3>
        {(item.round ?? 1) > 1 && <span className="dc-badge">new pair · round {item.round}</span>}
        <span className="dc-badge dc-badge-quiet">{item.stratum === 'wide' ? `common reason: ${item.chosen_by!.rule_id} links ${item.chosen_by!.card_pairs.toLocaleString('en-US')} pairs`
          : item.stratum === 'keyword_part' ? 'new link from a keyword part' : 'random pair'}</span>
      </header>
      {item.part && (
        <p className="dc-meta">This link is new. The app does not make it now. It makes it only if "{item.part.keyword_label}" also counts as "{item.part.part_label}"
          {item.part.when === 'may' ? ' (if the player chooses)' : item.part.when === 'if' ? ' (only on a condition)' : ''}, from its rule text. Is the link right?</p>
      )}
      <div className="dc-pair">
        <CheckCardBox role="Card A – gives" card={item.supply} quote={first?.supply_quote ?? ''} />
        <div className="dc-vs" aria-hidden="true">→</div>
        <CheckCardBox role="Card B – needs" card={item.demand} quote={first?.demand_quote ?? ''} />
      </div>
      <p className="dc-legend"><mark>Marked</mark> text is the part that the app links.</p>
      <details className="dc-lc-why">
        <summary>Why the app links them now ({item.reasons.length} reason{item.reasons.length === 1 ? '' : 's'})</summary>
        {item.reasons.map((r, i) => (
          <div key={i} className="dc-rule">
            <p>“{r.supply_quote}” → “{r.demand_quote}” <span className="dc-meta">({r.grade === 'confirmed' ? 'strong match' : 'possible match'})</span></p>
            {r.rules.map((x) => (
              <p key={x.rule_id} className="dc-meta"><span className="mono">{x.rule_id}</span> {x.supply} → {x.demand}: {x.evidence.map((e) => `${e.ref} “${e.quote}”`).join(' · ')}</p>
            ))}
          </div>
        ))}
      </details>
      <Answer kind="link_check" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'link', label: 'Yes, they work together', hint: 'Card A makes card B better. Put them in one deck.', primary: true },
        { choice: 'weak_link', label: 'Yes, but weak', hint: 'A real link, but with a small effect (for example an expensive card A).' },
        { choice: 'no_link', label: 'No', hint: 'Card A gives card B no real help.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

/** The tag groups (atom families) in plain words. */
const FAMILY_WORDS: Record<string, string> = {
  PRODUCES: 'makes or does something',
  ENABLES: 'gives a way to do something',
  CARES_ABOUT: 'watches for something, or gets better from it',
  COMBAT: 'combat ability',
  CONSTRAINTS: 'a limit or a condition',
  INTERACTION: 'acts on other cards or players',
};

/** A tag detail value in words. */
function detailValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(detailValue).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v).replace(/_/g, ' ');
}

function TagLine({ t, hover, setHover, mark }: { t: TagCheckTag; hover: string; setHover: (q: string) => void; mark?: string }) {
  const family = t.type.split('.')[0]!;
  const details = Object.entries(t.params).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  return (
    <li className={`dc-tc-tag${hover === t.quote ? ' on' : ''}`} onMouseEnter={() => setHover(t.quote)} onMouseLeave={() => setHover('')}>
      <p><b title={t.type}>{t.label ?? t.type.split('.')[1]!.toLowerCase().replace(/_/g, ' ')}</b>
        {!t.description && <span className="dc-meta"> · {FAMILY_WORDS[family] ?? family.toLowerCase()}</span>}
        {mark && <span className="dc-badge dc-tc-diff">{mark}</span>}</p>
      {t.description && <p className="dc-tc-desc">{t.description}</p>}
      {t.parts && <p className="dc-meta">Counts as: {t.parts.join(', ')}</p>}
      {details.length > 0 && (
        <p className="dc-meta">{details.map(([k, v]) => <span key={k} className="dc-tc-detail">{k.replace(/_/g, ' ')}: <b>{detailValue(v)}</b></span>)}</p>
      )}
      <p className="dc-tc-quote">from: <q>{t.quote}</q></p>
    </li>
  );
}

function TagCheckCard({ item, n, answer, onSaved }: { item: TagCheckItem; n: number; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  const [hover, setHover] = useState<string>('');
  const old = item.schema_versions.some((v) => v < 15);
  const two = item.reason === 'two_readings';
  const fresh = new Set(item.new_tags ?? []);
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Card {n}: are these tags correct?</h3>
        <span className="dc-badge dc-badge-quiet">{item.tags.length} tag{item.tags.length === 1 ? '' : 's'}</span>
        {old && <span className="dc-badge dc-tc-old" title={`Tag-list version ${item.schema_versions.join(' and ')}. The newest version was 15 when this sample was made.`}>old tags – made with an old tag list</span>}
        {two && <span className="dc-badge dc-tc-diff" title="The AI read this card two times, and the two readings gave different tags.">two readings differ</span>}
      </header>
      {two && <p className="dc-meta">The AI read this card two times. The two readings gave different tags. The app uses the newer reading. Tags marked "new" are only in the newer reading. The tags under the list are only in the older reading.</p>}
      <div className="dc-tc">
        <CheckCardBox role="The card" card={item.card} quote={hover} />
        <div className="dc-tc-tags">
          <div className="dc-text-k">What the app says about this card</div>
          {item.tags.length === 0 && <p className="dc-meta">No tags.</p>}
          <ol>
            {item.tags.map((t, i) => <TagLine key={i} t={t} hover={hover} setHover={setHover} {...(fresh.has(i) ? { mark: 'new' } : {})} />)}
          </ol>
          {two && (item.other_tags ?? []).length > 0 && (
            <>
              <div className="dc-text-k dc-tc-other-k">Only in the older reading (the app does not use these now)</div>
              <ol className="dc-tc-other">
                {item.other_tags!.map((t, i) => <TagLine key={i} t={t} hover={hover} setHover={setHover} mark="older reading" />)}
              </ol>
            </>
          )}
        </div>
      </div>
      <p className="dc-legend">Point at a tag to <mark>mark</mark> its words on the card.</p>
      <Answer kind="tag_check" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'keep', label: 'Correct – keep', hint: two ? 'The tags in the list are right, and no tag is missing. The older-reading tags are not needed.' : 'Every tag is right, and no tag is missing.', primary: true },
        { choice: 'needs_fixing', label: 'Needs fixing', hint: two ? 'A tag is wrong, or a tag is missing (for example, an older-reading tag that should stay). Write which one in the note.' : 'A tag is wrong, or a tag is missing. Write which one in the note.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

const tagName = (s: { type: string; label: string | null }) => s.label ?? s.type.split('.')[1]!.toLowerCase().replace(/_/g, ' ');

function TagMergeCard({ item, n, answer, onSaved }: { item: TagMergeItem; n: number; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  const [a, b] = [tagName(item.a), tagName(item.b)];
  const two = (item.round ?? 1) > 1;
  const roles = item.relation === 'open' ? ['First tag', 'Second tag'] : [item.relation === 'same' ? 'Tag to remove' : 'Tag to make a detail', 'Tag to keep'];
  const sideBox = (s: TagMergeItem['a'], name: string, role: string) => (
    <div className="dc-text">
      <div className="dc-text-k">{role}</div>
      <p><b title={s.type}>{name}</b>{!s.description && <span className="dc-meta"> · {FAMILY_WORDS[s.type.split('.')[0]!] ?? ''}</span>}</p>
      {s.description && <p className="dc-tc-desc">{s.description}</p>}
      <p className="dc-meta">{s.atoms} card text{s.atoms === 1 ? '' : 's'} · {s.rules} link rule{s.rules === 1 ? '' : 's'}</p>
    </div>
  );
  const quotes = (list: TagMergeItem['examples']) => <ul className="dc-quotes">{list.map((e, i) => <li key={i}><q>{e.quote}</q> <span className="dc-meta">– <span data-card-name={e.name}>{e.name}</span></span></li>)}</ul>;
  const signed = (x: number) => (x > 0 ? `+${x.toLocaleString('en-US')}` : x < 0 ? `−${(-x).toLocaleString('en-US')}` : '0');
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      {item.group && <div className="dc-tm-group">{item.group}</div>}
      <header className="dc-card-head">
        {two
          ? <h3>Pair {n}: {item.question}</h3>
          : <h3>Pair {n}: is <b>“{a}”</b> {item.relation === 'same' ? 'the same as' : 'only a kind of'} <b>“{b}”</b>?</h3>}
        {two && <span className="dc-badge">round {item.round}</span>}
        <span className="dc-badge dc-badge-quiet">{item.together === 0 ? 'never on the same text' : `together on ${item.together} of ${item.a.atoms} texts`}</span>
      </header>
      <div className="dc-pair">
        {sideBox(item.a, a, roles[0]!)}
        <div className="dc-vs" aria-hidden="true">{item.relation === 'open' ? '?' : '→'}</div>
        {sideBox(item.b, b, roles[1]!)}
      </div>
      {two ? (
        <div className="dc-tm-sides">
          <div><div className="dc-sub">What shows one meaning</div><ul>{item.one_meaning!.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          <div><div className="dc-sub">What shows two meanings</div><ul>{item.two_meanings!.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        </div>
      ) : <p className="dc-now"><b>Why Claude thinks they are one meaning: </b>{item.why}</p>}
      {item.evidence.map((e) => (
        <p key={e.ref} className="dc-tm-rule"><span className="mono">Rule {e.ref}</span> “{e.text}”</p>
      ))}
      {two && <p className="dc-now"><b>What Claude thinks: </b>{item.why}</p>}
      {item.examples.length > 0 && <><div className="dc-sub">Card texts with both tags now:</div>{quotes(item.examples)}</>}
      {item.a_only && item.a_only.length > 0 && <><div className="dc-sub">Card texts with only “{a}”, not “{b}”:</div>{quotes(item.a_only)}</>}
      {item.b_only && item.b_only.length > 0 && <><div className="dc-sub">Card texts with only “{b}”, not “{a}”:</div>{quotes(item.b_only)}</>}
      {item.effects && item.effects.length > 0 && (
        <>
          <div className="dc-sub">Effect on the links, measured on a copy of the database (build 16 is the base):</div>
          <table className="dc-tm-effects">
            <thead><tr><th>If the app does this</th><th>Card pairs that get a new link</th><th>Card pairs that lose their link</th><th>“Bad together” pairs</th><th>Test pairs</th></tr></thead>
            <tbody>{item.effects.map((e, i) => (
              <tr key={i}><td>{e.change}</td><td className="num">{signed(e.synergy_added)}</td><td className="num">{signed(-e.synergy_lost)}</td><td className="num">{signed(e.anti_change)}</td><td>{e.golden}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      <p className="dc-effect"><Icon name="info" size={14} /> <span><b>What changes if you approve: </b>{item.change}</span></p>
      <Answer kind="tag_merge" itemKey={item.key} answer={answer} onSaved={onSaved} choices={item.choices
        ? item.choices.map((c, i) => ({ ...c, ...(i === 0 ? { primary: true } : {}) }))
        : [
          { choice: 'merge', label: 'Merge', hint: 'Approve the change above.', primary: true },
          { choice: 'keep_both', label: 'Keep both', hint: 'The two tags mean different things. Write why in the note.' },
          { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
        ]} />
    </article>
  );
}

function Elsewhere({ e }: { e: DecisionPage['elsewhere'] }) {
  const rows: Array<{ n: number; href: string; title: string; text: string }> = [
    { n: e.review_edge_rules, href: '#/review?domain=edge', title: 'Disputed reasons', text: 'Three runs did not agree on these reasons, and a debate did not agree either. They are not in use until someone decides.' },
    { n: e.edge_reports, href: '#/review?domain=edge', title: 'Your link reports', text: 'Links that you reported as wrong.' },
    { n: e.fix_requests, href: '#/review?domain=edge', title: 'Fix requests in progress', text: 'Reasons that you sent to a Claude session to fix.' },
    { n: e.review_atom, href: '#/review', title: 'Card-reading questions', text: 'Card texts where the reading runs did not agree, or found text with no type.' },
  ];
  return (
    <div className="dc-list">
      <section className="dc-intro">
        <h2>On other pages</h2>
        <p>These items already have their own page, in the Review queue. You can open them from here.</p>
      </section>
      {rows.map((r) => (
        <a key={r.title} className="dc-else" href={r.href}>
          <span className="dc-else-n">{r.n.toLocaleString('en-US')}</span>
          <span><b>{r.title}</b><span>{r.text}</span></span>
          <Icon name="arrowRight" size={16} />
        </a>
      ))}
    </div>
  );
}

const ABILITY_WORDS: Record<string, string> = {
  triggered: 'by a triggered ability', activated: 'by an activated ability', other: 'by a spell effect, a keyword or a static ability',
};

/** The job of a pair in words, with the details of its one-effect group. */
function jobWords(job: RoundJob, labels: Record<string, string>): string {
  const details = Object.entries(job.params).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${detailValue(v)}`).join(', ');
  const ability = ABILITY_WORDS[job.ability];
  return `${typeName(job.type, labels)}${details ? ` (${details})` : ''}${ability ? `, ${ability}` : ''}`;
}

/** Each face of a card: what the owner must read. The body is in the words too, as an image can fail to load. */
function RateCardBox({ role, card }: { role: string; card: RoundCard }) {
  return (
    <div className="dc-text dc-lc-card">
      <div className="dc-text-k">{role}</div>
      <div className="dc-lc-body">
        {card.image && <img className="dc-lc-img" src={card.image} alt={card.name} loading="lazy" data-card-name={card.name} />}
        <div>
          {card.faces.map((f, i) => (
            <div key={i}>
              <p><b data-card-name={card.name}>{f.name}</b> {f.mana_cost && <span className="mono dc-meta">{f.mana_cost}</span>}</p>
              <p className="dc-meta">{f.type_line}{f.power !== null && ` · ${f.power}/${f.toughness}`}</p>
              <p className="dc-lc-oracle"><QuoteIn text={f.oracle_text} quote={card.quote} /></p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One pair of the round. It shows no rate, no gap and no side of the app. */
function RatePairCard({ item, n, labels, answer, onSaved }: { item: RateRoundItem; n: number; labels: Record<string, string>; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head"><h3>Pair {n}: which card is better at this job?</h3></header>
      <p className="dc-now"><b>The job: </b>{jobWords(item.job, labels)}</p>
      <div className="dc-pair">
        <RateCardBox role="Card A" card={item.a} />
        <div className="dc-vs" aria-hidden="true">or</div>
        <RateCardBox role="Card B" card={item.b} />
      </div>
      {item.a.quote && <p className="dc-legend"><mark>Marked</mark> text is the part of each card that does this job.</p>}
      <Answer kind="link_rule" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'a_better', label: 'Card A is better', hint: 'In a deck that wants this effect, card A does this job better.' },
        { choice: 'b_better', label: 'Card B is better', hint: 'In a deck that wants this effect, card B does this job better.' },
        { choice: 'equal', label: 'About equal', hint: 'Neither card is clearly better at this job.' },
        { choice: 'cannot_compare', label: 'I cannot compare', hint: 'The two cards are too different, or you do not know.' },
        { choice: 'other', label: 'Other: write my answer', hint: 'No button fits. Write your own answer in the box.', needsNote: true },
      ]} />
    </article>
  );
}

const WHOLE_CARD_CHOICES = [
  { choice: 'a_better', label: 'Card A is the better whole card', hint: 'In a deck that wants this effect, you play card A.', needsNote: true },
  { choice: 'b_better', label: 'Card B is the better whole card', hint: 'In a deck that wants this effect, you play card B.', needsNote: true },
  { choice: 'equal', label: 'About equal', hint: 'Neither card is clearly better.', needsNote: true },
  { choice: 'cannot_compare', label: 'I cannot compare', hint: 'The two cards are too different, or you do not know.', needsNote: true },
  { choice: 'other', label: 'Other: write my answer', hint: 'No button fits. Write your own answer in the box.', needsNote: true },
];
const ROUND_QUESTION_CHOICES = [
  { choice: 'yes', label: 'Yes', hint: 'It played a part in most choices.' },
  { choice: 'sometimes', label: 'Sometimes', hint: 'It played a part in a few choices.' },
  { choice: 'no', label: 'No', hint: 'It played no part.' },
  { choice: 'other', label: 'Other: write my answer', hint: 'No button fits. Write your own answer in the box.', needsNote: true },
];

/** One why-question after the round. It shows no rate and no side of the app. */
function RateFollowUpCard({ item, n, answer, onSaved }: { item: RateFollowUpItem; n: number; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head"><h3>Question {n}: {item.pair === null ? 'about the whole round' : `pair ${item.pair} of the round`}</h3></header>
      <p className="dc-tm-rule">{item.ask}</p>
      {item.your_answer && <p className="dc-now"><b>Your answer in the round: </b>{item.your_answer}</p>}
      {item.a && item.b && (
        <div className="dc-pair">
          <RateCardBox role="Card A" card={item.a} />
          <div className="dc-vs" aria-hidden="true">or</div>
          <RateCardBox role="Card B" card={item.b} />
        </div>
      )}
      <Answer kind="link_rule" itemKey={item.key} answer={answer} onSaved={onSaved} showNote choices={item.pair === null ? ROUND_QUESTION_CHOICES : WHOLE_CARD_CHOICES} />
    </article>
  );
}

function RateRoundStep({ round, labels, answerOf, onSaved }: {
  round: RateRoundPage; labels: Record<string, string>; answerOf: (key: string) => Decision | undefined; onSaved: (d: Decision | null, key: string, label?: string) => void;
}) {
  const [show, setShow] = useState<'open' | 'answered' | 'all'>('open');
  const [shown, setShown] = useState(PAGE);
  const rule = round.rule!;
  const answered = round.items.filter((i) => answerOf(i.key)).length;
  const items = round.items.filter((i) => show === 'all' || Boolean(answerOf(i.key)) === (show === 'answered'));
  return (
    <>
      <section className="dc-intro" id="dc-step">
        <h2>{RATE_ROUND_TITLE}</h2>
        <p>{rule.test}</p>
        <p>{rule.pairs}</p>
        <p>{rule.question}</p>
        <p><b>{rule.pass_line}</b></p>
        <p className="dc-effect"><Icon name="info" size={14} /> {rule.effect}</p>
      </section>
      <div className="dc-toolbar">
        <div className="dc-seg" role="tablist" aria-label="Show">
          {(['open', 'answered', 'all'] as const).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={show === f} className={show === f ? 'on' : ''} onClick={() => { setShow(f); setShown(PAGE); }}>
              {f === 'open' ? `Open (${round.items.length - answered})` : f === 'answered' ? `Answered by you (${answered})` : `All (${round.items.length})`}
            </button>
          ))}
        </div>
      </div>
      <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
        <RatePairCard key={i.key} item={i} n={round.items.indexOf(i) + 1} labels={labels} answer={answerOf(i.key)} onSaved={(d, l) => onSaved(d, i.key, l)} />
      )} />
    </>
  );
}

const ROUND2_CHOICES = [
  { choice: 'a_better', label: 'Card A is better', hint: 'Card A is the better whole card at this cost.' },
  { choice: 'b_better', label: 'Card B is better', hint: 'Card B is the better whole card at this cost.' },
  { choice: 'equal', label: 'About equal', hint: 'Neither card is better.' },
  { choice: 'depends', label: 'It depends on the deck', hint: 'Write what kind of deck decides it.', needsNote: true },
  { choice: 'cannot_compare', label: 'I cannot compare', hint: 'The two cards do not compare, or you do not know.' },
  { choice: 'other', label: 'Other: write my answer', hint: 'No button fits. Write your own answer in the box.', needsNote: true },
];

/** The image of a card, from the card route: the round route sends only the words. */
function useCardImage(oracleId: string): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/cards/${oracleId}`).then((r) => (r.ok ? r.json() as Promise<{ card: { image_normal: string | null }; faces: Array<{ image_normal: string | null }> }> : null))
      .then((j) => setImage(j?.card.image_normal ?? j?.faces[0]?.image_normal ?? null)).catch(() => setImage(null));
  }, [oracleId]);
  return image;
}

/** One pair of round 2. It shows no job and no value of the app. */
function Round2PairCard({ item, n, answer, onSaved }: { item: Round2Item; n: number; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  const [a, b] = item.key.slice('rr2:'.length).split('~') as [string, string];
  const [imageA, imageB] = [useCardImage(a), useCardImage(b)];
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head"><h3>Pair {n}: which is the better whole card at this cost?</h3></header>
      <div className="dc-pair">
        <RateCardBox role="Card A" card={{ ...item.a, image: imageA }} />
        <div className="dc-vs" aria-hidden="true">or</div>
        <RateCardBox role="Card B" card={{ ...item.b, image: imageB }} />
      </div>
      <Answer kind="link_rule" itemKey={item.key} answer={answer} onSaved={onSaved} choices={ROUND2_CHOICES} />
    </article>
  );
}

function Round2Step({ round, answerOf, onSaved }: {
  round: Round2Page; answerOf: (key: string) => Decision | undefined; onSaved: (d: Decision | null, key: string, label?: string) => void;
}) {
  const [show, setShow] = useState<'open' | 'answered' | 'all'>('open');
  const [shown, setShown] = useState(PAGE);
  const rule = round.rule!;
  const answered = round.items.filter((i) => answerOf(i.key)).length;
  const items = round.items.filter((i) => show === 'all' || Boolean(answerOf(i.key)) === (show === 'answered'));
  return (
    <>
      <section className="dc-intro" id="dc-step">
        <h2>{ROUND2_TITLE}</h2>
        <p>{rule.test}</p>
        <p>{rule.pairs}</p>
        <p>{rule.question}</p>
        <p>{rule.answers}</p>
        <p><b>{rule.pass_line}</b></p>
        <p className="dc-effect"><Icon name="info" size={14} /> {rule.effect}</p>
      </section>
      <div className="dc-toolbar">
        <div className="dc-seg" role="tablist" aria-label="Show">
          {(['open', 'answered', 'all'] as const).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={show === f} className={show === f ? 'on' : ''} onClick={() => { setShow(f); setShown(PAGE); }}>
              {f === 'open' ? `Open (${round.items.length - answered})` : f === 'answered' ? `Answered by you (${answered})` : `All (${round.items.length})`}
            </button>
          ))}
        </div>
      </div>
      <List items={items} shown={shown} more={() => setShown((s) => s + PAGE)} render={(i) => (
        <Round2PairCard key={i.key} item={i} n={round.items.indexOf(i) + 1} answer={answerOf(i.key)} onSaved={(d, l) => onSaved(d, i.key, l)} />
      )} />
    </>
  );
}

type Counts = Record<DecisionKind, { total: number; answered: number; debated: number; open: number }>;

/** The three high-help steps, with the time each one takes, and the four answer rules. */
function StartHere({ counts, tab, setTab }: { counts: Counts; tab: Tab; setTab: (k: DecisionKind) => void }) {
  const open = HIGH.reduce((s, k) => s + counts[k].open, 0);
  const total = HIGH.reduce((s, k) => s + counts[k].total, 0);
  const minutes = Math.max(1, Math.round(HIGH.reduce((s, k) => s + counts[k].open * KINDS[k].minutes, 0)));
  const go = (k: DecisionKind) => {
    setTab(k);
    requestAnimationFrame(() => document.getElementById('dc-step')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  return (
    <section className="dc-start">
      <div className="dc-start-head">
        <h2>{open === 0 ? 'The important questions are answered' : 'Start here'}</h2>
        <p>
          {open === 0
            ? `You answered all ${total} questions that help the app most. Thank you. The optional questions are below.`
            : `${open} question${open === 1 ? '' : 's'} help the app most. They take about ${minutes} minute${minutes === 1 ? '' : 's'}. Do the steps in order.`}
        </p>
      </div>
      <ol className="dc-steps">
        {HIGH.map((k, i) => {
          const c = counts[k];
          const left = Math.max(1, Math.round(c.open * KINDS[k].minutes));
          return (
            <li key={k}>
              <button type="button" className={`dc-step${tab === k ? ' active' : ''}${c.open === 0 ? ' done' : ''}`} onClick={() => go(k)}>
                <span className="dc-step-n">{c.open === 0 ? <Icon name="check" size={16} /> : i + 1}</span>
                <span className="dc-step-body">
                  <span className="dc-step-title">{KINDS[k].title}</span>
                  <span className="dc-step-sub">{KINDS[k].short}</span>
                </span>
                <span className="dc-step-num">
                  {c.open === 0 ? 'done' : <><b>{c.open}</b> open · about {left} min</>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <ul className="dc-how">
        <li><b>Use your own Magic knowledge.</b> The app does not know Magic. That is why it asks you.</li>
        <li><b>Each answer is saved at once.</b> You can change it or undo it later.</li>
        <li><b>If you do not know, press “Not sure”.</b> That is a good answer too.</li>
        <li><b>Nothing in the app changes yet.</b> Claude applies your answers in a later step.</li>
      </ul>
    </section>
  );
}

function ReadingCard({ item, labels, answer, onSaved }: {
  item: ReadingItem; labels: Record<string, string>; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void;
}) {
  const name = (t: string) => `“${typeName(t, labels)}”`;
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>{item.question}</h3>
        <span className="dc-badge dc-badge-quiet">{item.cards} card{item.cards === 1 ? ' has' : 's have'} this text</span>
      </header>
      <p className="dc-words"><span>The card text:</span> <q>{item.words}</q></p>
      <p className="dc-now">
        <b>What the app does now: </b>
        {item.types.map((t) => `${item.with_type[t] ?? 0} of ${item.cards} cards are read as ${name(t)}`).join('. ')}.
      </p>
      <div className="dc-examples">
        {item.examples.map((e) => (
          <div key={e.name} className="dc-text">
            <div className="dc-text-k"><span data-card-name={e.name}>{e.name}</span></div>
            <p><QuoteIn text={e.line} quote={e.match} /></p>
            <p className="dc-meta">
              Read now as: {e.now.length ? e.now.map((t) => typeName(t, labels)).join(', ') : 'nothing (no type)'}
            </p>
          </div>
        ))}
      </div>
      <p className="dc-why"><Icon name="info" size={14} /> <span><b>Why we ask:</b> {item.source}</span></p>
      <Answer kind="reading" itemKey={item.key} answer={answer} onSaved={onSaved} choices={item.choices} />
    </article>
  );
}

function RoleCard({ item, labels, answer, onSaved }: {
  item: RoleItem; labels: Record<string, string>; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void;
}) {
  const name = typeName(item.type, labels);
  const needHelp = item.needs === 'demand';
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>
          Can a <b title={typeTitle(item.type, labels)}>“{name}”</b> text also {needHelp ? 'need help from other cards' : 'help other cards'}?
        </h3>
        <span className="dc-badge dc-badge-quiet">{item.atoms} card text{item.atoms === 1 ? '' : 's'} of this type</span>
      </header>
      <p className="dc-now">
        <b>What the app does now: </b>
        {needHelp
          ? `it uses “${name}” only as a text that gives help. So it never looks for cards that help a “${name}” text.`
          : `it uses “${name}” only as a text that needs help. So it never looks for cards that a “${name}” text helps.`}
      </p>
      <div className="dc-sub">Examples of this type of text:</div>
      <ul className="dc-quotes">
        {item.examples.map((e) => <li key={e.name}><q>{e.quote}</q> <span className="dc-meta">– <span data-card-name={e.name}>{e.name}</span></span></li>)}
      </ul>
      {item.pairs.map((p) => (
        <div key={p.pair_id} className="dc-missed">
          <div className="dc-sub">The app misses this pair. An earlier check said that these two cards work together:</div>
          <div className="dc-pair">
            <CheckCardBox role="Card A – gives" card={p.supply} quote={p.supply_quote} />
            <div className="dc-vs" aria-hidden="true">→</div>
            <CheckCardBox role="Card B – needs" card={p.demand} quote={p.demand_quote} />
          </div>
        </div>
      ))}
      <p className="dc-legend"><mark>Marked</mark> text is the part that the earlier check used.</p>
      <Answer kind="type_role" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'both', label: 'Yes – both ways', hint: needHelp ? `A “${name}” text can also need help from other cards.` : `A “${name}” text can also help other cards.` },
        { choice: 'keep', label: 'No – keep one direction', hint: 'Keep the type as it is.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}

/** One card pair with no label, no reason and no marked text, so that nothing steers the answer. */
function BlindPairCard({ kind, item, n, badge, answer, onSaved }: { kind: 'golden_check' | 'link_rule'; item: GoldenCheckItem | LinkRuleItem; n: number; badge?: string; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  const followUp = 'ask' in item ? item : null;
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Pair {n}: {followUp ? 'a question about your answer' : 'does card A help card B?'}</h3>
        {badge && <span className="dc-badge dc-badge-quiet">{badge}</span>}
      </header>
      {followUp && <p className="dc-tm-rule">{followUp.ask}</p>}
      <div className="dc-pair">
        <CheckCardBox role="Card A" card={item.supply} quote="" />
        <div className="dc-vs" aria-hidden="true">→</div>
        <CheckCardBox role="Card B" card={item.demand} quote="" />
      </div>
      {followUp?.compare && (
        <>
          <div className="dc-tm-group">The other pair. Your answer: {followUp.compare.answer}</div>
          <div className="dc-pair">
            <CheckCardBox role="Card A" card={followUp.compare.supply} quote="" />
            <div className="dc-vs" aria-hidden="true">→</div>
            <CheckCardBox role="Card B" card={followUp.compare.demand} quote="" />
          </div>
        </>
      )}
      <Answer kind={kind} itemKey={item.key} answer={answer} onSaved={onSaved} showNote={Boolean(followUp)} choices={[
        { choice: 'link', label: 'Yes, they work together', hint: 'Card A makes card B better. Put them in one deck.' },
        { choice: 'weak_link', label: 'Yes, but weak', hint: 'A real link, with a high cost, a slow play or a small reward.' },
        { choice: 'no_link', label: 'No, no link at all', hint: 'Card A gives card B no help, or only because it is a creature.' },
        { choice: 'anti', label: 'No, card A works against card B', hint: 'Card A makes card B worse.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
        ...(kind === 'link_rule' ? [{ choice: 'other', label: 'Other: write my answer', hint: 'No button fits. Write your own answer in the box.', needsNote: true }] : []),
      ]} />
    </article>
  );
}

function WrongLinkCard({ item, n, answer, onSaved }: { item: WrongLinkItem; n: number; answer: Decision | undefined; onSaved: (d: Decision | null, label?: string) => void }) {
  const first = item.reasons[0];
  const says = [item.polarities.includes('+') ? 'helps' : '', item.polarities.includes('-') ? 'works against' : ''].filter(Boolean).join(' and also ');
  return (
    <article className={`dc-card${answer ? ' is-answered' : ''}`}>
      <header className="dc-card-head">
        <h3>Pair {n}: does card A help card B?</h3>
        <span className="dc-badge dc-badge-quiet">the app and an earlier check do not agree</span>
      </header>
      <div className="dc-pair">
        <CheckCardBox role="Card A" card={item.supply} quote={first?.supply_quote ?? ''} />
        <div className="dc-vs" aria-hidden="true">→</div>
        <CheckCardBox role="Card B" card={item.demand} quote={first?.demand_quote ?? ''} />
      </div>
      <p className="dc-legend"><mark>Marked</mark> text is the part that the app uses.</p>
      <details className="dc-lc-why">
        <summary>What the app says, and why (open it only if you need it)</summary>
        <p className="dc-meta">The app says: card A {says} card B.</p>
        {item.reasons.map((r, i) => (
          <div key={i} className="dc-rule">
            <p>“{r.supply_quote}” → “{r.demand_quote}”</p>
            {r.rules.map((x) => (
              <p key={x.rule_id} className="dc-meta"><span className="mono">{x.rule_id}</span> {x.supply} → {x.demand}: {x.evidence.map((e) => `${e.ref} “${e.quote}”`).join(' · ')}</p>
            ))}
          </div>
        ))}
      </details>
      <Answer kind="wrong_link" itemKey={item.key} answer={answer} onSaved={onSaved} choices={[
        { choice: 'link', label: 'Yes, they work together', hint: 'Card A makes card B better. Put them in one deck.' },
        { choice: 'weak_link', label: 'Yes, but weak', hint: 'A real link, but with a small effect.' },
        { choice: 'no_link', label: 'No, no real effect', hint: 'Card A gives card B no real help.' },
        { choice: 'anti', label: 'No, card A works against card B', hint: 'Card A makes card B worse.' },
        { choice: 'unsure', label: 'Not sure', hint: 'Keep the question for later.' },
      ]} />
    </article>
  );
}
