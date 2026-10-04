# Research: SillyTavern 1.19 World Info integration points (2026-10-04)

Root: `st-local-docker\src-1.19.0\` (local copy of the SillyTavern 1.19.0 source). Paths below are relative to it: WI = `public/scripts/world-info.js`, S = `public/script.js`. No files were changed.

**Biggest findings:**
- A dry run cannot reproduce sticky or cooldown effects.
- No hook tells you which key triggered an entry.
- Any edit to an entry changes its hash, which breaks its sticky/cooldown tracking.
- The book save debounce is shared across all books, so saves can be lost.
- The setExtensionPrompt filter pitfall is confirmed, with a nuance (section 8).
- Cyrillic text defeats whole-word matching.

**Imports.** An extension at `/scripts/extensions/third-party/<Ext>/index.js` imports `../../../world-info.js`, `../../../../script.js` and `../../../openai.js`. Many helpers are not in `getContext()`; the list is in section 6.

---

## 1. Events related to World Info (`public/scripts/events.js`)

| Event | Emitted where | Payload | Can listeners change the scan? | Dry run / quiet |
|---|---|---|---|---|
| `WORLDINFO_ENTRIES_LOADED` (:97) | `getSortedEntries()` WI:4604. Runs on every scan, on `CHAT_CHANGED` precache (WI:1013-1018), and whenever any extension calls `getSortedEntries` (Vectors does, inside its interceptor) | `{ globalLore, characterLore, chatLore, personaLore }`: arrays of per-scan copies `{uid, world, ...entry}` | **Yes**, but only in place (splice/push/edit). After the emit, the arrays are sorted and merged (WI:4606-4625), then `decorators` and `hash` are computed (WI:4628-4634). Changes last for that one call only. | Fires for dry runs and quiet runs. The payload has no dry-run flag, and the event fires several times per generation, so listeners must be idempotent. |
| `WORLDINFO_SCAN_DONE` (:98) | After **every scan loop** in `checkWorldInfo`, WI:5150-5186 | `{state:{current,next,loopCount}, new:{all,successful}, activated:{entries: Map<"world.uid",entry>, text}, sortedEntries, recursionDelay:{availableLevels,currentLevel}, budget:{current,overflowed}, timedEffects}` | **Yes.** Assigning `state.next`, `activated.text`, `recursionDelay.currentLevel`, `budget.current` or `budget.overflowed` is read back (WI:5179-5186). Arrays and the `activated.entries` Map can be mutated in place; the prompt is built from that Map (WI:5203). | Fires for dry runs and quiet runs. |
| `WORLD_INFO_ACTIVATED` (:62) | `getWorldInfoPrompt` WI:900-903, only when `!isDryRun && size>0` | `entry[]` in activation order. `content` is already macro-substituted (WI:5058) but not yet regex-processed. | No. The WI strings are already built when it fires. | No for dry runs; **yes for quiet runs**. Quick Reply uses it for `automationId` (`quick-reply/index.js:302`, `AutoExecuteHandler.js:87`). |
| `WORLDINFO_FORCE_ACTIVATE` (:77) | Emitted by you. The listener is WI:1020-1029 and stores entries in the static `WorldInfoBuffer.externalActivations` keyed `"world.uid"`. | `entry[]`; each needs `world` and `uid`. | The stored object **replaces** the scanned entry (`activatedNow.add(buffer.getExternallyActivated(entry))`, WI:4886-4889), so pass **full entries**, e.g. from `getSortedEntries()`. Gating still applies first (disable, triggers, characterFilter, delay, cooldown, delayUntilRecursion, excludeRecursion, `@@dont_activate`; WI:4801-4884), followed by probability, budget and inclusion groups. | The map is cleared at the end of **any** `checkWorldInfo`, dry runs included (WI:5275). Emit it right before the scan: from a `generate_interceptor` (this is how Vectors does it, `vectors/index.js:1725`) or from `GENERATION_AFTER_COMMANDS`. |
| `WORLDINFO_UPDATED` (:42) | `_save()` WI:4160, for both immediate and debounced saves | `(name, data)`. `data` is the same object that now sits in the cache. | Not applicable. | Not generation-related. It does **not** fire on delete, on import (WI:5850-5931) or for the old name on rename, and it fires even if the HTTP POST failed (the response is never checked). |
| `WORLDINFO_SETTINGS_UPDATED` (:41) | `onWorldInfoChange` WI:5842 (global book selection change, UI or `/world`), and the UI setting inputs WI:6226-6313 | none | Not applicable. | It is **not** fired for overflow-alert or group-scoring changes (WI:6287-6295) or by `updateWorldInfoSettings()`. The CC Prompt Manager re-renders on it, which triggers a dry run (`PromptManager.js:835`, `:862-872`). |

**Related generation events:**
- `GENERATION_STARTED` and `GENERATION_AFTER_COMMANDS` pass `(type, params, dryRun)` (S:4299, S:4321). Use them to flag dry runs, since the WI events carry no flag.
- `GENERATE_AFTER_COMBINE_PROMPTS` passes `{prompt, dryRun}` (S:5242).
- `CHAT_COMPLETION_PROMPT_READY` passes `{chat, dryRun}` (`openai.js:1618`).
- `GENERATE_AFTER_DATA` passes `(generate_data, dryRun)` (S:5318).
- `ITEMIZED_PROMPTS_LOADED/SAVED/DELETED` come from `itemized-prompts.js:35,53,90`.
- `emit` awaits listeners one after another and swallows their exceptions (`public/lib/eventemitter.js:130-158`).

## 2. Dry run: computing activations without generating

**Option A: `getContext().getWorldInfoPrompt(chatReversed, maxContext, true, globalScanData)`** (WI:892-915)
- Returns strings only: `{worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples:[{position,content}], worldInfoDepth:[{depth, entries:string[], role}], anBefore[], anAfter[], outletEntries:{name:string[]}}`.
- Entry identities are not included.

**Option B: `import { checkWorldInfo }`** (WI:4709; not in the context)
- Returns `{worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries, ANBeforeEntries, ANAfterEntries, outletEntries, allActivatedEntries: Set<entry>}` (WI:5281).
- Each entry carries `world, uid, content` (macro-substituted, not regexed), `position, depth, role, order, outletName, hash, decorators` and the rest.

**Building the inputs the way Generate does** (S:4624-4635):
- `chatForWI = coreChat.map(x => world_info_include_names ? \`${x.name}: ${x.mes}\` : x.mes).reverse()`. Newest first; `coreChat` already has regex, file content and reasoning applied.
- `maxContext = getMaxPromptTokens()` (S:5981, exported, not in the context).
- `globalScanData = {personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes, trigger}`, built from `getContext().getCharacterCardFields()`. `trigger` is one of `GENERATION_TYPE_TRIGGERS` (`constants.js:36-43`).

**Option C: `getContext().generate('normal', {}, true)`** (the Prompt Manager does this, `openai.js:707-713`)
- Gives the most faithful scan input, but returns nothing (S:5320-5322). Observe it through `WORLDINFO_SCAN_DONE` and `CHAT_COMPLETION_PROMPT_READY`.
- No interceptors run (S:4562-4573).
- In a group chat it calls `setCharacterId` (S:4371).

**Dry-run caveats:**
- **Sticky and cooldown are not evaluated.** `checkTimedEffects` skips them when `isDryRun` (WI:683-686), so cooldown entries look active and sticky entries look absent. Only `delay` is honoured.
- Probability rolls (WI:5041) and inclusion-group weighted rolls (WI:5453) use `Math.random`, so results are not deterministic.
- A dry run consumes pending force-activations (WI:5275).
- It rewrites the Author's Note prompt (the WI-in-AN hijack, WI:5268-5272) and emits ENTRIES_LOADED and SCAN_DONE to other extensions.
- It scans the current `extension_prompts` that have `scan:true` (WI:4719-4726), which may be stale from the previous generation.

**The triggering key is not stored.** `primaryKeyMatch` and the secondary match are locals that only go to `console.debug` (WI:4914-4932, 4955-4973). Ways to get it:
1. Re-implement the matching yourself. The scan text is `'\x01' + depth messages`, then the opted-in globalScanData fields, then the inject buffer, then the recursion buffer (WI:279-328). Match rules are in WI:337-366: `parseRegexFromString` is exported (WI:2901); keys go through `substituteParams`; case handling is `entry.caseSensitive ?? world_info_case_sensitive`.
2. Temporarily wrap `console.debug` during your own dry run and parse the `[WI] Entry <uid>` lines. The header line at WI:4790 includes the world and the entry object.

**Recursion source.** Use `WORLDINFO_SCAN_DONE`:
- `state.current` (INITIAL / RECURSION / MIN_ACTIVATIONS, from the `scan_state` export at WI:43) plus a diff of `activated.entries` tells you the loop and recursion level each entry came from.
- `activated.text` is the cumulative recursion buffer; only content from non-`preventRecursion` entries is added (WI:5139-5144). Match later-loop keys against earlier entries' content to attribute the source.

**Profiler tricks inside your own flagged dry run:**
- In `WORLDINFO_ENTRIES_LOADED`, set `useProbability=false` on the copies to get deterministic results.
- In `SCAN_DONE`, set `args.budget.current = Infinity` to see which entries the budget cut.

**Prompt itemization** (S:5340-5381, `itemized-prompts.js:16, 109-226`): `itemizedPrompts[i].worldInfoString` is only before+after. Depth WI is inside `allAnchors` or the CC conversation, so the itemization understates WI share.

## 3. Entry fields in 1.19 (`newWorldInfoEntryDefinition`, WI:4082-4125; template WI:4127)

- **Matching:** `key[]`, `keysecondary[]`, `selective`, `selectiveLogic` (AND_ANY 0 / NOT_ALL 1 / NOT_ANY 2 / AND_ALL 3, WI:33), `scanDepth` (null means global), `caseSensitive` (null means global), `matchWholeWords` (null means global).
- **Scan sources:** `matchPersonaDescription`, `matchCharacterDescription`, `matchCharacterPersonality`, `matchCharacterDepthPrompt`, `matchScenario`, `matchCreatorNotes`.
- **Content and state:** `comment`, `content`, `addMemo`, `constant`, `vectorized` (used only by Vectors), `disable`.
- **Placement:** `order` (default 100), `position` (`world_info_position`: before 0, after 1, ANTop 2, ANBottom 3, atDepth 4, EMTop 5, EMBottom 6, **outlet 7**; WI:855-864), `depth` (default 4), `role` (0/1/2; used with atDepth), **`outletName`**.
- **Budget and probability:** **`ignoreBudget`**, `probability`, `useProbability`.
- **Recursion:** `excludeRecursion`, `preventRecursion`, `delayUntilRecursion` (boolean `true` or a numeric level, WI:4754-4757).
- **Inclusion groups:** `group` (comma-separated, so several groups are allowed, WI:5392), `groupOverride`, `groupWeight` (default 100), `useGroupScoring` (null means global).
- **Timed effects:** `sticky`, `cooldown`, `delay` (each `number?`).
- **Other:** `automationId` (Quick Reply), **`triggers[]`** (filtered to `GENERATION_TYPE_TRIGGERS`).
- **Virtual fields** used by slash commands: `characterFilterNames`, `characterFilterTags`, `characterFilterExclude`. They map to the stored `characterFilter {isExclude, names (avatar filenames without extension), tags (ids)}`, which `addMissingWorldInfoFields` backfills (WI:2104-2136).
- **Stored but not in the template:** `uid`, `displayIndex`, and `extensions` (present on card-imported books, `convertCharacterBook` WI:5667).
- **Added at runtime by the scan:** `world`, `hash`, `decorators`.
- **Decorators:** `@@activate` and `@@dont_activate` on the first lines of the content, with an `@@@` escape (WI:100, 4652-4698, 4875-4884).
- **Storage for your own metadata:** `entry.extensions` is spread into the card's `character_book` on character save (`src/endpoints/characters.js:682-683`), so it survives. The book-level `data.extensions` is returned by the unused `POST /api/worldinfo/list` (`src/endpoints/worldinfo.js:39-69`).
- **Fields that write to `originalData`:** see `originalWIDataKeyMap` (WI:2687-2724).

**Which fields are new-ish.** This snapshot has no git history, so the following is from memory of the release history and is approximate:
- Newest: `outletName` / position 7.
- Recent: `ignoreBudget`, the `match*Description` family, `triggers`, numeric `delayUntilRecursion` levels.
- 1.12 era: `sticky`/`cooldown`/`delay`, decorators, `useGroupScoring`/`groupWeight`, `automationId`.
- Events: `WORLDINFO_ENTRIES_LOADED` and `WORLDINFO_SCAN_DONE` are recent; the `ITEMIZED_PROMPTS_*` events look the newest.

**Pitfall: the entry hash.**
- The hash is `getStringHash(JSON.stringify(entry))` over all fields (WI:4632).
- Timed effects find their entry by hash (WI:624).
- So **any edit** to an entry (content, order, `extensions`, even `displayIndex`) orphans its active sticky or cooldown.
- `getFreeWorldEntryUid` reuses the lowest free uid (WI:4395-4409), and timed-effect keys are `"world.uid"`.

## 4. Global WI settings

- **Module bindings** (WI:69-82): `world_info_depth` (scan depth, default 2), `world_info_min_activations`, `world_info_min_activations_depth_max`, `world_info_budget` (percent of `maxContext`, default 25), `world_info_include_names`, `world_info_recursive`, `world_info_overflow_alert`, `world_info_case_sensitive`, `world_info_match_whole_words`, `world_info_use_group_scoring`, `world_info_character_strategy` (`world_info_insertion_strategy`: evenly 0 / character_first 1 (default) / global_first 2; WI:27), `world_info_budget_cap` (0 means none), `world_info_max_recursion_steps` (0 means unlimited).
- **Budget:** `budget = round(budget% * maxContext / 100) || 1`, capped by `budget_cap` (WI:4736-4741).
- **Max recursion steps** counts every loop, including the initial scan (WI:4768): a value of 1 means no recursion. The UI makes min-activations and max-recursion mutually exclusive (WI:6241, 6306).
- **Overflow** shows a toast if the alert is on, and then stops recursion (WI:5061-5073, 5097).
- **Budget accounting quirks:**
  - Earlier loops are counted only through `allActivatedText`, which holds only recursion-eligible text (WI:5010, 5143). `preventRecursion` entries from earlier loops therefore don't count against the budget, and the total WI can exceed it.
  - Each loop re-tokenizes the growing `newContent` once per entry (WI:5061), so cost grows quadratically. That matters at ~180K characters.
- **Storage:** `settings.json` → `world_info_settings`, which also holds `world_info.globalSelect` and `world_info.charLore` (S:8080 save, S:8013 load, WI:84-87).
- **Reading them:** `import { getWorldInfoSettings } from world-info.js` (WI:795-812), or the live `export let` bindings. They are not in `getContext()`.
- **Writing them:** `updateWorldInfoSettings(settings, activeWorldInfo?)` (WI:819-853). It does **not** update the DOM and does not emit `WORLDINFO_SETTINGS_UPDATED`.

## 5. Chat, character and persona lorebooks

- **Chat book:** `chat_metadata['world_info']` (`METADATA_KEY`, WI:94).
- **Binding a chat book in code:** `ctx.chatMetadata.world_info = name; await ctx.saveMetadata();` and optionally toggle `.chat_lorebook_button` `world_set`. This is the same as `assignLorebookToChat` (WI:5951-5988).
  - Or run `/getchatbook create=true name=…` through `executeSlashCommandsWithOptions` (WI:1159-1182; it uses `createWorldWithName` → `createNewWorldInfo`).
  - Call `getContext()` fresh each time: `updateChatMetadata` replaces the `chat_metadata` object (S:8978).
- **Persona book:** `power_user.persona_description_lorebook`, mirrored to `power_user.persona_descriptions[avatar].lorebook` (`personas.js:1267-1305`, `2232-2236`). It can be set with `/getpersonabook create=true` (WI:1092-1107) or the `/persona-*` commands with `lorebook=`.
- **Character books:**
  - Primary: `characters[chid].data.extensions.world`.
  - Additional: `world_info.charLore[] = {name: <avatar file without extension>, extraBooks[]}` (WI:4475-4525).
  - Helpers: `charUpdatePrimaryWorld(name)` (UI-coupled; current character only, WI:6097), `charUpdateAddAuxWorld(avatarKey, names)` (WI:6134), `charSetAuxWorlds(fileName, books)` (WI:6145).
  - Or `ctx.writeExtensionField(chid, 'world', name)` (`extensions.js:2070`). Beware: an open character form posts `#character_world` and will overwrite it.
- **Scan priority order** (WI:4590-4625):
  1. Chat lore, sorted by `order` descending.
  2. Persona lore.
  3. Character and global lore according to the strategy: evenly = merged then sorted; character_first or global_first = each group sorted, then concatenated.
- **De-duplication:**
  - Chat is skipped if the book is also global.
  - Persona is skipped if it is the chat book or global.
  - A character book is skipped if it is global, chat or persona.
- **Where priority matters:** budget and recursion selection (sticky entries go first, WI:4995-5003). The final prompt is re-sorted by `order` alone, ascending, via `unshift` (WI:5203-5263), regardless of source.
- **Global selection:** `selected_world_info` is a live `export let` (WI:66). Change it with `/world name state=on|off|toggle silent=true` (`onWorldInfoChange`, WI:5772-5844), which also updates the DOM. Caveats:
  - Names are split on commas.
  - Matching is case-insensitive.
  - `on` can push duplicates.
  - Setting the array directly gets overwritten by the next UI interaction (WI:5822-5838).

## 6. Lorebook API

**In `getContext()`** (`public/scripts/st-context.js:278-284`): `loadWorldInfo`, `saveWorldInfo`, `reloadWorldInfoEditor` (= `reloadEditor(file, loadIfNotSelected)`), `updateWorldInfoList`, `convertCharacterBook`, `getWorldInfoPrompt`, `getWorldInfoNames` (returns a copy).

**Import from `world-info.js`:**
- Books: `createNewWorldInfo(name, {interactive})` (WI:4448), `deleteWorldInfo`, `getFreeWorldName`, `world_names`.
- Entries: `createWorldInfoEntry(_name, data)` (WI:4137; template defaults and the lowest free uid; it does **not** set `displayIndex`, `characterFilter` or `extensions`), `getFreeWorldEntryUid`, `deleteWorldInfoEntry(data, uid, {silent})`, `duplicateWorldInfoEntry`, `moveWorldInfoEntry(src, dst, uid, {deleteOriginal})` (WI:6000).
- Scanning: `getSortedEntries`, `checkWorldInfo`, `parseRegexFromString`, `splitKeywordsAndRegexes`, `scan_state`, `world_info_position`, `world_info_logic`.
- Settings and state: `selected_world_info`, `world_info`, `worldInfoCache`, `getWorldInfoSettings`, `updateWorldInfoSettings`, `METADATA_KEY`.
- Character and persona binding: `charUpdatePrimaryWorld`, `charUpdateAddAuxWorld`, `charSetAuxWorlds`.
- Editor: `openWorldInfoEditor`, `showWorldEditor`, `sortWorldInfoEntries(data, {customSort})`.
- Templates and mirroring: `newWorldInfoEntryTemplate`, `newWorldInfoEntryDefinition`, `originalWIDataKeyMap`, `setWIOriginalDataValue`, `deleteWIOriginalDataValue`.

**Pitfalls:**
- **Cache semantics.** `worldInfoCache` is a `StructuredCloneMap({cloneOnGet:true, cloneOnSet:false})` (WI:882; `util/StructuredCloneMap.js`).
  - `loadWorldInfo` returns a deep clone.
  - `saveWorldInfo` stores **your object by reference** (WI:4183), so don't mutate it after saving.
  - The cache never revalidates (other tabs, manual file edits), and `importWorldInfo` doesn't invalidate it.
- **The save debounce is shared across all books.** `saveWorldDebounced` (WI:83) is one debounce (`utils.js:574-584` keeps only the last call's arguments).
  - Debounced saves of two different books within 1 s lose the first one on disk; the cache still has it.
  - `_save` calls `cancelDebounce(saveWorldDebounced)` (WI:4153), so **an immediate save of book B cancels the editor's pending save of book A**.
  - Safest: use `immediately=true`, or POST `/api/worldinfo/edit` yourself, then `worldInfoCache.set` and emit `WORLDINFO_UPDATED`. Afterwards, re-flush any book open in the editor from the cache.
- **The editor keeps its own data object.** After you save a book that is open in the editor, call `reloadWorldInfoEditor(name)`; otherwise the editor's next edit writes back its stale copy.
- **`createNewWorldInfo`:**
  - Returns false with a toast if the name exists and `interactive` is false (`utils.js:2483-2503`).
  - Saves under the unsanitized name.
  - Switches the editor to the new book.
- **`originalData` mirroring for card-imported books.** The UI mirrors edits through `setWIOriginalDataValue` (WI:2756), not every field is mapped (`outletName` and `group` are set ad hoc, WI:3697, 3733), and the slash setter uses the map (WI:1439-1441).
  - But on character save the backend sets `character_book = originalData` and then **overwrites it** with `convertWorldInfoToCharacterBook(entries)` (`src/endpoints/characters.js:628-644`, `663-722`).
  - In practice the entries win, so `originalData` drift mostly doesn't matter in 1.19.
- **Size:** request bodies are limited to 500 MB (`src/server-main.js:110`).

## 7. Outlets

- Entries with `position = 7` and an `outletName` are grouped (WI:5248-5258).
- Generate stores each group as `setExtensionPrompt('customWIOutlet_<name>', joined, extension_prompt_types.NONE, 0)` (S:4674-4678; ids in `constants.js:55`). NONE means it is never auto-injected.
- `{{outlet::name}}` reads that value. New macro engine: `macros/definitions/core-macros.js:450-468`; legacy: `macros.js:597-600, 668`. The new engine is on by default (`power-user.js:302`).
- Use the macro in Prompt Manager prompts, the system or story string, the Author's Note or card fields.
- **Ordering:** outlet content is ordered by `order` **descending**, because it uses `push`; before/after use `unshift`, which gives ascending order.
- **Flushing:** outlets are cleared only when `skipWIAN` is false (`flushWIInjections`, S:4664-4681, 5678-5687). With `skipWIAN=true`, last turn's depth and outlet prompts appear to stay in `extension_prompts`.
- **Macro inside WI content:** content is macro-substituted during the scan (WI:5058), before the flush, so `{{outlet::x}}` inside an entry resolves to the **previous** generation's outlet.
- **Related macros:** for Text Completion the story string has `{{wiBefore}}`/`{{wiAfter}}` (aliases `loreBefore`/`loreAfter`, S:4711-4714). Chat Completion wraps before/after with `oai_settings.wi_format` (`formatWorldInfo`, `openai.js:789`; identifiers `worldInfoBefore`/`worldInfoAfter`, `openai.js:1376-1377`).

## 8. Generation interceptors and setExtensionPrompt

**Interceptors:**
- Declare `"generate_interceptor": "fnName"` in the manifest and set `globalThis.fnName = async (chat, contextSize, abort, type) => {}`.
- They run in manifest `loading_order` (`extensions.js:2024-2049`, sort at `:49`).
- `abort(immediately)` cancels the generation.
- They are **skipped for dry runs** (S:4562-4573) but run for quiet, impersonate, swipe, continue and regenerate (`type` tells you which).
- `chat` is `coreChat`: shallow copies `{...msg, mes: regexed+files, index}` (S:4496-4529); `extra` is still shared with the real message.
- **The WI scan runs after the interceptors on the same `coreChat`** (S:4624-4635), so interceptors can change what WI scans.
- Messages flagged `extra[IGNORE_SYMBOL]` are hidden from the prompt (S:5841) but **still scanned**.

**setExtensionPrompt:**
- Signature: `setExtensionPrompt(key, value, position, depth, scan=false, role=SYSTEM, filter=null)` (S:8926-8935).
- Positions (S:484-489): `NONE -1` (never injected; read by macros / `getExtensionPromptByName`), `IN_PROMPT 0`, `IN_CHAT 1` (depth plus role, up to `MAX_INJECTION_DEPTH` 10000, S:500), `BEFORE_PROMPT 2`.
- Roles: SYSTEM 0, USER 1, ASSISTANT 2 (S:494-498).
- `scan:true` adds the prompt to the WI inject buffer **whatever its position** (WI:4719-4726), and it is scanned for every entry (WI:318-320).
- **Useful for Russian chat with English books:** `setExtensionPrompt('lm_scan', englishGlosses, NONE, 0, true)` feeds text into the scan without sending it to the model. Set it in the interceptor.
- The quiet prompt is also scanned (S:4623).

**Filter pitfall: confirmed, with a nuance.**
- `getExtensionPrompt` (S:3301-3329) does `.filter(filterByFunction)` with an **async** callback. The Promise it returns is always truthy, so nothing is filtered (the filter still runs for side effects); `Promise.all` then just receives plain objects.
- Filters are ignored for:
  - IN_CHAT under Text Completion (S:5647) and Chat Completion (`openai.js:856`).
  - IN_PROMPT and BEFORE_PROMPT under Text Completion (S:4700-4701).
- Filters **are honoured** for:
  - Chat Completion IN_PROMPT / BEFORE_PROMPT with non-builtin keys (`openai.js:1449-1457`).
  - `getExtensionPromptByName`, which feeds the WI scan (S:3268-3272).
  - `getAllExtensionPrompts`, used for itemization (S:3241-3243).

## 9. Background LLM calls

**`ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, custom, overridePayload={})`** (`extensions/shared.js:423-492`)
- `prompt` is a string or `messages[]`; `maxTokens` is a number.
- `custom` defaults (`:393-400`): `stream:false`, `signal:null`, `extractData:true`, `includePreset:true`, `includeInstruct:true`, `instructSettings:{}`.
- Returns `{content, reasoning}`, raw JSON when `extractData:false`, or a generator function when `stream:true`.
- With a JSON schema (`overridePayload.json_schema`), Chat Completion parses `content` (`custom-request.js:490-492`).
- Only Chat Completion (`openai`) and Text Completion (`textgenerationwebui`) profiles are supported. It throws if the connection-manager extension is disabled; errors are wrapped as `Error('API request failed', {cause})`.
- It uses the profile's model, `secret-id`, `api-url` and proxy.
- `includePreset` applies only the preset's **sampler parameters**, not its prompts (`custom-request.js:544-606`, `createGenerationParameters`).
- `includeInstruct` formats `messages[]` for Text Completion (`custom-request.js:283-311`).
- It emits no events and doesn't touch the UI, so it is **the right choice for background tasks**.
- Helpers: `getSupportedProfiles()`, `getProfile(id)`, `constructPrompt(msgs, profileId)`, `handleDropdown(...)` (`shared.js:501-640`). Profiles live in `extensionSettings.connectionManager.profiles`.

**`generateRawData` / `generateRaw`** (S:4000-4114, 4122-4151)
- No chat, WI or interceptors, but they use the **main** API settings (`api` only chooses the API type).
- They emit `GENERATE_AFTER_COMBINE_PROMPTS` or `CHAT_COMPLETION_PROMPT_READY` with `dryRun:false`, so other extensions can mutate the prompt.
- They are aborted by the user's Stop button (`GENERATION_STOPPED`) and take no external signal.
- `generateRaw` cleans the output and throws on an empty reply.

**`generateQuietPrompt`** (S:3084-3118) → `Generate('quiet')`
- Builds the full prompt: card, history, **WI scan with real side effects** (sets sticky/cooldown, fires `WORLD_INFO_ACTIVATED`), interceptors.
- Locks the UI and sets `chat_metadata.tainted`.
- `skipWIAN` does **not** skip the scan or the WI before/after text; it only skips depth and outlet injection (S:4664).
- Entries whose `triggers` lack `quiet` are skipped.

## 10. Other building blocks for a lore profiler

**Token counting:**
- `getContext().getTokenCountAsync(str, padding)` (`tokenizers.js:443-490`).
  - Chat Completion: uses the model tokenizer when called without the shadow padding, which is how WI counts.
  - Text Completion: uses `power_user.tokenizer`.
  - Cached by string hash.
- Chat Completion per-identifier counts: `promptManager.tokenHandler.getTokensForIdentifier('worldInfoBefore' | 'worldInfoAfter')` (`openai.js:535, 3420-3479`). Depth WI lands in the conversation count.

**Itemization:**
- `itemizedPrompts` (S:308 re-export; `itemized-prompts.js:16`), stored in localforage per chat.
- Fields include `mesId`, `rawPrompt`, `worldInfoString`, `allAnchors`, `this_max_context`, and the `oai*Tokens` counts (S:5340-5372, 5989-6011).
- `itemizedParams()` computes `worldInfoStringTokens` and the percentage (`itemized-prompts.js:109-226`).

**Timed-effect state:**
- `chat_metadata.timedWorldInfo = {sticky:{"world.uid":{hash,start,end,protected}}, cooldown:{…}}` (WI:559-577).
- The `timedEffects` instance in `SCAN_DONE` has `isEffectActive`, `getEffectMetadata`, `setTimedEffect`.

**Matching on Russian text:**
- Whole-word mode uses `(?:^|\W)(key)(?:$|\W)` (WI:356). JavaScript's `\W` is ASCII-only, so **every Cyrillic letter counts as a boundary**, and Cyrillic keys effectively match as substrings even with whole-words on.
- English keys never match Russian text. You need RU keys, regex keys (`/…/iu` with `\p{L}`), or scan-only gloss injection (section 8).
- Keys go through `substituteParams` (WI:4915).

**Final injected text and regex:**
- WI regex scripts run only at build time, `getRegexedString(content, regex_placement.WORLD_INFO, …)` (WI:5205). Recursion scans the pre-regex content.

**Slash commands** (WI:1617-1960): `/world`, `/getchatbook`, `/getglobalbooks`, `/getpersonabook`, `/getcharbook`, `/findentry`, `/getentryfield`, `/createentry`, `/setentryfield`, `/wi-set-timed-effect`, `/wi-get-timed-effect`.

**Backend:** `/api/worldinfo/get|edit|delete|import|list` (`src/endpoints/worldinfo.js`). `edit` writes the body verbatim, so unknown fields persist.

**Performance at your scale:** each scan deep-clones every active book twice (`loadWorldInfo` plus WI:4639), JSON-hashes every entry, and rebuilds the scan string for each entry (WI:4911), including the growing recursion buffer.
