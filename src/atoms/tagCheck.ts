/**
 * The tag check (owner request 2026-10-21): a sample of real cards with their current atoms
 * ("meaning tags" in the UI), for the owner to mark on the "Your decisions" page. The owner says
 * if the tags of each card are correct, or need a fix. The marks are owner labels; they change
 * nothing else.
 *
 * The sample is mechanical and seeded, so it is the same each time: cards drawn uniformly from all
 * cards with current atoms (any schema version, so stale atoms show too, unless `minSchema` is set).
 * Round 2 (owner 2026-10-23) adds cards where two readings of the same text disagree: the item then
 * also shows the tags that only the earlier reading had.
 * The code makes no decision on a card; it knows no Magic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { cardOf, rng, type LinkCheckCard } from '../graph/linkCheck.js';
import { matchAtoms } from './golden.js';
import { latestLabels } from './schema.js';
import { V16_TWINS } from './schemaV16.js';
import { V18_REMOVED } from './schemaV18.js';
import { loadTagDescriptions } from './tagDescribe.js';

export const TAG_CHECK_PATH = 'docs/tag-check/sample.json';
export const TAG_CHECK_CHOICES = ['keep', 'needs_fixing', 'unsure'] as const;

export interface TagCheckTag {
  /** `FAMILY.TYPE_KEY`. */
  type: string;
  /** The label of the type in the atom's schema version (null when the type is not in it). */
  label: string | null;
  params: Record<string, unknown>;
  quote: string;
  /** The plain description of the type (config/tag-descriptions.json), added when the page asks. */
  description?: string;
  /** The labels of the types that a keyword type is made of, by its CR text. */
  parts?: string[];
}
export interface TagCheckItem {
  key: string;
  /** The check round (1 = the first sample). */
  round: number;
  card: LinkCheckCard;
  /** The schema version of the card's current atoms (more than one when they are mixed). */
  schema_versions: number[];
  tags: TagCheckTag[];
  /** Why the card is in the sample. Absent on round 1 items (all random). */
  reason?: 'random' | 'two_readings';
  /** two_readings: the run of the earlier reading. */
  other_run?: number;
  /** two_readings: the tags of the earlier reading that the current reading does not have. */
  other_tags?: TagCheckTag[];
  /** two_readings: the indices in `tags` of the tags that the earlier reading does not have. */
  new_tags?: number[];
}
export interface TagCheckSample { seed: number; made_at: string; cards_with_tags: number; items: TagCheckItem[] }

type AtomRow = { family: string; type_key: string; params_json: string; quote: string; schema_version: number; label: string | null; span_start: number; span_end: number };
const ATOM_COLS = `a.family, a.type_key, a.params_json, a.quote, a.schema_version, t.label, a.span_start, a.span_end
    FROM atoms a LEFT JOIN atom_types t ON t.schema_version = a.schema_version AND t.family = a.family AND t.type_key = a.type_key`;
const tagOf = (r: AtomRow): TagCheckTag => ({ type: `${r.family}.${r.type_key}`, label: r.label, params: JSON.parse(r.params_json) as Record<string, unknown>, quote: r.quote });

/**
 * The cards that both runs read (first pass), where the two readings do not give the same tags.
 * Two tags match on the same type and an overlap of at least half of the span (`matchAtoms`). An
 * earlier tag that a v16 twin rule removes (M3: ACTIVATE beside a keyword kind; M4: Discard, Card draw,
 * Search, Shuffle or Reveal beside Cycling) is not a difference: that change is a schema change, not
 * a new reading. Params are not compared.
 */
export function readingDifferences(db: DatabaseSync, run: number, earlier: number): Map<string, { onlyNew: number[]; onlyOld: AtomRow[]; nowCount: number }> {
  const q = db.prepare(`SELECT ${ATOM_COLS} WHERE a.run_id = ? AND a.oracle_id = ? AND a.pass_index = 0 ORDER BY a.face_index, a.span_start, a.id`);
  const ids = (db.prepare(`SELECT DISTINCT oracle_id FROM atoms WHERE run_id = ? AND pass_index = 0
    AND oracle_id IN (SELECT oracle_id FROM atoms WHERE run_id = ? AND pass_index = 0) ORDER BY oracle_id`).all(run, earlier) as Array<{ oracle_id: string }>)
    .map((r) => r.oracle_id);
  const out = new Map<string, { onlyNew: number[]; onlyOld: AtomRow[]; nowCount: number }>();
  for (const id of ids) {
    const now = q.all(run, id) as AtomRow[];
    const old = q.all(earlier, id) as AtomRow[];
    const { runIdx, goldenIdx } = matchAtoms(now, old);
    const both = [...now, ...old];
    const twinDropped = (a: AtomRow) => V16_TWINS.some((t) => `${a.family}.${a.type_key}` === t.drop && both.some((k) =>
      `${k.family}.${k.type_key}` === t.keep && matchAtoms([{ ...k, family: a.family, type_key: a.type_key }], [a]).pairs.length > 0));
    const onlyOld = old.filter((a, j) => !goldenIdx.has(j) && !twinDropped(a));
    const onlyNew = now.map((_, i) => i).filter((i) => !runIdx.has(i));
    if (onlyNew.length || onlyOld.length) out.set(id, { onlyNew, onlyOld, nowCount: now.length });
  }
  return out;
}

