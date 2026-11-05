# Golden set procedure

**Language:** ASD-STE100

The golden set is about 150 cards with atoms that the user checks, card by card. The packet kernel comes from its CR citations, and `npm run packet-check` scores each golden extraction run against it. A golden entry that is wrong is worse than no entry, because every later step treats it as true.

Two parts of the work are fixed:

- **The drafter (Claude) drafts. The user accepts.** Only `npm run golden:draft -- --accept` (or the **Golden set** page) writes a card into `golden_cards` and `golden_atoms`. A draft is a file in `data/golden-drafts/<oracle_id>/`, not a row.
- **Each citation is read, not recalled.** Cite only a rule that is in the drafting packet or that you read with `--lookup`. `--stage` refuses a cited rule that is in neither.

## 1. Select the candidates

1. Run `npm run golden -- --select`. It writes the candidate list. On a new database, it first measures the "bottom decile": the cards whose text matches the fewest CR rules.
2. After each `sync:cards` or `sync:rules`, run `npm run golden -- --bottom-decile` and then `--select` again.

## 2. Draft a card (the drafter)

1. Run `npm run golden:draft -- --next 10` to see the next candidates.
2. Run `npm run golden:draft -- --packet <oracle_id>`. It writes `packet.json` with the faces, the clause split and the ungated CR rules that the text matches. The tag list is in `data/golden-drafts/vocabulary.json`.
3. Read a rule that the packet does not have with `--lookup <oracle_id> <rule>`, `--lookup <oracle_id> --search "<text>"` or `--lookup <oracle_id> --glossary <term>`. Each lookup goes into a log.
4. Write `data/golden-drafts/<oracle_id>/proposal.json` (the format is below).
5. Run `npm run golden:draft -- --stage data/golden-drafts/<oracle_id>/proposal.json`. Correct each error that it gives, and stage again.

## 3. The rules of a reading

- Read all faces. A back face with no text has no clauses. That is correct.
- Each atom has a quote that is exactly `oracle_text.slice(span_start, span_end)` of its face.
- The `type_key` must exist in the current tag list, and the `params` must agree with its `params_schema`.
- A clause can give more than one atom. Only a `reminder` clause can give no atom.
- **The subject is a parameter.** Which object a clause is about (a creature, an artifact, a player) goes into `params`, not into the tag name. A different cost, zone, timing or cost position is a different mechanism, and keeps its own tag.
- **Do not force a fit.** If no tag fits a clause, record an unclassified candidate with a `proposed_label`. The label names one mechanism, never a subject. Use an existing label when yours differs from it only in the subject.
- Give a `rationale` for each atom and each candidate: why the clause gives it, with the words of the rule that you read.

## 4. The proposal format

```json
{
  "oracle_id": "<id>",
  "oracle_hash": "<the hash in packet.json>",
  "schema_version": 20,
  "drafted_by": "<agent name and model>",
  "drafted_at": "<ISO time>",
  "claims_complete": true,
  "atoms": [
    { "face_index": 0, "family": "PRODUCES", "type_key": "CREATE", "params": {},
      "span_start": 0, "span_end": 10, "quote": "<exact text>", "rule_numbers": ["111.1"],
      "rationale": "<why>" }
  ],
  "unclassified": [
    { "face_index": 0, "span_start": 0, "span_end": 10, "quote": "<exact text>",
      "proposed_label": "<MECHANISM_NAME>", "rationale": "<why no tag fits>" }
  ],
  "notes": "<doubts and other readings, for the user>"
}
```

The example shows the shape only: each tag has its own `params`, with the names and values of its `params_schema`. Use the `schema_version` of the current tag list. `claims_complete` is only a hint. The user decides if a card is complete.

## 5. Check a card (the user)

1. Open the **Golden set** page (`#/golden`), or run `npm run golden:draft -- --show <oracle_id>`. Each atom shows next to its quote and the full text of each rule that it cites.
2. Accept a correct draft. Use **complete** (`--accept <oracle_id> --complete`) only when each clause that is not a reminder has an atom or a candidate. If you are not sure, accept it as partial: the score counts only complete cards.
3. On the page, you can clear one atom. Then you must write a note. Reject a wrong draft with `--reject <oracle_id> --note "<reason>"`. The draft stays on disk for the drafter.
4. After a batch of accepted cards, run `npm run kernel:derive`.
5. Run `npm run golden -- --verify <oracle_id>` to check a card again. It also finds a card whose text changed (errata): draft that card again.
