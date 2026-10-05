// Knowledge base of the assistant (M33): the extension stack Maestro conducts — what each neighbour does, what it
// owns and how Maestro works with it (plan §2, §2.2, §10). Hand-written, English and Russian.
import type { DocTopic } from '../../../../domain/assistant-docs';

interface StackDoc {
    id: string;
    keywords: string[];
    en: [title: string, text: string];
    ru: [title: string, text: string];
}

const STACK: readonly StackDoc[] = [
    {
        id: 'sillytavern',
        keywords: [
            'st',
            'sillytavern',
            'worldinfo',
            'world info',
            'lorebook',
            'лорбук',
            'regex',
            'регекс',
            'profiles',
            'профили',
            'macro',
            'макрос',
        ],
        en: [
            'SillyTavern 1.19',
            'The core: storage, the World Info (lorebook) scan engine, events, connection profiles (Connection Manager), backgrounds, the regex extension, the macro engine. Maestro extends it through events and never changes the scan engine or file formats. Facts that matter: WI keys match against the last N messages (scan depth); «match whole words» uses an ASCII boundary, so Cyrillic keys behave like substrings and Russian case forms («Анна» / «Анну») need their own keys; a dry run cannot see sticky/cooldown; regex scripts run global → preset → scoped, by placement (user input, AI output, world info, reasoning…) and mode (display only, prompt only, or the stored text); a script without the g flag replaces only the first match; replacements know {{match}}, $1 and $<name> only. {{if}} in presets needs the new macro engine (power_user.experimental_macro_engine). Chat Completion is required; group chats are not supported by Maestro.',
        ],
        ru: [
            'SillyTavern 1.19',
            'Ядро: хранение, движок сканирования World Info (лорбуков), события, профили подключения (Connection Manager), фоны, расширение регексов, движок макросов. Maestro расширяет его через события и никогда не меняет движок сканирования и форматы файлов. Важные факты: ключи WI ищутся в последних N сообщениях (глубина сканирования); «целые слова» используют ASCII-границу, поэтому кириллические ключи ведут себя как подстроки, а падежным формам («Анна» / «Анну») нужны свои ключи; пробный прогон не видит sticky/cooldown; регексы выполняются глобальные → пресета → карточки, по месту (ввод, ответ ИИ, лор, рассуждения…) и режиму (только показ, только промпт или сам текст); скрипт без флага g заменяет только первое совпадение; в замене работают только {{match}}, $1 и $<name>. {{if}} в пресете требует новый движок макросов (power_user.experimental_macro_engine). Нужен Chat Completion; групповые чаты Maestro не поддерживает.',
        ],
    },
    {
        id: 'des',
        keywords: [
            'des',
            "doom's enhancement suite",
            'tracker',
            'трекер',
            'portraits',
            'портреты',
            'quests',
            'квесты',
            'campaigns',
            'кампании',
            'aliases',
        ],
        en: [
            "Doom's Enhancement Suite (DES 2.6)",
            "Owns the scene tracker (a JSON block in every reply: who is present, location, time, weather, outfits, relationships, stats, quests), the portrait bar, the Workshop, campaigns and auto-linking of books by name, canonical aliases, the Lore Library. Maestro reads the tracker of every committed turn (signals, places, relationships, calendar, wardrobe, director, mechanics via stats), repairs a missing tracker through DES's own update path (Medic), adds stats for mechanics with consent, manages campaigns through DES's API in the Lore Studio, resets the Lore Library cache after lorebook writes, and never writes DES stores while the Workshop popup is open. Common problem: a regex that eats the tracker JSON (Doctor finds it).",
        ],
        ru: [
            "Doom's Enhancement Suite (DES 2.6)",
            'Владеет трекером сцены (JSON-блок в каждом ответе: кто присутствует, место, время, погода, наряды, отношения, статы, квесты), полосой портретов, Workshop, кампаниями и автопривязкой книг по имени, каноническими алиасами, Lore Library. Maestro читает трекер каждого зафиксированного хода (сигналы, места, отношения, календарь, гардероб, режиссёр, механики через статы), чинит пропавший трекер через собственный путь обновления DES (Медик), с твоего согласия добавляет статы для механик, ведёт кампании через API DES в Лор-студии, сбрасывает кэш Lore Library после записи в лорбуки и никогда не пишет в хранилища DES, пока открыт Workshop. Частая беда: регекс, съедающий JSON трекера (находит Доктор).',
        ],
    },
    {
        id: 'desru',
        keywords: [
            'des-ru',
            'desru',
            'russian',
            'русский',
            'declension',
            'склонения',
            'case forms',
            'падежи',
            'language lock',
        ],
        en: [
            'DES-RU',
            "The Russian adaptation of DES, BunnyMo and CarrotKernel: interface translation, Cyrillic fixes, names and declensions (case forms), the sheet normaliser, a language lock, Russian RAG forms, its own on-the-fly BunnyMo fixes. Maestro takes case forms from it (canon keys, world model, places) and coordinates functions: when voice cards are on, DES-RU stops rebuilding CK's «Character Consistency» injection. Russian specifics stay in DES-RU; general stack fixes are Maestro's.",
        ],
        ru: [
            'DES-RU',
            'Русская адаптация DES, BunnyMo и CarrotKernel: перевод интерфейсов, исправления кириллицы, имена и склонения (падежные формы), нормализатор листов, языковой замок, русские формы RAG, свои правки BunnyMo на лету. Maestro берёт у него падежи (ключи канона, модель мира, места) и согласует функции: при включённых голосовых карточках DES-RU перестаёт пересобирать вставку CK «Character Consistency». Русская специфика остаётся в DES-RU, общие исправления стека — в Maestro.',
        ],
    },
    {
        id: 'carrotkernel',
        keywords: [
            'ck',
            'carrotkernel',
            'carrot',
            'archive',
            'архив',
            'rag',
            'bunnymotags',
            'repository',
            'репозиторий',
            'sheet capture',
        ],
        en: [
            'CarrotKernel (CK 1.0)',
            "Owns character archive repositories (<BunnymoTags> blocks in lorebooks), tag parsing, RAG collections, Baby Bunny and sheet capture. Maestro reads archives and tags (dossier, voices, revision proposes tag changes from the pack dictionary only), silences the «Character Consistency» injection at prompt assembly when voice cards are on (CK settings unchanged), keeps RAG and archives, can budget the RAG injection (architect). Never calls CK's initializeSheetGenerator; never renames <Name:…> in archives. The Doctor checks archive scan depth, case of <BunnymoTags>, placeholders and multiple blocks.",
        ],
        ru: [
            'CarrotKernel (CK 1.0)',
            'Владеет репозиториями архивов персонажей (блоки <BunnymoTags> в лорбуках), разбором тегов, коллекциями RAG, Baby Bunny и захватом листов. Maestro читает архивы и теги (досье, голоса; ревизия предлагает теги только из словаря паков), гасит вставку «Character Consistency» при сборке промпта, когда включены голосовые карточки (настройки CK не меняются), не трогает RAG и архивы, может ограничить вставку RAG бюджетом (архитектор). Никогда не вызывает initializeSheetGenerator CK и не переименовывает <Name:…> в архивах. Доктор проверяет глубину сканирования архивов, регистр <BunnymoTags>, заглушки и несколько блоков.',
        ],
    },
    {
        id: 'bunnymo',
        keywords: [
            'bunnymo',
            'packs',
            'паки',
            'tags',
            'теги',
            'psychology',
            'психология',
            'mbti',
            'sheet command',
            'команда листа',
        ],
        en: [
            'BunnyMo V3 and packs',
            "A dictionary of psychology and tags (trait descriptions, MBTI, species, dere types) in core and pack lorebooks, plus sheet commands. Pack files are untouchable in meaning (P13): no file edits, no Russian keys, no translations. On the fly Maestro applies only technical fixes (assistant role → system, recursion, byte-identical duplicates suppressed), each listed and switchable; when two versions of one pack disagree (MBTI v1 and V2) Maestro asks once which to keep. Packs per chat in BunnyMo mode; sheet commands are generated by Maestro's own prompt (sheets).",
        ],
        ru: [
            'BunnyMo V3 и паки',
            'Словарь психологии и тегов (описания черт, MBTI, виды, типы «дере») в книгах ядра и паков, плюс команды листов. Файлы паков неприкосновенны по смыслу (P13): никаких правок в файлах, русских ключей и переводов. На лету Maestro делает только технические правки (роль assistant → system, рекурсия, подавление побайтных дублей) — каждая видна списком и выключается; если версии одного пака расходятся (MBTI v1 и V2), Maestro один раз спрашивает, какую оставить. Паки по чатам — в режиме BunnyMo; команды листов генерируются своей сборкой промпта Maestro (листы).',
        ],
    },
    {
        id: 'qvink',
        keywords: [
            'qvink',
            'memory',
            'память',
            'summary',
            'пересказ',
            'summaries',
            'long-term',
            'short-term',
            'remember',
            'запомнить',
        ],
        en: [
            'Qvink Memory 1.3',
            'Owns summaries: per-message short and long memory, and removing old messages from the prompt. Maestro sets the «remember»/«exclude» flags (auto-memory), returns not-yet-summarised messages to the prompt (the «gaps» rule), keeps NAI picture posts out, starts summaries, turns memories that fell out of long memory into canon chapters (chronicle) and can budget the short memory (architect; long memory is never cut). Its own LLM calls count as source «qvink» in the treasurer.',
        ],
        ru: [
            'Qvink Memory 1.3',
            'Владеет пересказами: краткая и долгая память по сообщениям, удаление старых сообщений из промпта. Maestro ставит флаги «запомнить» и «исключить» (автопамять), возвращает в промпт ещё не пересказанное (правило «дыр»), не пускает посты-картинки NAI, запускает пересказ, превращает выпавшие из долгой памяти воспоминания в главы канона (летопись) и может ограничить краткую память бюджетом (архитектор; долгая не трогается никогда). Его запросы к ИИ казначей считает источником «qvink».',
        ],
    },
    {
        id: 'naistudio',
        keywords: [
            'nai',
            'nai studio',
            'novelai',
            'images',
            'картинки',
            'passport',
            'паспорт',
            'portraits',
            'anlas',
            'pictures',
        ],
        en: [
            'NAI Studio',
            "Everything visual: passports (card, persona, chat, lore entries), pictures in the chat, DES portraits, backgrounds, location continuity. Maestro decides when and what, NAI Studio decides how: the quality gate («quality ok» before drawing, needs 0.11+), chat-level passports from the revision and wardrobe (outfits, states), passports of lore entries in the scene (0.12.1+), background generation for a place, continuity by Maestro's place id. Anlas spend is shown by the treasurer. The card is never changed by Maestro.",
        ],
        ru: [
            'NAI Studio',
            'Всё визуальное: паспорта (карточка, персона, чат, записи лора), картинки в чате, портреты DES, фоны, непрерывность локаций. Maestro решает, когда и что, NAI Studio — как: сигнал «качество ок» перед рисованием (нужна 0.11+), паспорта уровня чата из ревизии и гардероба (наряды, состояния), паспорта записей лора в сцене (0.12.1+), генерация фона для места, непрерывность по id места Maestro. Расход Anlas показывает казначей. Карточку Maestro не меняет никогда.',
        ],
    },
    {
        id: 'localizer',
        keywords: [
            'localizer',
            'локализатор',
            'lorebook localizer',
            'russian keys',
            'русские ключи',
            'translation',
            'перевод ключей',
        ],
        en: [
            'Lorebook Localizer',
            'Translates entry keys into Russian with word forms (regex keys) and marks what it added. Maestro uses it as a library from the Lore Studio and the canon (Russian keys of new entries); BunnyMo system packs are closed to it. The Doctor reports keys without Russian forms and broken localizer keys.',
        ],
        ru: [
            'Lorebook Localizer',
            'Переводит ключи записей на русский со словоформами (ключи-регулярки) и помечает, что добавил. Maestro пользуется им как библиотекой из Лор-студии и канона (русские ключи новых записей); системные паки BunnyMo для него закрыты. Доктор сообщает о ключах без русских форм и сломанных ключах локализатора.',
        ],
    },
    {
        id: 'preset',
        keywords: [
            'marinara',
            'preset',
            'пресет',
            'yablochny',
            'nemo',
            'prompt manager',
            'conditional',
            'условные блоки',
        ],
        en: [
            'The preset (Marinara and others)',
            'The base instructions of the model. Maestro never rewrites the preset on the fly: it drives blocks through one-shot flags maestro_* inside {{if}} conditions (set before a generation, cleared after), keeps your edits as a layer in the Preset Studio so a new base version keeps them, and moves the layer to another preset (Yablochny, Nemo…) by anchors. Saving the preset file happens only with an explicit body and by your action.',
        ],
        ru: [
            'Пресет (Marinara и другие)',
            'Базовые инструкции модели. Maestro никогда не переписывает пресет на лету: управляет блоками одноразовыми флагами maestro_* в условиях {{if}} (ставятся перед генерацией и снимаются после), хранит твои правки слоем в Пресет-студии, чтобы новая версия базы их не потеряла, и переносит слой на другой пресет (Yablochny, Nemo…) по якорям. Файл пресета сохраняется только с явным содержимым и только твоим действием.',
        ],
    },
];

export const STACK_TOPICS: DocTopic[] = STACK.map((doc) => ({
    id: `stack.${doc.id}`,
    kind: 'stack',
    title: { en: doc.en[0], ru: doc.ru[0] },
    keywords: doc.keywords,
    body: { en: doc.en[1], ru: doc.ru[1] },
}));
