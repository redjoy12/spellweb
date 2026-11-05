import { useEffect, useState } from 'react';
import { api } from '../api.js';

export { kindName, plainSide, reasonSentence, scopeName, sideText, typeName, typePairName, typeTitle } from './plain.js';

/**
 * Plain-language names for the project terms (owner request after the first demo look, 2026-10-18).
 * Official Magic words (activated ability, token, mana value, Comprehensive Rules) stay as they are;
 * the words that the project made (atom, edge, supply/demand, grade, class node, tier, build) get a
 * plain name and a short explanation. Each <Term> in the UI opens one of these entries.
 */

export interface GlossaryEntry { term: string; plain: string; more?: string; project?: string }

export const GLOSSARY = {
  link: {
    term: 'Link',
    plain: 'One card helps another card. The system found this in the card text: one card gives something that the other card needs.',
    project: 'edge',
  },
  gives: {
    term: 'Gives',
    plain: 'What a card does or makes. Examples: "creates a token", "makes mana", "a creature dies".',
    project: 'supply',
  },
  needs: {
    term: 'Needs',
    plain: 'What a card uses or cares about. Examples: "whenever a creature dies", "pay mana to activate", "if you control an artifact".',
    project: 'demand',
  },
  strong: {
    term: 'Strong match',
    plain: 'All conditions of the reason are true for the two cards.',
    more: 'This is not proof of a good synergy. A broad link can also be a strong match.',
    project: 'grade "confirmed"',
  },
  possible: {
    term: 'Possible match',
    plain: 'The reason fits the two cards, but the card text does not tell if some conditions are true. The open conditions show next to the label.',
    project: 'grade "plausible"',
  },
  broad: {
    term: 'Broad link',
    plain: 'The "needs" side has no details in the current card-reading format. So every card that gives the thing links to every card that needs it.',
    more: 'Example: every card that makes mana links to every card with an activated ability. Many broad links are not real synergies. This is the main known problem of this version.',
    project: '"demand type without params"',
  },
  strength: {
    term: 'Strength',
    plain: 'A number that puts the links in order. Higher is stronger.',
    more: 'It combines the match (a strong match counts double), how often the effect can repeat, the cost, and how many cards share the link. It is not a quality score.',
    project: 'weight',
  },
  reason: {
    term: 'Reason',
    plain: 'A general statement that the system wrote from card text and the Comprehensive Rules, for example "a card that makes mana helps a card that pays mana to activate".',
    more: 'Each reason has an ID (like ER-0123) and quotes from the rules as evidence. Many links can share one reason.',
    project: 'edge rule',
  },
  fix: {
    term: 'Fix request',
    plain: 'You give one reason to a Claude session with a name that you choose. The session reads all your reports on this reason, finds why the reason makes these links, and writes a short report with the smallest fix.',
    more: 'Your report notes count as your decisions. The session does not change a reason or make a new graph version without a clear plan. Use the same session name again to give more work to the same session.',
    project: 'fix_requests row and brief file in data/fix-requests',
  },
  kind: {
    term: 'Card-kind link',
    plain: 'A link to a whole group of cards, for example "every creature card". The group comes from the type line, the mana value or the colour.',
    project: 'class edge / class node',
  },
  conflict: {
    term: 'Conflict',
    plain: 'One card works against the other card, for example it removes or stops what the other card needs.',
    project: 'anti-synergy edge',
  },
  loop: {
    term: 'Loop',
    plain: 'A chain of links that comes back to the first card: A helps B, B helps C, C helps A. The system searches for loops only when you ask.',
    project: 'cycle',
  },
  marked: {
    term: 'Marked text',
    plain: 'A short piece of rules text that the system read as one fact, for example "Create a 1/1 black Rat creature token". Links connect marked texts.',
    project: 'atom',
  },
  version: {
    term: 'Graph version',
    plain: 'One complete calculation of all links for one colour group (here: the Black-Red cards). A new version is made when the card reading or the reasons change.',
    project: 'graph build',
  },
  testPairs: {
    term: 'Test pairs',
    plain: 'Card pairs with a known answer ("synergy" or "no synergy"). Separate AI checkers labelled them from the card text only. The system uses them to measure its accuracy.',
    project: 'golden pairs',
  },
  rightStrong: {
    term: 'Right strong matches',
    plain: 'Of the test pairs that the graph calls a strong match, the share that really is a synergy. Target: 90%.',
    project: 'confirmed precision',
  },
  found: {
    term: 'Synergies found',
    plain: 'Of the test pairs that really are a synergy, the share that the graph links. Target: 90%.',
    project: 'synergy recall',
  },
  format: {
    term: 'Card-reading format',
    plain: 'The list of facts that the system can read from card text: the tags of config/atom-schema.json.',
    more: 'A new version of the tag list can add details to the "needs" side. That removes broad links.',
    project: 'atom schema',
  },
  outdated: {
    term: 'Out of date',
    plain: 'The card reading changed after this graph version was made. Make a new version to include the change.',
    project: 'stale build',
  },
} satisfies Record<string, GlossaryEntry>;

export type TermId = keyof typeof GLOSSARY;

/** The loop kinds (spec sec. 9.5) in plain words. A loop kind is not a quality score. */
export const LOOP_KIND: Record<1 | 2 | 3, { label: string; plain: string }> = {
  3: { label: 'Infinite combo', plain: 'The loop can repeat with no limit, all amounts are known, all links are strong matches, and something grows each time.' },
  2: { label: 'Repeatable engine', plain: 'Every step is a triggered or activated ability, and no step uses up more than the loop gives back.' },
  1: { label: 'Value loop', plain: 'Any other loop: some step is not a triggered or activated ability, or the loop uses up more than it gives back.' },
};

/** The ability kinds of the card text. Triggered and activated are Magic terms. */
export const ABILITY_KIND: Record<string, string> = {
  triggered: 'triggered ability',
  activated: 'activated ability',
  other: 'other text',
};

// ---------- type labels ----------

let labelsPromise: Promise<Record<string, string>> | null = null;

/** The vocabulary labels ("PRODUCES.MANA_PRODUCTION" -> "Produces mana by colour"), loaded one time. */
export function useTypeLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    // A failed load is not kept, so that the next page can try again.
    labelsPromise ??= api.graphLabels().then((r) => r.labels).catch(() => { labelsPromise = null; return {}; });
    let live = true;
    void labelsPromise.then((l) => { if (live) setLabels(l); });
    return () => { live = false; };
  }, []);
  return labels;
}
