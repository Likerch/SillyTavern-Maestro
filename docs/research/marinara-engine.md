# Marinara Engine: the agent system

Recon for Maestro's agents plan ([`../agents-plan.md`](../agents-plan.md)). Source: Pasta-Devs/Marinara-Engine at commit
`fc0333c` (2026-11-06, version 2.5.2), read only; agent packages from Pasta-Devs/Marinara-Agents; CHANGELOG, docs,
GitHub issues, two Reddit threads. Paths are relative to the Engine repo root. **[inference]** marks my reading.

Since 2.3.0 the Engine ships no agent prompts: every former built-in is a downloadable, hash-verified package in
Marinara-Agents (48 package folders). The Engine keeps the runtime: pipeline, executor, result applicators, UI.

## 1. Pipeline

- Everything runs on the server inside the generate route (`packages/server/src/routes/generate.routes.ts`, ~16k
  lines); the client gets SSE events `agent_start / agent_result / agent_warning / agent_error`.
- Three phases (`AgentPhase`, `packages/shared/src/types/agent.ts:22`), orchestrated by
  `services/agents/agent-pipeline.ts` → `{ preGenerate, runParallel, postGenerate }`:
  - `pre_generation` — before the main call, adds context to the prompt;
  - `parallel` — at the same time as the main call, never sees the reply;
  - `post_processing` — after the reply, may read it; rewriters may replace it.
- Ordering rules:
  - **text-rewrite agents run last and one after another**, each on the text the previous one left, each seeing a
    summary of every other post-processing result of the turn; the built-in rewriters (Prose Guardian, Continuity,
    Immersive HTML) are first merged into one editor call;
  - **pre-generation agents do not re-run on swipes / regenerates** — cached injections are reused; post agents run
    after every reply;
  - knowledge retrieval / router run as separate parallel promises; Lorebook Keeper has its own path.
- Cadence: `runInterval` 1–100 counted in user + assistant messages since the agent's last **successful** run
  (`services/generation/agent-cadence.ts`). Gates on top (2.5.0): activation keywords (scan depth 5), then a yes/no
  **activation question** to a small "Decision model" (threshold 0.5, batched per phase, timeout or garbage = run),
  plus "run anyway after N skips". Trackers can be switched to manual (re-run from the HUD).
