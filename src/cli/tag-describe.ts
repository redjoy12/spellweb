/**
 * npm run tag-describe -- --prepare [--size 25]      write the writer batches (a new run)
 * npm run tag-describe -- --check-prepare --run <n>  check the writer answers; write the checker batches
 * npm run tag-describe -- --debate-prepare --run <n> check the checker answers; write the debate batch
 * npm run tag-describe -- --finalise --run <n>       write config/tag-descriptions.json
 *
 * Owner request 2026-10-24 (tag check round 2, P1 and P2). Dispatch one fresh agent per batch
 * directory, with the path only; it reads packet.md and writes response.json. Read only on the database.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { openDb } from '../db/client.js';
import { currentCorpusId } from '../atoms/golden.js';
import { currentSchemaVersion } from '../atoms/schema.js';
import { finalise, prepareCheck, prepareDebate, prepareWrite, TAG_DESCRIBE_DIR, TAG_DESCRIPTIONS_PATH } from '../atoms/tagDescribe.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = openDb();
const run = () => {
  const n = Number(opt('--run'));
  if (!Number.isInteger(n)) throw new Error('give --run <n>');
  return n;
};

if (args.includes('--prepare')) {
  const runs = existsSync(TAG_DESCRIBE_DIR) ? readdirSync(TAG_DESCRIBE_DIR).map((n) => Number(n.replace('run-', ''))).filter(Number.isInteger) : [];
  const n = Math.max(0, ...runs) + 1;
  const dirs = prepareWrite(db, n, currentSchemaVersion(db), currentCorpusId(db), Number(opt('--size') ?? 25));
  console.log(`run ${n}: ${dirs.length} writer batch(es)\n  ${dirs.join('\n  ')}`);
} else if (args.includes('--check-prepare')) {
  const dirs = prepareCheck(db, run());
  console.log(`${dirs.length} checker batch(es)\n  ${dirs.join('\n  ')}`);
} else if (args.includes('--debate-prepare')) {
  const dir = prepareDebate(db, run());
  console.log(dir ? `debate batch: ${dir}` : 'no fix items: every item is agreed');
} else if (args.includes('--finalise')) {
  const d = finalise(db, run());
  writeFileSync(TAG_DESCRIPTIONS_PATH, JSON.stringify(d, null, 2) + '\n', 'utf8');
  const all = Object.values(d.types);
  console.log(JSON.stringify({
    out: TAG_DESCRIPTIONS_PATH, types: all.length,
    agreed: all.filter((t) => t.status === 'agreed').length, debated: all.filter((t) => t.status === 'debated').length,
    with_parts: all.filter((t) => t.parts.length > 0).length,
  }, null, 2));
} else {
  console.error('usage: npm run tag-describe -- --prepare [--size 25] | --check-prepare --run <n> | --debate-prepare --run <n> | --finalise --run <n>');
  process.exit(1);
}
