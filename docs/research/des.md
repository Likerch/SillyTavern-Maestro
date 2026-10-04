# Research: Doom's Enhancement Suite 2.6.0 data model and integration points (2026-10-04)

**Where this comes from**
- DES 2.6.0, commit `10ad241`.
- The vendor clone `SillyTavern-DES-RU\vendor\des` and the installed copy `st-local-docker\extensions\Dooms-Enhancement-Suite` are byte-identical (`diff -rq` is empty).
- Path prefixes used below:
  - `des/` = `SillyTavern-DES-RU\vendor\des\`
  - `desru/` = `SillyTavern-DES-RU\`
  - `ST:` = `st-local-docker\src-1.19.0\public\` (the full ST 1.19 source is on disk there, which is useful for checking claims).
- Read in full: `desru/docs/des-recon.md`, plus `desru/src/des-adapter.js`, `modules/fixes.js`, `modules/names.js`, `src/st.js` and the guide docs. Everything below was re-checked against the DES source.

---

## 1. Tracker state

### Where it lives
| What | Path | Refs |
|---|---|---|
| Per message, per swipe (the source of truth) | `chat[i].extra.dooms_tracker_swipes[swipeId] = {quests, infoBox, characterThoughts}`, all JSON **strings** (or null). Only on non-user messages. | written: `des/src/systems/integration/sillytavern.js:211-222` (together), `des/src/systems/generation/apiClient.js:377-390` (separate/external) |
| Fallback when reading | `chat[i].swipe_info[swipeId].extra.dooms_tracker_swipes[swipeId]` | `des/src/core/persistence.js:756-758`, `injector.js:229-233`, `trackerJsonInline.js:25-33` |
| In memory, what is displayed | `lastGeneratedData = {quests, infoBox, characterThoughts, html}` | `des/src/core/state.js:502-507` |
| In memory, what the next prompt is built from | `committedTrackerData` | `state.js:512-517`. It is copied from `lastGeneratedData` on the user's next send (`injector.js:743-809`) |
| Per-chat blob | `chat_metadata.dooms_tracker` (shape below) | `persistence.js:567-601` |
| Quests mirror | `extensionSettings.quests = {main: string, optional: string[]}` | `parser.js:409-416` (it also calls `saveSettings`, so the value goes to the global settings) |

- **Per swipe:** ST 1.19 replaces `message.extra` on every swipe with `structuredClone(swipe_info[id].extra)` (`ST:script.js:6939, 7015`). Always index the map with the message's current `swipe_id`, and never cache references to `extra`.
- **`chat_metadata.dooms_tracker` shape.** DES rebuilds this object on every `saveChatData`, so any foreign keys inside it are lost:
```json
{ "quests": {"main":"None","optional":[]},
  "lastGeneratedData": {...}, "committedTrackerData": {...},
  "syncedExpressionPortraits": {}, "syncedExpressionLabels": {},
  "doomCounterState": null, "knivesEnabled": false,
  "characterSheets": {"Name": {...}}, "timestamp": 0,
  "knownCharacters": {"Аня": {"emoji":"😊","previousColors":["#.."]}},
  "removedCharacters": ["..."], "characterColors": {"Аня":"#C71585"},
  "bannedCharacters": ["..."] }
```
  Per-chat roster tracking is forced on (`state.js:263`), so the active roster always comes from here.

### JSON shape the model is asked for (one unified object)
Spec builders: `des/src/systems/generation/promptBuilder.js:171-216` and `jsonPromptHelpers.js:154-316`.
```json
{"quests": {"main": {"title":"…"}, "optional": [{"title":"…"}]},
 "infoBox": {"date":{"value":"…"}, "time":{"start":"…","end":"…"}, "location":{"value":"…"},
   "weather":{"emoji":"🌧️","forecast":"rain"}, "temperature":{"value":12,"unit":"C"},
   "recentEvents":["1-2 brief major events"], "moonPhase":"…", "tension":"…",
   "timeSinceRest":"…", "conditions":"…", "terrain":"…", "<custom_snake_key>": "…", "doomTension": 3},
 "characters": [{"name":"…","emoji":"…","color":"#RRGGBB",
   "details":{"appearance":"…","demeanor":"…"}, "relationship":{"status":"Friend"},
   "stats":[{"name":"Health","value":90}], "thoughts":{"content":"…"}}]}
