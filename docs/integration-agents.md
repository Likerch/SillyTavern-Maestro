# Агенты для соседей: `MAESTRO_API.agents` и `context`

> Maestro 1.34.0. План — [`agents-plan.md`](agents-plan.md) §4.10. Тип целиком — `ApiAgents`, `ApiContext` и соседние
> типы в [`src/shared/public-api-types.ts`](../src/shared/public-api-types.ts) (файл самодостаточный, его можно
> копировать к себе). Общие правила API — [`integration-dramatis.md`](integration-dramatis.md),
> [`integration-officina.md`](integration-officina.md).

Окно «Агенты» показывает все задачи, ради которых что-то в стеке зовёт модель: свои агенты пользователя, встроенные
агенты Maestro и — с 1.34 — встроенные агенты соседей. Пользователь видит поручение, дописывает «Дополнительные
указания» или правит весь текст, меняет модель и её параметры, видит журнал запусков. Логика задачи остаётся у соседа:
Maestro не знает, что сосед делает с ответом.

## 1. Как узнать, что есть

`MAESTRO_API.features` содержит `'agents'`; `MAESTRO_API.agents` и `MAESTRO_API.context` — объекты. Нет — Maestro старше
1.34 или модуль «Агенты» выключен (тогда регистрации ничего не делают, но и не падают).

Все id, виды и источники — с префиксом соседа: `dramatis.`, `officina.`, `nai.`, `localizer.`. Без префикса вызов
бросает ошибку `MAESTRO_API.agents: …`.

## 2. Встроенный агент соседа: `agents.registerBuiltIn(spec)`

```ts
const off = MAESTRO_API.agents.registerBuiltIn({
    id: 'dramatis.turn',
    title: { ru: 'Ход персонажа', en: 'Character turn' },
    when: { ru: 'после каждого ответа', en: 'after every reply' },
    description: { ru: 'Что персонажи хотели и что вышло…', en: '…' },
    sources: { ru: 'ответ, каст, профили', en: 'the reply, the cast, the profiles' },
    icon: 'fa-masks-theater',
    defaultInstructions: () => [TURN_SYSTEM_PROMPT],
    defaults: { maxTokens: 1600, temperature: 0.4 },
    // по желанию:
    enabled: () => settings.turn.enabled,
    setEnabled: (on) => { settings.turn.enabled = on; save(); },
    knobs: [{ id: 'every', label: { ru: 'Каждые N ответов', en: 'Every N replies' }, kind: 'number', min: 1, max: 10,
              get: () => settings.every, set: (v) => { settings.every = Number(v); save(); } }],
});
```

- **Канал Maestro** (`channel` не задан или `'maestro'`): сосед шлёт запросы как раньше, через
  `MAESTRO_API.llm.request({ task: 'dramatis.turn', … })`. Maestro находит в системном сообщении текст из
  `defaultInstructions` и ставит на его место то, что сделал пользователь (дописка — блоком «Additional instructions»
  после текста; весь текст — вместо него), подставляет температуру, длину, рассуждения и профиль. Ничего не менял —
  запрос уходит тем же объектом. Каждый запрос попадает в журнал запусков чата.
- **Свой канал** (`channel: 'own'`, решение В11: NAI Studio, Localizer): Maestro запросов не видит. Перед запросом сосед
  спрашивает `agents.instruction(id, defaultText)` → `{ text, temperature?, maxTokens?, reasoning? }` (ничего не менялось
  — `{ text: defaultText }`), после — сообщает `agents.report(id, { ok, ms, error?, costUsd?, tokens?, request?, raw? })`.
  Профиль модели в карточке такого агента не выбирается: модель выбирается у соседа.
- Слова (`title`, `when`, …) нужны на обоих языках; одно из двух можно опустить — возьмётся другое.
- `defaultInstructions` должен вернуть хотя бы один текст — именно тот, что стоит в запросе. Если текст зависит от языка
  или настройки — все варианты; показывается первый.
