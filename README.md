# Spellweb

**Language:** ASD-STE100

Spellweb is a synergy deck builder for Magic: The Gathering Arena, Standard, best of one. It reads the text of each card, finds the pairs of cards that work together, and builds 60-card decks from these links.

This repo has the code and the default settings only. It has no card data, no links and no answers. You make your own links with Claude Code, and you correct them while you build decks.

## How it works

| Step | What happens | Who does it |
|---|---|---|
| 1. Cards and rules | The app downloads the cards from Scryfall and the Comprehensive Rules (CR). | The code |
| 2. Atoms | Each card text becomes typed facts ("atoms") with a tag, for example `PRODUCES.CREATE` or `CARES_ABOUT.DISCARD`. Each atom quotes the card text. | Claude subagents |
| 3. Edge rules | Rules join a tag that a card gives (supply) to a tag that another card needs (demand). Each rule quotes CR text. | Claude subagents |
| 4. Graph build | The code applies the rules to all atoms. A pair of cards that a rule joins is a link: `+` (good together) or `-` (bad together). | The code |
| 5. Decks | A search builds a 60-card deck from the links, with a mana base, warnings, the reason of each card and the Arena import text. | The code |
| 6. Corrections | You mark false or weak links. Claude suggests link changes, and you accept or refuse them. | You and Claude |

The code makes no model call and needs no API key. Each model step writes packet files. A fresh Claude Code subagent answers each packet, and a command checks and stores the answers.

## What you need

- Node.js 24 or later. The app uses `node:sqlite`, so Node prints an `ExperimentalWarning`. You can ignore it.
- Claude Code, signed in. The model steps use subagents of Claude Code. The deck chat and the build chat start the `claude` CLI with `--effort`, `--tools` and `--setting-sources`, so use a recent version (the app was tested with 2.1.316). Use the native installer, so that `claude` is an executable on your `PATH`. On Windows, an npm install gives `claude.cmd`, and the chat cannot start it.
- About 1 GB of free disk space.
- Optional: MTG Arena on the same computer, for the game review.

The model steps use many subagent turns of your Claude plan. These counts are from the pool of November 2026, for the black-red slice:

| Step | Size |
|---|---|
| Atom extraction | 1,940 cards: 78 batches of 25 cards, and then the voting passes of some cards |
| Edge rules, Stage A (roles) | 6 parts, 3 passes each: 18 subagent runs on Opus |
| Edge rules, Stage B (rules) | from 171 to 2,847 subagent runs on Opus, by the number of demand tags in the scope |

Run `npm run edge-rules -- --measure` after Step 4 to get the counts for your own atoms. Start with one colour slice, as this guide shows.

## Install

```bash
git clone https://github.com/<your-account>/spellweb.git
cd spellweb
npm install
npm test
```

`npm test` runs the unit tests. They need no card data.

## Step 1: Get the cards and the rules

```bash
npm run sync:cards
npm run sync:rules
npm run seed:atom-schema
```

- `sync:cards` downloads the Scryfall card file (about 80 MB) into `data/cache/` and keeps the cards of the Arena Standard pool. The next run downloads again only when Scryfall has a newer file.
- `sync:rules` downloads and reads the Comprehensive Rules.
- `seed:atom-schema` loads the tag list of `config/atom-schema.json` into the database. Run it one time on a new database. Do not use `npm run generate:atom-schema` before the seed: on a new database, that command gives the tag list an earlier version number.

All data goes into `data/app.db`. Git ignores the `data/` folder. Git also ignores `docs/`, where some commands write their sample and question files.

## Step 2: Start the app

Use two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open `http://localhost:5173`. The API is on `http://127.0.0.1:8787`. On Windows, do not use `npm run dev`, because it does not stop the two processes correctly there.

## Step 3: Make a golden set (recommended)

The golden set is a small set of cards (about 150) with atoms that you check yourself. The app uses it for two jobs:

- It selects the CR rules that each packet always contains (the packet kernel). Without a golden set, each packet has only the rules that its card text names.
- It scores each extraction run, so you can see if the model reads the cards correctly.

The full procedure, with the rules of a reading and the proposal format, is in `config/golden-set-procedure.md`. In short:

1. Run `npm run golden -- --select`. It selects candidate cards. On a new database, it first measures the cards with the thinnest packets (`--bottom-decile`).
2. Open Claude Code in this folder. Ask: "Draft the next 10 golden cards. Follow `config/golden-set-procedure.md`." Each draft is a file in `data/golden-drafts/`.
3. Check each draft on the **Golden set** page (`#/golden`), or with `npm run golden:draft -- --show <oracle_id>`.
4. Accept a correct draft with `npm run golden:draft -- --accept <oracle_id>`. Add `--complete` only when every clause of the card has its atoms. Reject a wrong draft with `--reject <oracle_id> --note "<reason>"`.
5. Run `npm run kernel:derive`.

