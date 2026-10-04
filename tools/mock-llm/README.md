# Mock LLM

A dependency-free, OpenAI-compatible server for the Maestro test bench (dev-plan §2.2). SillyTavern talks to it as
a **Custom (OpenAI-compatible)** Chat Completion source. Replies are deterministic for the same request.

```bash
node tools/mock-llm/server.mjs                 # http://127.0.0.1:5199/v1, records into tools/stand/runtime/requests
node tools/mock-llm/server.mjs --port 0        # random port, printed as "MOCK_LLM_LISTENING port=<n> ..."
node tools/mock-llm/server.mjs --no-record --quiet
```

`tools/stand/stand.mjs start` runs it for you.

## Endpoints

| Route                                      | What                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/models`                           | `mock-deepseek-v4` (default), `mock-cheap`, `mock-premium`                                                                     |
| `POST /v1/chat/completions`                | `stream: false` → one JSON; `stream: true` → SSE `data:` chunks, a finish chunk, a usage chunk (`choices: []`), `data: [DONE]` |
| `GET /__requests`                          | recorded requests (summary)                                                                                                    |
| `GET /__requests/<n>` / `/__requests/last` | one recorded request: body, scenario, flags, the reply                                                                         |
| `POST /__reset`                            | forget and delete the recorded files (`{"keepFiles": true}` keeps them)                                                        |
| `GET /__config`, `POST /__config`          | runtime flags (same names as below, camelCase: `{"fail":"429","failRate":0.5}`; `{"clear":true}` resets)                       |

Every reply carries OpenRouter-like usage: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost` (USD from the
price table in `server.mjs`), `is_byok`, token details. Tokens are estimated as UTF-8 bytes / 4.

Each request is written to `tools/stand/runtime/requests/<UTC timestamp>-<n>.json` (pretty JSON) — the input of
`tools/stand/snapshot.mjs`.

## Scenarios

The scenario is picked from the **trailing user turn**: every user/system message after the last assistant message
that precedes the last user message (so depth-0 injections count, an assistant prefill does not).

| Trigger                                                                                   | Reply                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (nothing)                                                                                 | DES together-mode block ` ```json {"quests","infoBox","characters"} ``` ` + 2–4 paragraphs of Russian prose. Names, location, date and time are taken from the request (DES tracker JSON in the prompt, else capitalised names)                                                                                                                                                                                                                |
| `[mock:nojson]`                                                                           | no tracker block                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `[mock:english]`                                                                          | tracker values and prose in English                                                                                                                                                                                                                                                                                                                                                                                                            |
| `[mock:user]`                                                                             | adds actions and lines for {{user}} (name: `MOCK_USER_NAME`, a user message `name`, else «Кай»)                                                                                                                                                                                                                                                                                                                                                |
| `[mock:refusal]`                                                                          | refusal with moralising, no tracker                                                                                                                                                                                                                                                                                                                                                                                                            |
| `[mock:truncate]`                                                                         | cut mid-sentence (inside the prose), `finish_reason: "length"`                                                                                                                                                                                                                                                                                                                                                                                 |
| `[mock:bos]`                                                                              | starts with `<｜begin▁of▁sentence｜>` and a code block                                                                                                                                                                                                                                                                                                                                                                                         |
| `[mock:repeat]`                                                                           | repeats the previous assistant message verbatim                                                                                                                                                                                                                                                                                                                                                                                                |
| `[mock:invent]`                                                                           | adds a new named place/tradition that is not in the request                                                                                                                                                                                                                                                                                                                                                                                    |
| `[mock:reasoning]`                                                                        | adds `reasoning` / `reasoning_content` (streamed first)                                                                                                                                                                                                                                                                                                                                                                                        |
| `[mock:sheet]`, `[mock:sheet:Name]`, or a user line starting with `!fullsheet Name`       | BunnyMo-style sheet (`## SECTION n/14`, `**Name:**`, `<BunnymoTags>…<INTJ-H>…</BunnymoTags>`) **followed by an unrequested scene and a DES block** — the defect Maestro repairs. Mentions of `!fullsheet` inside instructions do not trigger it                                                                                                                                                                                                |
| system prompt «summarization assistant» (Qvink) or `[mock:summary]`                       | one-sentence summary                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `response_format: json_schema`                                                            | JSON for the schema: a registered handler (`maestro_ping`, `maestro_revision`, `maestro_living_canon`, `maestro_backstage`, `nai_passports`) or the schema walker (required properties, `minItems`, first enum value, bounds, `$ref`, `allOf`, `anyOf`). Unknown keys are dropped when `additionalProperties: false`. Modifiers: `[mock:fenced]` (wrapped in ` ```json `), `[mock:badjson]` (broken JSON), `[mock:truncate]`, `[mock:refusal]` |
| `tools` + `[mock:tool]` / `[mock:tool:name]` / a tool name in the message / `tool_choice` | a tool call with arguments from the tool's parameter schema; the next request with a `tool` message gets a closing answer                                                                                                                                                                                                                                                                                                                      |

Markers combine: `[mock:english][mock:truncate]`. A marker can also be forced for every request with
`MOCK_SCENARIO=english,nojson`, the `x-mock-scenario` header or `/__config`.

Add replies for Maestro's own schemas in `scenarios.mjs` with `registerSchema(name, (ctx, rng) => partialObject)`;
missing required fields are filled from the schema. `registerTool(name, ...)` does the same for tool arguments.

## Flags

Environment variable / request header (header wins) / `/__config` key:

| Env                                                             | Header                      | Meaning                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MOCK_LATENCY_MS`                                               | `x-mock-latency-ms`         | delay before the reply: `500` or a range `200-800`                                                                                         |
| `MOCK_FAIL`                                                     | `x-mock-fail`               | `429`, `500` or `drop` (connection closed without a reply); rate inline `429:0.3` or via `MOCK_FAIL_RATE` / `x-mock-fail-rate` (default 1) |
| `MOCK_FAIL_SCOPE`                                               | `x-mock-fail-scope`         | `all` (default), `main`, `schema`, `tools` or a comma list — e.g. break only background tasks                                              |
| `MOCK_STREAM_DROP`                                              | `x-mock-stream-drop`        | probability (or `1`) of cutting a stream after ~40 % of the chunks (no finish, usage or `[DONE]`)                                          |
| `MOCK_CHUNK_DELAY_MS`                                           | `x-mock-chunk-delay-ms`     | delay between stream chunks (default 5)                                                                                                    |
| `MOCK_SCENARIO`                                                 | `x-mock-scenario`           | forced markers                                                                                                                             |
| `MOCK_USER_NAME`                                                | `x-mock-user` (URI-encoded) | {{user}} name for `[mock:user]`                                                                                                            |
| `MOCK_SEED`                                                     | —                           | seeds the random draws of the failure flags                                                                                                |
| `MOCK_PORT`, `MOCK_HOST`, `MOCK_RECORD_DIR`, `MOCK_NO_RECORD=1` | —                           | server options                                                                                                                             |

SillyTavern can send the headers through the Custom source's "Include headers" field (`custom_include_headers`).
