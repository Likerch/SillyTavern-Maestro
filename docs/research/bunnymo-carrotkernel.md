# Research: BunnyMo V3.0 and CarrotKernel 1.0.0 integration points (2026-10-04)

All work was read-only. Paths are relative to these roots:
- **BM** = `SillyTavern-DES-RU\vendor\BunnyMo` (commit 7a61c9f, V3.0)
- **CK** = `SillyTavern-DES-RU\vendor\CarrotKernel` (commit 145c273, v1.0.0)
- **DR** = `SillyTavern-DES-RU` (v0.7.0)
- **LL** = `SillyTavern-LorebookLocalizer` (a sibling project with useful write helpers)

Notation:
- SillyTavern (ST) entry roles: 0 = system, 1 = user, 2 = assistant.
- ST positions: 0 = before character, 1 = after character, 2/3 = Author's Note top/bottom, 4 = at depth, 5/6 = example messages top/bottom, 7 = outlet.
- Most BunnyMo JSON files are minified onto one line, so entries are cited by `uid`. The MBTI V2 pack is pretty-printed and has real line numbers.

`docs/ck-ui-map.md` in DES-RU covers UI only. `docs/bunnymo-recon.md` was read fully; its facts are folded in below.

---

## 1. BunnyMo

### 1.1 What it physically is
- **No code.** BunnyMo is a set of SillyTavern lorebook (World Info) JSON files: `{ "entries": { "<n>": entry } }`.
  - There is no pack metadata. Only the Traits pack has an extra `description` field.
  - Packs therefore have to be recognised by their keys and content, not by file name.
- **Core lorebook:** `BM/✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V3.0.json`, 84 entries. Old versions sit in `BM/BunnyMo Pastures (Old Versions)/`.
- **Packs:** `BM/BunnMo Packs/**`.

| Pack | Content | Key style |
|---|---|---|
| Species | 111 entries in one file, plus a split edition `---A…---I` | `<ELF>`, `<SPECIES:ELF>` |
| Dere | V2 (37) + ExpanPack (17) | `<DERE:TSUNDERE>` |
| MBTI | V2 (37) + "Editions (Seperated)" | `<INTJ-U>` |
| Traits | 69 | `<TRAIT:STOIC>` |
| CarrotCast genres | V1.0 (56) + Limited (57) | `<GENRE:ROMANCE>` |
| Linguistics | full `.bny` + split, LiteR + split | `<LING:BLUNT>` |
| Tell Tail Lenses | 19 | none (constant) |
| BSM-5 | 39 | `<BSM:PTSD>`, `<PTSD>` |
| BSM-5 CoT Lenses | 40 | same keys as BSM-5 |
| BunnyRX | 36 | `<MED:XANAX>` |
| HopSpital | 33 | `<CONDITION:WHEELCHAIR>` |
| Retired | MBTI v1 and the old "The Analysts" | — |

- The split editions are stated to be identical to the merged ones: `BM/BunnMo Packs/MBTI…/ReadMe` and `Species…/ReadMe`.
- In the core, entry content is wrapped as `<BunnymoTags:Entry Name>…</BunnymoTags:Entry Name>`. Some packs (CarrotCast, Linguistics, lenses) use the same wrapper, so the wrapper alone does not identify the core lorebook.

### 1.2 The tag system
- **Format:** `<KEY:VALUE>`. Keys and values are English, upper case, with `_` instead of spaces, e.g. `<ATTACHMENT:FEARFUL_AVOIDANT>`. ST matches keys case-insensitively by default.
- **MBTI is a bare tag with no colon:** `<XXXX-H>` (healthy) or `<XXXX-U>` (unhealthy).
- **Archive block format.** Template in core #44, example in core #43:
  ```
  <BunnymoTags><Name:Atsu_Ibn_Oba_Al-Masri>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:HUMAN>, <GENDER:MALE>, … </PHYSICAL>
  <PERSONALITY><Dere:Sadodere>, <ENTJ-U>, <TRAIT:CRUEL>, <ATTACHMENT:FEARFUL_AVOIDANT>, … </PERSONALITY>
  <NSFW>…</NSFW> </BunnymoTags>
  <Linguistics> Character uses <LING:COMMANDING> … </linguistics>
  ```
  - The V3 fullsheet "TAG SYNTHESIS" in core #2 adds `<HEALTH><BSM:…>, <CONDITION:…>, <MED:…>, <REC:…></HEALTH>`.
  - It also adds prose blocks `<Genre>`, `<MentalHealth>`, `<PhysicalConditions>`, `<Medications>`, `<Linguistics>`.
