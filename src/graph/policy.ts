import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = resolve(here, '../../config/graph-policy.json');

const count = z.number().int().nonnegative();
const share = z.number().min(0).max(1);

const GraphPolicySchema = z.object({
  packet_budget_bytes: z.number().int().positive(),
  /** spec rev. 10 sec. 5.3: Stage B covers the live types only, or all types. */
  stage_b_scope: z.enum(['live', 'all']).default('all'),
  resources: z.array(z.string().min(1)).min(1).refine((r) => r.includes('other'), 'resources must include "other"'),
  weights: z.object({
    grade: z.object({ confirmed: share, plausible: share }),
    repeat: z.object({ engine: share, other: share }),
    cost_per_mv: z.number().nonnegative(),
    /** spec rev. 16 sec. 7.4: a typed edge gets the specificity part of its rule. Absent in older builds. */
    specificity: z.boolean().optional(),
  }),
  cycles: z.object({ max_length: z.number().int().min(1), top_k: z.number().int().min(1), budget: z.number().int().min(1) }),
  golden: z.object({
    round_size: z.number().int().min(1),
    cap: z.number().int().min(1),
    shared_term_max_share: share,
    batch_size: z.number().int().min(1),
    targets: z.object({
      synergy: count, synergy_per_cares_about: count, anti: count, none: count,
      param_gap: count, unrecorded_restriction: count,
    }),
    top_weight: count,
    owner_sample: count,
    owner_correction_limit: z.number().int().min(1),
  }),
  sweep: z.object({ top_share: share }),
  /** spec rev. 13 sec. 7.7: the owner exclusion list. The build leaves out these rules. */
  excluded_rules: z.array(z.object({
    rule_id: z.string().min(1),
    rule_hash: z.string().regex(/^[0-9a-f]{64}$/),
    source: z.string().min(1),
  })).default([]),
  /**
   * A rule that a Stage B batch part shows when it has one of `types` as a supply candidate and its
   * fixed part does not have the rule (spec rev. 24 sec. 24.6, from missing-rule reports).
   */
  batch_part_rules: z.array(z.object({
    rule: z.string().min(1),
    types: z.array(z.string().min(1)).min(1),
  })).default([]),
});

/** spec sec. 19: every provisional Phase 3 value, in one file (plan D4). */
export type GraphPolicy = z.infer<typeof GraphPolicySchema>;

export function loadGraphPolicy(path: string = DEFAULT_POLICY): GraphPolicy {
  return GraphPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** JSON with object keys sorted at every depth - the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** spec rev. 13 sec. 7.7: the rule hashes of the owner exclusion list. */
export function excludedRuleHashes(p: GraphPolicy): Set<string> {
  return new Set(p.excluded_rules.map((r) => r.rule_hash));
}

/**
 * The build key's policy part (plan D4): the weights only. A change to the cycle limits or the
 * golden values does not change an edge, so it must not make a new build.
 */
export function weightsSha(p: GraphPolicy): string {
  return createHash('sha256').update(canonicalJson(p.weights), 'utf8').digest('hex');
}
