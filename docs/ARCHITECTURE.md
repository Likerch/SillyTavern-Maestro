# Maestro — architecture and code conventions

This file is the contract for everyone writing Maestro code (humans and agents). The functional plan is
[`plan.md`](plan.md), the build order is [`dev-plan.md`](dev-plan.md), host facts are in [`research/`](research/).

## Layers

| Folder | Role | May import |
|---|---|---|
| `src/shared/` | `contracts.ts` (all service interfaces, `App`, `MaestroModule`) and constants | nothing |
| `src/domain/` | pure logic: no DOM, network, `SillyTavern`, `console` | `shared` |
| `src/host/` | the only door to SillyTavern: context, events with ordering, runtime imports of ST modules, capabilities, fetch gate | `shared`, `domain` |
| `src/core/` | services: settings, i18n, the story language, logger, files, chat store, leader, tasks, user jobs, LLM client, cost, journal, autonomy, inbox, ephemeral, bus, turn pipeline | `shared`, `domain`, `host` |
| `src/adapters/<id>/` | one neighbour extension each (des, desru, ck, bunnymo, qvink, nai, localizer, preset, dramatis) | `shared`, `domain`, `host`, `core` |
| `src/ui/` | generic components, the windows shell (side panels, floating windows, menu), styles | `shared`, `domain`, `host`, `core` |
| `src/features/<key>/` | modules M1–M35 | everything except `app` |
| `src/app/` | wiring: builds the `App`, registers modules, lifecycle; `MAESTRO_API` for neighbours (`public-api.ts`, docs/integration-dramatis.md) | everything |

ESLint enforces these zones (`npm run lint`).

## Modules

Every plan module is a `MaestroModule` (see `src/shared/contracts.ts`) in `src/features/<key>/index.ts`:

```ts
export const loreJournal: MaestroModule<LoreJournalSettings> = {
    id: 'M1', key: 'loreJournal', stage: 1, titleKey: 'm1.title', enabledByDefault: true,
    defaults: () => ({ keepTurns: 200 }),
    requires: ['st.events.scanDone'],
    i18n: { en: {...}, ru: {...} },
    init({ app, settings, log, own }) { own(app.host.events.on('...', handler)); },
};
```

Rules:
- **Everything a module registers must be released when it is disabled.** Wrap every listener, tab, style,
  slash command, injection producer and timer with `own(...)`. A disabled module leaves no trace (P11).
- Modules talk to each other only through `app.modules.expose(key, api)` / `app.modules.api<T>(key)` or the
  Maestro bus (`app.bus`). No imports of another feature's internals; a feature may import another feature's
  `api.ts` *types* only.
- Settings slice: `defaults()` returns the full slice; stored at `extensionSettings.maestro.modules[key]`.
  Never store large data in settings — use `app.chat` (per-chat documents) or `app.files`.
- Strings: every user-visible string goes through `app.i18n.t('m1.something')`. Keys are prefixed by module id
  in lower case (`m1.`, `m22.`), core uses `core.`, ui uses `ui.`. Provide both `en` and `ru` (Russian is the
  primary UI language; write natural Russian, no calques). The user is male: address him with masculine or
  neutral forms.
- No direct `SillyTavern.getContext()` outside `src/host`; use `app.host.ctx()`. Never cache the context
  object (it is rebuilt on every call; `chatMetadata` is reassigned on chat load).
- ST modules not exposed in the context are loaded through `app.host.modules.*` and must be guarded by a
  capability (`app.host.caps.register(id, probe)`), so a different ST version degrades instead of crashing.
- Autonomy: any change to user-visible data goes through `app.autonomy.decide(proposal, defaultLevel)` and is
  recorded in `app.journal` with an undo handler for its target type.
- What the user reads (plan-2 §3): every action kind passed to autonomy / the Inbox / the journal has a human label
  `kind.<kind>` (en + ru), and every journal target is described in `MaestroModule.targets` (`target.<target>` label,
  human field labels and value formatters from `src/core/labels.ts`; ids, keys, tags and English canon text are
  `hidden`/`technical`). Card titles and descriptions use story words; technical notes go to `Proposal.details`
  («Подробнее»). `tests/app/labels-static.test.ts` fails for an unlabelled kind or an undescribed undo target.
- Notices: `app.ui.notice(text, { importance, group, groupText, action })`. Background news is `info` (a 5 s toast at
  the default level «Всё»), what needs attention `important`, replies to the user's own click `urgent: true`. Repeated
  notices of one turn share a `group`. Automatic actions get a «Сделал: …» toast with undo from autonomy; give
  proposals that read badly after «Сделал:» an `appliedNotice` in the past tense.