```
- **Storage forms after parsing (`parser.js:167-181`):**
  - `characterThoughts` is stored as `JSON.stringify(parsed.characters)`, so it is usually an **array**. Legacy, default and injected data use `{characters:[...]}` (`state.js:249`, `characterWorkshop.js:3216-3229`). Handle both.
  - `removeLocks` re-stringifies with indent 2 (`lockManager.js:220-231`).
- **Fields that are configurable or optional:**
  - `details` keys are `toSnakeCase(field name)`. Cyrillic names produce `""`; DES-RU puts the names back, so you will see keys like `внешность` / `поведение` (des-recon §11.3, §12.3).
  - Enabled per-character fields: `trackerConfig.presentCharacters.customFields` (`state.js:217-220`).
  - Relationship status list: `trackerConfig.presentCharacters.relationshipFields` (`state.js:208`).
  - Custom scene fields: `getCustomSceneFields()` (`jsonPromptHelpers.js:122-145`).
- **There is no presence flag.** "Present" is computed: an English off-scene regex runs over `thoughts` (`portraitBar.js:1252`, `sceneHeaders.js:825`). DES-RU writes an `(off-scene)` marker into thoughts for Russian phrasing (`desru/src/modules/fixes.js:122-157`).
- **Readers must tolerate flat forms too:** `location` as a string, `time` as a string, `recentEvents` as a string or object, `relationship` as a string or `Relationship` (`sceneHeaders.js:410-432, 725-806`; `characterSheet.js:504`).
- **Not tracked:**
  - Inventory and user stats were removed (`state.js:165, 252`; `jsonPromptHelpers.js:146-148`).
  - Quests have no completion flag. A finished quest just disappears or becomes `"None"`.

### Where the JSON comes from in each mode
- **together** (the default, `state.js:13`):
  - The model writes "ONE JSON code block" at the **start** of the main reply (`promptBuilder.js:172-174`).
  - The block stays in `mes` (`sillytavern.js:223-227`).
  - It is parsed on `MESSAGE_RECEIVED` from `chat[last].mes`; the messageId argument is ignored (`sillytavern.js:160-297`).
- **separate:**
  - A second call goes through `safeGenerateRaw` with its own prompt built by `generateSeparateUpdatePrompt` (`promptBuilder.js:834-960`). That prompt has no WI, extension prompts or preset. It can switch connection profile first (`apiClient.js:281-303`).
- **external:**
  - A direct `fetch` to `<baseUrl>/chat/completions` (`apiClient.js:46-106`). The key is in localStorage `dooms_tracker_external_api_key`.
- **separate and external together:**
  - They run only if `autoUpdate` is on (default false, `state.js:11`), 500 ms after `MESSAGE_RECEIVED` (`sillytavern.js:298-347`), or from the manual Refresh button.
  - Both use the same `parseResponse`.
  - When finished, DES emits `dooms_tracker_update_complete` (`apiClient.js:11, 483`). It is emitted from `finally`, so it also fires after errors.

---

## 2. Characters, the "Present Characters" roster, portraits

All of these are global `extensionSettings` maps keyed by the **exact name string**.

- **Roster:**
  - Active roster = `chat_metadata.dooms_tracker.knownCharacters` (`persistence.js:850-861`).
  - New names are added **inside a render function**, `getCharacterList()` (`portraitBar.js:1320-1334`), which then calls `saveCharacterRosterChange()`. That call also triggers lorebook auto-link (`persistence.js:922-936`).
  - Absent characters are never removed automatically.
  - Names whose "same character?" popup is still pending are held back (`portraitBar.js:1296-1302`).
- **`removedCharacters`** (per chat, case-insensitive hide list): `persistence.js:868-879`.
- **`bannedCharacters`** (per chat): adds a standing prompt slot `dooms-workshop-banned-characters` (`characterWorkshop.js:203-231, 245-277`).
- **Orphan adopt:** on every `loadChatData`, each name in `removedCharacters` that has no card becomes `knownCharacters[name] = {emoji:'👤'}`; user-persona names are skipped (`persistence.js:808-837`). DES-RU removes these stubs again (`desru/src/des-adapter.js:444-465`).
- **Aliases:**
  - Stored as `characterAliases = {canonical: [alias…]}`, global (`state.js:71`).
  - Applied before anything is stored (`sillytavern.js:181-187`; `apiClient.js:341-348`).
  - Exports and algorithm: `characterAliases.js:48-77, 567-618`.
  - "No" answers to the popup are stored in `aliasDismissals["normA|normB"]`.
  - `adoptVariantAsAlias` (`characterAliases.js:355-477`) moves or erases the variant's data in every store, globally.
- **Workshop identity stores** (`campaignProfiles.js:38-48`):
  - `characterInjection[name] = {description, lorebook, promptTemplate?}`
  - `characterAppearance[name] = "portrait prompt"` (a single line, appearance only)
  - `npcAvatars`, `npcAvatarsFullRes`
  - `npcAvatarHistory[name] = [{avatar, avatarFullRes, replacedAt}]`, at most 5 (`des/src/utils/avatars.js:185-268`)
  - `characterRelationships[name] = "status"` (the user's persistent override)
  - `characterKnives`, `heroPositions`
  - `generatedPortraits[name] = {source, prompt, stateHash, url, createdAt}` (`avatarGenerator.js:94-109`)
  - `userCharacters[name] = {color, avatar, avatarFullRes, pronouns, linkedPersona, injection, knives}` (`characterWorkshop.js:1155-1181`)
  - When a campaign is active, these flat stores are physically swapped to that campaign's version (`campaignProfiles.js:1-34`).
- **The Workshop description is not injected every turn.** It is used only by the one-shot "Inject into Scene" (`characterWorkshop.js:3127-3165`, slot `dooms-workshop-scene-inject`, IN_PROMPT), plus portraits and knives. A grep confirms no per-turn use (only `doomCounter.js:314` reads relationships). So lorebooks are the natural persistent home for NPC facts.
- **Portraits:**
  - Resolution order (`portraitBar.js:743-819`): synced expression → active user character → `npcAvatars` (exact, then prefix match) → ST character cards (`portraitAutoImport`) → `portraits/` file.
  - Files are saved to `/user/images/des-portraits/` (`avatars.js:16-17, 109`).
  - Generation runs `/sd quiet=true <prompt>` (`avatarGenerator.js:668-716`). Prompt sources, in order: `characterAppearance` (`:66-75, 607-611`), the session LLM prompt, a fallback.
  - Auto Portraits modes are `only_missing` / `state_changed` / `every_reply`. The state hash is computed over the character's tracker entry (`avatarGenerator.js:281-310`).
  - "Generate portrait from description" turns `injection.description` into tags (`promptBuilder.js:1140-1160`).
  - Exports: `getCharacterAppearance`, `regenerateAvatar`, `generateAvatarWithPrompt`, `distillDescriptionPrompt`, `isSdAvailable`, `hasExistingAvatar`.
  - Hooks: DES emits no "portrait done" event. ST's `SD_PROMPT_PROCESSING` event does exist (des-recon §8.5).

---

## 3. Lore Library

- **What it is:**
  - A modal that hijacks ST's World Info button when `lorebook.enabled` is on (`index.js:2423-2461`).
  - It lets you browse and edit WI entries, create, move, delete, rename, import and export books, toggle which books are active, and edit **global WI settings** (`lorebook.js:237-257`, `lorebookAPI.js:325-340`).
- **Metadata:** `extensionSettings.lorebook` (`state.js:384-402`):
  - `campaigns{id:{id,name,icon,color,books:[WI filenames]}}`, `campaignOrder`
  - UI state: `collapsedCampaigns`, `expandedBooks`, `lastActiveTab/Filter/Search`, `viewMode`
  - `activeCampaignId`, `globalBooks`, `campaignActivated` (ledger)
  - `autoLinkByName` (default true), `autoLinked` (ledger)
- **It does not change the WI engine, but it does change which books are active** (`selected_world_info`):
  - **Active campaign:** turns its books on and the previous campaign's off, except global books (`campaignManager.js:214-320`). It also swaps the character stores.
  - **Auto-link** (`autoLink.js:44-85`): any WI book whose name exactly equals a key in the chat's `knownCharacters` is switched on. That means the whole chat cast, including absent and removed characters, not only who is present. Books it switched on are switched off when the name leaves the cast.
  - **Workshop inject** switches on `characterInjection[name].lorebook` and never switches it off (`characterWorkshop.js:3134-3145`).
- **API (lazy modules, no events emitted):**
  - `lorebookAPI.js`: `getAllWorldNames`, `getActiveWorldNames`, `isWorldActive`, `activateWorld`/`deactivateWorld`, `applyWorldActivation`, `loadWorldData`/`saveWorldData`, `createEntry`/`deleteEntry`, `updateEntryField`, `clearWICache`, `invalidateWICache`, `renameWorld`, …
  - `campaignManager.js`: `getActiveCampaign`, `getCampaignForBook`, `getCampaignsInOrder`, `addBookToCampaign`, `queueBookTask`, `setActiveCampaign`, …
  - `autoLink.js`: `syncAutoLinkedLorebooks`, `isAutoLinkEnabled`
  - `campaignProfiles.js`: `readVersion`, `writeVersion`, `snapshotLive`, `PROFILE_FIELDS`

---

## 4. Events, exports, settings

- **eventSource:** DES emits only `dooms_tracker_update_complete`, with no arguments (separate and external only).
- **window CustomEvents:**
  - DES emits: `dooms:perf-mode-changed` (`index.js:629`), `dooms:tracker-config-saved` (`trackerEditor.js:330`), `dooms:inject-state-changed {name, pending}` (`characterWorkshop.js:294`).
  - DES listens: `dooms:open-workshop {characterName, isUser}`, `dooms:cancel-inject {name}` (`characterWorkshop.js:330-340`), `dooms:open-roster` (`characterRoster.js:114`), `doom-counter-trigger` on `document` (`sillytavern.js:617`).
- **No event at all for:** together-mode parse, manual tracker or panel edits, Workshop save, alias adoption, roster change, campaign switch, Lore Library edits.
- **`window` globals:** `window.DES_INSPECTOR` only (`inspector.js:393`). No slash commands and no macros.
- **ST events DES subscribes to** (all plain `on`, registered at the end of its async init, `index.js:3435-3456`):
  - `MESSAGE_SENT`, `GENERATION_STARTED`, `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED`
  - `MESSAGE_SWIPED`, `MESSAGE_UPDATED`, `MESSAGE_DELETED`, `CHAT_CHANGED`
  - prompt-ready events (`injector.js:1019-1036`)
  - It does **not** listen to `WORLDINFO_UPDATED`.
- **Importing DES modules** (see `desru/src/des-adapter.js:207-233, 577-603`):
  - Locate DES's `<script src>` (`desru/src/st.js:44-64`), then `import(new URL('src/…', scriptUrl))`. The same URL gives the same module instance.
  - Read `export let` values through the module namespace every time; `loadChatData` reassigns them (`des-adapter.js:754-756`).
- **Useful exports for a lorebook keeper:**
  - **State and persistence:**
    - `core/state.js`: `extensionSettings`, `lastGeneratedData`, `committedTrackerData`
    - `core/persistence.js`: `saveSettings`, `saveChatData({immediate})`, `getActiveKnownCharacters`, `getActiveRemovedCharacters`, `getActiveBannedCharacters`, `getActiveCharacterColors`, `saveCharacterRosterChange`
    - `core/lazyUI.js`: `ensureSettingsUI`
  - **Parsing:**
    - `parser.js`: `parseResponse` (pure)
    - `apiClient.js`: `parseCharacterEntriesFromThoughts`, `DOOMS_TRACKER_UPDATE_COMPLETE`
    - `utils/trackerParse.js`: `parseTrackerJson` (memoised; the result is shared, read it only)
    - `jsonPromptHelpers.js`: `toFieldKey`, `getCustomSceneFields`
    - `promptBuilder.js`: `getAssembledTrackerPrompt`, `formatHistoricalTrackerData`
  - **Names:**
    - `characterAliases.js`: `resolveCharacterAlias`, `addCharacterAlias`, `hasPendingAliasDecision`, `waitForAliasDecisions`
    - `utils/nameSimilarity.js`: `normalizeName`, `namesAreSimilar`, `findSimilarCharacter`
  - **Rendering and portraits:**
    - `portraitBar.js`: `resolvePortrait`, `resolveFullPortrait`, `updatePortraitBar`
    - `avatarGenerator.js`: the exports listed in §2
  - **Lazy module:** `characterSheet.js` → `computeCharacterStats(name)` (`:384-581`): presence, relationship timeline, top locations, last thoughts, built by walking every message's swipe data. A good reference walker.
- **Exports with side effects:**
  - `parseQuests` writes global quests and saves.
  - `getCharacterList` writes the roster and triggers auto-link.
  - `applyCharacterAliases` can add aliases and queue popups.
- **Settings object:** `extension_settings['third-party/<folder>']`; the folder name comes from `import.meta.url` (`config.js:11-16`). Defaults: `state.js:8-436`. Groups:
  - mode, injection depth/role: `:11-20`
  - prompt overrides `custom*Prompt`: `:31-50`
  - `historyPersistence`: `:73-79`
  - `trackerConfig`: `:167-237`
  - identity stores: `:254-271, 343-350`
  - `lorebook`: `:384-402`
  - `doomCounter`: `:405-420`
  - `presetManager`: `:422-432`; `trackerConfig` is replaced wholesale on `CHAT_CHANGED` by auto-preset (`persistence.js:1273-1425`)

---

## 5. Prompt injection

All calls go through `desSetExtensionPrompt` with **`scan=false`**, so WI never sees DES injections. Slot registry: `inspector.js:27-39`.

| Slot | Position / depth / role | Content |
|---|---|---|
| `dooms-tracker-inject` | IN_CHAT, `promptInjection.trackerInstructions` (default depth 0, role user) | instructions, lock rule, FORMAT spec, continuation text (`injector.js:856-861`) |
| `dooms-tracker-example` | IN_CHAT at the depth of the last assistant message, role assistant | previous **committed** tracker in a ```json fence (`injector.js:816-851`) |
| `dooms-tracker-html`, `dooms-tracker-dialogue-coloring` | IN_CHAT, configurable (default depth 0) | HTML prompt; colour prompt plus reserved colours (`injector.js:862-888`) |
| `dooms-tracker-context` | IN_CHAT depth 1 (separate/external only) | `<context>` summary (`injector.js:899-919`) |
| `dooms-tracker-new-fields` | IN_PROMPT | boost for newly enabled widgets (`injector.js:100-136`) |
| `dooms-doom-counter-twist` / `-tension` | IN_CHAT / … | Doom Counter |
| `dooms-workshop-scene-inject` / `-eject` / `-banned-characters` | IN_PROMPT | Workshop one-shot inject or eject; standing ban list |

