# Maestro и Officina

> Maestro 1.24.0. Officina — мастерская карточек (`SillyTavern-Officina`, её `docs/plan.md` §15 и `docs/dev-plan.md`,
> задача 0.12). Тип API целиком — [`src/shared/public-api-types.ts`](../src/shared/public-api-types.ts): файл
> самодостаточный (только типы и две константы, без импортов), Officina копирует его к себе дословно. Связь с Dramatis —
> [`integration-dramatis.md`](integration-dramatis.md).

Officina сама владеет проектами, генерацией и выпуском карточек. От Maestro ей нужны инфраструктура и его студии:
журнал с откатом, общий дневной лимит расходов, Лор-студия, роли книг, механики, слой и привязки пресета, проверка
промпта, «Создать персону», служебный режим для чата соавтора. Без Maestro Officina работает сама (своя запись книг,
свой лимит); с ним — через `globalThis.MAESTRO_API`.

## 1. Как найти API

- `globalThis.MAESTRO_API`, `version: 1`. Появляется, когда модули Maestro запущены; при каждом появлении на `window`
  приходит `maestro-api-ready` (`{ detail: { version: 1 } }`). Officina грузится после Maestro (`loading_order` 210), но
  всё равно ждёт события: Maestro могли включить позже.
- Версия не растёт: члены только добавляются. `features` (с 1.24) — что есть в этой сборке: `prefix:dramatis`,
  `prefix:officina`, `cost`, `lore`, `bookRoles`, `mechanics`, `presets`, `promptAudit`, `persona`, `serviceCard`,
  `prepareScenes`. Нет `features` или нужного пункта — Maestro старше, пользоваться этим нельзя.
- Когда Maestro останавливается, объект убирается; вызов старого объекта отвечает `'maestro-stopped'`.

## 2. Префикс `officina.`

С 1.24 у API два соседа: `EXTERNAL_PREFIXES = ['dramatis.', 'officina.']` в `src/app/public-api.ts`.

- Задачи ИИ, виды действий и виды записей журнала — `officina.<имя>` (`officina.bible`, `officina.release`); цели
  журнала — `officina.<имя>` или `officina-<имя>`. Чужие id отклоняются так же, как у Dramatis.
- Записи журнала и карточки «Входящих» идут под модулем `officina` (в окнах — «Officina»); цели, зарегистрированные
  через `journal.registerUndo`, подписаны «Officina», их значения — под «Подробнее».
- `llm.registerTask('officina.bible', {ru, en})` даёт строку задачи в «Настройки → Профили», как у Dramatis.
- `llm.request` для задач Officina работает и в служебном чате (её чат соавтора — служебный), задачи `dramatis.*` там
  по-прежнему получают `'workshop'`. Схема уходит модели под именем задачи: `officina.bible` → `officina_bible`.
  Свой канал Officina (ниже) называет схемы так же.

## 3. Общий дневной лимит (`cost`)

Officina ходит к модели своим каналом (`ConnectionManagerRequestService`, без пресета и чата), а не через
`llm.request`. Чтобы её траты были видны и упирались в тот же лимит, что и фон Maestro:

| Член | Что делает |
|---|---|
| `cost.record({task, model?, provider?, tokens?, usd, at?})` | записывает трату под соседом `officina` (источник счётчика `'officina'`, `chatId: null` — к ходам чата не относится). `task` — только `officina.*`; `usd` — число ≥ 0 (0 — «оценка», как ответ без стоимости); `tokens` — `{prompt?, completion?, cached?}`; `at` — момент сегодня (другой считается «сейчас»). В «Расходах» Officina — отдельная строка, видна, когда она что-то потратила (колонка «День») |
| `cost.remaining()` | `{capUsd, spentUsd, remainingUsd}`: `capUsd` — настройка Maestro «Потолок фона в день» (`backgroundDailyCapUsd`, `null` — без потолка), `spentUsd` — сегодняшний фон (задачи Maestro и траты соседей), `remainingUsd` — сколько осталось до остановки фона (с учётом общего дневного лимита с действием «Остановить фоновые задачи»; `null` — ограничений нет) |
| `cost.claim(signal)` | запросы, отправленные с этим `AbortSignal`, счётчик Maestro не считает сам — их стоимость Officina сообщает через `record()`. Возвращает снятие |

Лимит — тот, которому подчиняются фоновые задачи Maestro: `CostMeter.backgroundCapReached()` в `src/core/cost.ts`
считает потолок по источникам `BACKGROUND_SOURCES` (`maestro` и `officina`); общий дневной лимит считает всё. Перед
запуском задачи Officina смотрит `remaining()`; исчерпанный лимит Maestro сам ей ничего не запрещает.

