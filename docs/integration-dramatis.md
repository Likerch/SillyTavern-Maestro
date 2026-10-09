# Maestro и Dramatis

> Maestro 1.17.0. Dramatis — движок личностей (`SillyTavern-Dramatis`, его `docs/model.md` §13 и `docs/dev-plan.md`).
> Контракт — `src/adapters/dramatis/apis.ts`, дословная копия `SillyTavern-Dramatis/src/shared/apis.ts`: меняется
> сначала в Dramatis, потом копируется сюда без правок.

Dramatis владеет мотивами, целями, отношениями и повестками персонажей; Maestro — инфраструктурой (фоновые задачи ИИ,
стоимость, ведущая вкладка, «Входящие», журнал, опознание имён, события хода) и дирижирует стеком. Связь — два
версионированных глобальных API:

- `globalThis.MAESTRO_API` (v1) публикует Maestro, Dramatis им пользуется;
- `globalThis.DRAMATIS_API` (v1) публикует Dramatis, Maestro читает его через адаптер.

Без Dramatis Maestro работает как раньше; без Maestro у Dramatis остаются только самостоятельные функции.

## 1. Как Maestro находит Dramatis

Адаптер `src/adapters/dramatis/index.ts` (id `dramatis`, `app.adapters.dramatis`; в модулях — `dramatisOf(app)`):

- находит расширение по манифесту (`display_name: "Dramatis"` или `homePage` с `SillyTavern-Dramatis`), папка по
  умолчанию — `third-party/SillyTavern-Dramatis`; выключенное в ST расширение не считается;
- читает `globalThis.DRAMATIS_API` вживую и принимает его, только если `version === 1` и есть все методы;
- Dramatis может загрузиться позже Maestro: событие окна `dramatis-api-ready` обновляет возможности и перерисовывает
  разделы, которые показывают данные Dramatis; подписка `onChange` переходит на новый объект API сама;
- возможности: `dramatis.present` (установлен, включён, загружен), `dramatis.api` (опубликован API v1);
- все чтения защищены: брошенное исключение или мусор в ответе дают пустой результат, а не сломанный Maestro.

## 2. MAESTRO_API v1

Устанавливается в `src/app/app.ts` после запуска модулей (`installMaestroApi`, `src/app/public-api.ts`), убирается при
остановке Maestro. Каждый раз, когда API появляется, на `window` отправляется
`CustomEvent('maestro-api-ready', { detail: { version: 1 } })`. После остановки объект отвечает безопасно: запросы к
ИИ — `{ ok: false, error: 'maestro-stopped' }`, списки — пустые, регистрации — пустые снятия.

**Идентификаторы.** Задачи ИИ и виды действий — только `dramatis.<имя>` (`dramatis.turn`, `dramatis.intent`); цели
журнала — `dramatis.<имя>` или `dramatis-<имя>`. Чужие id отклоняются (журнал — исключением, остальное — пустым
снятием или `'skipped'` с предупреждением в консоли).

