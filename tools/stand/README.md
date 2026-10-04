# Test bench

A local SillyTavern 1.19 with the whole neighbour stack, fixtures and the mock model (dev-plan §2). It runs the
SillyTavern **source tree** with Node directly (no Docker) and keeps everything it creates in
`tools/stand/runtime/` (gitignored); the SillyTavern folder itself is never modified.

```bash
npm run build                          # Maestro needs dist/ (or keep `npm run dev` running)
node tools/stand/stand.mjs setup       # once (and after `reset`)
node tools/stand/stand.mjs start       # mock LLM :5199 + SillyTavern :8123, in the background
node tools/stand/stand.mjs status
node tools/stand/stand.mjs stop
```

Open http://127.0.0.1:8123 — the reference chat «Хроники Серебряной Гавани» loads and is connected to the mock.

## Commands

| Command                                                                | What it does                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup [--force] [--maestro=copy] [--no-neighbours] [--preset <file>]` | writes `runtime/config/config.yaml` and `runtime/data/default-user/` (settings, extensions, lorebooks, card, chats, images). `settings.json` is kept on re-runs unless `--force` |
| `start` / `stop` / `restart`                                           | background processes; pids in `runtime/pids.json`, logs in `runtime/logs/{st,mock}.log`                                                                                          |
| `run`                                                                  | both in the foreground with prefixed logs (Ctrl+C stops both)                                                                                                                    |
| `reset`                                                                | stop and delete runtime data, config, requests, logs; the vendor cache stays                                                                                                     |
| `status`                                                               | installed neighbours, Maestro link/build state, processes, recorded requests                                                                                                     |
| `logs [st\|mock] [-n 80]`                                              | tail of the logs                                                                                                                                                                 |

## What setup installs

- **SillyTavern config** — a copy of `default/config.yaml`: port 8123, `listen: false`, whitelist on (`127.0.0.1`,
  `::1`), basic auth off, no browser launch, no extension auto-update, no model/tokenizer downloads, no chat backups.
  Started with `--configPath`, `--dataRoot`, `--port`, `--listen=false`, `--whitelist=true`, `--basicAuthMode=false`,
  `--browserLaunchEnabled=false`. Data root: `runtime/data` (webpack cache in `runtime/data/_webpack`).
- **settings.json** — from `default/content/settings.json`: `main_api: openai`, `oai_settings.chat_completion_source:
custom`, `custom_url: http://127.0.0.1:5199/v1`, `custom_model: mock-deepseek-v4`, `stream_openai: true`, context
  65 536, reply 1 200 tokens; user «Кай»; `active_character` + `power_user.auto_load_chat` + `auto_connect`; global
  lorebooks: the CK archive, BunnyMo V3.0, Species, Dere, BunnTrAIts; CarrotKernel: the archive is a character repo,
  display mode `none`; DES «What's new» marked as seen. `--preset <file.json>` copies a Chat Completion preset (e.g.
  Marinara) to `OpenAI Settings/` and applies its prompt keys (connection keys are kept).
- **Neighbours** — per-user extensions in `runtime/data/default-user/extensions/<folder>` (ST 1.19 serves
  `/scripts/extensions/third-party/<folder>` from there). Pins are in `sources.mjs`:

  | Folder                                | Version | Source                                                                      |
  | ------------------------------------- | ------- | --------------------------------------------------------------------------- |
  | SillyTavern-MessageSummarize (Qvink)  | 1.3.29  | github clone at `81b3326` in `runtime/vendor/qvink`                         |
  | Dooms-Enhancement-Suite               | 2.6.0   | `../SillyTavern-DES-RU/vendor/des` @ `10ad241`                              |
  | CarrotKernel                          | 1.0.0   | `../SillyTavern-DES-RU/vendor/CarrotKernel` @ `145c273`                     |
  | SillyTavern-Doom-Enhancement-Suite-RU | 0.7.0   | `../SillyTavern-DES-RU` @ `2128441`                                         |
  | SillyTavern-NAI-Studio                | current | `../SillyTavern-NAI-Studio` @ `HEAD` (dist/ is committed; no server plugin) |
  | SillyTavern-LorebookLocalizer         | 0.1.0   | `../SillyTavern-LorebookLocalizer` @ `ae00f4b`                              |

  Commits are exported with `git ls-tree` + `git cat-file --batch` into `runtime/vendor/exports/<folder>@<sha>` (no
  `.git`), then copied. Override a pin with `STAND_REF_<ID>=<sha|HEAD|WORKTREE>` (ids: qvink, des, ck, desru, nai,
  localizer); `WORKTREE` copies tracked files including uncommitted edits.

- **BunnyMo V3.0 lorebooks** — 13 books from `../SillyTavern-DES-RU/vendor/BunnyMo` @ `7a61c9f` into `worlds/`.
- **Fixtures** (`tools/fixtures/`, see below) — lorebooks, the card as a PNG (`chara` + `ccv3` chunks), chats,
  placeholder images for the NAI Studio posts.
- **Maestro** — `extensions/SillyTavern-Maestro/` with a copy of `manifest.json` and a junction `dist → <repo>/dist`
  (so a rebuild only needs a page reload; `start` refreshes the manifest copy). `--maestro=copy` or
  `npm run deploy:local` installs a plain copy instead. Without `dist/index.js` SillyTavern starts without Maestro
  (404 in the console) and the bench prints a hint.