- DES rewrites these slots on every `GENERATION_STARTED`, including quiet generations. It clears them on suppression: guided generations or impersonate (`injector.js:690-701, 977-1004`).
- **History persistence** (off by default): appends "Context for that moment:" plus historical tracker text to past messages at the prompt-ready events, after the WI scan (`injector.js:180-303, 524-641`).
- **Regexes DES installs on every start** (`index.js:2973-2993`), all with placement `[2]` (AI output):
  - "Doom's Character Tracker - Remove Tracker JSON (Together Mode)": `/```(?:json|markdown)?[\s\S]*?```/gim`, markdownOnly and promptOnly, re-forced on every start (`jsonCleaning.js:21-102`).
  - "Clean RPG Trackers (From Outgoing Prompt)": fenced json containing quests/infoBox/characters keys, promptOnly (`htmlCleaning.js:107-169`).
  - "Clean HTML (From Outgoing Prompt)": strips **all** tags (including `<font>`), promptOnly (`htmlCleaning.js:38-99`).

---

## 6. DES and World Info

- DES **never reads lorebook content** to build cards, prompts or portraits. Portrait and separate prompts use only the ST card description and personality (`promptBuilder.js:40-102`).
- **It writes WI only through the Lore Library UI**, using ST's `saveWorldInfo` / `createWorldInfoEntry` (`lorebookAPI.js:174-198`).
- **It switches books on and off in three ways:** campaigns, auto-link by name, and Workshop inject (§3).
- **The per-character link** `characterInjection[name].lorebook` maps an NPC to a WI book name. The Workshop combo box lists `world_names` (`characterWorkshop.js:1603-1666`). This is a ready-made NPC → book mapping you can reuse.
- **WI scan input in ST 1.19:** the scan runs over `coreChat` *after* `getRegexedString(..., {isPrompt:true})` (`ST:script.js:4501-4506, 4624`; regex engine `ST:scripts/extensions/regex/engine.js:350-354`).
  - So the promptOnly DES regexes **do** strip fenced tracker JSON and HTML from WI scanning.
  - This contradicts the comment in `desru/src/st.js:69-71`.
  - Unfenced JSON, which the DES parser also accepts, would still reach both the prompt and the WI scan.