- **Which tag categories actually trigger pack entries.** Keys of all enabled entries across every pack were enumerated:
  - **Trigger-bearing:** SPECIES, DERE, GENRE, TRAIT, LING, BSM/MENTAL/MOOD/ANXIETY/TRAUMA/PERSONALITY/EATING/DISSOCIATIVE/ADDICTION/SLEEP, MED/REC/BENZO/SSRI/STIMULANT/…, CONDITION/MOBILITY/SENSORY/…, DOMAIN/DIVINE/BENDER, plus 822 bare tags such as `<PTSD>`, `<ELF>`, `<ISTJ-H>`.
  - **Informational only** (no pack entry keys on them): ATTACHMENT, CONFLICT, BOUNDARIES, FLIRTING, KINK, POWER, ORIENTATION, CHEMISTRY, AROUSAL, JEALOUSY, DECISION, COMFORT, VICE, LOYALTY, TRUST, MASK, GENDER, BUILD, HAIR, STYLE, AGE.
  - Core "HawThorne Link" entries #74–#83 match prefixes such as `<ATTACHMENT:`, `<DERE:`, `MBTI:`, `<MED:`, `<BSM:`, `<SPECIES:`, `<TRAIT:`, and only set `bmo_*` variables.
- **Wrapper collisions to know about:**
  - **Biggest one:** CarrotCastLimited's "Erotic" entry has the bare key `<NSFW>`. Every archive using the `<NSFW>…</NSFW>` wrapper therefore fires it through recursion.
  - Smaller ones: `<DERE>` is a key of Deredere, `<HUMAN>`/`<ELF>` are bare species keys, `<ANXIETY>` is a GAD key.
- **HopSpital self-throttle:**
  - Each entry asks the model to print `<WHEELCHAIR:CHECKED>` (or similar) in its reply.
  - It uses `selectiveLogic: 2` (NOT_ANY) on that secondary key, with sticky 3 and cooldown 2.
  - Any tool scanning chat for tags must ignore `:CHECKED` tags.

### 1.3 Core V3.0 flags (by uid)
- **Sheet commands:** #2 `!fullsheet` (at depth 0, role user, 28.8k characters); #3–#7 `!quicksheet`, `!tagsheet`, `!memsheet`, `!updatesheet`, `!physheet` (at depth 0, role system; #7 has excludeRecursion).
- **Master entries #13–#40:** mostly position 0, keys like `!dere` and `<DERE_SYSTEM>`.
  - #20 Dere and #22 Genre are at depth 6, system, excludeRecursion.
  - #12 Archetypes is at depth 0, user, sticky 999999. It asks for a line `<Name> <XXXX-U>` before every reply.
- **Enabled constants:** #25 Kaomoji (outlet, never sent), #41 Medicine Check (depth 4, system, key `/^/`), **#64 AUTO-FILTRATION LINGUISTICS (depth 3, role 2 assistant)**, #76 HawThorne Flag Reset.
- **Enabled role-2 (assistant) entries:** only #64. Disabled role-2 entries: #10, #43, #44, #56, #57, #61, #62, #66–#68. Tell Tail "Ozone Filter" (uid 18) is constant, at depth 0, role 2 and enabled; the other 18 lenses ship disabled.
- **Auto-detectors #46–#52:** depth 3, system, cooldown 4–8. #55 Anti-Clanker Alpha: position 6 (bottom of example messages), sticky 1, cooldown 3.
- **Pack flags:**
  - BunnyRX: all entries at example-messages bottom, depth 0, probability 55, excludeRecursion.
  - HopSpital: at depth 0, system, probability 75.
  - MBTI V2: Analysts uid 29–36 are **at depth 0, system, no excludeRecursion** (changed from v1). The rest are position 1, depth 5, and about half have excludeRecursion (for example lines 17, 47, 78 of the V2 file).

### 1.4 How tags in an archive trigger packs
1. The archive is a lorebook entry whose content is the `<BunnymoTags>` block, keyed by the character's name.
2. When it activates, its content enters ST's recursion buffer, and pack entries keyed `<SPECIES:ELF>` and so on fire.
3. **This only works if the pack entry does not have `excludeRecursion`.** BunnyRX, CoT Lenses, half of MBTI and parts of BSM-5 can only fire from tags that appear directly in chat text, or from DES-RU's scan-only injection.
4. CK's own tag injection does **not** trigger packs. It is formatted `Name: VALUE, VALUE` and lives in `WORLD_INFO_ACTIVATED`, which runs after the scan. See DR `docs/upstream-issues.md:130-134`.

### 1.5 Version duplication (measured)
- **MBTI v1 (Retired) vs V2:**
  - Same 32 MBTI keys, 89 shared normalised keys in total.
  - 24 entries have byte-identical content.
  - The 8 Analysts entries were rewritten: v1 `<INTJ-U>` is "The Schemer" (3002 characters), V2 is "The Cynic" (3478). V2 keys sit at e.g. `<ISTJ-H>` line 128, `<ESFP-H>` line 1155, `<INTJ-U>` line 2117.
  - Loading both fires two different texts on one tag.
  - The "Editions" files duplicate V2. `Editions/The Analysts` has no `.json` extension and equals V2; `Retired/The Analysts.json` equals v1.