| Метод | Что делает | Где |
|---|---|---|
| `version`, `maestroVersion` | `1` и версия Maestro из манифеста | `public-api.ts` |
| `llm.request(r)` | запрос через клиент Maestro: профиль задачи, повторы, предохранитель, разбор JSON по схеме; стоимость записывается казначею как фоновая трата Maestro (источник `maestro`) с меткой задачи. `background: true` — только в ведущей вкладке (иначе `error: 'not-leader'`) и в пределах дневного потолка (иначе `'cap'`); `background: false` — задача, которую запустил пользователь, потолок её не останавливает. Схема уходит модели под именем задачи: `dramatis.turn` → `dramatis_turn` | `public-api.ts` → `core/llm.ts` (`LlmRequest.interactive`) |
| `llm.available(task)` | есть профиль и предохранитель закрыт | `public-api.ts` |
| `llm.registerTask(id, {ru, en})` | строка задачи в «Настройки → Профили» со своим названием; возвращает снятие | `public-api.ts` → `ui/views/registries.ts` |
| `leader.isLeader()`, `leader.onChange(fn)` | ведущая вкладка чата | `core/leader.ts` |
| `registerApplier(kind, {ru, en}, apply, stillValid?)` | как применять карточку этого вида (и после перезагрузки); название вида попадает в настройки автономии, «Входящие» и журнал (`kind.<kind>`) | `public-api.ts` → `core/inbox.ts` |
| `propose(p)` | предложение по уровням автономии (`auto` / `notify` / `inbox` / `ask` / `off`, по умолчанию — `p.fallback`); применяется через зарегистрированный applier; без applier — `'skipped'`. Модуль карточки — `dramatis`; `ttlMs` — срок жизни карточки во «Входящих» | `public-api.ts` → `core/autonomy.ts` |
| `journal.record(a)` | запись журнала (модуль `dramatis`), возвращает id | `core/journal.ts` |
| `journal.registerUndo(target, fn)` | откат изменений этой цели; Maestro спрашивает текущий обработчик Dramatis (нет — откат не удался). Цели показываются как «Dramatis», значения — под «Подробнее» | `public-api.ts` |
| `notice(text, {importance, action})` | уведомление Maestro (`info` по умолчанию) | `ui` |
| `onTurn(fn)` | события хода Maestro (ниже); возвращает снятие | `core/turn.ts` → `core/bus.ts` |
| `names.resolve(name)` | сущность модели мира: `{ id, name, aliases, forms }`; формы — склонения из модели мира, а если их нет — из DES-RU 0.8 | `features/world` |
| `names.same(a, b)` | один ли это человек в этом чате: модель мира (алиасы, карта алиасов чата, формы), иначе склонения DES-RU | `public-api.ts` |
| `present()` | кто в сцене после последнего зафиксированного хода — тот же расчёт, что у голосовых карточек: трекер DES зафиксированного ответа, без персоны и скрытых в DES, имена — как в модели мира | `domain/scene-cast.ts` |
| `speech(name)` | выжимка речи из архива CK — то, что показала бы голосовая карточка: `Speech: …` (теги LING и раздел Linguistics) и `MBTI: …`, через `readSheet` режима BunnyMo, иначе `loadWorldInfo`; работает и при выключенных голосовых карточках. Синхронно: архивы читаются в фоне (смена чата, ход, новый ответ, промах), первый вызов может вернуть `null` | `app/archive-speech.ts` |
| `quiet(fn, owner)` | заявка Dramatis на функцию Maestro (раздел 3); возвращает снятие | адаптер Dramatis |
| `styleUp(name, tags)` | «Оформить» нового персонажа с готовыми тегами BunnyMo: архив CK только с тегами, прошедшими проверку режима BunnyMo по подключённым пакам (остальные отброшены и названы в «Подробнее»), одной карточкой «Оформить» через автономию (по умолчанию — «Входящие»). `true` — применено, поставлено во «Входящие» или предложено; `false` — нельзя (нет режима BunnyMo или чата, архив у персонажа уже есть, ни один тег не прошёл, некуда записать). Паки не меняются (P13) | `features/dossier/style-up.ts` (`DossierApi.styleUpArchive`) |
| `setCanonGoals(name, goals)` | цели персонажа в поле `goals` его записи канона чата (тип «персонаж»): существующая запись дополняется, иначе создаётся новая (имя, цели, русские ключи). Пустой список очищает поле. Запись журналируется каноном с откатом. `false` — нет чата или модуля канона | `public-api.ts` → `features/canon` |

### Ошибки `llm.request`

`'not-leader'`, `'cap'`, `'no-profile'` (нет профиля или Connection Manager), `'breaker'` (профиль на паузе после трёх
сбоев подряд), `'bad-task'`, `'bad-request'` (нет сообщений), `'maestro-stopped'`, а также ошибки клиента Maestro как
есть: `'refusal'` (с `refusal: true` и текстом), `'parse'`, `'empty'`, `'aborted'`, `'transport: …'`.

