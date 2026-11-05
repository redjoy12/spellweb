/**
 * Edge weights (Phase 3 spec sec. 6.2 and 7.4). Each part is stored on its own, so that the
 * explorer can show the calculation. All values come from `config/graph-policy.json` and are
 * provisional. The cycle search needs weights of 1.0 or less, so a larger weight throws.
 */
import type { GroupKind } from './groups.js';
import type { Grade } from './match.js';
import type { GraphPolicy } from './policy.js';

/** `size` is the class part 1 / log2(1 + n) of sec. 6.2; 1 for an explicit edge. */
export interface WeightParts { grade: number; repeat: number; cost: number; size: number; total: number }

function gradePart(grade: Grade, policy: GraphPolicy): number {
  if (grade === 'rejected') throw new Error('a rejected grade makes no edge and has no weight');
  return policy.weights.grade[grade];
}

function checked(p: Omit<WeightParts, 'total'>): WeightParts {
  const total = p.grade * p.repeat * p.cost * p.size;
  if (!(total <= 1) || total < 0) throw new Error(`edge weight ${total} is above 1.0 or not a number (spec sec. 7.4)`);
  return { ...p, total };
}

/**
 * sec. 7.4: grade x repeat x cost x size. `mv` is the mana value of the supply card. `size` is
 * the specificity part of the rule (rev. 16, `ruleSpecificity`); 1 when the policy has no
 * specificity part.
 */
export function weightOf(grade: Grade, supplyKind: GroupKind, mv: number, policy: GraphPolicy, size = 1): WeightParts {
  const w = policy.weights;
  return checked({
    grade: gradePart(grade, policy),
    repeat: supplyKind === 'other' ? w.repeat.other : w.repeat.engine,
    cost: 1 / (1 + w.cost_per_mv * mv),
    size: w.specificity ? size : 1,
  });
}

/**
 * spec rev. 16 sec. 7.4: the specificity part of a typed rule, min(1, 1 / log2(1 + s x d / n)).
 * `s` and `d` are the counts of scope cards that the supply side and the demand side of the rule
 * hold for, and `n` is the count of scope cards with atoms. s x d / n is the mean count of
 * partners for each card if the rule connects every supply card to every demand card. A rule
 * with one partner or fewer for each card keeps 1; a wider rule gets less, as a class edge does
 * (sec. 6.2).
 */
export function ruleSpecificity(supplyCards: number, demandCards: number, cards: number): number {
  if (!(cards >= 1)) return 1;
  const partners = (supplyCards * demandCards) / cards;
  return partners <= 1 ? 1 : 1 / Math.log2(1 + partners);
}

/** sec. 6.2: grade x 1 / log2(1 + n), where n is the member count of the class. */
export function classWeight(grade: Grade, members: number, policy: GraphPolicy): WeightParts {
  if (!(members >= 1)) throw new Error(`a class with ${members} members has no weight`);
  return checked({ grade: gradePart(grade, policy), repeat: 1, cost: 1, size: 1 / Math.log2(1 + members) });
}