After each `sync:cards` or `sync:rules`, run `npm run golden -- --bottom-decile` and then `--select` again.

## Step 4: Read the cards (atoms)

The graph and the deck search support black, red and black-red cards now. Start with the black-red slice:

1. Run `npm run extract -- --prepare --batch slice --colours BR`. It writes batch folders in `data/extract-batches/run-<N>/`.
2. In Claude Code, ask: "Dispatch one fresh atom-extractor subagent for each batch folder in `data/extract-batches/run-<N>/`. Give each one only its folder path." Each subagent writes `response.json`.
3. Run `npm run extract -- --submit-run <N>`. It checks and stores the atoms.
4. Run `npm run extract -- --escalate <N>`. It writes voting passes for the cards that need a second reading. Dispatch and submit them as in steps 2 and 3.

To score the reading against your golden set, run `npm run extract -- --prepare --batch golden`, dispatch and submit it, and then run `npm run packet-check -- --run <N>`. Do this on a copy of the database (see "Rules for the database"), because a golden run replaces the atoms of its cards.

## Step 5: Derive the edge rules

The edge rules use Opus. Stage A finds the role of each tag (supply, demand or both). Stage B writes the rules for each demand tag. Run `npm run edge-rules -- --measure` first: it prints the number of subagent runs of each stage, and makes no set.

1. Run `npm run edge-rules -- --prepare --stage roles --model claude-opus-5-5`. It makes a new rule set and writes pass folders.
2. Dispatch one fresh `edge-rule-deriver` subagent for each pass folder. Then run `npm run edge-rules -- --submit-set <set> --stage roles`.
3. If items are disputed, run `npm run edge-rules -- --debate-prepare --set <set> --stage roles`. Dispatch one fresh `edge-rule-debater` subagent for each folder, and run `--debate-submit`. Do this again until no item is disputed. A disputed role that stays has the role `none`.
4. Run `npm run edge-rules -- --prepare --stage pairs --set <set>`. This step writes generated agents in `.claude/agents/` (`edge-rule-pair-deriver-g<N>` and `edge-rule-pair-debater`). Do not edit them.
5. Start a new Claude Code session, because a session loads agent files only when it starts. Dispatch one subagent of the named group for each pass folder. The session that dispatches can run on Haiku, because each agent file sets its own model.
6. Run `npm run edge-rules -- --submit-set <set> --stage pairs`. Debate the disputed rules as in step 3, with `edge-rule-pair-debater`. A disputed rule that stays is not in the build.
7. Run `npm run edge-rules -- --accept --set <set>`.

## Step 6: Build the graph

```bash
npm run graph -- --groups --scope BR
npm run graph -- --build --scope BR
npm run rate-fit
```

- `--groups` splits each card text into ability groups.
- `--build` makes a graph build from the accepted rule set. A build with the same inputs is used again.
- `rate-fit` calculates the card rate. Run it after each new build, or the deck page disables the card rate switch.

Open **Explore cards** (`#/graph`) to see the links of each card, the atoms and the rule of each link.

To compare two builds, run `npm run build-diff -- <old build> <new build>`.

To score a build, make an edge golden set (labeled card pairs) first:

1. Run `npm run edge-golden -- --sample --round 1`, then `--prepare-round 1`.
2. Dispatch one fresh `edge-golden-labeler` subagent for each pass folder. Then run `--submit-round 1`.
3. Run `npm run edge-golden -- --status`. Do more rounds (2, 3, and so on) until the counts meet the targets.
4. Optional: run `--owner-sample` and answer the pairs on the **Edge golden set** page (`#/edge-golden`). Then run `--review-prepare`, dispatch one `edge-golden-reviewer` subagent for each batch, and run `--review-submit`.
5. Run `npm run graph -- --score --build <id>`.

## Step 7: Build decks

Open **Build a deck** (`#/decks`). You can use the deck in two ways:

- Fill the goal form: colours, target turn, interaction, minimum creatures, seed cards, "must have" cards, excluded cards and "never" tags. Then press **Build the deck**.
- Describe the deck in the panel **Describe your deck**. Claude asks questions and fills the form. Only you press **Build the deck**.

The deck page shows the 60 cards by mana value, the lands, the colour sources, the warnings, the reason of each card and the Arena import text. In the panel **Talk about this deck**, Claude suggests real cards, and you press **Swap**, **No** or **Undo**.