**Двойной счёт.** Счётчик Maestro видит каждый запрос `/api/backends/chat-completions/generate`. Запрос, у которого
JSON-схема названа `officina_*`, он пропускает сам; запрос без схемы (соавтор с инструментами, авто-игрок) Officina
помечает через `claim(signal)` — иначе он попадёт в «Прочее» (или в «Qvink», если тот установлен) и посчитается
дважды.

## 4. Фасады служб

Тонкие двери к службам, которыми пользуются студии Maestro, — с теми же правилами стека: одна очередь сохранения на
книгу, BunnyMo никогда не пишется, редактор ST и кэш DES обновляются, рабочий пресет не теряет правок. Код —
`src/app/public-api-services.ts`.

Каждый метод отвечает `{ok: true, …}` или `{ok: false, error, message?}`:

| `error` | Когда |
|---|---|
| `'off'` | модуль-владелец выключен или стоит на паузе (служебный чат ставит на паузу сюжетные модули, механики в их числе; определения механик при этом доступны — с 1.24.1, см. `mechanics`) |
| `'bad-args'` | аргументы не прошли проверку (`message` — какой) |
| `'read-only'` | книга BunnyMo или другая, которую Maestro не пишет |
| `'not-found'` | нет такой книги, записи, карточки, пресета, механики |
| `'exists'` | имя занято |
| `'unsaved'` | у рабочего пресета несохранённые правки |
| `'no-chat'` | нужен открытый чат |
| `'unavailable'` | хост сейчас не может (нет нужного модуля ST, проверка промпта занята) |
| `'maestro-stopped'` | Maestro остановлен |
| `'failed'` | остальное; `message` — текст ошибки службы |

Записи пишутся в журнал Maestro под модулем `officina` и отменяются оттуда (откат — обработчиками самих служб).
`options` записи: `by` — сосед, под которым запись (`'officina'` по умолчанию, `'dramatis'`), `summary` — слова записи
(их берут лор, правки слоя и `presets.saveAs`; остальные записи — словами Maestro).

| Член | Методы | Служба |
|---|---|---|
| `lore` | `listBooks()` → `{books: [{name, role, readOnly}]}`; `load(book)` → `{book}`; `createBook(name, options?)` → `{name}`; `createEntry(book, entry, options?)` → `{uid}`; `updateEntry(book, uid, patch, options?)`; `deleteEntry(book, uid, options?)`; `setCharacterBook(avatar, book \| null, options?)` — основная книга любой карточки, не только открытой; `entryTypes()`; `composeContent(type, fields)`; `typeFields(book, uid)` → `{typed}`; `setTypeFields(book, uid, typed \| null, {compose?})` → `{storage}` | `loreStore` (M23): `features/loreStudio/store.ts`. Ключи — списки строк, `uid` из патча отбрасывается. Типовые поля книг Maestro и канона живут в записи (`extensions.maestro`), остальных книг — в боковом файле ролей (P2); `compose: true` пишет и текст записи из полей. Книга, чью роль M35 ещё не знает (только что созданная), для студии только для чтения (P13): перед записью фасад сам определяет её роль |
| `bookRoles` | `get(book)` → `{info}`; `set(book, role, options?)` (`'unknown'` — снова определять самому) | M35: `features/bookRoles`. Книгу BunnyMo поменять нельзя (`'read-only'`) |
| `mechanics` | `list({scope?, avatar?, chatId?})` → `{defs}` — все области, не только видимые в чате; `get(id)`; `save(def, {scope, by?})` → `{def}` (проверка определения — `'bad-args'` с кодом замечания); `remove(id, options?)`; `templates()`; `fromTemplate(id, {scope?})` (по умолчанию — глобальная); `parseBlock(text)` — разбор блока `<mechanics>` ответа, как его читает Maestro, ничего не применяет; `setEnabledInChat(id, on)` | M25: `features/mechanics`. `templates`, `fromTemplate` и `parseBlock` работают и при выключенном модуле. В служебном чате (с 1.24.1) определения доступны: `list`, `get`, `save`, `remove`, `templates`, `fromTemplate` работают и в чате соавтора — книги механик к открытому чату не относятся (`app.modules.api('mechanicsDefinitions')`, его держит модуль на паузе). `setEnabledInChat` — переключатель открытого чата — там отвечает `'off'`; `'off'` у остальных — только когда модуль механик выключен |
| `presets` | `list()` → `{names, current}`; `working()` → `{name, body}`; `saved(name)` → `{body}`; `select(name, {force?})` — модель и провайдеры остаются; `saveAs(name, body?, {overwrite?, select?, summary?})` → `{name}` — из тела (недостающие ключи — из текущего пресета, адреса и пароли — никогда) или рабочая копия под новым именем; `ops(scope, owner?)` → `{layers: {base: ops[]}, binding}`; `record(base, op, scope, owner?, options?)`; `remove(base, index, scope, owner?, options?)`; `bind(scope, preset, owner?)`, `unbind(scope, owner?)` | M34: `presetStore` и `presetLayer`. Области: `'global'`, `'character'` любой карточки (`owner` — её аватар, без него — открытая), `'chat'` — только открытый чат. Если правят часть, которая сейчас лежит на рабочей копии, рабочая копия следует сразу; пресет при этом не становится «несохранённым». Привязка пресета к открытой карточке переключает его как обычно |
| `promptAudit` | `run({dry?})` → `{report: {at, source, conflicts, hidden} \| null}` | M38: только находки (`id`, `topic`, `severity`, `title`, `why`, `risk?`, стороны `a`/`b` со ссылками `preset:…`, `card:…`, `slot:…`, `lore:…`); исправлений через API нет. `dry` — пробная сборка открытого чата (`'unavailable'`, если её сейчас нельзя) |
| `persona` | `create({name, description, title?, wardrobe?, linkAvatar?, passport?, picture?, appearanceEn?, makeCurrent?})` → `{avatarId, name, linked, passport, picture, current, steps}` | M41: те же шаги, что у кнопки «Создать персону», но без вызова модели Maestro — описание готовое. Паспорт и картинку делает NAI Studio 0.14+ (её собственный запрос); без неё шаги пропущены с причиной в `steps`. Отката нет, как у M41: персона удаляется в окне персон ST |
| `workshop` | `isServiceCard(avatar)`; `setCard(avatar, on, options?)` | M42 «Служебный режим»: ставит первый тег настройки («служебная») или снимает все служебные теги; запись журнала с откатом |