---

## 7. Best inputs for "the story changed → propose lorebook updates"

**Snapshot per turn:** `swipes[swipe_id]` of each assistant message. Diff it against the nearest earlier assistant message *per section*: a section can be null when the model omitted it, and a reply without JSON stores an all-null entry (`sillytavern.js:211-222`).

| Signal | Source | Suggested lorebook action |
|---|---|---|
| New NPC | name in `characters[]` not seen before, or a new key in `chat_metadata.dooms_tracker.knownCharacters` | create an NPC entry (keys = name + `characterAliases[name]`) |
| New alias | `extensionSettings.characterAliases` diff | add as a key or secondary key on that NPC's entry |
| Relationship change | `characters[i].relationship.status` (AI, per turn) vs `characterRelationships[name]` (user override) | update the relationship line; `computeCharacterStats` already produces a timeline (`characterSheet.js:503-508`) |
| Appearance or demeanour drift | `characters[i].details.*` (keys depend on config; may be Cyrillic) | appearance is fairly durable, demeanour is volatile; also `characterAppearance[name]` (portrait prompt) and `characterInjection[name].description` |
| Location change | `infoBox.location.value` (or string); DES's own transition detector is `sceneHeaders.js:456-557` | new or updated location entry |
| Events | `infoBox.recentEvents` (1–2 strings) | timeline / event entries |
| Time and date | `infoBox.time{start,end}`, `infoBox.date.value` | timestamps for events |
| Quests | `quests.main.title`, `optional[].title`; "None" means no quest | a quest that **disappears** is the only completion signal |
| Cast exits | `removedCharacters`, `bannedCharacters` diff; off-scene markers in thoughts | mark as absent, do not delete |
| Imported sheets | `chat_metadata.dooms_tracker.characterSheets` | rich NPC source |

