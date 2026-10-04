# Research: Qvink Memory 1.3.29 and NAI Studio 0.9.10 integration points (2026-10-04)

Abbreviations used for paths:
- `Q` = `<scratch>/qvink/index.js` (4980 lines; Qvink upstream: https://github.com/qvink/SillyTavern-MessageSummarize, commit 81b3326)
- `N` = `SillyTavern-NAI-Studio\src\`
- `ST` = `st-local-docker\src-1.19.0\public\` (local ST 1.19 source, used to check core behaviour)

---

## A. Qvink Memory (SillyTavern-MessageSummarize)

**Version check.** Cloned with `--depth 1`. HEAD is `81b3326` (2026-05-25), and `manifest.json` there says `"version": "1.3.29"`, the same as prod. The remote has no tags. Main *is* 1.3.29, so there are no differences to report. The newest CHANGELOG entry is v1.3.27. Manifest settings: `loading_order: 1`, `generate_interceptor: "memory_intercept_messages"`.

### A1. Storage, short-term vs long-term, inclusion, ignore symbol, Remove Messages

**Per-message storage**
- Data lives in `chat[i].extra.qvink_memory` (`MODULE_NAME='qvink_memory'`, Q:45).
- Writes go through `set_data` (Q:3492-3516). It also copies the block into `swipe_info[swipe_id].extra.qvink_memory` and calls `saveChatDebounced`. Reads use `get_data` (Q:3517).
- Shape:
  ```js
  extra.qvink_memory = {
    memory: "Alice cut her hair short.", // summary text, stored WITHOUT prefill (Q:3410-3417)
    hash, prefill, reasoning, error,     // hash = getStringHash(mes) at summary time
    edited: bool,
    remember: bool,  // user marked "long-term" (brain icon)
    exclude: bool,   // user force-excluded
    include: 'short' | 'long' | null,    // recomputed on every refresh
    lagging: bool    // true = still newer than the injection threshold (raw message still in prompt)
  }
  ```
- Chat-level data is in `chat_metadata.qvink_memory`: `{enabled, profile}` (Q:663-680, 712-722, 1374-1387). Settings are in `extension_settings.qvink_memory` (Q:645-661).

**Short-term vs long-term**
- `remember` is the only marker of a long-term memory, set by `remember_message_toggle` (Q:3592-3628). If the message has no summary yet, setting `remember` also queues one (Q:3610-3626).
- `update_message_inclusion_flags` (Q:3799-3896) walks the chat from newest to oldest:
  - Every summarized message goes to `'short'` until the short-term token budget runs out.
  - After that, only `remember`-ed messages go to `'long'`, until the long-term budget runs out.
  - With `separate_long_term` ("Always Separate") on, `remember`-ed messages skip short-term entirely (Q:3856).
- `collect_chat_messages(include)` skips lagging messages (Q:3933-3950). So the injected text never contains summaries of messages that are still in the prompt.

**Inclusion and exclusion rules** — `check_message_exclusion` (Q:3744-3798), in priority order:
1. `remember` → always included.
2. `exclude` → excluded.
3. User messages (setting), thought messages, `is_system` (setting), narrator messages (setting), group members that are disabled.
4. Messages under `message_length_threshold` (default 10 tokens).

**Ignore symbol and "Remove Messages"**
- The interceptor is `globalThis.memory_intercept_messages` (Q:3978-3997). It does nothing unless `exclude_messages_after_threshold` ("Remove Messages", default true) is on.
- For every prompt entry (except the last one on `continue`) it does `chat[i] = structuredClone(chat[i]); chat[i].extra[getContext().symbols.ignore] = !lagging`.
- So **every** message older than the threshold is dropped from the prompt, whether or not it has a summary.
- ST honours the flag in `formatMessageHistoryItem` (ST script.js:5841, `IGNORE_SYMBOL = Symbol.for('ignore')`, constants.js:25).
- Side effect: before cloning, Qvink runs `delete chat[i].extra.ignore_formatting` (Q:3991). ST's prompt entries are `{...chatItem}` copies that share `extra` with the live chat (ST script.js:4501-4529), so this deletion touches the real messages. It also throws if `extra` is undefined.
- Threshold calculation: `get_injection_threshold` (Q:3663-3739) — counted in messages, tokens or %, with delayed "update triggers". `keep_last_user_message` keeps the latest user message (Q:3834-3838).

### A2. Macros and reading memories programmatically

**Global macros** (legacy `MacrosParser.registerMacro`, Q:4977-4978):
- `{{qm-long-term-memory}}` → `get_long_memory()` (Q:3951)
- `{{qm-short-term-memory}}` → `get_short_memory()` (Q:3963)
- Both apply the long/short templates, which use `{{memories}}` (Q:69, 92-93), and return only the currently injected, non-lagging set.

**Summary-prompt-only macros:** `{{message}}`, `{{history}}`, `{{words}}`, `{{lorebook}}`, plus user-defined custom macros (Q:94-99).

**There is no programmatic API.** The only ES export is `MODULE_NAME` (Q:42), and the only global is the interceptor. Ways to read memories:
- Read `ctx.chat[i].extra.qvink_memory` directly. Recommended.
- `/qm-get [index|range] separator=` returns concatenated memories (Q:4643-4669).
- `/qm-enabled` (Q:4512).
- `substituteParams('{{qm-long-term-memory}}')`.

**Other slash commands:** `/qm-summarize range show_progress=` (Q:4731), `/qm-summarize-chat`, `/qm-stop-summarization`, `/qm-toggle-remember idx` (Q:4595), `/qm-toggle-exclude range exclude=` (Q:4613), `/qm-set`, `/qm-refresh`, `/qm-update-injection-threshold`, `/qm-profile`, `/qm-get-message-world-info`.

**Bugs to avoid:**
- `/qm-set idx text` keeps only the **first word** of the text (`value.split(' ')`, `values[1]`, Q:4696-4701). Instead, write `extra.qvink_memory.memory` yourself and then run `/qm-refresh`.
- `remember_message_toggle(null)` turns into `[null]` and crashes (Q:3596-3600). So `/qm-toggle-remember` without an index is broken.

### A3. Events, timing, connection profile

**Listens to** (Q:4958-4974):
- `CHARACTER_MESSAGE_RENDERED` via `makeLast`
- `USER_MESSAGE_RENDERED`, `MESSAGE_DELETED`, `MESSAGE_EDITED`, `MESSAGE_SWIPED`, `CHAT_CHANGED`, `MORE_MESSAGES_LOADED`
- `GENERATION_STARTED` (as "before_message"), `GENERATION_STOPPED` (sets `just_aborted`)
- `groupSelected` / `GROUP_UPDATED`
- `PRESET_CHANGED` / `CONNECTION_PROFILE_LOADED|UPDATED` (these trigger a settings refresh)

**Emits:** nothing. There is no `eventSource.emit` anywhere in Q.

**When summarization runs** (`on_chat_event`, Q:4097-4244):
- Default: on `CHARACTER_MESSAGE_RENDERED`, but not while streaming is unfinished and not in the first 1 s after a chat opens (Q:4105-4114, 4170-4201).
- `auto_summarize_on_send` moves it to `GENERATION_STARTED`. ST awaits those listeners, so with `auto_summarize_block_generation` (default true) generation is held until summaries finish (Q:4134-4152).
- Swipe re-summarizes if the previous swipe had a memory. Continue and edit are optional (Q:4176-4211).
- After an aborted stream, the next message is not summarized (Q:4232-4235).
- `collect_messages_to_auto_summarize` (Q:4029-4075):
  - Walks back up to `auto_summarize_message_limit` eligible messages (default 10), after skipping `summarization_delay` ("lag", default 0).
  - Takes only messages without a memory.
  - Skips the run if there are fewer than `auto_summarize_batch_size` (default 1) (Q:4076-4090).
- `SummaryQueue` (Q:3177-3462):
  - Up to `parallel_summaries_count` workers (default 1), with an optional `summarization_time_delay`.
  - With `block_chat` (default true) it calls `deactivateSendButtons()` at queue start and `activateSendButtons()` when the series ends (Q:3267-3290).
  - After the series it calls `refresh_memory()`, which recomputes flags and calls `setExtensionPrompt('qvink_memory_long'|'qvink_memory_short', …)` (Q:4001-4026).

**Connection profile — no switching.**
- `summarize_text` calls `ctx.ConnectionManagerRequestService.sendRequest(profileId, messages)` (Q:3454). The CHANGELOG for v1.3.24 states "Connection Profiles are now used for summaries without switching".
- Profile id comes from the setting, falling back to the currently selected profile (Q:517-533). The preset comes from the profile (Q:534-569).
- **No collision** on the global profile/preset with another extension's background calls. The remaining interactions are:
  1. Two extensions can hit the same backend concurrently (rate limits).
  2. Qvink re-enables the send buttons when *its* series ends, even if another extension disabled them.
  3. `/qm-stop-summarization` calls `ctx.stopGeneration()` (Q:3333). That aborts the **main** generation and emits `GENERATION_STOPPED` (ST script.js:5607-5620). It does not abort Qvink's own request, because no `signal` is passed (ST shared.js:423-424).
  4. Any `GENERATION_STOPPED` sets `just_aborted`, so the next auto-summary is skipped.
  5. NAI Studio image posts emit `MESSAGE_RECEIVED` + `CHARACTER_MESSAGE_RENDERED` with type `'extension'` (N:features/generation/output.ts:165-169). Qvink treats them as character messages. Visible image posts whose prompt text is at least 10 tokens get summarized.

### A4. Reacting to "message summarized" / "new long-term memory"

There is no hook or event, so a new extension has to detect changes itself:
1. **Diff the data (recommended).** Keep `index → (memory, remember)` per message and re-scan `extra.qvink_memory`:
   - debounced after `CHARACTER_MESSAGE_RENDERED` / `MESSAGE_EDITED` / `MESSAGE_SWIPED`;
   - plus a short poll while the queue runs, because the summary lands asynchronously after Qvink's `makeLast` handler.
   - "New long-term memory" = `remember === true && memory` becomes truthy, or `remember` flips to true on a message that already has a memory.
   - Note: `edit_memory` with empty text clears `remember` (Q:3544-3547).
2. **DOM.** A `MutationObserver` on `#chat` for `div.qvink_memory_text` (re-created on every update, Q:1456-1507).
   - The text goes "Summarizing..." (Q:3381) → final text (Q:3429).
   - The span class shows the state: `qvink_long_memory` / `qvink_short_memory` / `qvink_old_memory` / `qvink_exclude_memory` (Q:1422-1443).
   - Clicks on the brain button: class `qvink_memory_remember_button` (Q:72).
   - This only works for rendered messages and when `display_memories` is on.
3. Wrapping `ConnectionManagerRequestService.sendRequest` is possible but fragile. Not recommended.

---

## B. NAI Studio (v0.9.10, `loading_order: 100`, interceptor `NAIST_ProcessTriggers`)

### B1. Passports

**Data model** — N:domain/passport.ts:6-63:
```ts
Passport = {
  version: 1, id: "p<base36>",     // 'main' = legacy (line 14)
  kind: 'character'|'world'|'location'|'scenario'|'object',
  name: "",                        // '' = the card/persona itself
  aliases: ["Лира","Ly"],
  tags: "",                        // only for non-character kinds
  slots: { base:"1girl, elf, adult", hair, eyes, body, skin, clothing, accessories, style },
  nsfw: { enabled:false, tags:"" },          // explicit anatomy only (lines 203-227)
  outfits: [{name:"ballgown", tags:"..."}], activeOutfit: "",   // '' → slots.clothing
  states: [{id:"wet", tags:"wet, wet hair, wet clothes", enabled:false}, ...], // 8 presets (16-26) + custom
  negative: "", pose: {preset:"", custom:""}, position: {x,y} | null
}
```
- Species has no dedicated field. It goes in `slots.base` (e.g. "1girl, elf").
- `withoutUnstatedSpecies` drops species tags the source text never names (N:domain/passport-gen.ts:214-230, uses data/species-words.json).
- Tag order when rendering: `passportTags()` (passport.ts:240-263) — base, hair, eyes, body, skin, clothing/outfit, accessories, enabled states, NSFW (only if allowed), style. With `withoutClothing` the clothing part is dropped.
- `normalizePassport` / `normalizePassportList` / `primaryPassport` are at passport.ts:104-172.

**Storage**
- Card: `character.data.extensions.nai_studio` (`CARD_FIELD`, N:features/characters/character-prompts.ts:9):
  ```js
  { passports: Passport[], passport: <main, for <0.8 readers>, characterPrompt?: {positive, negative} }
  ```
- Reading: `cardPassports()` (N:features/characters/passport-store.ts:26-29).
- Writing: `saveCardPassports()` calls `writeExtensionField(index,'nai_studio',{...existing, passports, passport: main})` (passport-store.ts:44-59), then notifies internal `onPassportsSaved` listeners. Shallow cards are unshallowed first (passport-store.ts:37-42).
- Personas: `extension_settings.nai_studio.scene.personaPassports[<personas.user_avatar>]`, key falling back to `'default'` (passport-store.ts:70-86; N:core/settings-schema.ts:342-343, default at 505). The settings object is the live `extensionSettings.nai_studio` (N:core/settings.ts:21-44).

**Generation from a description** — N:features/characters/passport-generator.ts:
- Card: `generateCardPassports(index)` (38-57) sends description, personality, scenario and first message (after `substituteParams`). The card's own character gets `name=''`.
- Persona: `generatePersonaPassport()` (82-90).
- NPC: `generateTrackerPassport(name, look, cardIndex)` (63-79). It sends only the card sentences that name the character (`sentencesNaming`).
- All three go through `askLlm` (N:features/language/llm.ts:89-98) with `PASSPORT_GEN_SCHEMA` and `maxTokens` 3500 (card) or 1200. Backend comes from `settings.language.backend`:
  - `main`: `generateRaw` with `jsonSchema` on Chat Completion, `prefill '{'` on Text Completion (26-47).
  - `profile`: `ConnectionManagerRequestService.sendRequest(profileId, …, {json_schema})` (49-73).
  - `novelai`: GLM-4.6 through the server plugin (75-87).
- Prompts: N:domain/passport-gen.ts:29-52 (card/persona/npc).
- Parser: `parseGeneratedPassports` (154-197) — style/palette tags stripped, anatomy moved to `nsfw`, futanari turns the NSFW layer on, the first outfit becomes active if `clothing` is empty.
- The manager offers merge "add new by name" or "replace all" (N:ui/passport-manager.ts:27-40, 141-144).

**Auto NPC passports from DES** — N:integration/des/des-integration.ts:
- Flow: `handleTracker` (313-331) → `findPassport` searches all chat cards by name, aliases and sound match (`mentionIndex`, N:domain/scene-assembly.ts:73-83, Latin↔Cyrillic) (361-372) → if not found and `des.autoPassports` is on, `createPassport` (375-399).
- New passports are saved into the 1:1 card, or in a group into the last speaker's card (345-354).
- Failures are remembered per name and not retried.

### B2. Macros, slash commands, public API

**Macros**
- `{{nai_characters}}`: comma list of non-user candidates that have a passport or a DES look (N:integration/macros.ts:27-39, registered at N:integration/markers-setup.ts:105).
  - It is refreshed only in `refreshMarkerInstruction` (markers-setup.ts:70-97), on `GENERATION_STARTED` and `CHAT_CHANGED`.
  - **It is empty unless `markers.enabled` is on** (markers-setup.ts:75).
- `{{charPrefix}}` / `{{charNegativePrefix}}`: only after takeover (macros.ts:7-24).

**Slash commands** — none of them read or write passports:
- `/nai` (`/nai-imagine`), `/nai-style`; after takeover `/imagine` (`/sd`, `/img`, `/image`), `/imagine-style`, `/imagine-source` (N:integration/commands.ts:150-173)
- `/nai-insert`, `/nai-images`, `/nai-gallery` (N:integration/inline-setup.ts:265-334)
- `/nai-scene` (N:integration/scene-setup.ts:188-235)
- `/nai-translate`, `/nai-prompt`, `/nai-location`, `/nai-sprites`, `/nai-comic` (N:integration/phase6-setup.ts:174-239)
- `/nai-vibes` (N:integration/tools-setup.ts:186)
- `/nai-prompt <prose>` returns tags for the current model (phase6-setup.ts:190-209). A story→canon tool could use it to turn Russian prose into tags.

**Public API:** none.
- The bundle exports only lifecycle hooks (N:index.ts:61-144).
- Globals are only `NAIST_ProcessTriggers` (N:integration/interceptor.ts:54) and `NAIST_inlineDebug` (inline-setup.ts:125).
- No custom events. It emits only standard ST events: `SD_PROMPT_PROCESSING` (pipeline.ts:515), `FORCE_SET_BACKGROUND`, and `MESSAGE_RECEIVED`/`CHARACTER_MESSAGE_RENDERED` with type `'extension'` (output.ts:165-169).
- So another extension has to read and write `data.extensions.nai_studio.passports` itself.
- Passports are re-read from the card on every use (no cache), so external writes take effect immediately. Two exceptions:
  - `{{nai_characters}}` waits until the next refresh.
  - The DES Portrait-prompt sync (`onPassportsSaved` is module-internal, passport-store.ts:14-19) catches up only on the next tracker pass, and only for tracker characters (des-integration.ts:323-329).

### B3. DES integration (checked against DES 2.6.0)

**Reads from DES**
- ES modules imported from DES's own script URL: `state.extensionSettings`, `persistence.saveSettings`, `avatarGenerator.regenerateAvatar`, `portraitBar.updatePortraitBar` (N:integration/des/des-adapter.ts:10-15, 107-177).
- DES settings: `enabled`, `generationMode`, `npcAvatars`, `generatedPortraits`, `characterAppearance`, `characterAliases` (adapter 17-27).
- Tracker:
  - `message.extra.dooms_tracker_swipes[swipeId].{infoBox, characterThoughts}` (JSON strings), or the first JSON object in the reply text in together mode (N:domain/des.ts:87-123).
  - Characters become `{name, look}` (127-141). The scene becomes `{location, time, weather, tags}` with time-of-day, indoors/outdoors and weather tags (189-216).
- Event `dooms_tracker_update_complete`. Also `MESSAGE_RECEIVED` via `makeLast`, `MESSAGE_SWIPED`, `CHAT_CHANGED` (des-integration.ts:158-174).
- DOM: `#dooms-pb-context-menu`, `.dooms-info-banner`, `.dooms-scene-transition`, `#character-workshop-popup`, `#cw-char-title`.

**Writes to DES**
- **Workshop "Portrait prompt" sync:** `api.settings.characterAppearance[name] = passportTags(passport, {allowNsfw:false})`, or the raw tracker look if there is no passport, then `api.save()` (`syncLine`, des-integration.ts:402-411).
  - Triggered on every tracker pass and on internal passport saves (`syncCard`, 413-419).
  - The normalized line is remembered in a line → name map. When DES's quiet `/sd` call arrives, the portrait hook (`setPortraitHook`, N:integration/commands.ts:59-82) recognises it and swaps in the full passport, current look, `des.portraitTags` and a stable per-name seed (`portraitPlan`, des-integration.ts:457-475).
- Turns DES auto portraits off (`autoPortraitMode='off'`, `autoGenerateAvatars=false`) and stores the originals in `nai_studio.des.saved` (183-202).
- Calls `regenerateAvatar(name)`. Policy is missing / state / every, with a hash of passport id + line + look kept in `chatMetadata.nai_studio.desPortraits` (423-454).
- Emotion sprites go to `characters/<name>`. Context-menu items, banner "Illustrate" and a Workshop button (532-651).

**Scene provider**
- A single slot: `setSceneProvider({candidates, setting})` (N:features/scene/scene-service.ts:77-88). DES occupies it (des-integration.ts:147-150).
- `candidates`: tracker people as `{key:'des:Name', passport:null, currentLook}` (275-295). They are merged by name into card/persona candidates; `currentLook` replaces passport clothing (scene-service.ts:94-110; N:domain/scene-assembly.ts:339-355).
- `setting`: tracker scene tags + location (297-301). Combined with card world/scenario/location passports in `sceneSetting` (scene-service.ts:178-199).
- In separate/external mode, markers wait up to 120 s for the tracker (237-246).

### B4. "Continuity" = visual location continuity (not narrative)

- N:features/continuity/continuity-service.ts, N:domain/continuity.ts.
- Stored in `chatMetadata.nai_studio.continuity = {current: "Tavern", locations: {"tavern": {name, filePath, width, height, model, seed, prompt, updatedAt, vibeId?}}}` (service 14-37).
- When on:
  - a generation at the current location uses its last image as the img2img base (`strength` clamped 0.1-0.95), or as a vibe (vibe mode) (94-116);
  - new txt2img/img2img pictures re-bind the current location (auto-bind, 119-135);
  - a known location named in the text becomes current (`detectLocation`, 80-92).
- DES tracker location changes call `setCurrentLocation` (des-integration.ts:319-322). `/nai-location` sets or reads it (phase6-setup.ts:211-226).
- Settings: `continuity {enabled:false, mode:'img2img', strength:0.6, autoBind:true}` (settings-schema.ts:321-327, 495).

### B5. Interceptor and what a new extension must not break

**`stripPlaceholders`** (N:integration/interceptor.ts:27-33):
- Each prompt entry whose `mes` contains `[nai:img:<id>]` is replaced with a **shallow** copy `{...message, mes: textForPrompt(...)}`. The placeholder becomes an `[image: …]` description or is removed (`settings.inline.llmText`).
- Shallow on purpose: `structuredClone` drops `extra[Symbol.for('ignore')]` set by Qvink, which runs first (loading_order 1 vs 100; interceptors are sorted by `loading_order`, ST extensions.js:2033). This was the 0.9.3 fix.
- After that it may `abort(true)` on an interactive "send me a picture" trigger (39-52), which stops the remaining interceptors.

**Rules for a new extension:**
- In any interceptor, never `structuredClone` prompt entries and never mutate `entry.extra` in place. `extra` is shared with the live chat (ST script.js:4501-4529). Copy shallowly and keep the symbol.
- Do not take first place on `MESSAGE_RECEIVED`. NAI's marker finalizer must see the reply first (`makeFirst` plus `keepFirst` re-ordering before every generation, markers-setup.ts:127-146). Otherwise you see raw `<img data-nai='{…}'>` JSON, and DES loses its info box.
- Card field `nai_studio`: always merge (`{...existing, passports, passport: primary}`) and keep `characterPrompt` and the legacy `passport`. Keep passport `id`s stable: composer keys are `<avatar>#<id>` (scene-service.ts:112-141), and emotions/DES look passports up by id.
- Don't write DES `characterAppearance` for characters that have passports. NAI overwrites it from the passport.
- Don't replace `chatMetadata.nai_studio` (it holds `continuity` and `desPortraits`). Don't touch the extension prompt `nai_studio_markers` (markers-setup.ts:26, 93), `extra.nai_images`, or the `[nai:img:…]` placeholders in `mes`.
- Picture posts carry `extra.nai_studio {model, seed, mode, transport, cost}` and `extra.media`, and their `mes` is the image prompt (output.ts:143-161). Skip them when analysing the story.
- Passport text should be English Danbooru tags: lowercase, comma-separated, spaces not underscores. Explicit anatomy goes only in `nsfw.tags` (`moveExplicitAnatomy`). No style/palette/quality tags.

### B6. Passport fields a "story → canon" tool would propose to change (kind `character`)

| Story change | Field |
|---|---|
| Haircut, dye, new hairstyle | `slots.hair` (replace the conflicting length/colour/style tags) |
| Scar, tattoo, burn, freckles, tan | `slots.skin` (marks on the skin) or `slots.body` (prompt: "build, height, figure, notable features"). Scar on the face, e.g. `scar on face`, `scar across eye`. |
| Lost eye, prosthetic, amputation, muscle or weight change, pregnancy, height | `slots.body` (eyepatch/prosthetic as an item → `slots.accessories`) |
| Eye colour, heterochromia, blindness | `slots.eyes` |
| Transformation, species or age change | `slots.base` (count tag + species/age) |
| New permanent default outfit | `slots.clothing` (one item per body part, one colour each) |
| New named or situational outfit | add `outfits[{name, tags}]`, optionally set `activeOutfit` |
| Glasses, jewellery, weapon, hat | `slots.accessories` |
| Temporary condition (wet, injured, crying) | toggle or add `states[]` entries, not slots (the NPC prompt says temporary states stay out of slots, passport-gen.ts:49) |
| New nickname or name in another script | `aliases[]` |
| "Must never be drawn with X" | `negative` |
| Explicit anatomy | `nsfw.tags` only |
| Leave alone | `slots.style`, `pose`, `position`, `id`, `kind` |

For non-character kinds (world/location/object), the tool would edit `tags`.

**Side effects to keep in mind:**
- For DES-tracked characters, the tracker's `currentLook` already replaces the passport clothing at render time. So the most valuable updates are to the permanent slots (hair, eyes, body, skin, base).
- Any passport change alters the DES portrait hash. Under the default `portraitPolicy: 'state'` that redraws the DES portrait (des-integration.ts:436-441).
- Persona changes go into `extension_settings.nai_studio.scene.personaPassports[user_avatar]`, followed by `saveSettingsDebounced()`.

**Other notes**
- README.ru.md has the same structure and content as README.md (174 lines each); headings and key passages were checked rather than reading it in full.