- Агент живёт в группе «Соседи» окна «Агенты». Снятие (`off()`) убирает его; при выключении Maestro регистрации
  снимаются сами.

## 3. Приёмник предложений: `agents.registerReceiver(receiver)`

Агенты пользователя с результатом «Предложения» могут предлагать изменения в хранилище соседа (Dramatis: профиль
персонажа). Приёмник описывает один элемент ответа:

```ts
MAESTRO_API.agents.registerReceiver({
    kind: 'dramatis.profile',
    label: { ru: 'Профиль Dramatis', en: 'Dramatis profile' },
    describe: 'fill empty fields of a character profile: name; fields: {field: value} …',  // для модели, англ.
    schema: { type: 'object', properties: { name: { type: 'string' }, fields: { type: 'object' } }, required: ['name'] },
    defaultAutonomy: 'inbox',                     // 'auto' | 'notify' | 'inbox' | 'ask' | 'off'
    available: ({ messageIndex }) => true,       // по желанию: «сейчас не нужен» — агент не запускается
    toProposal: (data, { agentName, messageIndex }) =>
        known(data.name) ? { title: `Профиль: ${data.name}`, payload: data, changes: [...] } : null,
    apply: async (payload) => { /* записать, журнал — свой */ },
});
```

- Предложение идёт через автономию Maestro: «Само», «Сообщить», «Во входящие», «Спросить». Карточки «Входящих»
  переживают перезагрузку: `apply(payload)` получает сохранённый `payload`.
- `changes` — записи журнала с целями соседа (`dramatis-…`); откат — через `MAESTRO_API.journal.registerUndo`.
- `direct: true` — применить сразу, без автономии (трекер); тогда сосед журналирует сам.
- `kind` приёмника — отдельный вид; не путать с видами `propose` / `registerApplier`.

## 4. Источник контекста: `context.register(source)`

```ts
MAESTRO_API.context.register({
    id: 'dramatis.cast',
    title: 'Cast: motives and goals of those present',   // для модели, англ.
    label: { ru: 'Каст Dramatis', en: 'Dramatis cast' },
    budget: 1500,                                        // символов по умолчанию
    stable: false,
    available: () => castReady(),
    render: ({ agentId, focusIndex, budget }) => castText(focusIndex).slice(0, budget),
});
```

Источник появляется в списке «Что видит» редактора агента. `render` может вернуть `Promise`; ошибка или не-строка — пустой
источник.

## 5. Свои агенты и наборы (Officina, авторы)

- `agents.list()` — свои агенты пользователя: `{ id, name, builtin: false, phase, result, on }`.
- `agents.get(id)` — копия определения агента; `agents.save(def)` — создать или изменить (проверка как у редактора,
  журнал с откатом), ответ — id или `null`.
- `agents.setEnabled(id, on, scope?)` — включить в области `'global' | 'character' | 'chat'` (по умолчанию везде).
- `agents.sets()`, `agents.saveSet(set)` (встроенные наборы не перезаписываются), `agents.applySet(setId, scope?)`.
- `agents.run(id, { messageIndex? })` — запустить сейчас; `agents.onResult(fn)` — каждый законченный запуск чата
  (`{ agentId, agentName, ok, builtin, messageIndex?, applied, error?, at }`).
- Агенты карточки: Officina кладёт определения в `data.extensions.maestro.agents` карточки; Maestro при открытии чата
  спрашивает пользователя, брать ли их (как с 1.28).

## 6. Что сделано у соседей в 1.34

| Сосед | Что |
|---|---|
| Dramatis 1.8 | шесть задач — встроенные агенты на канале Maestro; каст — источник `dramatis.cast`; приёмник `dramatis.profile` |
| Localizer 0.6 | «Расширить мир» — встроенный агент на своём канале (`localizer.expand`) |
| Officina 0.9 | агенты и наборы в проекте и в выпущенной карточке; «Перенести в механики» из «Своей механики» |