- **Other key-overlap counts:**
  - CarrotCast V1.0 vs Limited: 293.
  - BSM-5 vs CoT Lenses: 176 (a deliberate pairing — different content types).
  - LINGUISTICS vs LiteR: 103, plus each split file vs its merged file.
  - Species merged vs each split edition: 27–64 shared keys, with identical content.

### 1.6 Detecting duplicates across packs (suggested algorithm)
1. Normalise keys: trim, upper-case, remove spaces after `:` (the pack itself contains `<LING: HORNY>`). Keep regex keys verbatim.
2. Index enabled entries by normalised key, and separately by whitespace-normalised content hash.
3. Classify each group:
   - **Exact duplicate** (same keys, same content): the same pack loaded twice, or merged plus split editions.
   - **Version conflict** (same keys, different content): MBTI v1 vs V2 Analysts. Prefer the higher version found in the file name or comment. Also diff flags (position, depth, role, excludeRecursion, probability).
   - **Intentional pair:** BSM-5 with CoT Lenses — whitelist by comment prefix `CoT LENS`.
   - **Lite vs full:** Linguistics — offer to keep one.
4. Use trigram or MinHash similarity on content to catch near-copies.
5. Reuse DR `src/bunnymo-adapter.js:84-107` `classifyWorlds`:
   - core = 3 or more core entries;
   - pack = (3 or more tagged keys and at least 60% of keyed entries) or 3 or more wrapped entries.
6. Use `packVocabulary` (`:114-127`, all keys) rather than CK's `{{BUNNYMO_PACK_TAGS}}` (CK `sheet-generator.js:1000-1082`). CK's macro reads only `key[0]`, and when two packs share a prefix the last one wins.

---

## 2. CarrotKernel

### 2.1 Features and where their data lives
CK is a real ST extension: `CK/manifest.json` with `generate_interceptor: carrotKernelRagInterceptor_CK`. Settings key is `extension_settings.CarrotKernel` (`carrot-state.js:354`).

| Feature | Storage | Reference |
|---|---|---|
| Settings: `displayMode` ('none' / 'thinking' / 'cards'), `sendToAI`, injectionRole/Depth, maxCharactersDisplay/Inject, `babyBunnyMode`, `autoRescanOnChatLoad`, `bunnymoTagWrapping`, `excludeTagSynthesis` | `extension_settings.CarrotKernel` | `index.js:610-665` |
| **Repos** (Character Repo / Tag Library marking) | lorebook names in `selectedLorebooks[]`, `characterRepoBooks[]`, `tagLibraries[]`; mirrored to in-memory Sets | `index.js:673-785`, toggles `index.js:8998-9094`, `carrot-state.js:12-17` |
| Character sheet ("archive") | ST lorebook entry in a Character Repo; content holds `<BunnymoTags>…</BunnymoTags>` | parsers below |
| Parsed characters | in-memory `scannedCharacters` Map `"world::Name" → {name, tags: Map, source, uid}` | `carrot-state.js:17` |
| Which characters were shown | `chat[i].extra.carrot_character_data` = composite keys (array, or `{characters, displayMode, timestamp, version}`) | `index.js:2712-2723`, `6798-6807` |
| "thinking" display mode | appends a `<BunnyMoTags>` dump to **`message.mes`** and saves the chat | `index.js:2960-3066` |
| "cards" display mode | pushes a system message named `BunnyMoTags` (JSON in `mes`, `extra.bunnyMoData`) into the chat | `index.js:2821-2903` |
| Templates (consistency and sheet-command text) | `extension_settings.CarrotKernel.templates{}`, `primaryTemplate`; built-ins in code | `sheet-generator.js:188-208`, `555-669` |
| Lorebook connections | `chat_metadata.carrot_chat_books`, `chat_metadata.world_info`, `world_info.charLore[].extraBooks` | `lorebook-connector.js:744-773` |
| Per-chat / per-character settings overrides | `chat_metadata.CarrotKernel`, card `data.extensions.CarrotKernel` | `context-manager.js:100-188` |
| RAG chunk text and metadata | `extension_settings.CarrotKernel.rag.libraries.{global \| character[characterId] \| chat[chatId]}[collectionId][hash] = {text, section, topic, tags, keywords, systemKeywords, keywordGroups, keywordRegex, customWeights, chunkLinks, …}` | `fullsheet-rag.js:95-183`, `1979-1995`, `3882-3888` |
| RAG triggers | `rag.collectionMetadata[collectionId] = {keywords[], alwaysActive, characterName, createdAt, lastModified}` — **no UI to edit these** | `fullsheet-rag.js:3893-3913` |
| Vectors | ST server vector store through `/api/vector/{list,insert,query,delete,purge}`. collectionId = `carrotkernel_char_<lowercased \p{L}\p{N}_ name>` plus `_chat_<chatId>` or `_charid_<idx>` | `fullsheet-rag.js:49`, `365-502`, `683-723` |
| Embedding source and model | read from ST's Vector Storage settings (`extension_settings.vectors`) when present, otherwise from `rag.*`; default `transformers` | `fullsheet-rag.js:194-307` |
| WorldBook Tracker | in memory only | `worldbook-tracker.js:3423` |

