import { openDb } from '../db/client.js';
import { resolveRulesTextUrl, ensureRulesFile } from '../rules/fetch.js';
import { parseComprehensiveRules, normalizeTermKey } from '../rules/parse.js';
import { buildKeywordMap, persistCorpus, poolKeywords } from '../rules/lookup.js';
import { buildTypeRuleMap } from '../rules/typemap.js';
import { loadPacketPolicy } from '../rules/relevance.js';
import { carryPromotedKernel, deriveKernelReport, persistKernel } from '../rules/kernel.js';
import { USER_AGENT } from '../scryfall/bulk.js';

const db = openDb();

try {
  console.log('Resolving the current Comprehensive Rules URL...');
  const url = await resolveRulesTextUrl();
  console.log('  ', url);

  const { text, sha256 } = await ensureRulesFile(url, 'data/cache');
  const corpus = parseComprehensiveRules(text);
  console.log(`  effective ${corpus.effective_date}: ${corpus.sections.length} sections, ` +
              `${corpus.rules.length} rules, ${corpus.glossary.length} glossary entries`);

  // Ability words come from Scryfall's catalog - data, not a judgement call.
  const abilityWordsRes = await fetch('https://api.scryfall.com/catalog/ability-words', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!abilityWordsRes.ok) throw new Error(`Scryfall ability-words returned ${abilityWordsRes.status}`);
  const abilityWords = new Set(
    ((await abilityWordsRes.json()) as { data: string[] }).data.map(normalizeTermKey),
  );

  // Only keywords that actually appear in the pool matter. If the pool is empty,
  // fall back to the full catalogs so `sync:rules` is useful before `sync:cards`.
  let terms = poolKeywords(db);
  if (terms.length === 0) {
    console.log('  pool is empty - falling back to the full Scryfall keyword catalogs');
    for (const cat of ['keyword-abilities', 'keyword-actions', 'ability-words']) {
      const r = await fetch(`https://api.scryfall.com/catalog/${cat}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`Scryfall ${cat} returned ${r.status}`);
      terms.push(...((await r.json()) as { data: string[] }).data);
    }
  }

  const keywordMap = buildKeywordMap(corpus, terms, abilityWords);
  const typeMap = buildTypeRuleMap(corpus);
  const corpusId = persistCorpus(db, { sourceUri: url, sha256, corpus, keywordMap, typeMap });

  const tally = keywordMap.reduce<Record<string, number>>((acc, m) => {
    acc[m.resolution] = (acc[m.resolution] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  corpus ${corpusId}: ${keywordMap.length} pool keywords mapped`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`    ${k}: ${v}`);

  const subtypes = typeMap.filter((m) => m.kind === 'subtype');
  const forms = typeMap.filter((m) => m.kind === 'card_form');
  console.log(`  type map: ${subtypes.length} subtypes, ${forms.length} card forms (all derived by parsing)`);
  for (const m of subtypes) console.log(`    subtype   ${m.term} -> ${m.rule_number}   [${m.evidence}]`);
  for (const m of forms) console.log(`    card form ${m.term} -> ${m.rule_number}   [${m.evidence}]`);

  // Rules accepted from missing-rule reports first, so a derived row cannot displace them.
  const carry = carryPromotedKernel(db, corpusId);
  if (carry.carried.length > 0) {
    console.log(`  packet kernel: carried ${carry.carried.length} review-promoted rule(s): ${carry.carried.join(', ')}`);
  }
  if (carry.dropped.length > 0) {
    console.log(`  WARNING: ${carry.dropped.length} review-promoted kernel rule(s) are not in this corpus and were NOT ` +
                `carried (renumbered or removed): ${carry.dropped.join(', ')}. The packet holes they closed may be ` +
                'open again - re-check their missing-rule reports in the review queue.');
  }

  // The packet kernel is keyed by corpus: a new corpus starts with none, and packet
  // assembly refuses to run without one once a golden set exists. Re-derive it here so
  // a CR refresh never silently drops it. `npm run kernel:derive` prints the full report.
  const golden = (db.prepare('SELECT COUNT(*) AS n FROM golden_atoms').get() as { n: number }).n;
  if (golden > 0) {
    const report = deriveKernelReport(db, corpusId, loadPacketPolicy());
    persistKernel(db, corpusId, report.kernel);
    console.log(`  packet kernel: ${report.kernel.length} rules derived from ${golden} golden atoms ` +
                `(${report.skippedRules.length} citations not in this corpus, ` +
                `${report.skippedCards.length} golden cards not in the pool - see npm run kernel:derive)`);
  }

  const unresolved = keywordMap.filter((m) => m.resolution === 'unresolved');
  if (unresolved.length > 0) {
    console.log(`  UNRESOLVED (${unresolved.length}) - visible in the UI at /rules/keywords:`);
    for (const m of unresolved) console.log(`    ${m.keyword}`);
  }
} catch (err) {
  console.error('sync:rules failed:', err);
  process.exitCode = 1;
}
