/**
 * npm run deck -- [--seed <name>] [--seed <name>] [--colours BR] [--turn 6] [--interaction some] [--creatures 14] [--exclude <name>] [--build <id>] [--rate]
 *   [--pin <name>] [--never <FAMILY.TYPE>]
 *
 * Read only (Phase 4 plan Task 5). Builds one deck from the goal and prints the deck, the warnings
 * and the top link kinds. Default build: the newest. Each card name must match the database.
 * `--rate` turns on the card rate (card rate plan Task 5). The value comes from card text. It is
 * not a win rate.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../db/client.js';
import { deckLinkKinds } from '../deck/justify.js';
import { BuildIndex } from '../graph/buildIndex.js';
import { makeDeck, newestBuild, scopePairTable, withWeakAnswers } from '../deck/deck.js';
import { loadDeckPolicy } from '../deck/policy.js';

const args = process.argv.slice(2);
const all = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
const one = (flag: string) => all(flag)[0];

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const policy = loadDeckPolicy();

/** The card with this name: the whole name, or the name of its front face. */
function cardId(name: string): string {
  const r = db.prepare(`SELECT oracle_id FROM cards WHERE rotated = 0 AND (name = ?1 OR name LIKE ?1 || ' // %') ORDER BY name LIMIT 1`)
    .get(name) as { oracle_id: string } | undefined;
  if (!r) throw new Error(`no card with the name ${name}`);
  return r.oracle_id;
}

const seeds = all('--seed').map(cardId);
const buildId = one('--build') ? Number(one('--build')) : newestBuild(db);
const started = Date.now();
const idx = BuildIndex.load(db, buildId);
const table = withWeakAnswers(db, scopePairTable(db, idx), policy);
const tableMs = Date.now() - started;
const deck = makeDeck(db, idx, table, {
  colours: one('--colours') ?? 'BR', seeds, excluded: all('--exclude').map(cardId), target_turn: Number(one('--turn') ?? 6),
  interaction: one('--interaction') ?? 'some', ...(one('--creatures') ? { min_creatures: Number(one('--creatures')) } : {}),
  use_rate: args.includes('--rate'), pinned: all('--pin').map(cardId), excluded_tags: all('--never'),
}, policy);

const name = (id: string) => deck.cards.get(id)?.name ?? id;
console.log(`build ${buildId}, table ${tableMs} ms, deck ${Date.now() - started - tableMs} ms, ${deck.loops} loops, card rate ${deck.goal.use_rate ? `on, weight ${policy.score.rate_weight}` : 'off'}`);
for (const s of deck.spells) {
  const c = deck.cards.get(s.oracle_id)!;
  const rate = c.rate ? `  rate ${c.rate.rate?.toFixed(2) ?? c.rate.reason}` : '';
  console.log(`${s.copies} ${c.name.padEnd(44)} mv ${String(c.cmc).padStart(2)}  ${s.role.padEnd(5)} fit ${s.fit.toFixed(3).padStart(7)}${rate}  ${c.type_line}`);
}
for (const l of deck.mana.lands) console.log(`${l.copies} ${name(l.oracle_id).padEnd(44)} ${l.kind}`);
console.log(`lands ${deck.mana.land_count}, T ${deck.mana.turn}, needs ${JSON.stringify(deck.mana.needs)}, sources ${JSON.stringify(deck.mana.sources)}`);
console.log(`warnings: ${deck.warnings.length}`);
const byKind = new Map<string, number>();
for (const w of deck.warnings) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1);
console.log(JSON.stringify(Object.fromEntries(byKind)));
for (const w of deck.warnings) console.log(`  ${w.kind}: ${w.text}`);
console.log('top link kinds:');
for (const k of deckLinkKinds(idx, table, deck.spells.map((s) => s.oracle_id)).slice(0, 8)) console.log(`  ${String(k.pairs).padStart(3)}  ${k.kind}`);