- **Baby Bunny does not generate sheets.**
  - The LLM writes the sheet because of BunnyMo's `!fullsheet` entry plus CK's `/inject id=carrot-sheet-<type>` "MANDATORY OOC OVERRIDE" (`index.js:447-551`, triggered in `6869-6946`).
  - Baby Bunny then detects the finished sheet in an AI message (`baby-bunny-mode.js:46-192`, extraction `195-376`, parser `380-447`) and writes an archive entry.
  - Its "Skip to Chunking" path goes into RAG instead (`baby-bunny-mode.js:1880-1915`, `3572-3606`).
- **CK's "generate sheet" functions** (`generateFullSheet`/`TagSheet`/`QuickSheet`, `sheet-generator.js:40-181`) only format strings from a tag Map. They are reachable only through the `{{FULLSHEET_FORMAT}}`-style macros (`1425-1468`).
- **"Workshop" is not part of CK** (no matches for "workshop" in CK). It is DES's Character Workshop (`vendor/des/src/systems/ui/characterWorkshop.js`), which edits NPC aliases, relationship, injection and appearance. Known pitfall: it saves a snapshot taken when opened, so it overwrites alias changes made in between (`docs/bunnymo-recon.md` §5.2 F).

### 2.2 Exact sheet-entry format (Baby Bunny single path)
`baby-bunny-mode.js:2273-2312` (manual entry for a new lorebook: `2218-2260`):
```
comment: "<Name> Character Archive - Generated by Baby Bunny Mode"
content: "<BunnymoTags>…</BunnymoTags>[\n<Linguistics>…</Linguistics>]"
key: [triggers], keysecondary: [], selective/constant from user choice
position: 4, depth: 2, role: 2 (assistant), order: 550
excludeRecursion: true, preventRecursion: false, useProbability: true, probability: 100
ignoreBudget: true, scanDepth: 1, matchWholeWords: true, caseSensitive: false, sticky/cooldown/delay: 0
```
- The code comments say these values "Match Egyptian Royalty format", i.e. BunnyMo #43. That entry is at depth 2, role 2, order 550.
- **`role: 2` hardcoded: confirmed at `baby-bunny-mode.js:2246` and `:2299`.**
- After saving, the lorebook is registered as a Character Repo (`2349-2357`).
- **Batch path differs** (`addCharacterToLorebook`, `1404-1448`):
  - comment ends in "(Batch)";
  - position 4, order 550, excludeRecursion true;
  - role, depth and scanDepth are not set, so ST's `createWorldInfoEntry` defaults apply;
  - `useProbability: false`;
  - **the lorebook is not registered as a Character Repo.**
- With `scanDepth: 1` and whole-word matching, a single-path archive only activates when the name appears in the **last** message. Whole-word matching is also broken for Cyrillic in ST.

### 2.3 How CK decides what to inject
1. **On `CHAT_CHANGED`:** if `autoRescanOnChatLoad`, `scanSelectedLorebooks(allCharacterRepos)` (`index.js:6665-6693`).
   - It clears `scannedCharacters` and parses every non-disabled entry of the repos (`1148-1238`).
   - Parser `extractBunnyMoCharacters` / `parseBunnyMoTagBlock` (`789-882`):
     - **all** `<BunnymoTags>` blocks (exact case);
     - regex `<([^:>]+):([^>]+)>`;
     - **name and values upper-cased, `_` replaced by space**, values stored in a Set;
     - `<Name:>` required plus at least one other tag.
2. **On `WORLD_INFO_ACTIVATED`** (`6869-6953`):
   - If the last chat message contains `!fullsheet` etc., CK injects the sheet override and stops there.
   - Otherwise `processActivatedLorebookEntries` (`2583-2741`) runs.
   - It takes **only entries from Character Repos that ST actually activated** (`2615-2617`). CK does not scan the chat itself.
   - `extractCharacterDataFromEntry` (`2744-2818`):
     - **only the first** `<BunnyMoTags>` or `<BunnymoTags>` block (case-sensitive);
     - name from the comment (Baby Bunny pattern `2751`), overridden by `<Name:>` **with original case** (`2804-2806`);
     - values kept raw in arrays.
   - The result is written into `scannedCharacters` under `world::Name`. That key can differ in case from the scan-time key.
