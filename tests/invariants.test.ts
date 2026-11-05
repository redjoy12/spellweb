import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `src/atoms` doesn't exist until Task 2; walking it must not be an error - an
// absent directory contributes zero files, not a scan failure.
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ((p.endsWith('.ts') || p.endsWith('.json')) && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** A bare CR rule number: 3 digits, optionally .N, optionally a trailing letter. */
const RULE_LITERAL = /(?<![\w.])[1-9]\d{2}(?:\.\d+[a-z]?)?(?![\w.])/g;

/**
 * Strips anything that is documentation or provenance rather than behaviour, and
 * records whether the line carries the `i2-ok:` in-place justification marker.
 *
 * `marked` is captured from the RAW line, before comment-stripping: the marker
 * lives inside a trailing `//` comment (see Step 11's two examples), and that
 * comment is exactly what the stripping below removes. Checking the stripped
 * `text` for the marker would make it invisible to every consumer of this
 * function - the marker would never be found, and neither the offender-exemption
 * nor the site-count below could ever work. So the two concerns are split: `text`
 * is prose-free code for RULE_LITERAL matching, `marked` is read from the
 * original line for the justification check.
 */
function behaviouralLines(
  src: string,
  isJson: boolean,
): Array<{ n: number; text: string; marked: boolean }> {
  const out: Array<{ n: number; text: string; marked: boolean }> = [];
  let inBlock = false;
  // Split on \r?\n, not bare \n: a CRLF checkout (git's default on Windows) leaves a
  // trailing \r on every line otherwise, and JS regex `.` excludes line terminators
  // (including \r) while `$` won't match before a stray one - so `.replace(/\/\/.*$/, '')`
  // below silently fails to strip the comment, and the whole comment's prose (numbers
  // included) leaks into `text` as if it were code. parse.ts's own tokenizer already
  // splits the same way for the same reason.
  src.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    let marked = false;
    if (!isJson) {
      if (inBlock) { if (line.includes('*/')) inBlock = false; return; }
      if (/^\s*\/\*/.test(line)) { if (!line.includes('*/')) inBlock = true; return; }
      if (/^\s*\*/.test(line)) return;                    // block-comment body
      marked = line.includes('i2-ok:');
      line = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
      // Provenance and extractor prose in a TS string (the schema v15 overlay's `source` and
      // `description`) is documentation, as `evidence` is in config below.
      line = line.replace(/\b(source|description|evidence)\s*:\s*'(?:[^'\\]|\\.)*'/g, '');
    } else {
      // Provenance and prose in config are documentation, not selection policy.
      if (/"(_[a-z_]*comment|evidence|label|description|_comment)"\s*:/.test(line)) return;
      marked = line.includes('i2-ok:');
    }
    if (line.trim() === '') return;
    out.push({ n: i + 1, text: line, marked });
  });
  return out;
}

describe('I2 — every rule number in the rules layer is a justified site', () => {
  const files = [...walk('src/rules'), ...walk('src/atoms'), ...walk('src/graph'), ...walk('config').filter((f) => !f.endsWith('tag-descriptions.json'))];

  for (const file of files) {
    it(`${file}: no unjustified rule-number literal`, () => {
      const src = readFileSync(file, 'utf8');
      const offenders = behaviouralLines(src, file.endsWith('.json'))
        .filter((l) => !l.marked)                          // in-place justification
        .flatMap((l) => [...l.text.matchAll(RULE_LITERAL)].map((m) => `${l.n}: ${m[0]} — ${l.text.trim()}`));
      expect(offenders, `\n${offenders.join('\n')}`).toHaveLength(0);
    });
  }

  it('the number of justified sites has not grown silently', () => {
    // Every entry is a rule number in behavioural code, reviewed and justified in place.
    // Adding one is a deliberate act that must update this list and say why.
    const EXPECTED: Record<string, number> = {
      'src/rules/typemap.ts': 1,   // /^205\.3[a-z]?$/ - filters the corpus by its own numbering
      'src/rules/terms.ts': 2,     // IN ('701','702') - the sections that structurally hold keyword definitions
      // NOT a rule number: sec. 7.2's oracle-text length threshold (chars). The scan cannot tell
      // a 3-digit count from a rule, so it is ledgered here rather than disguised.
      'config/escalation.json': 1,
      // NOT a rule number: the edge golden set's pair cap (spec 2026-10-10 sec. 11.2, plan D4).
      // The other is CR 701.21a in `batch_part_rules` (spec sec. 24.6): two missing-rule reports
      // ask for it, and the batch part shows the stored rule.
      'config/graph-policy.json': 2,
      // NOT a rule number: the percent factor of the cycle measure report (plan Task 6 Step 5).
      'src/graph/cycleMeasure.ts': 1,
      // The CR 701.10a-g subrules of the "Double" object gate (spec rev. 14 sec. 7.8, owner
      // decision on fix request 5): each subrule names the thing that an effect doubles.
      'src/graph/buildIndex.ts': 7,
      // NOT rule numbers: the two golden atom ids of three digits in the schema v17 golden table.
      'src/atoms/goldenV17.ts': 2,
      // The CR 700.11 reference of the role of CARES_ABOUT.DESCENDED (spec sec. 22.5): no pass
      // gave this role, and giveDemandRole checks the quote against the stored rule.
      'src/atoms/schemaV17.ts': 1,
      // The CR references of the six event trigger tags (spec sec. 24.1): the golden atoms cite
      // them, and a role of plan Task 17 takes the same reference and quote.
      'src/atoms/schemaV19.ts': 6,
      // Six are NOT rule numbers: the golden atom ids of three digits in the schema v20 golden
      // table. The other three are the CR references that the new golden atoms cite (spec sec. 25.3).
      'src/atoms/goldenV20.ts': 9,
    };
    const actual: Record<string, number> = {};
    for (const file of files) {
      const n = behaviouralLines(readFileSync(file, 'utf8'), file.endsWith('.json'))
        .filter((l) => l.marked)
        .flatMap((l) => [...l.text.matchAll(RULE_LITERAL)]).length;
      if (n > 0) actual[file.replace(/\\/g, '/')] = n;
    }
    expect(actual).toEqual(EXPECTED);
  });
});