### События хода (`onTurn`)

| Событие Maestro (`app.bus`) | `ApiTurnEvent` |
|---|---|
| `chat:changed { chatId }` | `{ type: 'chat:changed', chatId }` |
| `reply:ready { messageIndex, type }` — ответ дописан, DES, DES-RU и маркеры NAI его уже обработали | `{ type: 'reply:ready', messageIndex }` |
| `turn:committed { messageIndex }` — пользователь отправил сообщение, ответ перед ним зафиксирован (P14) | `{ type: 'turn:committed', messageIndex }` |
| `message:invalidated { messageIndex, reason }` — свайп, удаление, правка | `{ type: 'message:invalidated', messageIndex, reason }` |
| `generation:before` (`GenerationInfo`) — внутри перехватчика Maestro, до сканирования лорбуков | `{ type: 'generation:before', generation: info.type, dryRun, quiet }` |
| `generation:ended { type, stopped }` | `{ type: 'generation:ended', generation: type, stopped }` |

Обработчики вызываются по порядку подписки; ошибка одного не мешает остальным. `generation:before` идёт на пути
отправки: Maestro ждёт обещание обработчика не дольше 1,5 с (P15) и пишет предупреждение, если дольше.

## 3. Мост на стороне Maestro

### Тихие режимы

Заявки (`quiet`) живут в памяти адаптера; после перезапуска Maestro их нет — Dramatis заявляет снова по
`maestro-api-ready`. Функция Maestro гасится, только пока Dramatis установлен и включён, заявил её и (для частей
промпта) говорит, что этой генерации достаётся его блок (`castBlockActive()`). Настройки соседей не трогаются (P8, P11).

- **`voices`** — голосовые карточки (M15) не уходят вставкой `maestro_voices`: Dramatis выводит один общий блок, речь
  берёт из `speech()`. Если Dramatis решил про свой блок уже после производителей Maestro, карточки вынимаются из
  собранного промпта при `CHAT_COMPLETION_PROMPT_READY`. Сами карточки строятся как обычно (их видно во вкладке).
- **`ck.consistency`** — вставка CarrotKernel «Character Consistency» (`script_inject_carrot-consistency`)
  вынимается из собранного промпта тем же кодом, что у голосовых карточек (`features/voices/ck-quiet.ts`), и DES-RU
  перестаёт её перестраивать (`ck.consistencyRebuild`). При включённых голосовых карточках CK и так гасится, пока
  карточки есть (в том числе слитые с блоком Dramatis); заявка Dramatis гасит CK и без карточек. При выключенном M15 то
  же делает мост приложения (`app/dramatis-bridge.ts`) — только в настоящей генерации Maestro (не тихие запросы
  других расширений, не пробные сборки, не команды листов).
- **`bunnymo.medicineCheck`** — правило M22 «“Проверка лекарств” BunnyMo, пока привычки ведёт Dramatis»
  (`features/rules/builtin/medicine.ts`, включено по умолчанию, требует `dramatis.api`). Запись основного лорбука
  BunnyMo «💉 Master - Medicine Check» (V3.0 uid 41; узнаётся по книге — роль `bunnymo.core`, адаптер BunnyMo или
  классификация содержимого — и по заголовку или обёртке `<BunnymoTags:Master - Medicine Check>` при ключе `/^/` или
  `constant`) выключается на копии сканирования, когда **все** персонажи сцены (как в `present()`) и персона, у кого в
  архиве CK есть теги `<MED:…>` или `<REC:…>`, есть в `dependenceOwned()`. Никого с такими тегами нет, архив ещё не
  прочитан или хоть один не принадлежит Dramatis — запись остаётся. Файлы BunnyMo не меняются (P13).

### Остальное

- **Граф отношений (M19)** — `RelationsApi.engine()` и раздел «Отношения по Dramatis» во вкладке: позиции
  `stances()` (к персоне — первыми, сильные — выше), имена — канонические, с пометкой «Dramatis» и причинами. История
  DES (`all()`) с ними не смешивается.