## 5. Стартовые сцены для «Подготовки к игре»

Карточка может нести `data.extensions.officina.scenes` — массив, выровненный с приветствиями
`[first_mes, ...alternate_greetings]`:

```json
{ "place": "Таверна «Солёный якорь»", "time": "вечер", "present": ["Вера", "Мартин"],
  "mood": "тревожное ожидание", "hook": "В таверну входит гонец с чёрной печатью." }
```

Элемент — `{place?, time?, present?, mood?, hook?}` или `null` (у этого приветствия сцены нет); лишние элементы после
последнего приветствия не читаются. Тексты обрезаются (место и время — до 120 знаков, настроение и крючок — до 400), в
`present` — до 16 имён. Имена — как в истории (на её языке): Maestro берёт их как есть.

«Подготовка к игре» (M37, `domain/prepare-author-scenes.ts`):

- запросу анализа каждой части отдаются сцены автора для приветствий этой части — блоком `<author_scenes>` с
  указанием взять место, время и присутствующих как даны, а настроение и крючок учесть в описании сцены;
- в плане сцена такого приветствия получает место, время и состав из сцены автора (дата, наряды и тип первой сцены —
  из анализа); если анализ сцены не дал, она собирается из сцены автора (описание — крючок и настроение);
- то же при повторном использовании сохранённой подготовки: сцены автора всегда главнее.

## 6. Стенд и имитация модели

- Сосед `officina` в `tools/stand/sources.mjs`: папка `SillyTavern-Officina`, ref `WORKTREE`, нужны `manifest.json` и
  `dist/index.js`; пока сборки нет — пропускается с предупреждением (как Dramatis).
- Имитация модели (`tools/mock-llm`) отвечает на схемы `officina_*` из `tools/mock-llm/fixtures/officina/<task>.json`
  (или `<schema>.json`; папку меняет `MOCK_OFFICINA_FIXTURES`), иначе — обходом схемы; `registerTask('officina.…')`
  работает так же, как для Dramatis. Запрос Officina через Connection Manager —
  `response_format: {type: 'json_schema', json_schema: {name: 'officina_<задача, точки → _>', schema}}`. Маркеры сбоев
  (`[mock:badjson]`, `[mock:refusal]`, `[mock:truncate]`) и флаги `MOCK_FAIL`, `MOCK_STREAM_DROP` действуют и здесь.

## 7. Чего нет

- Исправлений проверки промпта через API, правки чужого чата в слое пресета, отката созданной персоны.
- Механик в самом служебном чате: модуль механик там на паузе (ни вставок в промпт, ни разбора блока `<mechanics>`,
  ни бросков, ни значений), и `setEnabledInChat` отвечает `'off'`. Определения (`list`, `get`, `save`, `remove`) с
  1.24.1 работают и там; модуль, вернувшись в сюжетном чате, читает их заново.
- Officina не получает событий хода в служебном чате (`onTurn` там молчит для всех соседей).