You can also build a deck from the terminal. This command writes nothing:

```bash
npm run deck -- --seed "<card name>" --colours BR --turn 6 --interaction some --creatures 14
```

## Step 8: Correct your links

- On a deck page, mark a link as false ("This link is false") or as weak.
- Press **Check the links with Claude**. Claude writes suggestions: delete, add or correct a link. Answer them on the **Decisions** page (`#/decisions`), tab "Link changes".
- Press **Apply link changes**. The app opens a new Claude Code session. That session follows `config/link-apply-procedure.md`, shows you its plan, and changes nothing before your yes.
- After a change of the object gate or the exclusion list, restart `npm run dev:api`, because the API keeps the pair table in memory. Make a new deck to see the changes. A stored deck keeps its links.

## Game review

The API reads the MTG Arena logs at each start and each 30 seconds. It links each game to a deck, and you can talk about a game in the deck chat (panel **Games**).

- In Arena, select the gear icon, then **View Account**, then **Detailed Logs (Plugin Support)**. Then restart Arena.
- The app reads the usual Arena log folder of Windows (`AppData/LocalLow/Wizards Of The Coast/MTGA`). On another system, or for another folder, set `GAME_LOG_DIR`, or set `log_dir` in `config/game-review.json`.
- `npm run game-scan` does one scan and prints counts.

## Optional checks

| Command | What it does |
|---|---|
| `npm run cr-duplicates` | Finds groups of CR sentences that say almost the same thing. The Overview shows these pairs as "optional questions". |
| `npm run cr-debate -- --prepare --round <n>` | Writes debate packets for these CR pairs. Dispatch one fresh `edge-rule-debater` subagent for each debater folder, then run `--submit --round <n>`. |
| `npm run tag-describe -- --prepare` | Writes batches that describe each tag in plain words. The steps are `--check-prepare`, `--debate-prepare` and `--finalise`, each with `--run <n>`. The result goes into `config/tag-descriptions.json`. |
| `npm run batch:select -- --size 400` | Selects a stratified sample of cards. `npm run extract -- --prepare --batch stratified` prepares the same sample for extraction. |

## The fix-dispatch mod

On a link, **Fix this reason** saves a fix request and writes a brief in `data/fix-requests/`. The mod in `.claude/skills/fix-dispatch` sends the brief to the Claude Code session with the title that you give.

- Each Claude Code session in this folder of the desktop app loads the mod when it starts. The mod asks the API at `http://127.0.0.1:8787` each 20 seconds, so it works only on the default API port.
- The mod reads the titles of your open sessions, and it sends the brief to the session with the same title.
- If you do not want this, remove the folder `.claude/skills/fix-dispatch`.

## The screens

| Group | Screen | Route | What it shows |
|---|---|---|---|
| — | Overview | `#/` | The status of each step and the newest build |
| — | Guide | `#/guide` | How to check links, and the words of the app |
| — | Decisions | `#/decisions` | The questions that only you can answer, and the link changes from Claude |
| — | Build a deck | `#/decks`, `#/decks/:id` | The goal form, the saved decks, the deck page and the chats |
| Result | Graph build | `#/graph-builds` | The builds, their counts and their scores |
| Result | Explore cards | `#/graph` | The links of a card, the atom pair and the rule of each link, and its loops |
| Card data | Cards | `#/cards`, `#/card/:id` | The card browser and the card inspector: faces, rules packet, clauses and atoms |
| Card data | Pool and rules | `#/pool` | The pool size, the rotation changes and the rules version |
| Atom extraction | Runs | `#/runs` | The extraction runs and their batches |
| Atom extraction | Golden set | `#/golden` | The golden cards and the drafts to check |
| Atom extraction | Review queue | `#/review` | The findings of the checks, by severity |
| Synergy edges | Edge rules | `#/edge-rules` | The rule sets, the roles, the rules and the debate results |
| Synergy edges | Edge golden set | `#/edge-golden` | The labeled card pairs |

## Settings

The settings are in `config/`. All values are starting values. Change them to fit your play.

| File | What it sets |
|---|---|
| `atom-schema.json` | The tag list: each tag, its parameters and its evidence |
| `tag-descriptions.json` | A plain description of each tag |
| `packet-policy.json`, `core-packet.json` | Which CR rules go into each packet |
| `escalation.json` | When a card gets a second reading |
| `graph-policy.json` | The graph build: weights, cycle limits, golden set sizes and `excluded_rules` (rules that the build leaves out; empty at the start) |
| `text-tests.json` | The text tests that split a card into ability groups |
| `deck-policy.json` | The deck search: weights, the mana base and the warnings |
| `deck-chat.json`, `deck-chat-prompt.md`, `build-chat-prompt.md` | The model, the effort and the prompts of the two chats |
| `game-review.json` | The scan time and the Arena log folder |
| `golden-set-procedure.md` | The steps and the rules of golden set drafting |
| `link-apply-procedure.md` | The steps of a session that applies link changes |

