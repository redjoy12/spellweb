/**
 * npm run duplicate-rules -- [--build <id>] [--tables <md>]
 *
 * Read only (Phase 3 spec rev. 11 sec. 5.8): the duplicate-rule analysis of the accepted
 * edge-rule set. It prints the counts of subsumed rules, conflicting type pairs and supply twins,
 * the merged edges of the build (default: the newest build of the set) that each class touches,
 * and the proof that the build rules give the same merged edges and card pairs as all accepted
 * rules. --tables writes the report tables (docs/phase-3-duplicate-reasons.md) to a file.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../db/client.js';
import { analyseDuplicates, renderDuplicateTables } from '../graph/duplicateRules.js';
import { currentRuleSet } from '../graph/ruleSet.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const db = openDb();
const set = currentRuleSet(db);
if (!set) throw new Error('no accepted edge-rule set');
const buildId = opt('--build') !== undefined ? Number(opt('--build'))
  : (db.prepare('SELECT MAX(id) id FROM graph_builds WHERE rule_set_id = ?').get(set.id) as { id: number | null }).id;
const a = analyseDuplicates(db, set.id, buildId);
console.log(JSON.stringify({
  set: a.set_id, build: a.build_id, accepted: a.accepted, type_pairs: a.type_pairs, multi_type_pairs: a.multi_type_pairs,
  multi_rules: a.multi_rules, subsumed: a.subsumed.length, conflict_type_pairs: a.conflicts.length,
  conflict_rules: a.conflicts.reduce((s, c) => s + c.rules.length, 0), twins: a.twins.filter((t) => t.jaccard === 1).map((t) => t.supply_types.join(' + ')),
  near_twins: a.twins.filter((t) => t.jaccard < 1).length, touch: a.touch,
  proof: a.proof && { ...a.proof, differences: a.proof.differences.length, first_differences: a.proof.differences.slice(0, 10) },
}, null, 2));
const tables = opt('--tables');
if (tables) {
  writeFileSync(tables, renderDuplicateTables(a) + '\n', 'utf8');
  console.log(`tables: ${tables}`);
}
