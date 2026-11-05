/**
 * npm run rate-groups -- [--build <id>] [--sample <n>]
 *
 * Read only (card rate plan Task 2). Prints the counts of the one-effect groups of a build, the
 * same counts at each step of the reward rule, the largest groups, and a sample of spread groups
 * with their words. Default build: the newest. Default sample: 20 groups.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import {
  groupCounts, isRewardType, isSupplyType, loadGroupInput, makeGroups, rewardTest, sampleGroups, typeTest, wordings, type AtomTest, type GroupCounts, type RewardGroup,
} from '../rate/groups.js';

const args = process.argv.slice(2);
const flag = (name: string): number | null => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : null;
};
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const buildId = flag('--build') ?? (db.prepare('SELECT MAX(id) id FROM graph_builds').get() as { id: number }).id;
const sampleSize = flag('--sample') ?? 20;

const input = loadGroupInput(db, buildId);
const groups = makeGroups(input);
const c = groupCounts(groups, input.spells.length);
const share = (n: number) => `${n} (${((100 * n) / c.spells).toFixed(1)}%)`;
const range = (g: RewardGroup) => `${g.mana_values[0]} to ${g.mana_values.at(-1)}`;

const line = (name: string, x: GroupCounts, largest: RewardGroup | undefined) =>
  `  ${name.padEnd(30)} groups ${String(x.groups).padStart(4)}  of 2+ ${String(x.groups_of_2).padStart(4)}  spread ${String(x.spread_groups).padStart(4)}`
  + `  spells in spread ${share(x.spells_in_spread).padEnd(13)}  largest ${largest?.members.length ?? 0} ${largest?.key ?? ''}`;

console.log(`build ${buildId}: ${c.spells} spells with atoms, ${input.atoms.filter(rewardTest(input.roles)).length} of ${input.atoms.length} atoms are rewards`);
console.log(`groups ${c.groups}, groups of 2 or more ${c.groups_of_2}, spread groups ${c.spread_groups}`);
console.log(`spells in a group ${share(c.spells_in_any)}, in a group of 2 or more ${share(c.spells_in_2)}, in a spread group ${share(c.spells_in_spread)}`);
console.log(`a spell is in ${c.mean_groups.toFixed(2)} spread groups (mean); ${c.same_words} spread groups have one wording`);
console.log(`smallest spread group of each spell: 2-9 ${share(c.narrowest['2-9'])}, 10-49 ${share(c.narrowest['10-49'])}, 50+ ${share(c.narrowest['50+'])}`);

console.log('steps of the reward rule');
const steps: Array<[string, AtomTest]> = [
  ['role supply', typeTest(input.roles, (r) => r.status === 'accepted' && r.role === 'supply')],
  ['role supply or both', typeTest(input.roles, isSupplyType)],
  ['and a value resource', typeTest(input.roles, isRewardType)],
  ['and not a cost to you', rewardTest(input.roles)],
];
for (const [name, test] of steps) {
  const g = makeGroups(input, test);
  console.log(line(name, groupCounts(g, c.spells), g[0]));
}

console.log('largest groups');
for (const g of groups.slice(0, 12)) console.log(`  ${String(g.members.length).padStart(4)}  mana value ${range(g).padEnd(8)}  ${g.key}`);

console.log(`sample of ${sampleSize} spread groups`);
for (const g of sampleGroups(groups, sampleSize)) {
  const w = wordings(g);
  console.log(`  ${g.key}: ${g.members.length} cards, mana value ${range(g)}, ${w.length} wordings`);
  for (const x of w.slice(0, 3)) console.log(`      ${String(x.cards).padStart(3)} × ${x.words.replace(/\n/g, ' / ')}`);
}