Paths: `STAND_ST_DIR` (default `../st-local-docker/src-1.19.0`), `STAND_NEIGHBOURS_ROOT` (default: the folder that
holds this repository), `STAND_ST_PORT`, `STAND_MOCK_PORT`, `STAND_RUNTIME`.

## Fixtures

`node tools/fixtures/make-fixtures.mjs` regenerates them (deterministic). Synthetic content only.

- `chats/reference-320.jsonl` — 320 turns (648 messages) of a Russian fantasy story (Элизабет, Вера, Мартин,
  Александр, Александра, Томас; Серебряная Гавань, маяк, топи, перевал). Assistant messages start with a DES
  together-mode block and carry `extra.dooms_tracker_swipes` (locations, weather, time, relationships and quests
  evolve over six arcs); some have two swipes; older ones carry `extra.qvink_memory` (some `remember: true`); six
  NAI Studio image posts (`extra.media`, `extra.nai_studio`, half hidden); a hidden OOC message; turn 120 is
  `!fullsheet Вера` with the sheet + scene + tracker defect.
- `chats/short-sheet.jsonl` — 5 turns with a `!fullsheet Мартин` reply.
- `worlds/Velmar Reaches.json` — the big world book: 49 English entries, English and some Russian keys, every entry
  names three others, so recursion pulls most of the book into the prompt (two constant entries start the chain).
- `worlds/Архив персонажей (стенд).json` — CarrotKernel archive as Baby Bunny writes it (position 4, depth 2, role
  assistant, `<BunnymoTags>` with MBTI tags); keys reproduce real problems («Вера», «Александр» inside «Александра»).
- `characters/silver-harbor.json` — spec v2 card «Хроники Серебряной Гавани» linked to `Velmar Reaches`.

## Prompt snapshots

The mock records every request. `snapshot.mjs` normalises the `messages` (line endings, blanks, timestamps, UUIDs)
and compares them with `tools/fixtures/golden/<name>.json`:

```bash
node tools/stand/snapshot.mjs list
node tools/stand/snapshot.mjs turn-default --update          # last request becomes the golden copy
node tools/stand/snapshot.mjs turn-default                   # compare; exit code 1 when different
node tools/stand/snapshot.mjs turn-default --request 12      # a specific recorded request
node tools/stand/snapshot.mjs --all replay --filter story    # every recorded main request -> replay-001, ...
```

The report shows sizes per role, detected blocks (DES tracker and instructions, BunnyMo tags and sheets, Qvink
memory, language lock, CK OOC, think, HTML, NAI markers, Maestro blocks, service garbage), how many entries of each
lorebook are present in the prompt, parameter changes and the changed messages with the first differing line.

## Measurements (R3 criteria)

`measure.mjs` turns a bench session into a docs-ready Markdown report for plan §14 (dev-plan 4.6). It only reads:
the recorded requests, Maestro's per-chat metrics documents (`user/files/maestro-chat-*-metrics.json`, written by
the M21m module in the browser) and the installed BunnyMo files.

```bash
node tools/stand/measure.mjs                                   # report for everything recorded so far
node tools/stand/measure.mjs --last 40 --out docs/reports/r3-bench.md
node tools/stand/measure.mjs --baseline runtime-copy/requests  # criterion 3: compare with a run without the rules
node tools/stand/measure.mjs --mock http://127.0.0.1:5199      # read the requests from the running mock
node tools/stand/measure.mjs --json                            # the same numbers as JSON
```

| Criterion                        | Source on the bench                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| 1. send-path latency, p95        | metrics document (the browser measures it; a narrow window counts as a phone)           |
| 2. background spend share        | `usage.cost` of the mock's replies by request kind (synthetic prices), and the document |
| 3. lore characters per turn      | lorebook entries found in the prompts of two recorded runs (`--baseline` = rules off)   |
| 4. dropped without a summary     | metrics document                                                                        |
| 5. assistant-role lore at depth  | metrics document (lore journal per turn)                                                |
| 10. BunnyMo files byte-identical | sha256 of `default-user/worlds/*` against the pinned BunnyMo export                     |
| 6–9                              | by hand on the bench or only in real play: the pult tab «Замеры» shows them             |

Request kinds come from the mock's scenario labels: `story`/`sheet`/`refusal`/`repeat` → main, `summary` → Qvink,
`schema:maestro_*` and tool calls → Maestro, `schema:nai_*` → NAI Studio, the rest → other. A turn is a main request
plus every request until the next main one. For criterion 3 record the reference turns twice: once with Maestro's
lore rules off (copy `runtime/requests` aside, `POST /__reset`), once with them on, then pass the first folder as
`--baseline`. Entries that reached the prompt only without the rules are listed for the "was it needed?" check.

## Notes

- SillyTavern 1.19 discovers per-user extensions in `<dataRoot>/default-user/extensions` (`/api/extensions/discover`,
  type `local`) and serves them under `/scripts/extensions/third-party/`. Folder names matter: CarrotKernel only
  works from `CarrotKernel`, DES-RU looks for `Dooms-Enhancement-Suite` first.
- The first `start` compiles SillyTavern's frontend libraries into `runtime/data/_webpack` (about 15 s).
- On page load NAI Studio asks the main API for character passports (`nai_passports` schema); the mock answers.
  Its server plugin is not installed, so `/api/plugins/nai-studio/*` returns 404 — expected.
- The vendor cache (`runtime/vendor`) survives `reset`; a pinned export is reused without git.
