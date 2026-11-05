/**
 * The provisional values of deck assembly (Phase 4 design sec. 5 to 7), in one file. Each deck
 * stores the SHA of the values that made it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalJson } from '../graph/policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = resolve(here, '../../config/deck-policy.json');

const probability = z.number().gt(0).lt(1);
const count = z.number().int().positive();

const DeckPolicySchema = z.object({
  deck_size: count,
  max_copies: count,
  score: z.object({ hub_power: z.number().nonnegative(), anti_penalty: z.number().nonnegative(), seed_weight: z.number().positive(), weak_factor: z.number().gt(0).lte(1), rate_weight: z.number().nonnegative(), owner_link_weight: z.number().positive() }),
  search: z.object({ beam_width: count, mana_loops: count }),
  copies: z.object({ seed_min: count, thirds: z.tuple([count, count, count]), legendary_max: count }),
  quotas: z.object({
    interaction: z.object({ none: z.number().int().nonnegative(), some: z.number().int().nonnegative(), heavy: z.number().int().nonnegative() }),
    min_creatures_default: z.number().int().nonnegative(),
    quota_card_copies: count,
  }),
  mana: z.object({
    start_lands: count, lands_min: count, lands_max: count, turn_percentile: probability, turn_min: count, turn_max: count,
    land_probability: probability, colour_probability: probability, cards_seen_on_turn_0: count, dual_land_copies: count,
    basic_lands: z.object({ B: z.string().min(1), R: z.string().min(1) }),
  }),
  export: z.object({ name_form: z.record(z.string(), z.enum(['full', 'front'])) }),
});

export type DeckPolicy = z.infer<typeof DeckPolicySchema>;

export function loadDeckPolicy(path: string = DEFAULT_POLICY): DeckPolicy {
  return DeckPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The SHA of the policy values; the notes of the file are not in the values. */
export function deckPolicySha(p: DeckPolicy): string {
  return createHash('sha256').update(canonicalJson(p), 'utf8').digest('hex');
}