/** Makes the sample. Reads the database; writes nothing. */
export function makeTagCheckSample(db: DatabaseSync, opts: {
  seed?: number; size?: number; exclude?: ReadonlySet<string>; round?: number;
  /** Draw only cards whose current atoms are all on this schema version or later. */
  minSchema?: number;
  /** Also draw `size` cards from the cards where run `run` and run `earlier` disagree. */
  twoReadings?: { run: number; earlier: number; size: number };
} = {}): TagCheckSample {
  const seed = opts.seed ?? 20261021;
  const size = opts.size ?? 20;
  const all = (db.prepare('SELECT oracle_id FROM atoms WHERE is_current = 1 GROUP BY oracle_id HAVING MIN(schema_version) >= ? ORDER BY oracle_id')
    .all(opts.minSchema ?? 0) as Array<{ oracle_id: string }>).map((r) => r.oracle_id);
  const rand = rng(seed);
  const used = new Set<string>(opts.exclude ?? []);
  const draw = (from: readonly string[], n: number): string[] => {
    const got: string[] = [];
    for (let tries = 0; got.length < n && tries < 10_000 && from.length > 0; tries++) {
      const id = from[Math.floor(rand() * from.length)]!;
      if (used.has(id)) continue;
      used.add(id);
      got.push(id);
    }
    return got;
  };
  // The two-readings cards first, so that a random draw cannot take them.
  const diffs = opts.twoReadings ? readingDifferences(db, opts.twoReadings.run, opts.twoReadings.earlier) : new Map();
  const runOf = db.prepare('SELECT DISTINCT run_id FROM atoms WHERE oracle_id = ? AND is_current = 1');
  // A later move with no model (spec sec. 23) gives a card atoms of a second run. `onlyNew` then has no place in its rows.
  const oneRun = (id: string, run: number) => {
    const runs = runOf.all(id) as Array<{ run_id: number }>;
    return runs.length === 1 && runs[0]!.run_id === run;
  };
  const twoIds = opts.twoReadings ? draw([...diffs.keys()].filter((id) => all.includes(id) && oneRun(id, opts.twoReadings!.run)), opts.twoReadings.size) : [];
  const randomIds = draw(all, size);

  const atoms = db.prepare(`SELECT ${ATOM_COLS} WHERE a.oracle_id = ? AND a.is_current = 1 ORDER BY a.face_index, a.span_start, a.id`);
  const item = (id: string, reason: 'random' | 'two_readings'): TagCheckItem => {
    const rows = atoms.all(id) as AtomRow[];
    const base: TagCheckItem = {
      key: `tag:${id}`, round: opts.round ?? 1, card: cardOf(db, id),
      schema_versions: [...new Set(rows.map((r) => r.schema_version))].sort((a, b) => a - b),
      tags: rows.map(tagOf),
    };
    if (!opts.twoReadings) return base;
    if (reason === 'random') return { ...base, reason };
    // The current atoms are the atoms of the later run (`oneRun`), so the indices of `onlyNew` are indices in `rows`.
    const d = diffs.get(id)!;
    if (rows.length !== d.nowCount) throw new Error(`tag-check: ${id} has ${rows.length} current atoms, but run ${opts.twoReadings.run} read ${d.nowCount}`);
    return { ...base, reason, other_run: opts.twoReadings.earlier, other_tags: d.onlyOld.map(tagOf), new_tags: d.onlyNew };
  };
  const items = [...twoIds.map((id) => item(id, 'two_readings')), ...randomIds.map((id) => item(id, 'random'))];
  return { seed, made_at: new Date().toISOString(), cards_with_tags: all.length, items };
}

export function loadTagCheckSample(path: string = TAG_CHECK_PATH): TagCheckSample | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as TagCheckSample : null;
}

const WHEN_WORDS: Record<string, string> = { may: ' (if the player chooses)', if: ' (only on a condition)' };

/**
 * Adds the plain description and the parts of each tag's type, and gives each tag its current name
 * (a sample keeps the label and the type of the day it was made, spec sec. 23): the label of the
 * type, or of the type that keeps the fact of a removed type. Types with no description keep only
 * the new label.
 */
export function withDescriptions(db: DatabaseSync, items: TagCheckItem[]): TagCheckItem[] {
  const d = loadTagDescriptions();
  const labels = latestLabels(db);
  const now = (type: string) => V18_REMOVED.find((r) => r.type === type)?.into ?? type;
  const named = <T extends TagCheckTag>(t: T): T => ({ ...t, label: labels.get(now(t.type)) ?? t.label });
  return items.map((i) => ({
    ...i,
    tags: i.tags.map((t) => {
      const x = d?.types[now(t.type)];
      return named(x ? { ...t, description: x.description, ...(x.parts.length ? { parts: x.parts.map((p) => `${labels.get(p.type) ?? p.type}${WHEN_WORDS[p.when] ?? ''}`) } : {}) } : t);
    }),
    ...(i.other_tags ? { other_tags: i.other_tags.map((t) => { const x = d?.types[now(t.type)]; return named(x ? { ...t, description: x.description } : t); }) } : {}),
  }));
}