- **Механики (M25)** — пока `replacesSocialMechanics()`, шаблоны «Отношения» (`relationships`) и «Социальные шкалы»
  (`social`) не показываются в списке шаблонов и в `MechanicsService.templates()`; механики, созданные из них раньше,
  остаются и получают пометку (`features/mechanics/dramatis.ts`).
- **Закулисье (M16)** — в досье персонажа для фоновой модели добавляется строка «Their own plans (from the personality
  engine…)» из `offscreenBrief(name)` (до шести строк); те же строки проверяются на противоречие с событием.
- **Режиссёр (M14)** — `matureAgendas()` становятся источниками поворотов вида `agenda` с весом Dramatis.
- **Проверка промпта (M38)** — слоты `dramatis_*` принадлежат `dramatis` (`DRAMATIS_SLOTS`: `dramatis_cast` → часть
  `cast`, «карточка мотивов персонажей»); любые исправления к ним — только совет «поправь в настройках Dramatis».
  Промпты соседей (M36) не меняются.
- **Архитектор (M20)** — источник бюджета `dramatis` (слот `dramatis_cast`): только замер против бюджета, Maestro блок не
  сокращает; строка видна, когда Dramatis установлен, бюджет задан или блок уходил.
- **Инспектор хода (M2)** — владелец слотов `dramatis_*` — «Dramatis».

## 4. Стенд и имитация модели

- `tools/stand/sources.mjs`: сосед `dramatis` — `../SillyTavern-Dramatis`, папка `SillyTavern-Dramatis`, ref `WORKTREE`
  (отслеживаемые и новые неигнорируемые файлы), нужны `manifest.json` и `dist/index.js`. Сосед необязательный: без
  репозитория или сборки он пропускается с предупреждением (`status` пишет `skip`). Другой ref —
  `STAND_REF_DRAMATIS=<sha|HEAD|WORKTREE>`.
- `tools/mock-llm`: запрос со схемой `dramatis_*` отвечается обработчиком `registerTask('dramatis.turn', …)` в
  `scenarios.mjs`, иначе файлом `tools/mock-llm/fixtures/dramatis/<задача>.json` (объект или массив объектов), иначе
  обходом схемы — всегда валидный объект. Подробно — в `tools/mock-llm/README.md`, раздел «Dramatis tasks».

## 5. Что нужно от Dramatis

1. Подписаться на `maestro-api-ready` и на старте проверить `globalThis.MAESTRO_API?.version === 1`; после каждого
   появления API — заново `registerTask`, `registerApplier`, `journal.registerUndo`, `quiet` (Maestro их не помнит).
2. Все задачи — `dramatis.*`, с `registerTask` для строки профиля; фоновые проходы — `background: true` и спокойно
   переживать `'not-leader'` и `'cap'`.
3. Применение предложений — только через applier: замыкания в `propose` не нужны и после перезагрузки не живут;
   `payload` должен быть JSON.
4. Свой блок — слот `dramatis_cast` (глубина 1, system, одноразовый); `castBlockActive()` — правда ровно для генераций,
   в которые блок уходит. Заявлять `voices` и `ck.consistency`, только когда включено слияние с голосовыми карточками.
5. `dependenceOwned()` — имена как в истории (Maestro сравнивает их через модель мира и формы).

## 6. Открытые вопросы

- `speech()` синхронный: первый вызов для нового персонажа может вернуть `null`, пока архив читается. Если Dramatis
  нужен гарантированный ответ к генерации, можно добавить в v1 асинхронный `speechAsync()` (только добавление).
- Бюджет архитектора для `dramatis` только измеряется: Dramatis не может его прочитать через API. Если нужен общий
  бюджет, в v1 можно добавить `budget(source)`.
- `setCanonGoals` пишет напрямую (с журналом канона), без уровней автономии: Dramatis сам решает, предлагать ли это
  через `propose`.
- У «Проверки лекарств» не учитываются отсутствующие персонажи: модель BunnyMo следит только за теми, кто в сцене.
