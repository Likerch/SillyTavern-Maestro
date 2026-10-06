// Knowledge base of the assistant (M33): one topic per Maestro module — what it does, where it lives in the pult and
// where its settings are, common questions and the assistant tools that read it. Hand-written, English and Russian.
// Module on/off switches are always in Settings → Modules; the windows are those of src/ui/windows/builtin.ts (by the
// groups of src/ui/views/pult-groupsts.
import type { DocTopic } from '../../../../domain/assistant-docs';

interface ModuleDoc {
    key: string;
    id: string;
    keywords: string[];
    en: [title: string, text: string];
    ru: [title: string, text: string];
}

const MODULES: readonly ModuleDoc[] = [
    {
        key: 'loreJournal',
        id: 'M1',
        keywords: ['lore', 'лор', 'worldinfo', 'activation', 'сработал', 'ключ', 'key', 'recursion', 'рекурсия'],
        en: [
            'Lore journal (M1)',
            "Records which lorebook entries reached the prompt on every turn and why: the key that matched, recursion (which entry pulled which), constant entries, entries cut by the budget or by a Maestro rule, why a book is active (global, character, chat, persona, DES campaign, CK). «What if» runs a dry scan without generating.\nWhere: the «Turn» window → «Turn lore».\nQuestions: why did/didn't an entry fire, which entries eat the budget, which entries never fire.\nTools: lore_turn (with name for «why did X not …»), lore_entry, lore_search.",
        ],
        ru: [
            'Журнал лора (M1)',
            'Записывает, какие записи лорбуков ушли в промпт на каждом ходу и почему: какой ключ совпал, рекурсия (какая запись подтянула какую), постоянные записи, срезанные бюджетом или правилом Maestro, почему книга активна (глобально, карточка, чат, персона, кампания DES, CK). «Что если» — пробное сканирование без генерации.\nГде: окно «Ход» → «Лор хода».\nВопросы: почему запись сработала или нет, какие записи съедают бюджет, какие не срабатывают никогда.\nИнструменты: lore_turn (с name для «почему X не …»), lore_entry, lore_search.',
        ],
    },
    {
        key: 'inspector',
        id: 'M2',
        keywords: ['prompt', 'промпт', 'tokens', 'токены', 'weight', 'вес', 'sources', 'источники'],
        en: [
            'Turn inspector (M2)',
            'Shows what the prompt of each turn was made of: preset blocks, card, lore by book, neighbour injections (DES, CK, Qvink, NAI Studio, DES-RU, Maestro), chat history, with token weights (reconstructed: ST glues injections of the same depth). Rules of the architect show their before/after here.\nWhere: the «Turn» window → «Turn prompt».\nQuestions: why is the prompt so big, which extension adds the most, where did history go.\nTools: turn_prompt, cost_turn.',
        ],
        ru: [
            'Инспектор хода (M2)',
            'Показывает, из чего собран промпт каждого хода: блоки пресета, карточка, лор по книгам, вставки соседей (DES, CK, Qvink, NAI Studio, DES-RU, Maestro), история чата — с весом в токенах (восстановленным: ST склеивает вставки одной глубины). Правила архитектора показывают здесь «до и после».\nГде: окно «Ход» → «Промпт хода».\nВопросы: почему промпт такой большой, какое расширение добавляет больше всех, куда делась история.\nИнструменты: turn_prompt, cost_turn.',
        ],
    },
    {
        key: 'medic',
        id: 'M3',
        keywords: ['health', 'здоровье', 'tracker', 'трекер', 'prefill', 'repair', 'ремонт', 'des json'],
        en: [
            'Medic (M3)',
            "Checks the neighbours after every reply: the DES tracker JSON is present and valid (repairs it through DES's own update path, or the cheap model as a fallback), DES/Qvink/lore health, and warns about an assistant-role prefill (DeepSeek through OpenRouter turns it into code-like replies).\nWhere: the «Health» window → «Health» (checks with «Fix» buttons).\nQuestions: the tracker did not update, «нет трекера DES», odd replies after a prefill.\nTools: maestro_health.",
        ],
        ru: [
            'Медик (M3)',
            'Проверяет соседей после каждого ответа: есть ли и цел ли JSON трекера DES (чинит через собственный путь обновления DES, запасной путь — дешёвая модель), здоровье DES, Qvink и лора; предупреждает о prefill с ролью assistant (DeepSeek через OpenRouter отвечает «кодом»).\nГде: окно «Здоровье» → «Здоровье» (проверки с кнопкой «Исправить»).\nВопросы: трекер не обновился, нет трекера DES, странные ответы после prefill.\nИнструменты: maestro_health.',
        ],
    },
    {
        key: 'guardian',
        id: 'M4',
        keywords: ['guardian', 'страж', 'baseline', 'эталон', 'drift', 'дрейф', 'tab', 'вкладка', 'stale'],
        en: [
            'Settings and tab guardian (M4)',
            'Keeps a baseline of tracked ST settings and the active preset; drift (something changed outside Maestro) goes to the Inbox with «restore». The tab guard stops a stale browser tab (another tab or device saved later) from overwriting settings, presets and lorebooks.\nWhere: the «Health» window → «Guardian».\nQuestions: settings rolled back by themselves, «вкладка устарела», what changed since the baseline.\nTools: maestro_health (tab state), journal_recent, inbox_list.',
        ],
        ru: [
            'Страж настроек и вкладок (M4)',
            'Держит эталон отслеживаемых настроек ST и активного пресета; дрейф (что-то изменилось мимо Maestro) приходит во «Входящие» с возможностью вернуть. Страж вкладок не даёт устаревшей вкладке (другая вкладка или устройство сохранили позже) перезаписать настройки, пресеты и лорбуки.\nГде: окно «Здоровье» → «Страж».\nВопросы: настройки откатились сами, «вкладка устарела», что изменилось с эталона.\nИнструменты: maestro_health (состояние вкладки), journal_recent, inbox_list.',
        ],
    },
    {
        key: 'doctor',
        id: 'M5',
        keywords: ['doctor', 'доктор', 'regex', 'регекс', 'findings', 'находки', 'packs', 'паки', 'keys', 'ключи'],
        en: [
            'Doctor (M5)',
            'Scans the active lorebooks and all regex scripts: duplicate and conflicting BunnyMo packs, recursion chains and «vacuum» entries, assistant role at depth, CK archive problems, keys without Russian forms, Cyrillic whole-word keys, budget overflow; regexes that break the DES JSON or NAI markers, strip BunnyMo tags, duplicates, dead and conflicting scripts. «Fix in file» for your own books (never BunnyMo packs) and regex treatment, all undoable. Regex test bench.\nWhere: the «Health» window → «Doctor».\nQuestions: what is wrong with my lore/regexes, why tags disappear from sheets.\nTools: regex_list, regex_explain, regex_test, maestro_health.',
        ],
        ru: [
            'Доктор (M5)',
            'Проверяет активные лорбуки и все регексы: дубли и конфликты паков BunnyMo, цепочки рекурсии и записи-«пылесосы», роль assistant на глубине, проблемы архивов CK, ключи без русских форм, кириллица с «целыми словами», переполнение бюджета; регексы, которые ломают JSON DES или маркеры NAI, срезают теги BunnyMo, дубли, мёртвые и конфликтующие. «Исправить в файле» для твоих книг (паки BunnyMo — никогда) и лечение регексов, всё с откатом. Испытание регексов.\nГде: окно «Здоровье» → «Доктор».\nВопросы: что не так с моим лором и регексами, почему пропадают теги в листах.\nИнструменты: regex_list, regex_explain, regex_test, maestro_health.',
        ],
    },
    {
        key: 'rules',
        id: 'M22',
        keywords: ['rules', 'правила', 'on the fly', 'на лету', 'qvink gaps', 'дыры', 'cyrillic', 'кириллица', 'cap'],
        en: [
            'Rules on the fly (M22)',
            'Fixes known corners of the stack at every scan without editing files: assistant role → system, book cap and recursion limit, byte-identical pack duplicates, pack version conflicts, Cyrillic keys and whole words (left boundary only), Qvink «gaps» (messages dropped before they were summarised), NAI picture posts in Qvink, visible BunnyMo tags, <NSFW> in archives, CK archive depth, DES portrait bar on phones. Each rule can be switched off and shows its effect in the turn inspector.\nWhere: the «Health» window → «Rules».\nTools: maestro_settings(rules), turn_prompt.',
        ],
        ru: [
            'Правила на лету (M22)',
            'Чинят известные «углы» стека при каждом сканировании, не правя файлы: роль assistant → system, потолок книги и лимит рекурсии, побайтные дубли паков, конфликт версий паков, кириллица и «целые слова» (граница только слева), «дыры» Qvink (сообщения выпали из промпта до пересказа), посты-картинки NAI в Qvink, видимые теги BunnyMo, <NSFW> в архивах, глубина архивов CK, полоса портретов DES на телефоне. Каждое правило выключается отдельно и показывает эффект в инспекторе хода.\nГде: окно «Здоровье» → «Правила».\nИнструменты: maestro_settings(rules), turn_prompt.',
        ],
    },
    {
        key: 'scenarios',
        id: 'M34s',
        keywords: ['scenario', 'сценарий', 'impersonate', 'continue', 'продолжение', 'перевоплощение'],
        en: [
            'Generation scenarios (M34s)',
            'Own prompt assemblies for special generations without switching the preset: Maestro replaces the prompt messages right before sending and sets the parameters of that request only. The first scenario is BunnyMo sheets; impersonate and continue can get their own parameters (off by default).\nWhere: Preset Studio → «Parameters» / scenarios.\nTools: preset_blocks, docs_read(module.sheets).',
        ],
        ru: [
            'Сценарии генерации (M34s)',
            'Свои сборки промпта для особых генераций без переключения пресета: Maestro заменяет сообщения промпта прямо перед отправкой и задаёт параметры только этого запроса. Первый сценарий — листы BunnyMo; для перевоплощения и продолжения можно задать свои параметры (выключено по умолчанию).\nГде: Пресет-студия → «Параметры» / сценарии.\nИнструменты: preset_blocks, docs_read(module.sheets).',
        ],
    },
    {
        key: 'sheets',
        id: 'M31',
        keywords: ['sheet', 'лист', 'bunnymo command', 'команда', 'character sheet', 'лист персонажа', 'collapse'],
        en: [
            'Character sheets (M31)',
            'A BunnyMo sheet command in your message is generated with its own prompt (no scene tail, no DES tracker), the sheet is collapsed in the chat and leaves the prompt after the next turn. CarrotKernel captures it as usual.\nQuestions: the sheet came out as a scene, the tracker got into the sheet, the sheet clutters the prompt.\nTools: docs_read(stack.bunnymo), maestro_settings(sheets).',
        ],
        ru: [
            'Листы персонажей (M31)',
            'Команда листа BunnyMo в твоём сообщении генерируется своей сборкой промпта (без хвоста сцены и трекера DES), лист сворачивается в чате и уходит из промпта после следующего хода. CarrotKernel захватывает его как обычно.\nВопросы: лист вышел сценой, в лист попал трекер, лист засоряет промпт.\nИнструменты: docs_read(stack.bunnymo), maestro_settings(sheets).',
        ],
    },
    {
        key: 'wizard',
        id: 'W1',
        keywords: ['wizard', 'мастер', 'first run', 'первый запуск', 'setup', 'настройка'],
        en: [
            'First-run wizard (W1)',
            'Opens after installation: checks the stack, connection profiles for background tasks, the mode, the lore and background choices, the macro engine for {{if}}. Can be run again from Settings → Data → «Run the first-run wizard again».',
        ],
        ru: [
            'Мастер первого запуска (W1)',
            'Открывается после установки: проверяет стек, профили подключения для фоновых задач, режим, выбор по лору и фонам, движок макросов для {{if}}. Запускается снова из Настройки → Данные → «Запустить мастер первого запуска снова».',
        ],
    },
    {
        key: 'bookRoles',
        id: 'M35r',
        keywords: ['book roles', 'роли книг', 'bunnymo pack', 'пак', 'archive', 'архив', 'read-only'],
        en: [
            'Book roles (M35r)',
            "Knows what each lorebook is: BunnyMo core and packs (read-only, never edited — P13), CK archive repository, world, card, NPC, chat canon, Maestro books, chat/persona books, backups. Detected by content and the neighbours' settings; you can set a role by hand in the Lore Studio. Also keeps Maestro's metadata of base-book entries (type, passport) outside the files.\nWhere: Lore Studio → books.\nTools: lore_entry (shows the book role), lore_search.",
        ],
        ru: [
            'Роли книг (M35r)',
            'Знает, что за книга перед ним: ядро и паки BunnyMo (только чтение, никогда не правятся — P13), репозиторий архивов CK, мир, карточка, NPC, канон чата, книги Maestro, книги чата и персоны, резервные копии. Определяется по содержимому и настройкам соседей; роль можно задать вручную в Лор-студии. Здесь же метаданные Maestro о записях базовых книг (тип, паспорт) — вне файлов.\nГде: Лор-студия → книги.\nИнструменты: lore_entry (показывает роль книги), lore_search.',
        ],
    },
    {
        key: 'canon',
        id: 'M6',
        keywords: ['canon', 'канон', 'override', 'переопределение', 'suppress', 'подавление', 'pin', 'закрепление'],
        en: [
            'Chat canon (M6)',
            "Story changes live in a separate lorebook of the chat («Maestro · канон · …»), never in your books: overrides (replace a base entry's text for this chat), suppressions, pins (force an entry in), additions. Canon entries are English with Russian keys; a canon budget, archive of dormant items, drift of the base, «make canon for all chats» (asks), export as a plain book, branches follow the journal.\nWhere: the «Canon» window → «Canon».\nQuestions: why the character still remembers the old fact (check the override), what the canon says about X.\nTools: canon_list, lore_turn, dossier.",
        ],
        ru: [
            'Канон чата (M6)',
            'Изменения сюжета живут в отдельном лорбуке чата («Maestro · канон · …»), а не в твоих книгах: переопределения (заменить текст записи базы для этого чата), подавления, закрепления (принудительно включить запись), добавления. Записи канона — на английском с русскими ключами; бюджет канона, архив спящих, слежение за базой, «сделать каноном для всех чатов» (с вопросом), экспорт обычной книгой, ветки по журналу.\nГде: окно «Канон» → «Канон».\nВопросы: почему персонаж помнит старый факт (проверь переопределение), что канон говорит о X.\nИнструменты: canon_list, lore_turn, dossier.',
        ],
    },
    {
        key: 'loreStudio',
        id: 'M23',
        keywords: [
            'lore studio',
            'лор-студия',
            'lorebook editor',
            'редактор лорбуков',
            'entries',
            'записи',
            'des campaigns',
        ],
        en: [
            'Lore Studio (M23)',
            "Maestro's lorebook editor next to ST's window: books by role, every field and action of the native editor, the chat canon next to the base, version history per entry, Russian keys (Localizer), DES campaigns and auto-linking, entry types (place, mechanic, tradition…) and passports. Can take over the «Worlds/Lorebooks» button (setting).\nWhere: the «Maestro» window → «Lore Studio» (opens its own window).\nTools: lore_search, lore_entry.",
        ],
        ru: [
            'Лор-студия (M23)',
            'Редактор лорбуков Maestro рядом со штатным окном: книги по ролям, все поля и действия штатного редактора, канон чата рядом с базой, история версий каждой записи, русские ключи (Localizer), кампании и автопривязка DES, типы записей (место, механика, традиция…) и паспорта. Может забрать кнопку «Миры и лорбуки» (настройка).\nГде: окно «Maestro» → «Лор-студия» (открывает своё окно).\nИнструменты: lore_search, lore_entry.',
        ],
    },
    {
        key: 'places',
        id: 'M24',
        keywords: ['places', 'места', 'location', 'локация', 'visits', 'визиты', 'nesting'],
        en: [
            'Places (M24)',
            "The chat's place registry from the DES location: a new name becomes a place after two turns in a row; nesting (city → district → building → room), aliases with case forms, visit history (who was there, when), a description entry of type «place» in the canon, state and background (stage 10). NAI Studio keeps location continuity by place id.\nWhere: the «World» window → «Places».\nTools: places_current, dossier.",
        ],
        ru: [
            'Места (M24)',
            'Реестр мест чата по локации DES: новое название становится местом, если продержалось два хода подряд; вложенность (город → район → здание → комната), алиасы с падежами, история визитов (кто был и когда), описание — запись типа «место» в каноне, состояние и фон (этап 10). NAI Studio держит непрерывность локаций по id места.\nГде: окно «Мир» → «Места».\nИнструменты: places_current, dossier.',
        ],
    },
    {
        key: 'world',
        id: 'M7w',
        keywords: [
            'world model',
            'модель мира',
            'entity',
            'сущность',
            'alias',
            'алиас',
            'merge',
            'склейка',
            'identity',
        ],
        en: [
            'World model (M7w)',
            'Every character, persona and place of the stack as one entity: cards, DES cast, DES and DES-RU aliases, case forms, NAI passports, CK archives, typed lore entries, canon and places. One person under different names is glued together; doubtful matches go to the Inbox. Chat-only nicknames.\nWhere: the «World» window → «World».\nTools: dossier (resolves any name or case form).',
        ],
        ru: [
            'Модель мира (M7w)',
            'Каждый персонаж, персона и место стека — одной сущностью: карточки, состав DES, алиасы DES и DES-RU, падежи, паспорта NAI, архивы CK, записи лорбуков с типом, канон и места. Одно лицо под разными именами склеивается; сомнительные совпадения — во «Входящих». Прозвища, действующие только в этом чате.\nГде: окно «Мир» → «Мир».\nИнструменты: dossier (узнаёт любое имя и падеж).',
        ],
    },
    {
        key: 'relations',
        id: 'M19',
        keywords: ['relations', 'отношения', 'relationship', 'graph', 'граф', 'attitude'],
        en: [
            'Relationships (M19)',
            "How characters relate to your persona (and to each other), turn by turn, from the DES tracker's relationship status and canon facts; the history is kept per chat. Voice cards use it.\nWhere: the «World» window → «Relationships».\nTools: relations.",
        ],
        ru: [
            'Граф отношений (M19)',
            'Как персонажи относятся к твоей персоне (и друг к другу), ход за ходом — по статусу отношений в трекере DES и фактам канона; история хранится по чату. Ею пользуются голосовые карточки.\nГде: окно «Мир» → «Отношения».\nИнструменты: relations.',
        ],
    },
    {
        key: 'dossier',
        id: 'M7',
        keywords: ['dossier', 'досье', 'character page', 'страница персонажа', 'spread', 'разнести', 'appearance'],
        en: [
            'Dossier (M7)',
            "One page per entity with everything the stack knows: DES, lore, canon, CK archive and tags, NAI passport (with this chat's changes), case forms, Qvink memories, RAG, the last sheet. Structural checks (no entry, passport or archive; an alias is not a key; names disagree), an AI appearance comparison on demand, «Spread» an edit to every store, «Make up» a new NPC in one click. Command /maestro-dossier.\nWhere: the «Characters» window → «Dossier».\nTools: dossier, wardrobe, relations, knowledge_who.",
        ],
        ru: [
            'Досье (M7)',
            'Одна страница на сущность со всем, что знает стек: DES, лор, канон, архив CK и теги, паспорт NAI (с изменениями этого чата), падежи, воспоминания Qvink, RAG, последний лист. Сверка структуры (нет записи, паспорта или архива; алиас не стал ключом; имена расходятся), сверка внешности ИИ по кнопке, «Разнести» правку по хранилищам, «Оформить» нового NPC одной кнопкой. Команда /maestro-dossier.\nГде: окно «Персонажи» → «Досье».\nИнструменты: dossier, wardrobe, relations, knowledge_who.',
        ],
    },
    {
        key: 'bunnymoMode',
        id: 'M35b',
        keywords: ['bunnymo mode', 'режим bunnymo', 'tags', 'теги', 'dictionary', 'словарь', 'packs per chat', 'паки'],
        en: [
            'BunnyMo mode (M35b)',
            'The tag dictionary of all packs (conflicts, duplicates, tags without a pack), packs per chat (all or a choice), comparing a pack with a new file, integrity check, a sheet editor for CK archives. Pack files are never changed. Command /maestro-bunnymo.\nWhere: the «Characters» window → «BunnyMo».\nTools: docs_read(stack.bunnymo).',
        ],
        ru: [
            'Режим BunnyMo (M35b)',
            'Словарь тегов всех паков (конфликты, дубли, теги без пака), паки по чатам (все или выбор), сравнение пака с новым файлом, проверка целостности, редактор листов архивов CK. Файлы паков не меняются никогда. Команда /maestro-bunnymo.\nГде: окно «Персонажи» → «BunnyMo».\nИнструменты: docs_read(stack.bunnymo).',
        ],
    },
    {
        key: 'signals',
        id: 'S4',
        keywords: ['signals', 'сигналы', 'commit', 'фиксация', 'turn committed', 'changes'],
        en: [
            'Turn signals (S4)',
            'When you send a message the previous reply is final: Maestro compares its DES tracker and Qvink memory with the turn before (no AI) — relationship, lasting appearance, place, time skip, scene end, quests, who came and left, new aliases and names, memories. Free text counts only after holding two turns; a swipe or an edit undoes exactly what that reply gave. Signals feed the revision.\nWhere: the «Canon» window → «Signals».',
        ],
        ru: [
            'Сигналы хода (S4)',
            'Когда ты отправляешь сообщение, прошлый ответ становится окончательным: Maestro без ИИ сравнивает его трекер DES и память Qvink с ходом раньше — отношения, стойкая внешность, место, пропуск времени, конец сцены, квесты, кто пришёл и ушёл, новые алиасы и имена, воспоминания. Свободный текст засчитывается, только продержавшись два хода; свайп и правка откатывают ровно то, что дал ответ. Сигналы питают ревизию.\nГде: окно «Канон» → «Сигналы».',
        ],
    },
    {
        key: 'contradictions',
        id: 'M26c',
        keywords: ['contradictions', 'противоречия', 'conflict', 'конфликт', 'check'],
        en: [
            'Contradiction check (M26c)',
            'Shared service for the revision and the living canon: rules first (names, numbers, dates, negations), the cheap model only when unsure. A conflict becomes an Inbox card instead of a silent overwrite.',
        ],
        ru: [
            'Проверка противоречий (M26c)',
            'Общий сервис для ревизии и живого канона: сначала правила (имена, числа, даты, отрицания), дешёвая модель — только при сомнении. Конфликт становится карточкой во «Входящих», а не тихой перезаписью.',
        ],
    },
    {
        key: 'revision',
        id: 'M8',
        keywords: ['revision', 'ревизия', 'story to canon', 'сюжет канон', 'maestro-revise', 'inbox cards'],
        en: [
            'Revision «story → canon» (M8)',
            'On signals, every N messages, at a scene end or by /maestro-revise, the cheap model looks at what changed about KNOWN characters and places and proposes updates to the owner: chat canon, CK archive tags (dictionary only), NAI chat-level passport, chat nicknames, place registry; outfits, promises and secrets go to their modules. Proposals go through the autonomy levels and the Inbox.\nWhere: the «Canon» window → «Revision».\nTools: inbox_list, journal_recent.',
        ],
        ru: [
            'Ревизия «сюжет → канон» (M8)',
            'По сигналам, раз в N сообщений, в конце сцены или командой /maestro-revise дешёвая модель смотрит, что изменилось у ИЗВЕСТНЫХ персонажей и мест, и предлагает обновить владельца: канон чата, теги архива CK (только из словаря), паспорт NAI уровня чата, прозвища чата, реестр мест; наряды, обещания и секреты уходят своим модулям. Предложения идут по уровням автономии и через «Входящие».\nГде: окно «Канон» → «Ревизия».\nИнструменты: inbox_list, journal_recent.',
        ],
    },
    {
        key: 'livingCanon',
        id: 'M26',
        keywords: ['living canon', 'живой канон', 'provisional', 'пробный', 'invented', 'придумал', 'tradition'],
        en: [
            'Living canon (M26)',
            'What the model invented (a holiday, a tavern, a family history) becomes a provisional canon entry with Russian keys after the turn is committed; it is confirmed only if you mention or accept it, if it resurfaces unprompted, or after 10 turns without contradictions. A swipe removes the provisional, confirmed stays.\nWhere: the «Canon» window → «Living canon».\nTools: canon_list(status=provisional).',
        ],
        ru: [
            'Живой канон (M26)',
            'То, что придумала модель (праздник, таверна, история рода), после фиксации хода становится пробной записью канона с русскими ключами; подтверждается, только если ты сам это упомянул или принял, если оно всплыло снова без подсказки или продержалось 10 ходов без противоречий. Свайп убирает пробное, подтверждённое остаётся.\nГде: окно «Канон» → «Живой канон».\nИнструменты: canon_list(status=provisional).',
        ],
    },
    {
        key: 'chronicle',
        id: 'M9',
        keywords: ['chronicle', 'летопись', 'memory', 'память', 'recap', 'ранее в истории', 'chapters', 'главы'],
        en: [
            'Chronicle and auto-memory (M9)',
            'Qvink memories that fall out of the long memory become canon chapters (fire on two keys at once); important moments get the «remember» mark in every swipe; «Previously…» after a break (for you only by default, not in the prompt).\nWhere: the «Canon» window → «Chronicle».\nTools: canon_list, docs_read(stack.qvink).',
        ],
        ru: [
            'Летопись и автопамять (M9)',
            'Воспоминания Qvink, выпавшие из долгой памяти, становятся главами канона (срабатывают по двум ключам сразу); важные моменты сами получают отметку «запомнить» во всех свайпах; «Ранее в истории…» после перерыва (по умолчанию только для тебя, не в промпт).\nГде: окно «Канон» → «Летопись».\nИнструменты: canon_list, docs_read(stack.qvink).',
        ],
    },
    {
        key: 'metrics',
        id: 'M21m',
        keywords: ['metrics', 'замеры', 'criteria', 'критерии', 'latency', 'задержка', 'report'],
        en: [
            'Measurements (M21m)',
            "How Maestro meets the criteria of the first full version on live play: Maestro's delay before the request, background spend share, lore per turn (with a what-if), dropped messages, entry roles, tabs, revision, living canon, sheets, untouched pack files. Export as JSON/Markdown.\nWhere: the «Health» window → «Measurements».",
        ],
        ru: [
            'Замеры (M21m)',
            'Как Maestro выполняет критерии первой полной версии в живой игре: задержка Maestro до запроса, доля фоновых расходов, лор на ход (с «что если»), выпавшие сообщения, роли записей, вкладки, ревизия, живой канон, листы, нетронутые файлы паков. Экспорт в JSON/Markdown.\nГде: окно «Здоровье» → «Замеры».',
        ],
    },
    {
        key: 'presetStudio',
        id: 'M34',
        keywords: [
            'preset studio',
            'пресет-студия',
            'preset',
            'пресет',
            'blocks',
            'блоки',
            'layer',
            'слой',
            'marinara',
            'versions',
        ],
        en: [
            'Preset Studio (M34)',
            "A big window for the Chat Completion preset: «Map» (how ST will assemble the prompt), «Blocks» (order, bulk enable, search, preview with macros), the block editor, «Analysis» (unsaved edits, empty and never-sent blocks, contradictions, repeats with lore, model/provider quirks), «Versions» (every save is a version, rollback), «Parameters». Your layer keeps your blocks and edits apart from the base preset, so a new Marinara keeps them. Conditional blocks: {{if .maestro_<flag>}}…{{/if}} with a flag simulator (needs ST's new macro engine).\nWhere: the «Maestro» window → «Preset Studio» (opens its own window); the Prompt Manager section can be replaced by a button (setting).\nTools: preset_blocks, director_scene.",
        ],
        ru: [
            'Пресет-студия (M34)',
            'Большое окно для пресета Chat Completion: «Карта» (как ST соберёт промпт), «Блоки» (порядок, массовое включение, поиск, предпросмотр с макросами), редактор блока, «Анализ» (несохранённые правки, пустые и неотправляемые блоки, противоречия, повторы с лором, особенности модели и провайдера), «Версии» (каждое сохранение — версия, откат), «Параметры». Твой слой хранит твои блоки и правки отдельно от базового пресета, поэтому новая Marinara их не теряет. Условные блоки: {{if .maestro_<флаг>}}…{{/if}} с симулятором флагов (нужен новый движок макросов ST).\nГде: окно «Maestro» → «Пресет-студия» (открывает своё окно); раздел Prompt Manager можно заменить кнопкой (настройка).\nИнструменты: preset_blocks, director_scene.',
        ],
    },
    {
        key: 'quality',
        id: 'M12',
        keywords: [
            'quality',
            'качество',
            'refusal',
            'отказ',
            'english',
            'английский',
            'redo',
            'переделать',
            'junk',
            'мусор',
        ],
        en: [
            'Reply quality (M12)',
            'Checks every reply before NAI Studio draws: drift into another language, calques and clichés, speaking/acting for you, refusals and moralising, out-of-character notes, softening, repeats, cut-off reply, service junk and leaked HTML, no DES tracker, the content boundary. Free rules first, the cheap judge only when unsure (never in Economy). Actions per defect kind: off / auto (clean, continue, one swipe per turn with an exact instruction, tracker repair) / notify (badges «Redo» and «Not a defect»). Early cut-off of service tokens in the stream.\nWhere: the «Turn» window → «Quality».\nTools: maestro_settings(quality), cost_turn (auto-swipes).',
        ],
        ru: [
            'Качество ответа (M12)',
            'Проверяет каждый ответ до того, как NAI Studio начнёт рисовать: уход в другой язык, кальки и штампы, реплики и действия за тебя, отказы и морализаторство, оговорки вне роли, смягчение, повторы, обрезанный ответ, служебный мусор и протёкший HTML, нет трекера DES, граница контента. Сначала бесплатные правила, дешёвая модель-судья — только при сомнении (в «Экономном» никогда). Действия по видам брака: выкл / «Само» (очистить, попросить продолжить, один свайп за ход с точной инструкцией, ремонт трекера) / «Уведомить» (значки «Переделать» и «Не брак»). Ранняя отсечка служебных токенов в потоке.\nГде: окно «Ход» → «Качество».\nИнструменты: maestro_settings(quality), cost_turn (авто-свайпы).',
        ],
    },
    {
        key: 'architect',
        id: 'M20',
        keywords: ['architect', 'архитектор', 'budget', 'бюджет', 'cache', 'кэш', 'duplicates', 'повторы', 'presence'],
        en: [
            'Prompt architect (M20)',
            'Budgets per source: a total lore cap on top of book caps, CK RAG, Qvink short memory, the optional DES context block, voices, mechanics, director (the least important pieces go first; DES tracker instructions and Qvink long memory are never cut). «Who is near»: entries about absent characters and far places are damped unless mentioned lately; present characters and the current place are pinned. Repeated facts across lore, canon, Qvink, CK and DES (report, one source by consent). Provider cache: share of cached prompt and where the prompt starts to change. Everything is off by default.\nWhere: the «Turn» window → «Architect».\nTools: turn_prompt, cost_turn, maestro_settings(architect).',
        ],
        ru: [
            'Архитектор промпта (M20)',
            'Бюджеты по источникам: общий потолок лора поверх потолков книг, RAG CarrotKernel, краткосрочная память Qvink, необязательный блок контекста DES, голоса, механики, режиссёр (уходят наименее важные куски; инструкции трекера DES и долгая память Qvink не трогаются никогда). «Кто рядом»: записи об отсутствующих и далёких местах приглушаются, если о них не говорили в последних сообщениях; присутствующие и текущее место закрепляются. Повторы фактов между лором, каноном, Qvink, CK и DES (отчёт, один источник по согласию). Кэш провайдера: доля промпта из кэша и место, где промпт начинает меняться. По умолчанию всё выключено.\nГде: окно «Ход» → «Архитектор».\nИнструменты: turn_prompt, cost_turn, maestro_settings(architect).',
        ],
    },
    {
        key: 'treasurer',
        id: 'M21',
        keywords: [
            'treasurer',
            'казначей',
            'cost',
            'расходы',
            'spend',
            'money',
            'деньги',
            'expensive',
            'дорогой',
            'anlas',
            'limit',
        ],
        en: [
            'Treasurer (M21)',
            'What the game costs: the last turn, the session, today and 14 days, by source (main model, regenerations, auto-swipes, Qvink, Maestro tasks, NAI) and Anlas; cached tokens are counted. When the overall daily limit is reached it can switch to Economy (Settings → Budget).\nWhere: the «Turn» window → «Spending».\nQuestions: why was this turn expensive, how much do background tasks cost.\nTools: cost_turn, cost_summary.',
        ],
        ru: [
            'Казначей (M21)',
            'Сколько стоит игра: последний ход, сессия, сегодня и 14 дней — по источникам (основная модель, перегенерации, авто-свайпы, Qvink, задачи Maestro, NAI) и Anlas; кэшированные токены учитываются. При общем дневном лимите может перейти в «Экономный» (Настройки → Бюджет).\nГде: окно «Ход» → «Расходы».\nВопросы: почему этот ход дорогой, сколько стоят фоновые задачи.\nИнструменты: cost_turn, cost_summary.',
        ],
    },
    {
        key: 'director',
        id: 'M13',
        keywords: [
            'director',
            'режиссёр',
            'scene type',
            'тип сцены',
            'flags',
            'флаги',
            'pacing',
            'темп',
            'twist',
            'поворот',
            'nudge',
        ],
        en: [
            'Scene director (M13, M14)',
            "After each turn decides the scene type (dialogue, combat, intimate, exploration, time skip, social, drama) from the reply, your message and the DES tracker, with hysteresis; the cheap model only when unsure. For the next generation it sets one-shot flags: maestro_scene_<type>, reply length, explicit scene, language, «picture moment» — for conditional preset blocks. You can set the type yourself. Pacing: when the story stalls (same place, nothing happens, repeats, loops) a short director's note near the end of the prompt with a twist from DES quests and open threads; silent when you steer the plot; «Shake up» writes one now.\nWhere: the «Turn» window → «Director».\nTools: director_scene, preset_blocks.",
        ],
        ru: [
            'Режиссёр сцены (M13, M14)',
            'После каждого хода определяет тип сцены (диалог, бой, интимная, исследование, пропуск времени, светская, драма) по ответу, твоему сообщению и трекеру DES, с устойчивостью к скачкам; дешёвая модель — только при сомнении. Для следующей генерации ставит одноразовые флаги: maestro_scene_<тип>, длина ответа, откровенная сцена, язык, «момент для картинки» — для условных блоков пресета. Тип можно задать самому. Темп: если история встала (то же место, ничего не происходит, повторы, разговор по кругу) — короткая заметка режиссёра ближе к концу промпта с поворотом из квестов DES и незакрытых нитей; молчит, когда ты сам ведёшь сюжет; «Встряхнуть» — заметка сейчас.\nГде: окно «Ход» → «Режиссёр».\nИнструменты: director_scene, preset_blocks.',
        ],
    },
    {
        key: 'voices',
        id: 'M15',
        keywords: [
            'voices',
            'голоса',
            'voice card',
            'голосовая карточка',
            'speech',
            'речь',
            'character consistency',
            'mbti',
        ],
        en: [
            'Character voices (M15)',
            "A compact card per present character: manner of speech (LING and the Linguistics block), MBTI with state, attitude to you now, links with others present, goals. When on, CarrotKernel's «Character Consistency» injection is silenced at prompt assembly (CK settings unchanged) and DES-RU stops rebuilding it. Off by default.\nWhere: the «Turn» window → «Voices».\nTools: relations, dossier.",
        ],
        ru: [
            'Голоса персонажей (M15)',
            'Компактная карточка на каждого присутствующего: манера речи (LING и блок Linguistics), MBTI с состоянием, отношение к тебе сейчас, связи с другими присутствующими, цели. Когда включено, вставка CarrotKernel «Character Consistency» гасится при сборке промпта (настройки CK не меняются), а DES-RU перестаёт её пересобирать. Выключено по умолчанию.\nГде: окно «Ход» → «Голоса».\nИнструменты: relations, dossier.',
        ],
    },
    {
        key: 'offscreen',
        id: 'M16',
        keywords: ['backstage', 'закулисье', 'offscreen', 'absent', 'отсутствующие', 'rumours', 'слухи'],
        en: [
            'Backstage (M16)',
            'Every few turns (15 in Balanced, 10 and at scene ends in Cinema, only by button in Economy) the background model briefly tells what up to three important absent characters were doing. Events go to the canon; death, capture, disappearance and anything that contradicts the canon wait in the Inbox. Sometimes the present characters hear a rumour.\nWhere: the «World» window → «Backstage».',
        ],
        ru: [
            'Закулисье (M16)',
            'Раз в несколько ходов (15 в «Сбалансированном», 10 и в конце сцен в «Кино», в «Экономном» только по кнопке) фоновая модель коротко рассказывает, чем были заняты до трёх важных персонажей, которых давно нет в сцене. События — в канон; смерть, плен, исчезновение и всё, что спорит с каноном, ждёт во «Входящих». Иногда присутствующие слышат слух.\nГде: окно «Мир» → «Закулисье».',
        ],
    },
    {
        key: 'calendar',
        id: 'M17',
        keywords: ['calendar', 'календарь', 'promises', 'обещания', 'deadline', 'срок', 'story time', 'время истории'],
        en: [
            'Calendar and promises (M17)',
            "Story time from the DES tracker (dates, «Day N», invented calendars); agreements and deadlines from the revision or by hand («by sunset», «in three days»). A due item becomes a director's note; overdue and broken ones are marked.\nWhere: the «World» window → «Calendar».\nTools: calendar_now.",
        ],
        ru: [
            'Календарь и обещания (M17)',
            'Время истории по трекеру DES (обычные даты, «День N», выдуманные календари); договорённости и сроки из ревизии или вручную («к закату», «через три дня»). Наступивший срок — повод для заметки режиссёра; просроченное и нарушенное отмечается.\nГде: окно «Мир» → «Календарь».\nИнструменты: calendar_now.',
        ],
    },
    {
        key: 'knowledge',
        id: 'M18',
        keywords: ['who knows', 'кто знает', 'secrets', 'секреты', 'knowledge', 'знание', 'does not know', 'не знает'],
        en: [
            'Who knows what (M18, experimental)',
            "Scene participants know the scene's events (by the DES cast at that time); secrets are marked during the revision. Voice cards get «does not know: …» when the topic came up. Off by default.\nWhere: the «World» window → «Who knows».\nQuestions: why does a character know (or not know) something.\nTools: knowledge_who.",
        ],
        ru: [
            'Кто что знает (M18, экспериментально)',
            'Участники сцены знают её события (по составу DES на тот момент); секреты помечаются во время ревизии. Голосовые карточки получают «не знает: …», когда тема всплыла. Выключено по умолчанию.\nГде: окно «Мир» → «Кто знает».\nВопросы: почему персонаж знает (или не знает) что-то.\nИнструменты: knowledge_who.',
        ],
    },
    {
        key: 'wardrobe',
        id: 'M27',
        keywords: [
            'wardrobe',
            'гардероб',
            'outfit',
            'наряд',
            'clothes',
            'одежда',
            'states',
            'состояния',
            'wet',
            'wounded',
        ],
        en: [
            'Wardrobe and states (M27)',
            'A new outfit in the DES tracker (repeated two turns) becomes a named outfit in the chat-level NAI Studio passport; a known outfit is recognised and worn again. Character states (wet, wounded, tired…) and place states (ruined, decorated, on fire, night) switch in the passports by the tracker. The card is never changed.\nWhere: the «Characters» window → «Wardrobe».\nTools: wardrobe, passports_scene.',
        ],
        ru: [
            'Гардероб и состояния (M27)',
            'Новый наряд из трекера DES (повторившийся два хода) становится именованным нарядом в паспорте NAI Studio уровня чата; знакомый наряд узнаётся и надевается снова. Состояния персонажей (мокрый, ранен, устал…) и мест (разрушено, украшено, пожар, ночь) включаются в паспортах по трекеру. Карточка не меняется никогда.\nГде: окно «Персонажи» → «Гардероб».\nИнструменты: wardrobe, passports_scene.',
        ],
    },
    {
        key: 'lorePassports',
        id: 'M28',
        keywords: ['passports', 'паспорта', 'nai passport', 'паспорт nai', 'visual', 'внешность', 'entry passport'],
        en: [
            'Passports in lorebooks (M28)',
            "A lore entry can have a visual passport in NAI Studio's format: in Maestro books inside the entry, for base books in Maestro's registry (files unchanged, BunnyMo books untouched). Made by NAI Studio's generator or the background model, edited in the Lore Studio. NAI Studio gets the passports of entries activated or mentioned in the scene.\nWhere: the «Canon» window → «Passports».\nTools: passports_scene, lore_entry.",
        ],
        ru: [
            'Паспорта в лорбуках (M28)',
            'У записи лора может быть визуальный паспорт в формате NAI Studio: в книгах Maestro — в самой записи, у базовых книг — в реестре Maestro (файлы не меняются, книги BunnyMo не трогаются). Создаётся генератором NAI Studio или фоновой моделью, правится в Лор-студии. NAI Studio получает паспорта записей, сработавших или упомянутых в сцене.\nГде: окно «Канон» → «Паспорта».\nИнструменты: passports_scene, lore_entry.',
        ],
    },
    {
        key: 'backgrounds',
        id: 'M29',
        keywords: ['backgrounds', 'фоны', 'background', 'фон', 'wallpaper', 'place background'],
        en: [
            'Backgrounds (M29)',
            "The chat background follows the place: first a pick from ST's background library (name, folders, place state, time of day and weather from DES), otherwise a «Generate background» button in NAI Studio (respecting «free only»). Only this chat's background — never the global one or settings.json. A background you set yourself is left alone until you let Maestro choose again.\nWhere: the «World» window → «Backgrounds».\nTools: places_current.",
        ],
        ru: [
            'Фоны (M29)',
            'Фон чата следует за местом: сначала подбор из библиотеки фонов ST (по названию, папкам, состоянию места, времени суток и погоде из DES), иначе — кнопка «Сгенерировать фон» в NAI Studio (с учётом «только бесплатно»). Только фон этого чата — не общий фон и не settings.json. Поставленный тобой фон Maestro не трогает, пока не разрешишь выбирать снова.\nГде: окно «Мир» → «Фоны».\nИнструменты: places_current.',
        ],
    },
    {
        key: 'mechanics',
        id: 'M25',
        keywords: [
            'mechanics',
            'механики',
            'stats',
            'статы',
            'magic',
            'магия',
            'mana',
            'мана',
            'dice',
            'кубики',
            'check',
            'проверка',
            'roll',
            'бросок',
        ],
        en: [
            'Mechanics (M25)',
            'Your own game systems: attributes (numbers, scales, lists, texts), holders (characters, persona, factions, world), rules for the model, threshold events with actions («mana at zero — the spell fails», a status, an item, revealing a hidden value), checks with dice and consequences (a failed spell still costs mana), derived values by formula, statuses with a duration and modifiers, inventories with prices, experience and levels, growth of skills by use, regeneration and decay by story time (DES date and time), fights with initiative and turn order. Where each mechanic is seen: «game», «book» (words, no numbers), «hidden» (until revealed), «secret» (Maestro alone). Templates: health and stamina, magic, faction reputation, money, skills, relationships, survival, sanity, inventory and trade, combat, social scales. Stored as a «mechanic» entry in a Maestro book; for the card, the chat or everywhere. Tracking: DES tracker stats, a short service block in the reply (parsed and hidden; the model may also ask Maestro for a roll there), or a background parse. Maestro rolls checks from trigger words in your message and puts the result into the prompt as a fact; /maestro-roll. Flags maestro_mech_<id> for conditional preset blocks. In play: a line under each reply with what changed («Kai: ❤ 80 → 65 · + Poisoned») and roll cards, each with «Undo»; the HUD over the chat (values pinned in the window, condition signs, money, quick «Roll» and «Inventory»; dragged to the top or the bottom); narrator messages of rolls and a status block under the reply are switched on per mechanic in «Where it is seen» (off by default); the dossier shows the mechanics of a character. Rules are written in your words: Maestro translates them into English for the model in the background.\nWhere: the «Mechanics» window — «In play» (values, rolls, the fight, conditions and items, «Peek» at hidden values), «History» (every change and roll with undo), «Constructor» (the gear holds the settings: the HUD, the DES strip).\nTools: mechanics_state.',
        ],
        ru: [
            'Механики (M25)',
            'Свои игровые системы: атрибуты (числа, шкалы, списки, тексты), у кого они есть (персонажи, персона, фракции, мир), правила для модели, события на порогах с действиями («мана на нуле — заклинание срывается», состояние, предмет, раскрытие скрытого), проверки с кубиками и последствиями (сорвавшееся заклинание тоже стоит маны), производные значения по формуле, состояния с длительностью и модификаторами, инвентарь с ценами, опыт и уровни, рост навыков от применения, восстановление и расход по времени истории (дата и время DES), бой с инициативой и очерёдностью. Где видна каждая механика: «Игровой», «Книжный» (словами, без чисел), «Скрытый» (пока не раскрыт), «Тайный от всех» (знает только Maestro). Шаблоны: здоровье и выносливость, магия, репутация у фракций, деньги, навыки, отношения, выживание, рассудок, инвентарь и торговля, бой, социальные шкалы. Хранится записью типа «механика» в книге Maestro; для карточки, чата или везде. Учёт: статы трекера DES, короткий служебный блок в ответе (читается и прячется; в нём модель может попросить Maestro о броске) или фоновый разбор. Maestro бросает кубики по словам-триггерам в твоём сообщении и кладёт результат в промпт фактом; /maestro-roll. Флаги maestro_mech_<id> для условных блоков пресета. В игре: под каждым ответом строка изменений («Кай: ❤ 80 → 65 · + Отравлен») и карточки бросков, у каждой «Отменить»; HUD поверх чата (значения, закреплённые в окне, значки состояний, деньги, быстрые «Бросок» и «Инвентарь»; перетаскивается к верху или к низу); сообщения рассказчика о бросках и статус-блок под ответом включаются у каждой механики в «Где видно» (по умолчанию выключены); досье показывает механики персонажа. Правила пишутся своими словами: Maestro в фоне переводит их для модели на английский.\nГде: окно «Механики» — «В игре» (значения, броски, бой, состояния и вещи, «Подсмотреть» скрытое), «История» (каждое изменение и бросок с отменой), «Конструктор» (шестерёнка — настройки: HUD, полоса под DES).\nИнструменты: mechanics_state.',
        ],
    },
    {
        key: 'theme',
        id: 'M32',
        keywords: ['theme', 'тема', 'style', 'стиль', 'look', 'оформление', 'density', 'плотность'],
        en: [
            'Unified look (M32)',
            "One Maestro stylesheet over your ST theme makes ST, the chat and the extensions look like one app: colours, blur, shadows, font size and chat width come from your theme; radii, spacing and controls are Maestro's. Per-part switches (ST, chat, each extension), density, radii, «Show as it was» for 10 seconds. Off → everything as before; neighbour settings are never changed.\nWhere: the «Maestro» window → «Settings» → «Appearance».",
        ],
        ru: [
            'Единый стиль (M32)',
            'Одна таблица стилей Maestro поверх твоей темы ST делает ST, чат и расширения одним приложением: цвета, размытие, тени, размер шрифта и ширину чата даёт твоя тема; скругления, отступы и элементы управления — Maestro. Переключатели по частям (ST, чат, каждое расширение), плотность, скругления, «Показать, как было» на 10 секунд. Выключил — всё как раньше; настройки соседей не меняются.\nГде: окно «Maestro» → «Настройки» → «Оформление».',
        ],
    },
    {
        key: 'dock',
        id: 'M32d',
        keywords: ['dock', 'док', 'extensions', 'расширения', 'settings blocks', 'блоки настроек', 'portrait bar'],
        en: [
            'Extensions dock (M32d)',
            "The settings blocks of CarrotKernel, Qvink, NAI Studio, DES-RU, Localizer and DES open right in the «Maestro» window, section «Extensions» (the real blocks, everything works) and go back to their place when that section is hidden, the window closes or Maestro is off; optionally the DES portrait bar too. Shortcuts open the neighbours' windows.\nWhere: the «Maestro» window → «Extensions».",
        ],
        ru: [
            'Док «Расширения» (M32d)',
            'Блоки настроек CarrotKernel, Qvink, NAI Studio, DES-RU, Localizer и DES открываются прямо в окне «Maestro», в разделе «Расширения» (настоящие блоки, всё работает), и возвращаются на место, когда раздел скрыт, окно закрыто или Maestro выключен; по желанию — и полоса портретов DES. Ярлыки открывают окна соседей.\nГде: окно «Maestro» → «Расширения».',
        ],
    },
    {
        key: 'assistant',
        id: 'M33',
        keywords: ['assistant', 'ассистент', 'helper', 'помощник', 'tools', 'инструменты', 'confirm', 'подтверждение'],
        en: [
            'Maestro assistant (M33)',
            'A conversation in its own window beside the chat, apart from the role-play; the model comes from the connection profile of the «assistant» task (Settings → Connection profiles; empty = the main background profile). It reads the documentation, settings, health, journal, lore and regexes, the chat messages, the character card with its starting scenes and the persona, explains and diagnoses, and makes changes — module settings, mechanics, regexes with a test, preset flags and blocks, passports, lore entries — only after you confirm a before/after card. Chat and lore are data for it, never instructions; secrets, API keys, addresses and connection profiles are invisible to it; every change is journaled with undo; changes per hour are limited.\nWhere: the «Assistant» window.',
        ],
        ru: [
            'Ассистент Maestro (M33)',
            'Переписка в своём окне рядом с чатом, отдельно от РП; модель — из профиля подключения задачи «ассистент» (Настройки → Профили подключения; пусто — основной фоновый профиль). Читает документацию, настройки, здоровье, журнал, лор и регексы, сообщения чата, карточку персонажа со стартовыми сценами и персону, объясняет и диагностирует, а меняет — настройки модулей, механики, регексы с испытанием, флаги и блоки пресета, паспорта, записи лора — только после твоего подтверждения карточки «было/стало». Чат и лор для него — данные, не инструкции; секреты, ключи API, адреса и профили подключения ему не видны; каждое изменение — в журнале с откатом; число изменений в час ограничено.\nГде: окно «Ассистент».',
        ],
    },
];

export const MODULE_TOPICS: DocTopic[] = MODULES.map((doc) => ({
    id: `module.${doc.key}`,
    kind: 'module',
    title: { en: doc.en[0], ru: doc.ru[0] },
    keywords: [doc.key, doc.id, ...doc.keywords],
    body: { en: doc.en[1], ru: doc.ru[1] },
}));