3. `injectCharacterData` (`1355-1546`):
   - limits to `maxCharactersDisplay`;
   - builds text from the "Character Data Injection" template (default `character_consistency` with `{{TRIGGERED_CHARACTER_TAGS}}`, `sheet-generator.js:191-208`, `972-990`), or from the fallback `[Character Consistency Data]`;
   - injects it with `/inject id=carrot-consistency position=chat ephemeral=true scan=true depth=… role=…` (`1482`). This is the **consistency slot** `script_inject_carrot-consistency`.
   - Tag-library entries that match a template get `carrot-tag-*` injections (`2466-2580`).
4. **The tag regex requires a colon** (`822`, `2787`), so **MBTI `<XXXX-H>` is invisible to CK.** It only reaches the model as raw archive text.

### 2.4 RAG pipeline
- **Detection** (`detectFullsheetInMessage`, `fullsheet-rag.js:3575-3646`):
  - message at least 1000 characters;
  - and either at least 2 headers matching `^#{0,2}\s*\S+\s+\d+\s*/\s*\d+`, or at least 3 `<K:V>` tags;
  - the name is suggested from the **first** `<K:V>` tag's value.
- **Vectorising:** auto on render only if the collection does not exist yet (`4035-4062`), or through the button with a `prompt()` for the name (`3736-3799`).
- **Chunking** (`chunkFullsheet`, `2299-2309`):
  - "simple": one chunk per `#`/`##` header (`2189-2289`);
  - default "math": `splitTextToSizedChunks(chunkSize 1000, overlap 300)`, chunks under 50 characters dropped (`2315-2367`);
  - `chunkFullsheetSectionBased` (`2373-2597`) is never called (dead code);
  - `excludeTagSynthesis` strips the TAG SYNTHESIS block (`2166-2184`);
  - hash = `getStringHash(name|…|text)`;
  - per-chunk keywords from English stop-words, stems and a keyword bank (`729-1100`, `1856-1995`).
- **Write** (`vectorizeFullsheetFromMessage`, `3808-3955`):
  - inserts only hashes that are new (`3843-3863`);
  - merges into `library[collectionId]` (`3872-3888`);
  - on first vectorisation sets `collectionMetadata.keywords = [characterName]` (`3899-3909`);
  - records `lastEmbeddingSource/Model`.
- **Query** (interceptor `4064-4158`):
  - skips `quiet` generations and runs only when `is_send_press`;
  - query = last `queryContext` (3) non-system messages (`3430-3470`);
  - **every collection in global, character and chat libraries is checked for activation**: `alwaysActive`, or **any trigger as a lower-case substring of the query** (`queryLower.includes(trigger)`, `3085-3095`);
  - then `/api/vector/query` with topK and threshold, crosslinks and keyword fallback (`3110-3415`);
  - injected with `setExtensionPrompt('carrotkernel_rag', …, IN_PROMPT, depth, role)` (`3482-3573`).

---

## 3. CK APIs, events and pitfalls

### 3.1 Callable surface
- **`window.CarrotKernel`** (`index.js:6518-6608`):
  - `scanSelectedLorebooks(names)` — re-parse repos; it clears the whole map first, so pass every repo;
  - `parseBunnymoTags(text)` — name only;
  - `openRepositoryManager`, `manualScan`, `showCharacterDetails`, `checkForCompletedSheets`, `openChunkVisualizer`, `open/closeLorebookConnector`, `openPackManager`, …
- **`window.CarrotTemplateManager`** (`sheet-generator.js:1503`):
  - `getTemplates`, `getPrimaryTemplateForCategory`, `getTriggeredCharacters` (`867-881`), `processMacros(text)` (`1478-1499`), `processTemplate` (`796-812`), `saveTemplate`, `macroProcessors`.
- **ES-module exports.** Import through the CK script URL, as DR `src/ck-adapter.js:221-275` does:
  - `carrot-state.js`: `scannedCharacters`, `characterRepoBooks`, `tagLibraries`, `getLastInjectedCharacters`, …
  - `sheet-generator.js`: `initializeSheetGenerator`, `generateTagSheet`, …
  - `fullsheet-rag.js`: `updateChunksInLibrary`, `chunkFullsheet`, `buildChunkMetadata`, `regenerateChunkKeywords`, … (`4234-4254`)
  - `index.js`: `wrapLorebookEntries`, `unwrapLorebookEntries` (`986`, `1065`).