- **Batching**: agents of one phase are grouped by connection + model + context compatibility and sent as ONE call:
  "You are a collection of N specialized agents… return one valid JSON object with one property per agent ID"
  (`agent-executor.ts:1753`). The context is the **union** of the members' sources; output budget = sum of their
  `maxTokens`; members missing from the reply or with bad JSON are retried individually (≤4 at a time). Excluded
  from batches: agents with "Share requests with other agents" off (2.5.0, after issue #6977), rewriters, tool users,
  image agents, agents reading their previous output, a few heavy built-ins.
- Concurrency: ≤8 groups per phase (`AGENT_PHASE_MAX_CONCURRENT_GROUPS`, `agent-pipeline.ts:70`), per-connection
  "max parallel jobs" 1–16, ≤4 tool agents at once, a sequential switch for small local GPUs.
- Where results go:
  - `context_injection` / `director_event` → `AgentInjection {agentType, agentName, text}` placed at a preset "Agent
    Section" marker or appended as a wrapped block;
  - trackers → per-message, per-swipe `game_state_snapshots`;
  - `text_rewrite` → replaces the message ("Hold Message Until Rewrite" hides the raw reply meanwhile);
  - `prompt_patch` → edits the outgoing prompt (`target`, `mode: append|prepend|replace`);
  - images, sprites, backgrounds, music, haptics, CYOA buttons, an audience widget;
  - lorebook, summary and card writes → an approval queue (`routes/generate/agent-write-approval.ts`);
  - "Add as Prompt Section" feeds a tracker's latest output into later prompts (on by default for trackers).

## 2. Data model

`packages/server/src/db/schema/agents.ts`:

```ts
agentConfigs = { id, type, name, description, phase: "pre_generation"|"parallel"|"post_processing",
                 enabled /*legacy*/, connectionId, imagePath, promptTemplate, settings /*JSON*/, createdAt, updatedAt }
agentRuns    = { id, agentConfigId, chatId, messageId, swipeIndex, resultType, resultData, tokensUsed, durationMs,
                 success, error, createdAt }
agentMemory  = { id, agentConfigId, chatId, key, value, updatedAt }   // KV per agent per chat
```

- Almost everything lives in `settings`: `resultType`, `contextSize` (messages, default 5), `maxTokens` (default 4096),
  `runInterval`, `promptTemplates[]` (named prompt variants, selectable per chat), `contextSources`, `injectAsSection`,
  `includePreGenInjections`, `includeParallelResults`, `holdForRewrite`, `batchWithOtherAgents`,
  `customCapabilities`, `enabledTools`, `lorebookWriteEnabled`, `activation*`; agent-specific values (`banned`,
  `directorMode`) are plain keys used as `{{banned}}` in the prompt.
- Context sources: `chatHistory, characters, persona, activatedLorebookEntries, chatSummary, authorNotes, trackerData,
  recalledMemories, previousOutput`. Custom agents default to chat history only; summaries are left out since 2.4.6.
- **32 result types** (`AGENT_RESULT_TYPE_VALUES`, `types/agent.ts:40`); custom agents may pick 21. Only
  `context_injection` and `director_event` are plain text, the rest is JSON checked by type-specific parsers (no
  formal JSON Schema; the format is described in the prompt).
- Model per agent: `connectionId` → global "default for agents" → a built-in local sidecar model → the chat's
  connection; fallback connection supported. Sampling from the connection's defaults; never the chat preset.
- Scope: definitions are global; enabling is **per chat** (`chat.metadata.enableAgents` + `activeAgentIds[]`); per-chat
  overrides for prompt variant and some settings. **No per-character scope** ("agents are turned on per chat").
  Chat presets can carry the agent list.

## 3. Agents (all packages are `enabledByDefault:false`)

| Agent | Phase | Result |
|---|---|---|
| Prose Guardian — banned words, repetition | post | text_rewrite (hold on) |
| Continuity Checker — spatial/timeline/physical errors; user ticks fixes | post | text_rewrite |
| Immersive HTML — in-world HTML | post | text_rewrite |
| Narrative Director — one push per turn; optional hidden "secret plot" arc in agent memory | pre | director_event (+secret_plot) |
| Knowledge Retrieval / Router — summarise or pick lore | pre | context_injection |
| Card Evolution Auditor — card edits, always approved, every 8 msgs | post | character_card_update |
| World State, Character Tracker, Persona Stats, Quest, Inventory, Custom Tracker | post | tracker updates |
| Expression Engine, Background, Beholder (clothes by slot, wounds) | post | sprite / background / injection |
| Memory Nag, Lorebook Keeper (durable facts, every 8 msgs, `search_lorebook` tool) | post | memory / lorebook_update |
| Echo Chamber (audience), Combat (initiative, HP, dice tool) | parallel | widget / game state |
| Illustrator (every 5 msgs), Music DJ, Haptics, CYOA Choices | post | image / media / buttons |

Prompt contracts worth noting:
- Prose Guardian: "Rewrite only `<assistant_response>`… Banned words: `{{banned}}`… Return
  `{"editNeeded":false,"editedText":"","changes":[]}`… editedText must be the full final message, never a diff."
- World State: "Preserve the previous state unless the latest narrative explicitly changes it…"; incremental mode
  `{"updates":[…],"removed":[…]}` is advertised by the host with a capability line.
- Narrative Director: "Return one concise direction for the next main response… Do not write prose…
  `{"direction":"…"}`"; the secret plot arc (`overarchingArc`) lives in agent memory.

## 4. Custom agents

- Editor (`client/src/components/agents/AgentEditor.tsx`, 5.1k lines): name, description, phase; **15 opt-in
  capabilities** (create/edit lorebooks, edit messages, edit trackers, backgrounds, image generation, edit main
  prompt…) that unlock result types; prompt template with an inline output example per type and named prompt
  variants; turn-data access toggles; activation keywords/question; tools; model override; "share requests"; budget
  (context size, max tokens); "Add as Prompt Section"; a single writable lorebook.
- "Copy agent", reset to default per prompt variant; package updates merge new defaults with the user's edited
  variants by id. The built-in assistant can author agents.
- **No test-run button**; dry run explicitly skips agents. Testing = real chat + re-run.
- Import/export of single agents, sets, folders and agent repositories. Imports are locked by default; each import
  lists its capabilities for approval, gets a fresh id (can never replace an official agent), no tools, no code.

## 5. State, memory, chaining

- `game_state_snapshots` per message and swipe with a `committed` flag (set when the user sends the next message),
  **field locks** protecting the user's edits, `manualOverrides`; swipes rewind state.
- `agent_memory` KV per agent per chat; since 2.4.6 an `"agent-context"` field in an agent's JSON is kept as private
  continuation context for its next run and never injected.
- No general A→B graph: post agents may opt into this turn's pre-generation injections and parallel results; rewriters
  see all post results; trackers chain through committed state.
- Tools: up to 16 rounds (`AGENT_MAX_TOOL_ROUNDS`): chat summary, edit message, chat variables, dice, lorebook
  read/write, expression, game state, web search, user-written custom tools.

## 6. Cost and robustness

- All off by default; JSON agents request reasoning off (a 12B local model burned 4096 tokens thinking, ~273 s turn);
  grammar-constrained JSON on the local model; an agent asking for the local model is skipped, not billed elsewhere.
- Timeout 300 s per agent call; streaming to dodge proxy timeouts; one strict retry on invalid JSON; a rewrite cut by
  `finish_reason=length` is rejected and the original kept (#8643); inventory JSON is never "repaired" (truncated
  arrays would delete items); a failed group never breaks the main reply.
- Failure UI: a dot on "Agent activity", failed agents with **Retry**, error classes (context limit, timeout,
  rejection, auth, rate limit, invalid response, tool error).
- Cost readout: instruction tokens + extra calls (phase × connection × lane), amber at ≥4 calls or ≥4000 tokens;
  deliberately excludes chat context, so real cost is higher.
- Debug: full prompt/response log per call in debug mode; a content-free progress stream (stage, TTFT, tokens,
  elapsed) for the Agents menu; `agent_runs` per run; an **Injections tab** to view, edit and re-run pre-gen output.

## 7. UX

- Chat Settings → Agents: master switch, "Add Agent" (Writer / Tracker / Misc / Custom), tracker controls, "Review
  Agent Outputs", the **Agent Suite** (stored memory, tracker data and recent outputs per agent, editable, JSON-checked).
- In chat: HUD and tracker panel with locks, CYOA buttons, "Push Story", a continuity fix checklist, approval modals
  (before/after, stale detection), "Agent activity" bubbles with phase, tokens and time.
- Since 1.5.9 writer agents may pause before the main reply so their injections can be edited.
- **Game mode does not use tracker agents**: the GM keeps state through its own tool calls (≤4 rounds) and inline tags
  — a code-driven path, with only a few optional agents (illustrator, music, session keeper).

## 8. Evolution and feedback

- 1.4.0 — 23 agents, custom tools, per-swipe snapshots; 1.5.7 — custom agents choose a result type (incl. Text
  Rewrite) and get chat memory; 1.5.9 — per-connection parallel jobs, review of writer injections, fix for agent
  output leaking into the main prompt; 2.0.0 — all agents reworked, import/export; 2.0.9 — batching switched to a raw
  JSON map to fix lag; 2.3.0 — agents become packages; 2.4.0 — per-agent context sources, intervals count both sides;
  2.4.6 — summaries out of agent requests, private agent context; 2.5.0 — activation questions, Decision models,
  "share requests" switch; 2.5.2 — Agent Organizer store with starter kits.
- Problems: batching confused local models and leaked one task's context into another (#6977); writer agents
  "roleplayed" instead of advising (#470); big tracker histories froze the client (#3104); the whole pipeline ran on
  out-of-character GM turns (#473); reasoning-only models failed as agent connections (#5582).
- Reddit (r/SillyTavernAI): "multiple requests of around 80k tokens" per turn; plot/continuity agents added plot
  holes and "really need a highly intelligent LLM"; marginal gains for much higher cost and slower replies; "still
  very much in beta".

## What Maestro takes and what it leaves

Takes:
1. The three phases, plus rewriters last and in sequence with the `editNeeded / editedText / changes` contract;
   reject a truncated rewrite.
2. Pre-generation results cached across swipes; post results stored per swipe; committed state only after the next
   send (Maestro already has this as P14).
3. Cheap gates in order (interval since the last successful run → keywords/conditions → optional cheap yes/no
   question), "run anyway" on gate failure.
4. Batching keyed by connection + model + context, an explicit JSON skeleton, individual retry, a per-agent opt-out.
5. Private continuation memory per agent per chat; editable agent memory/state with field locks.
6. Reasoning off for JSON agents; one strict JSON retry.
7. Capability-gated result types, permission review on import, fresh ids for imports.
8. Run log with error classes and Retry; a progress line without content; an injections view with edit / re-run.

Leaves:
- 32 result types, media/haptics/sprites; per-chat-only scope (Maestro keeps везде / персонаж / чат).
- Union-of-context batching by default; whole cards in every call; agents re-reading full history.
- Writing story state through free-form tracker agents where a deterministic store exists (DES, mechanics, canon):
  Marinara itself keeps Game mode state code-driven.
- No test run: Maestro adds «Что увидит агент» (no model) and «Пробный запуск» (model, nothing applied).

Sources: https://github.com/Pasta-Devs/Marinara-Engine · https://github.com/Pasta-Devs/Marinara-Agents ·
https://newreleases.io/project/github/Pasta-Devs/Marinara-Engine/release/v1.4.0 · GitHub issues #6977, #3104, #473,
#470, #5582, #8643 · Reddit snapshots via reddit.sentinel-team.org (posts 1spufte, 1td6q7j).