## Commands

| Command | Use |
|---|---|
| `npm run sync:cards`, `npm run sync:rules` | Get or update the cards and the rules |
| `npm run seed:atom-schema` | Load the tag list into a new database |
| `npm run generate:atom-schema -- --persist` | Make the tag list again from the CR, after a new CR version |
| `npm run golden -- --select` / `npm run golden:draft -- ...` | Select and draft the golden cards |
| `npm run kernel:derive` | Derive the packet kernel from the golden set |
| `npm run extract -- --prepare --batch golden\|slice --colours BR` | Write the extraction batches |
| `npm run extract -- --prepare --card <oracle_id>` | Write a batch for named cards |
| `npm run extract -- --submit-run <N>` / `--escalate <N>` / `--status` | Store a run, write its voting passes, show its state |
| `npm run packet-check -- --run <N>` | Score a golden extraction run |
| `npm run edge-rules -- ...` | Derive, debate, score and accept the edge rules (Step 5) |
| `npm run graph -- --groups` / `--build` / `--score --build <id>` | Ability groups, graph build, build score |
| `npm run graph -- --cycles --build <id> --card <oracle_id>` | The best loops of one card |
| `npm run graph -- --sweep --build <id>` | Read again the cards with the most links |
| `npm run build-diff -- <base> <after>` | The link pairs that each kind and rule adds or removes |
| `npm run edge-golden -- ...` | Make the edge golden set |
| `npm run link-check -- --sample` | 20 linked pairs for you to check |
| `npm run tag-check -- --sample` | Cards with their atoms, for you to check |
| `npm run owner-questions -- --make` | The questions with the most help, for the Decisions page |
| `npm run golden-check -- --apply` | Put your answers to "Does card A help card B?" into the edge golden set |
| `npm run duplicate-rules` | The rules that other rules contain, and conflicts |
| `npm run trigger-gap` | Trigger texts that have no tag |
| `npm run run-compare -- --run <N> --before <db copy>` | Compare a run with the atoms that it replaced |
| `npm run rate-fit` | Calculate the card rate after a build |
| `npm run rate-fields`, `rate-groups`, `rate-proof` | Show the parts of the card rate |
| `npm run deck -- ...` | Build one deck in the terminal |
| `npm run link-apply -- ...` | The commands of the link apply session |
| `npm run game-scan` | One scan of the Arena logs |

## Rules for the database

- `data/app.db` is a WAL database. To copy it, use `VACUUM INTO '<file>'` in SQLite. Do not use `cp`: a plain copy can be old or broken.
- To run a command on a copy, set `APP_DB_PATH` to the copy. For a golden run, also set `EXTRACT_BATCHES_DIR`.
- `npm run generate:atom-schema` writes `config/atom-schema.json`, also when `APP_DB_PATH` points to a copy.

## Tests

```bash
npm test
npx tsc --noEmit
npm run test:db
```

- `npm test` runs the unit tests. Each test file gets its own empty database in a temp folder.
- `npx tsc --noEmit` checks the types.
- `npm run test:db` runs all tests on `data/app.db`. Run it after you have a pool, atoms, rules and a build. Before that, some tests fail as expected:
  - before the golden set and `kernel:derive` (Step 3): "the golden set is non-empty" in `tests/kernel.test.ts`, and the kernel size test in `tests/e2e-pool.test.ts`,
  - before the first build (Step 6): `tests/cr-duplicates.test.ts`, `tests/deck-export.test.ts`, `tests/edge-packets.test.ts` and `tests/rate-fit.test.ts`.

## Limits

- The graph and the deck search support only black, red and black-red cards.
- The card rate is a value from card text only. It is not a win rate, and nobody has checked it against your play. The switch is off by default.
- The links are hints. Many links are false, and some real links are not there. The corrections of Step 8 make them better.
- A command that needs an earlier step stops with an error and a stack trace, for example `graph -- --build` with no accepted rule set, or `deck` and `rate-fit` with no build. Do the steps in the order of this guide.
- Some code comments name design notes that are not in this repo.
- `npm audit` reports known faults in some development packages. The app runs on your own computer only.

## License

MIT. See `LICENSE`.

Spellweb is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