- **`globalThis.CarrotKernelFullsheetRag`** (`fullsheet-rag.js:4213-4231`): `generateCollectionId`, `chunkFullsheet`, `collectionExists`, `queryRAG`, `vectorizeFullsheetFromMessage`, `getContextualLibrary`, `getAllContextualLibraries`, `deleteEntireCollection`, `purgeOrphanedVectors`, `apiInsertVectorItems`, `get/saveRAGSettings`.
- Also global: `window.CarrotPackManager` (`index.js:7094`), `window.CarrotDebug`, `window.carrotKernelRagInterceptor_CK` (`fullsheet-rag.js:4160`).
- **No custom events, no slash commands.** There is no `eventSource.emit` and no `registerSlashCommand` call in CK.
- **To observe CK,** listen to the same ST events and order your handlers with `makeFirst`/`makeLast`, as DR does. CK listens on `CHAT_CHANGED`, `CHARACTER_MESSAGE_RENDERED`, `WORLD_INFO_ACTIVATED` (`index.js:6659-6968`), plus RAG listeners (`fullsheet-rag.js:4000-4020`).
- **Repo detection:** read `extension_settings.CarrotKernel.characterRepoBooks` / `tagLibraries`, as DR `ck-adapter.js:185-189` (`ckMarkedBooks`) does.

### 3.2 Pitfalls (confirmed)
1. **Baby Bunny role 2:** `baby-bunny-mode.js:2246` and `:2299`. The batch path leaves ST defaults and does not register the repo (`1404-1448`; the only registration is `2349-2357`).
2. **`processTemplate` has side effects.** It increments `metadata.usage_count` and calls `saveTemplate`, which calls `saveSettingsDebounced`, for non-default templates (`sheet-generator.js:803-809`, `651-669`). Use `processMacros` instead; it has no side effects beyond `loadWorldInfo` inside `{{BUNNYMO_PACK_TAGS}}`.
3. **`initializeSheetGenerator(fn)` replaces the finder module-wide and cannot be undone** (`sheet-generator.js:24-34`). DES-RU already installs its own (`DR/src/modules/carrot-kernel.js:159-164`); a second extension calling it would clobber DES-RU's finder.
4. **Cyrillic names collapse.** `findCharacterByName` strips `[^\w\s]` / `[^a-zA-Z0-9\s]` (`index.js:1297`, `1301`, `1318`, `1322`), so every Cyrillic name becomes `""` and matches the first character.
5. **Two parsers with different normalisation** (scan `819-882` vs activation `2744-2818`). `scannedCharacters` can hold both `world::NAME` and `world::Name`. Activation reads only the first block per entry, so keep one character per entry and use exactly `<BunnymoTags>`.
6. **The dump is empty and pollutes saved chat.** It checks `values.size` but the tags are arrays (`3055`). It is appended to `message.mes` and saved (`3002`, `3018`), then `lastInjectedCharacters` is cleared (`3027`). Cards mode saves JSON system messages. Audit tools must strip both (DR `src/lib/carrot-data.js:68-132`).
7. **`scan=true` on the consistency injection never reaches a scan**, and its format is not `<K:V>` anyway.
8. **`bunnymoTagWrapping` rewrites lorebook files** with a `<BunnymoTags:Entry>` wrapper on Character Repo ↔ Tag Library toggles and on load, and creates `<name>.carrot_backup` lorebooks (`index.js:741-745`, `891-1143`, `9048-9090`). Never mark the core or pack lorebooks as Character Repos: the core's `<Name:NAME>` templates would be scanned as characters.
9. **CK's `WORLD_INFO_ACTIVATED` handler has no quiet-generation guard.** Any generation that activates World Info sets `lastInjectedCharacters` and writes `extra.carrot_character_data` onto the last user message (`2716-2723`). For LLM calls, prefer `generateRaw` or `ConnectionManagerRequestService` (LL `src/connection.js:41-79`).
10. **Baby Bunny auto-opens a popup on `CHARACTER_MESSAGE_RENDERED`** when `babyBunnyMode` is on (`index.js:6844-6857`). Do not post revised sheets into chat as AI messages.
11. **RAG pitfalls:**
    - re-vectorising never removes old chunks (`fullsheet-rag.js:3850-3888`);
    - auto-vectorise skips existing collections (`4046-4050`);
    - the UI delete removes the library and vectors but **leaves `collectionMetadata`** (`index.js:8908-8992`);
    - trigger matching is a raw substring;
    - the character-level library is keyed by `context.characterId`, i.e. the index into `characters[]`, which is fragile (`fullsheet-rag.js:114-119`, `709-714`);
    - the collection id depends on the current `contextLevel`, chat and character;
    - stop-words and stemming are English;
    - the model is not sent for OpenRouter (DR recon §9).
12. **`isValidCharacterName`** (`index.js:1245`) and `bunnymo_class.js` are dead code. A pack-update check runs 5 s after start (`index.js:7198-7203`).

