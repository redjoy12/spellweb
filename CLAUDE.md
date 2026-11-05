# Spellweb

Synergy deck builder for MTG Arena Standard, best of one. `README.md` is the guide for the user. This file is for Claude Code.

## How the app knows Magic

- Exact words come from the card text and the Comprehensive Rules (CR) text in the database. Do not invent a quote or a rule number.
- For judgement (how cards play, if a link is real, which card is better), use your own Magic knowledge.
- Never write an answer of the user from your own knowledge. The user gives answers on the Decisions page or in chat.

## Stack and layout

TypeScript ESM, Node 24 (`node:sqlite`), Fastify 5 API, React 19 + Vite 6 SPA, Vitest 3, zod. The database is `data/app.db`.

- `src/scryfall`, `src/pool`: card sync, filters, rotation diffs
- `src/rules`: CR parse, lookups, relevance gate, packet assembly, packet kernel (`kernel.ts`)
- `src/atoms`: clause splitter, atom schema and tag list, extraction batches (`extractBatch.ts`), checks, golden set, review queue
- `src/graph`: edge rules, ability groups, graph build, object gate (`objectGate.ts`), scores, cycles
- `src/deck`: deck assembly: goal, pair table, search, mana base, checks, reasons, export, swap, link changes
- `src/rate`: the card rate (a text-only value, not a win rate)
- `src/server/chat`: the deck chat and the build chat: tables, tools, one CLI turn
- `src/games`: game review: Arena log text, game rebuild, card table, deck link, counts
- `src/cli`: one file per npm script; `src/server`: API; `src/web`: UI
- `config/`: atom schema (the tag list), packet policy, graph policy, deck policy, chat settings and prompts, game review settings, tag descriptions, link apply procedure

## Commands

```bash
npm test                 # unit tests, no card data needed
npm run test:db          # all tests, on data/app.db (needs a synced pool and your builds)
npx tsc --noEmit         # typecheck
npm run sync:cards && npm run sync:rules && npm run generate:atom-schema -- --persist
npm run extract -- --prepare --batch golden|slice --colours BR | --submit-run <run_id> | --escalate <run_id> | --status
npm run packet-check -- --run <run_id>
npm run edge-rules -- --prepare --stage roles --model claude-opus-5-5 | --prepare --stage pairs --set <set> | --submit-set <set> --stage roles|pairs | --debate-prepare|--debate-submit --set <set> --stage roles|pairs | --accept --set <set>
npm run graph -- --groups --scope BR | --build --scope BR | --score --build <id> | --sweep --build <id>
npm run build-diff -- <base> <after>    # read only: link pairs that each link kind and rule adds or removes
npm run rate-fit                         # after each new build, or the deck page disables the card rate switch
npm run deck -- --seed <name> --colours BR [--turn 6] [--interaction some] [--creatures 14]
npm run link-apply -- --show <request>   # the apply session of the link review (config/link-apply-procedure.md)
npm run game-scan                        # one scan of the Arena logs
```

Dev servers: run `npm run dev:api` and `npm run dev:web` in two terminals. On Windows, do not use `npm run dev`.

## Model work

The code makes no model call and has no API key. Each model step writes packet files, and a fresh subagent answers each one.

- Atom extraction: `--prepare` writes `data/extract-batches/run-N/batch-XXX/packet.md`. Dispatch one fresh `atom-extractor` subagent per batch and give it only the batch folder path. It writes `response.json`. Then `--submit-run` checks and stores the answers. The agent runs on Sonnet. If a golden run misses a bar, set the agent to `model: opus`.
- Edge rules: `edge-rule-deriver` and `edge-rule-debater` run on Opus. Pass `--model claude-opus-5-5` to the roles prepare.
- Stage B (`--stage pairs`) writes generated agents in `.claude/agents/` (`edge-rule-pair-deriver-g<N>`, `edge-rule-pair-debater`). Do not edit them. A session loads agent files only when it starts, so start a new session after a prepare that writes one. The orchestrator session can run on Haiku, because each agent file sets its own model.
- Disputed items: isolated debater subagents debate them with the packet text only. If they do not agree, the default stays: a disputed role is `none`, and a disputed rule stays out of the build.

## Rules for changes

- `data/app.db` is a WAL database. Copy it with `VACUUM INTO`, not `cp`. Point a command at a copy with `APP_DB_PATH`. A golden run replaces the live atoms of its cards, so run it on a copy with `APP_DB_PATH` and `EXTRACT_BATCHES_DIR`.
- `npm run generate:atom-schema` writes the tracked `config/atom-schema.json` even with `APP_DB_PATH`. Restore it before the real persist.
- Restart `npm run dev:api` after a change of the object gate or the exclusion list: the API keeps the pair table in memory.
- After a change to the game log parser, add 1 to `PARSER_VERSION` in `src/games/rebuild.ts`.
- A deck chat turn on a database copy is not isolated: `claude --resume` finds a session by ID in any folder. Use a deck with `deck_chats.started = 0`, or a new session ID.
- When you add a migration, run the database tests on a copy with `APP_DB_PATH`.
- Ask the user before a step that costs many model turns, and before a change that you cannot undo.

## Token hygiene

Do not read these whole: any `packet.md` (200 to 350 KB), `tests/fixtures/cards.sample.json`, `src/web/styles.css`, `src/cli/generate-atom-schema.ts`, `config/atom-schema.json`, or anything under `data/`. Grep them or read ranges.