**When to diff (timing):**
- **together:** after DES has parsed. Use `makeLast(MESSAGE_RECEIVED)` registered after DES has initialised, or `CHARACTER_MESSAGE_RENDERED`. Defer with `setTimeout(0)` to also see DES-RU's fixes and aliasing.
- **separate/external:** `dooms_tracker_update_complete`. Compare with the previous snapshot by identity, as DES-RU does (`desru/src/modules/names.js:523-531`).
- **Most robust "final" point:** DES commits the turn when the user sends the next message (`GENERATION_STARTED` with the user message second-to-last, `injector.js:743-779`). Diffing `committedTrackerData` (or the previous assistant message's swipe data) at `MESSAGE_SENT` / `GENERATION_STARTED` avoids proposing changes from swipes the user later throws away.
- **Invalidate pending proposals** on `MESSAGE_SWIPED`, `MESSAGE_DELETED` (DES rolls back, `sillytavern.js:506-559`), `MESSAGE_EDITED`, and `CHAT_CHANGED`. After a chat change, the loaded state is a baseline, not a change.

---

## 8. Pitfalls for a second extension reading DES state

1. **Stored values are JSON strings**, and DES's own code calls `.trim()` on them, so write strings, not objects (`apiClient.js:393-395`). Handle array vs `{characters}`, flat vs nested fields, and legacy text formats. The memoised parse result is shared; never mutate it (`trackerParse.js:10-42`).
2. **`lastGeneratedData` is not per message.** In together mode, a reply without JSON leaves it holding the previous turn while the swipe entry is null. Prefer per-message swipe data.
3. **To persist an edit,** write it into `extra.dooms_tracker_swipes[swipe_id]` of the last assistant message; `loadChatData` overwrites the in-memory stores from it (`persistence.js:743-790`; DES-RU does this in `des-adapter.js:817-833`). Keep your own data outside `dooms_tracker` (`persistence.js:571-592`).
4. **Before DES's first `saveSettings`, `extension_settings[DES]` is not DES's live object** (`persistence.js:102-112, 544-558`). Import `state.js` instead.
5. **Event order:**
   - `makeFirst` puts a listener at the front; `makeLast` only pushes to the end at the moment you register (`ST:lib/eventemitter.js:43-107`). DES registers late (`index.js:3435`), so register after DES is ready (`#dooms-settings-fab` / `#rpg-extension-enabled`) or use `CHARACTER_MESSAGE_RENDERED` (DES-RU: `fixes.js:237-239`).
   - `emit` awaits each listener in turn. DES's together-mode parse, store update, swipe write and `saveChatData({immediate})` run as one synchronous pass, so you can only run before it or after it.
6. **`MESSAGE_RECEIVED` fires in more cases than new replies:** also for `first_message` (`ST:script.js:7705, 9916`; `group-chats.js:300`) and on streaming errors, where it is not awaited (`ST:script.js:3826-3830`). DES parses every one of them. Synthetic GuidedGenerations messages are skipped (`des/src/utils/messageGuards.js:23-44`).
7. **The tracker JSON stays at the start of `mes`.** Strip it (DES regex or `parseResponse`) before feeding text to an LLM. During streaming DES does nothing.
8. **Names:**
   - Keys are exact, case-sensitive strings in every store.
   - The alias popup may still be pending.
   - DES's Tier-1 auto-alias rewrites names after your `makeFirst` hook.
   - DES-RU adds aliases and `(off-scene)` markers and normalises "Нет" to "None" (`fixes.js:122-157`).
   - `\b` matching fails on Cyrillic (des-recon §11.2).
9. **Calling `getCharacterList` has side effects** (it writes the roster and triggers auto-link). Read `knownCharacters` directly instead.
10. **Lazy modules:**
    - Workshop, Roster, Sheet and Lore Library load only on first modal open, and their listeners and init run only then (`index.js:686-711`).
    - `dooms:open-workshop` is silent until `ensureSettingsUI()` has run (DES itself does that first, `portraitBar.js:403-405`).
    - While `#character-workshop-popup.is-open`, its draft overwrites aliases, injection, appearance and relationship on save (`characterWorkshop.js:2620-2720`). Do not write those stores while it is open.
11. **The Lore Library caches WI data** (`lorebookAPI.js:42-57`); the cache is cleared only when the modal opens (`lorebookModal.js:47-48`). Its editor saves the **whole book object** with a 500 ms debounce (`lorebook.js:59-65`), so a concurrent write by your extension to the same book can be overwritten. Call `invalidateWICache(name)` after your writes; DES ignores `WORLDINFO_UPDATED` (`ST:scripts/world-info.js:4160`).
12. **Campaign switches swap the Workshop stores and toggle books.** Auto-link turns on any book named like a cast member. Account for both if you create per-NPC books, or exploit it: name each NPC's book exactly after the card name.
13. **On every `CHAT_CHANGED`, DES deletes `extra.display_text`** in requestAnimationFrame chunks of 50 (`index.js:3046-3075`); DES-RU stashes and restores it (`fixes.js:165-220`). Do not store anything in `display_text`.
14. **separate/external:**
    - There is no event between the reply and the parse.
    - `dooms_tracker_update_complete` is emitted from the `finally` block, so it fires after every attempt that started, including errors and empty or failed parses (`apiClient.js:440-484`). It is not emitted when `updateRPGData` returns early: a generation already in progress, DES disabled, the mode is not separate/external, or all three tracker sections are hidden (`apiClient.js:252-268`).
    - With `autoUpdate` false, the update happens only on manual Refresh.
15. **Manual edits fire no event.** Panel edits (`thoughts.js:888-948, 1196-1214`; `infoBox.js:760-847`; `quests.js:17`) and the inline "Tracker Data" editor (`trackerJsonInline.js:151-215`) mutate the stores and swipe data and then save silently. Re-diff at commit points.
16. **Minor DES bug:** the Workshop's relationship fallback reads `window.dooms_lastGeneratedData`, which is never set (`characterWorkshop.js:1251`), so it is always empty.