---

## 4. What DES-RU already does (don't duplicate) and what is reusable

**Module 5, `DR/src/modules/bunnymo.js`.** Lorebook files are never modified.
- **Runtime World Info patches** on `WORLDINFO_ENTRIES_LOADED` (`156-181` → `src/lib/bunnymo-patch.js:107-153`):
  - Russian detector stems and anti-clanker keys (`src/lib/bunnymo-ru.js:17-64`);
  - `excludeRecursion` plus keys that do not match inside `<…>` (`regex-keys.js:95-105`);
  - `preventRecursion` on #25, #41, #64;
  - Russian Alpha text;
  - archetype line format `<NPC name="…">`;
  - Cyrillic archive keys widened to all case forms (`nameFormsKey`), skipping forms that are other people's names (`archiveFormsOf`, `patch:73-76`).
- **Language lock:** slot `desru_bunnymo_language` (IN_CHAT, depth 0, system), set in a `makeLast` `WORLD_INFO_ACTIVATED` handler when BunnyMo, archives or CK slots are active; never in quiet or dry runs (`188-265`).
- **Normalizer** on `MESSAGE_RECEIVED` (`makeFirst`) rewrites `message.mes` and the swipe: `SECTION N/M:`, `**Name:**`, Russian keys and values → English, wrappers, `</BunnymoTags>` case, sheet name → card name (`282-305`; `src/lib/bunnymo-normalize.js:109-229`).
- **Scene tags:** `chat_metadata.desru_bunnymo = {names[], tags[]}`, built from activated archives and including bare MBTI tags (`31`, `134-146`, `188-201`). The scan-only slot `desru_bunnymo_tags` (position NONE, scan=true) is refreshed on `GENERATION_STARTED`, so it lags one reply (`243-249`).
- **Warning** about outgoing-prompt regexes that strip `<…>` tags (`308-317`).

**Module 6, `DR/src/modules/carrot-kernel.js`:**
- installs a Unicode finder into CK (`127-164`);
- rebuilds the consistency text when names are Cyrillic and no template is used (`170-184`);
- **adds Russian case forms to `rag.collectionMetadata[id].keywords`** and records what it added in DES-RU's `ragFormsAdded` setting, so user removals are respected (`186-264`; runs on `GENERATION_STARTED` and `CHAT_CHANGED`);
- strips the CK dump from Chat Completion and Text Completion prompts (`273-325`);
- removes DES's false "import sheet" button and restores DES decorations (`331-385`);
- translates CK's UI.

**Module 2, `DR/src/modules/names.js`:**
- `rekeySheets` moves DES sheets saved under a name form, alias or full name to the card name; merges only when the import is newer (`541-581`, `592-614`; `src/des-adapter.js:398-442` `moveDesSheet`/`mergeDesSheets`).
- DES sheets live in `chat_metadata.dooms_tracker.characterSheets` (`des-adapter.js:238-248`, `1006-1037`).

**Reusable pure helpers.** All have Node tests in `DR/tests/*.test.js`; DES-RU is AGPL-3.0-or-later.

| File | Useful functions |
|---|---|
| `src/bunnymo-adapter.js` | `isBunnyMoCoreEntry`, `classifyWorlds`, `packVocabulary`, `isCharacterArchive` (rejects `NAME`/`BLANK` placeholders, `PLACEHOLDER_RE` `:56`), `archiveTags` (includes MBTI), `archiveNameWords` |
| `src/lib/bunnymo-normalize.js` | `normalizeMachineLayer`, `translateValue`/`resolveValue` (vocabulary + transliteration + same-stem), `extractTags`; `bunnymo-vocab.js` dictionaries |
| `src/lib/carrot-data.js` | `characterNameKey`, `findCharacter`, `ragTriggerForms`, `stripCarrotDumps`, `carrotDumpBodies` |
| `src/lib/regex-keys.js` | `isRegexKey`, `compileKey` (ST-compatible), `nameFormsKey`, `wordsKey`, `outsideTagsKey` |
| `src/lib/russian-names.js` | `wordForms`, `decideName`, `decideSheetOwner`, `bareSheetName` |
| `src/ck-adapter.js` | `inspectCk`/`createCkApi` (`ragCollections`, `scanned`, `lastInjected`, `consistencySlot`, `setConsistencyText`, `installFinder`), `ckMarkedBooks`, `hasCkSlots`, `CK_SLOTS`, `CK_RAG` |
| `src/name-context.js` | `canonicalCardName` |
| LL `src/lorebook.js` | `applyChanges` (re-load → modify → `saveWorldInfo(name, data, true)` → `reloadWorldInfoEditor`, `111-148`), `backupBook` (copy lorebook or downloaded JSON, `79-94`), mirroring to `originalData` |
| LL `src/entries.js` | provenance marker in `entry.extensions.lorebook_localizer` (`11-30`) |