- The strip under chat messages (plan-2 §5, src/ui/views/message-strip.ts): a module shows lines under a message with
  `own(app.ui.addMessageStripProvider?.({ id, order, items(messageIndex), onChange }))` — items derived from a stored
  document (they come back after a reload and go once decided), cheap `items()` (called on every repaint of that
  message), `onChange(indexes)` naming the messages whose items changed. Kinds `proposal`/`question` wait for a decision
  (the setting «только то, что ждёт решения»). Display only: never the message text, the prompt or Qvink memory.
  `app.ui.messageBadge` adds a memory-only line (gone after a reload).
- Ephemeral prompt changes (flags, injections) go through `app.ephemeral`; they are cleared after every
  generation.
- Windows (plan-2 §10, src/ui/windows): there is no modal pult. A module adds a section with `app.ui.addTab(tab)`
  (`PultTab.group` or the central map in src/ui/views/pult-groups.ts decides its window: Ассистент, Входящие,
  Персонажи, Механики, Мир, Канон, Ход, Здоровье, else «Maestro»), or a window of its own with
  `own(app.ui.addWindow({ id, titleKey, icon, order, render(container, ctx), canClose?, hidden?, defaultDock? }))`
  (the studios). Sections render lazily and must give back what they borrow in their cleanup (it runs when the section
  is switched, hidden, collapsed or closed). `openPult(tab)` opens the tab's window on that section; `closePult()`
  only makes room for the chat (closes the visible window on a phone); close a window with `closeWindow(id)`. A
  module's own settings inside its section go into `moduleSettingsSection()` (components/card.ts): the window's gear
  shows them.
- Long jobs the user starts himself (localize a book …) run through `app.jobs` (core/jobs.ts): one job per key,
  progress and «Stop», visible in the Tasks tab and as a ring on the top-bar icon; the view that started it draws
  its state from the job, so closing and reopening it loses nothing. Background work stays in `app.tasks`.
- The story language («Язык истории», 1.20): whatever Maestro writes in the story's language for the player (prepared
  names and texts, DES seeds, the recap, the format hint) asks `storyLanguage(app)` (core/language.ts: the core
  setting, else the player's messages, else the interface language), never its own script detector. Detectors that
  must follow the words actually written (chronicle keys) stay on the chat.
- Performance: nothing heavy on the send path (P15). Listeners on `WORLDINFO_ENTRIES_LOADED` /
  `WORLDINFO_SCAN_DONE` must be idempotent and cheap; cache by entry hash.

## Neighbour rules (from plan §10, summarised)

- Interceptor: never `structuredClone` prompt entries, never mutate shared `extra` in place — copy
  (`{...entry, extra: {...entry.extra}}`) and keep symbol keys.
- Do not take first place on `MESSAGE_RECEIVED`; Maestro's reply handling runs after DES, DES-RU and NAI Studio
  (use `app.bus` event `reply:ready`).
- WI copies in scan events: assign new values, never mutate nested arrays (`key`, `keysecondary`,
  `characterFilter`, `triggers`) — they alias ST's cache.
- Lorebook writes: `saveWorldInfo(name, data, true)` only, then `reloadWorldInfoEditor(name)` and reset DES
  Lore Library cache (adapter `des.invalidateLoreCache(name)`).
- Never call CarrotKernel `initializeSheetGenerator`. Never rename `<Name:…>` in archives.
- Never write DES stores while `#character-workshop-popup.is-open`.
- `nai_studio` card field: merge only, keep passport ids.
- Never use `/bg`; never toggle neighbour settings for quiet modes — suppress at prompt assembly instead.
- BunnyMo packs: never edit files, never add Russian keys, only technical runtime fixes (P13).
- Style neighbour DOM only with stylesheets (never inline styles on DES nodes).

## Tests

- `tests/domain/**` — unit tests for `src/domain` (coverage ≥ 90 %).
- `tests/core/**`, `tests/features/**` — integration with the ST mock in `tests/helpers/st-mock.ts`
  (happy-dom when DOM is needed: `// @vitest-environment happy-dom`).
- `tools/mock-llm` + `tools/stand` — live checks on a local SillyTavern 1.19 (see dev-plan §2).

## Style

TypeScript strict, 4 spaces, single quotes, 120 columns (Prettier). Comments explain *why* (host quirks,
ordering constraints) with references to `docs/research/*.md` where useful. File names kebab-case.
CSS classes prefixed `maestro-`; CSS custom properties `--maestro-*`.

## Commits

Authored by the repository owner only (git config), short English messages, no AI attribution lines.
One commit per stage at minimum (`Stage N: …`), tag `stage-N`.
