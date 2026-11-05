/**
 * npm run rate-fields -- [--build <id>] [--sample <n>] [--faces <n>] [--seed <n>]
 *
 * Read only (card rate plan Task 1). Prints the fill count of each size and speed field on the BR
 * slice of a build. Default build: the newest. `--sample` prints n atoms, an equal part of each
 * kind, with their quotes, for a check by hand. `--faces` prints n faces with their speed atoms.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { newestBuild } from '../deck/deck.js';
import { cardFields, readBuildCards, type AtomFields, type RateAtom, type RateCard, type Speed } from '../rate/fields.js';

const args = process.argv.slice(2);
const one = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const buildId = one('--build') ? Number(one('--build')) : newestBuild(db);
const seed = one('--seed') ?? '20261101';

interface Row { atom: RateAtom; card: RateCard; fields: AtomFields }
const rows: Row[] = [];
const faces: { card: RateCard; speed: Speed; atoms: RateAtom[] }[] = [];
for (const { card, atoms } of readBuildCards(db, buildId)) {
  const fields = cardFields(card, atoms);
  for (const atom of atoms) rows.push({ atom, card, fields: fields.atoms.get(atom.id)! });
  for (const speed of fields.speed) faces.push({ card, speed, atoms: atoms.filter((a) => a.face_index === speed.face_index) });
}
db.close();

const key = (a: RateAtom) => `${a.family}.${a.type_key}`;
const kinds: [string, (r: Row) => boolean][] = [
  ['stat change', (r) => key(r.atom) === 'COMBAT.STAT_CHANGE'],
  ['minus removal', (r) => key(r.atom) === 'INTERACTION.TARGETED_REMOVAL' && r.atom.params.removal_type === 'minus'],
  ['token', (r) => key(r.atom) === 'PRODUCES.CREATE'],
  ['mana', (r) => key(r.atom) === 'PRODUCES.MANA_PRODUCTION'],
  ['target limit', (r) => key(r.atom) === 'INTERACTION.TARGETED_REMOVAL'],
];
const count = <T>(list: T[], test: (t: T) => boolean) => list.filter(test).length;
const tally = (values: string[]) => {
  const m: Record<string, number> = {};
  for (const v of values) m[v] = (m[v] ?? 0) + 1;
  return JSON.stringify(m);
};
const filled = (v: unknown) => v !== null;

console.log(`build ${buildId}: ${new Set(rows.map((r) => r.card.oracle_id)).size} cards, ${rows.length} atoms, ${faces.length} faces`);
for (const [name, test] of kinds) {
  const list = rows.filter(test);
  const line = [`${name}: ${list.length} atoms`];
  if (name === 'stat change' || name === 'minus removal') {
    line.push(`power ${count(list, (r) => filled(r.fields.stat_power))}`, `toughness ${count(list, (r) => filled(r.fields.stat_toughness))}`,
      `both ${count(list, (r) => filled(r.fields.stat_power) && filled(r.fields.stat_toughness))}`);
  }
  if (name === 'token') {
    line.push(`power ${count(list, (r) => filled(r.fields.token_power))}`, `toughness ${count(list, (r) => filled(r.fields.token_toughness))}`);
  }
  if (name === 'mana') line.push(`amount ${count(list, (r) => filled(r.fields.mana_amount))}`);
  if (name === 'target limit') {
    const read = list.flatMap((r) => r.fields.target_limit ?? []);
    line.push(`read ${read.length}`, `no limit ${count(read, (l) => l.limit === null)}`, `limit ${count(read, (l) => l.limit !== null)}`,
      `number limit ${count(read, (l) => l.number !== null)}`);
  }
  console.log(line.join(', '));
  const prefix = { 'stat change': 'stat:', 'minus removal': 'stat:', token: 'token:', mana: 'mana:', 'target limit': 'target:' }[name]!;
  console.log(`  null notes: ${tally(list.flatMap((r) => r.fields.notes.filter((n) => n.startsWith(prefix))))}`);
}

const castable = faces.filter((f) => f.speed.cast !== null);
const spells = castable.filter((f) => f.speed.wait !== null && f.speed.tapped !== null);
console.log(`speed: ${faces.length} faces, ${castable.length} with a cast value, ${spells.length} with each axis read`);
console.log(`  cast ${tally(faces.map((f) => String(f.speed.cast)))}`);
console.log(`  wait ${tally(faces.map((f) => String(f.speed.wait)))}`);
console.log(`  tapped ${tally(faces.map((f) => String(f.speed.tapped)))}`);
console.log(`  ability_limit ${tally(faces.map((f) => String(f.speed.ability_limit)))}`);
console.log(`  cast/wait of faces with a cast value ${tally(castable.map((f) => `${f.speed.cast}/${f.speed.wait}`))}`);

/** A fixed order of the list for this seed. */
const shuffled = <T>(list: T[], id: (t: T) => string) => list
  .map((t) => ({ t, h: createHash('sha256').update(`${seed}:${id(t)}`).digest('hex') }))
  .sort((a, b) => (a.h < b.h ? -1 : 1))
  .map((x) => x.t);

const nameOf = (c: RateCard, i: number) => c.faces.find((f) => f.face_index === i)?.name ?? c.faces[0]!.name;
const sample = Number(one('--sample') ?? 0);
if (sample) {
  const groups = kinds.filter(([name]) => name !== 'minus removal');
  const share = Math.ceil(sample / groups.length);
  groups.forEach(([name, test], g) => {
    const size = Math.min(share, sample - g * share);
    for (const r of shuffled(rows.filter(test), (x) => String(x.atom.id)).slice(0, size)) {
      const { notes, ...values } = r.fields;
      const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
      console.log(`\n[${name}] atom ${r.atom.id}, ${nameOf(r.card, r.atom.face_index)}, ${JSON.stringify(r.atom.params)}`);
      console.log(`  quote: ${r.atom.quote}`);
      console.log(`  fields: ${JSON.stringify(set)}${notes.length ? `, notes ${notes.join(' ')}` : ''}`);
    }
  });
}

const faceSample = Number(one('--faces') ?? 0);
if (faceSample) {
  const speedKeys = ['COMBAT.HASTE', 'ENABLES.FLASH', 'CONSTRAINTS.ENTERS_TAPPED', 'CONSTRAINTS.TIMING'];
  for (const f of shuffled(faces, (x) => `${x.card.oracle_id}:${x.speed.face_index}`).slice(0, faceSample)) {
    const own = f.card.faces.find((x) => x.face_index === f.speed.face_index)!;
    const { face_index: _, ...axes } = f.speed;
    console.log(`\n${own.name} | ${own.type_line} | layout ${f.card.layout} | face ${f.speed.face_index}`);
    console.log(`  speed: ${JSON.stringify(axes)}`);
    for (const a of f.atoms.filter((x) => speedKeys.includes(key(x)))) console.log(`  ${key(a)}: ${JSON.stringify(a.params)} ${a.quote.slice(0, 140)}`);
  }
}