---

## 5. Lore revision: how to update a character safely

**Identity — do not change casually.**
- `<Name:…>` is the identity used everywhere:
  - CK cacheKey `world::Name` and lookups;
  - `message.extra.carrot_character_data` in old messages;
  - the RAG collection id derived from the name;
  - the DES `characterSheets` key;
  - DES-RU's `archiveTags` / `isCharacterArchive`.
- For a new nickname or title, add it as an entry key and as a DES alias instead.
- If `<Name:>` must change, also migrate:
  - the RAG collection: delete it, re-vectorise, and copy `collectionMetadata` including DES-RU's `ragFormsAdded`;
  - the DES sheet: `moveDesSheet`;
  - and accept that old thinking blocks stop restoring.
- Also keep the lorebook name, the `uid`, and the exact `<BunnymoTags>` casing. Repo lists, `charLore`, chat lorebook links and `world::` keys all refer to them.

**Safe to edit:**
- `content` inside the block:
  - **Trigger-bearing categories** (SPECIES, DERE, GENRE, TRAIT, LING, BSM/MED/REC/CONDITION, MBTI `<XXXX-H|U>`): values must exist in the loaded pack vocabulary. Validate with `packVocabulary` plus the MBTI regex.
  - **Informational categories** (ATTACHMENT, CONFLICT, BOUNDARIES, TRUST, LOYALTY, CHEMISTRY, JEALOUSY, MASK, …): free to evolve. Only the model and CK read them.
  - Personality development maps naturally to MBTI health flips (`<INTJ-U>` → `<INTJ-H>`), TRAIT add/remove, and DERE or ATTACHMENT conversion.
- `content` outside the block: prose paragraphs (`<Linguistics>`, `<Genre>`, `<MentalHealth>`, …). CK ignores them; ST injects the whole entry.
- `key` / `keysecondary`: you can add triggers. Leave regex keys from LL and DES-RU alone; DES-RU widens only plain Cyrillic keys and only in memory.
- `constant`/`selective` (BunnyMo's README says main characters should be constant), `sticky`, `cooldown`, `probability`.
- `comment`: only used as a fallback name when there is no `<Name:>`.
- Flags (position, depth, role, scanDepth): change only as an explicit option, e.g. "fix role 2 → system" or "scanDepth 1 → default".

**Never write into a block:**
- `!updatesheet` transitional markup: `→`, `at 40%`, `FADING`, `STRENGTHENING`, `↔ with {{user}}` (template in core #6). Both the old and new tags would fire, and CK would keep both.
- Placeholders such as `BLANK` or `NAME`.
- Russian keys or values.
- Duplicate MBTI tags.
- Multiple character blocks in one entry.

Resolve to a clean final set and keep the trajectory as prose, or in your own `entry.extensions` record.

**Relationship changes.**
- BunnyMo has no "relationship with X" tag, and per-person qualifiers are lost by CK's parser (it captures only `<K:V>`).
- Keep relationship facts in a separate non-archive entry, or in prose outside the block, or in DES (Workshop relationship field / tracker).
- Adjust only the general-pattern tags.

**Write procedure.**
1. Load the lorebook fresh, back it up (LL pattern), and diff old vs new tags for user confirmation.
2. Save with `saveWorldInfo(name, data, true)`. The debounced save shares one timer and loses lorebooks in batches; see the comments at BB `1477-1480` and `2329-2336`.
3. Refresh CK with `window.CarrotKernel.scanSelectedLorebooks(extension_settings.CarrotKernel.characterRepoBooks)`.
4. If a fullsheet RAG collection exists, purge it with `CarrotKernelFullsheetRag.deleteEntireCollection` and delete the library entry the way `index.js:8930-8960` does. Then call `vectorizeFullsheetFromMessage(name, newSheet)` under the same chat/character context; `collectionMetadata` and its triggers survive. For targeted edits, use the ES export `updateChunksInLibrary` (`fullsheet-rag.js:512-617`).
5. Update the DES sheet through DES's own import; DES-RU then re-keys it.

**LLM step.**
- Run the analysis outside the chat (`generateRaw` or a Connection Manager profile) so that World Info, CK and Baby Bunny hooks do not fire.
- You can borrow core #6's "evolution analysis" rubric: STABLE / STRENGTHENING / WEAKENING / CONVERTING / EMERGING / REMOVED per tag.
- Feed it the allowed vocabulary, either from `packVocabulary` or `CarrotTemplateManager.processMacros('{{BUNNYMO_PACK_TAGS}}')` (keeping that macro's `key[0]` / last-pack-wins limitation in mind).
- Require a clean `<BunnymoTags>` output.
