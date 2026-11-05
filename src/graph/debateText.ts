/**
 * The debate texts (spec rev. 9 sec. 5.6). A module of their own, so that `pairFixed.ts` can put
 * them into the generated debater agent without an import cycle with `ruleDebate.ts`.
 */

/**
 * The debate instructions (spec rev. 9 sec. 5.6, plan D14). They state only the procedure and the
 * answer format: no Magic examples, no hints about which types connect, no rules of play.
 */
export const DEBATE_INSTRUCTIONS = `You take part in a debate about disputed items. Use ONLY the text in this packet. Do not use anything that you remember about the game or about a card.

Earlier passes followed the instructions in "Instructions of the earlier passes". Their answers did not agree on the items in "Disputed items". Each item gives its options. You select one option for each item. You do not write a new answer.

Do these steps for each item:
1. Read the options of the item. Read the entries of the types that the item names, and the CR text for them. The "[for: ...]" lines in "Comprehensive Rules" show which types need each rule.
2. If "Arguments of the previous round" has arguments for the item, read them. Examine each argument against the CR text in this packet. An argument is not correct only because other debaters gave it.
3. Select the option that the CR text in this packet supports best. The test is the definitions and the steps in "Instructions of the earlier passes": an option is correct when an earlier pass that obeyed those instructions must give it.
4. Write an argument: two to five sentences that state why the CR text in this packet supports this option and not the other options.
5. Give the evidence: one or more items of CR text from this packet that support your argument. Copy each quote character for character. A quote can be a part of the text of a rule or a glossary entry. Do not join two parts with an ellipsis.

Decide each item alone. The decision on one item has no effect on the decision on a different item. Other debaters answer the same items in their own directories. Do not try to match their answers.`;

export const ROLE_OPTIONS = `Each item is one atom type. Its options are:
- P1, P2, P3: the answer of that earlier pass for the type (role, demand note, resource effects and evidence).
- voted: the role and the resource effects on which two or more earlier passes agreed.
- none: the role none, with no resource effects.
An item shows only the options that you can select for it. The order of the options has no meaning.`;

export const RULE_OPTIONS = `Each item is one edge rule that only one earlier pass gave. Its options are:
- adopt: the rule goes into the rule set. Select it when the earlier passes had to write this rule by their instructions.
- reject: the rule stays out of the rule set. Select it when the earlier passes had to not write this rule by their instructions.
The order of the options has no meaning.`;

export const DEBATE_ANSWER_FORMAT = `Write ONE file, response.json, in the directory of this packet. Write it one time. It contains only this JSON object, with no commentary and no code fence:

{"answers": [ANSWER, ...]}

ANSWER is {"item": "D", "choice": "C", "argument": "A", "evidence": [EVIDENCE, ...]}.
- D is the label of the item in "Disputed items", for example "D01".
- C is the name of one option of that item, as its "Options:" line shows it, for example "P1". Give the name only. Select only an option that the item shows.
- A is your argument.
Give one or more EVIDENCE items for each ANSWER. EVIDENCE is {"source": "rule", "ref": "R", "quote": "Q"} or {"source": "glossary", "ref": "T", "quote": "Q"}. R is a rule number as this packet shows it. T is a glossary term as this packet shows it. R and T are JSON strings. Q is copied from the text of that rule or glossary entry.

Give one ANSWER for each item. Use no other fields.`;
