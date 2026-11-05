# Link apply procedure

**Language:** ASD-STE100

An apply session follows these steps. The user started it with "Apply link changes" on the Decisions page. The prompt gives the number of the apply request.

## 1. Read the request

1. Run `npm run link-apply -- --show <request>`.
2. Read each item: the two cards and their text, the link on the newest build, its rules, the answer and the note of the user, and the pair count of each rule.
3. An item marked `STALE` already has its change on the newest build. Mark it as applied with the fix "already true on build N".

The output has two kinds of item:

| Item | Source |
|---|---|
| Suggestion | Claude wrote it in a link check, and the user answered it on the Decisions page. |
| Report | The user pressed "This link is false" on a deck page. Treat it as a `delete` with the answer "Yes, no link". |

## 2. Select a fix for each item

| Answer | Fixes, in order of preference |
|---|---|
| `delete`, "Yes, no link", or a report | A rule fix when the rule is wrong for most of its pairs. Otherwise a block on this pair only. |
| `delete`, "Weak, not false" | `--weak <suggestion>` |
| `add`, "Yes, add it" or "Add it as weak" | A fix of the part that stops the link (a gate part, an exclusion row or an atom reading) when one stops it. Otherwise `--owner-link <suggestion>`. |
| `correct`, `weak` | `--weak <suggestion>` |
| `correct`, `not_weak` | `--weak <suggestion> --remove` |
| `correct`, `wrong_reason` | Fix the rule as for a `delete`. Keep the pair with `--owner-link <suggestion> --add` when no other rule gives it. |

To select between a rule fix and a pair fix:

1. Read 5 or more other pairs of the rule. The graph explorer (`#/graph`) and `reasonLinks` in `src/graph/fixRequests.ts` give examples.
2. Use your own Magic knowledge to judge each pair. Exact words come from the card text and the CR text.
3. If most pairs are false, fix the rule. If most pairs are real, block only this pair.
4. For a missing link, find the cause: no atom on a card, no rule for the two tags, a gate part, or an exclusion row. Tell the user about a missing tag or rule that has no fix.

The kinds of rule fix:

- An exclusion row goes in `excluded_rules` of `config/graph-policy.json`. Give the `rule_id`, the `rule_hash` and a `source` line with the reason.
- A gate part goes in `src/graph/objectGate.ts`. Add 1 to `OBJECT_GATE_VERSION`, and add tests to `tests/object-gate.test.ts`.

The default link rules:

- A link is a payoff or an enabler. A resource, a definition or the wrong direction is no link.
- "No" means no link at all. A high cost, a slow play or a small reward makes a link weak.
- A target is aimed at an opponent. "Any target" does not mean "you".
- A link through speed alone is no link.

## 3. Show the plan and get one yes

1. Measure each rule fix on a database copy (`VACUUM INTO`, then `APP_DB_PATH`). Do not use `cp`.
2. Show the user a table: item, cards, answer, fix, and the link pairs that the fix adds or removes.
3. Ask for one yes. Do not change anything before the yes.

Also ask before these changes:

- a new rule,
- a fix that adds or removes more than 1,000 link pairs.

Do not ask a new question about a card pair in the session. Run `--question <suggestion> --text "<question>"`. The item goes back to the Decisions page, and the next apply request takes the answer.

## 4. Do the fixes

1. Make a backup: `VACUUM INTO 'data/app.db.bak-<date>-pre-link-apply-<request>'`.
2. Do the pair fixes and the weak marks first. They need no build.
3. Do all rule fixes, then make one build: `npm run graph -- --build`.
4. Compare it with the earlier build: `npm run build-diff -- <base> <after>`. If you have an edge golden set, score it: `npm run graph -- --score --build <id>`.
5. Run `npm run rate-fit`, or the deck page disables the card rate switch.
6. Run `npx tsc --noEmit` and `npm test`. Use `APP_DB_PATH` on a copy when a migration is new.

## 5. Mark the items

| Result | Command |
|---|---|
| A suggestion is fixed | `--applied <suggestion>[,...] --how "<fix>" [--build <id>]` |
| A suggestion needs an answer of the user | `--question <suggestion> --text "<question>"` |
| A report is fixed | `--report <id>[,...] --status accepted` |
| The user says that a report is wrong | `--report <id> --status rejected` |

Each suggestion of the request must be applied or sent back with a question before you close the request.

## 6. Close the request

Run `npm run link-apply -- --done <request> --results "<text>"`. In the text, give the items, the fixes, the new build and the link pairs that it adds or removes.

## 7. Tell the user

- Restart `npm run dev:api` after a change of the gate or the exclusion list, because the API keeps the pair table in memory.
- Make a new deck to see the changes. A stored deck keeps its links.
- Commit nothing unless the user asks.
