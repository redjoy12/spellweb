import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RULES_PAGE = 'https://magic.wizards.com/en/rules';
const BROWSER_UA = 'MTGADeckBuilder/0.1 (local research tool)';

/**
 * I2 discipline applied to the corpus itself: the CR filename is date-stamped and
 * changes with every rules update, so the URL is scraped from the official page,
 * never hardcoded.
 */
export async function resolveRulesTextUrl(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(RULES_PAGE, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`WotC rules page returned HTTP ${res.status}`);
  const html = await res.text();

  const matches = [...html.matchAll(/href="(https:\/\/media\.wizards\.com\/[^"]*?\.txt)"/g)]
    .map((m) => m[1]!)
    .filter((u) => /MagicCompRules/i.test(u));

  if (matches.length === 0) {
    throw new Error('WotC rules page: no MagicCompRules .txt link found - the page layout changed');
  }
  // Filenames are date-stamped (e.g. "MagicCompRules 20260619.txt"). If WotC ever
  // lists an archive alongside the current file, matches[0] could be stale; sort
  // by the trailing YYYYMMDD in the filename, newest first.
  const newest = matches
    .slice()
    .sort((a, b) => {
      const da = /(\d{8})\.txt$/i.exec(a)?.[1] ?? '';
      const db = /(\d{8})\.txt$/i.exec(b)?.[1] ?? '';
      return db.localeCompare(da);
    })[0]!;
  return encodeURI(newest);
}

export async function ensureRulesFile(
  url: string,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; text: string; sha256: string }> {
  mkdirSync(cacheDir, { recursive: true });
  const name = decodeURIComponent(url.split('/').pop() ?? 'MagicCompRules.txt').replace(/\s+/g, '_');
  const path = join(cacheDir, name);

  let text: string;
  if (existsSync(path)) {
    text = readFileSync(path, 'utf8');
  } else {
    const res = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok) throw new Error(`Comprehensive Rules download returned HTTP ${res.status}`);
    // The file is UTF-8 with a BOM; strip it so downstream offsets are clean.
    text = (await res.text()).replace(/^\uFEFF/, '');
    writeFileSync(path, text, 'utf8');
  }

  return { path, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
