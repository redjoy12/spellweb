/**
 * npm run cr-duplicates -- [--list <md>]
 *
 * Read only (owner request 2026-10-18, docs/phase-3-duplicate-reasons.md sec. 11): the repeated
 * sentences of the current CR corpus (src/rules/crDuplicates.ts) by tier, and a dry run of the
 * evidence mapping of the accepted edge-rule set (src/graph/evidenceRefs.ts): how many quotes
 * locate in the stored text, move to a main sentence, or repeat another quote of the same list.
 * --list writes every group (main sentence, members, tiers) to a Markdown file.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../db/client.js';
import { currentCorpusId } from '../atoms/golden.js';
import { crDuplicates, withConfirmed, type CrDuplicates } from '../rules/crDuplicates.js';
import { confirmedSame } from '../graph/crDebate.js';
import { mapEvidenceList } from '../graph/evidenceRefs.js';
import type { Evidence } from '../graph/quotes.js';
import { currentRuleSet, getRuleSet, setRoles, setRules } from '../graph/ruleSet.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const db = openDb();
const corpusId = currentCorpusId(db);
// The fuzzy pairs that an owner answer or an agreed debate verdict confirms as `same` are applied too.
const d = withConfirmed(crDuplicates(db, corpusId), confirmedSame(db, corpusId));
const tiers: Record<string, { members: number; chars: number }> = {};
for (const g of d.groups) for (const m of g.members) {
  const t = (tiers[m.tier] ??= { members: 0, chars: 0 });
  t.members++; t.chars += m.text.length;
}
const out: Record<string, unknown> = { corpus: corpusId, sentences: d.sentences.length, groups: d.groups.length, tiers, applied: d.mainOf.size, fuzzy_confirmed_same: d.mainOf.size - (tiers['exact']?.members ?? 0) - (tiers['contained']?.members ?? 0) };

const set = currentRuleSet(db);
if (set) {
  const setCorpus = getRuleSet(db, set.id)!.corpus_id;
  const lists: Evidence[][] = [];
  for (const r of setRules(db, set.id, 'all')) { lists.push(r.evidence); for (const i of r.implications) lists.push(i.evidence); }
  for (const r of setRoles(db, set.id)) { lists.push(r.evidence); for (const x of r.resources) lists.push(x.evidence); }
  const none: CrDuplicates = { ...d, mainOf: new Map() };
  const run = (dd: CrDuplicates) => lists.reduce((s, l) => {
    const m = mapEvidenceList(db, setCorpus, l, dd);
    return { quotes: s.quotes + l.length, unlocated: s.unlocated + m.unlocated.length, mapped: s.mapped + m.mapped, dropped: s.dropped + m.dropped, lists_with_drops: s.lists_with_drops + (m.dropped ? 1 : 0) };
  }, { quotes: 0, unlocated: 0, mapped: 0, dropped: 0, lists_with_drops: 0 });
  out['evidence'] = { set: set.id, corpus: setCorpus, lists: lists.length, without_groups: run(none), with_groups: setCorpus === corpusId ? run(d) : 'corpus differs' };
}
console.log(JSON.stringify(out, null, 2));

const list = opt('--list');
if (list) {
  const cell = (s: string) => s.replace(/\|/g, '\|').replace(/\s+/g, ' ');
  const label = (s: { source: string; ref: string }) => (s.source === 'rule' ? `CR ${s.ref}` : `glossary ${s.ref}`);
  const L = ['| Main text | Also stated in (tier) |', '|---|---|'];
  for (const g of d.groups) {
    L.push(`| ${label(g.main)}: "${cell(g.main.text)}" | ${g.members.map((m) => `${label(m)} (${m.tier})${m.tier === 'fuzzy' ? `: "${cell(m.text)}"` : ''}`).join('<br>')} |`);
  }
  writeFileSync(list, L.join('\n') + '\n', 'utf8');
  console.log(`list: ${list}`);
}
