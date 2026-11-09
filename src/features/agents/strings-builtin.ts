// Strings of the built-in agents (`m44.bi.*`, release 1.29): the agent of each Maestro task — its name, what it does,
// when it runs, what its module gives it — and the labels of the module settings shown in its card.
import type { I18nParts } from '../../shared/contracts';

interface Entry {
    title: string;
    desc: string;
    when: string;
    sources: string;
    knobs?: Record<string, string>;
}

const RU: Record<string, Entry> = {
    revision: {
        title: 'Ревизия канона',
        desc: 'Читает недавние ходы и замечает, что в истории изменилось: факты о персонажах, местах, одежде, сроках, знаниях. Изменения идут в канон и соседние хранилища через автономию и «Входящие».',
        when: 'Когда накопились сигналы, раз в N сообщений и в конце сцены; в фоне.',
        sources:
            'Модуль собирает сам: сообщения с прошлой ревизии, сигналы, память Qvink, известных персонажей и словарь мира. Форма ответа — список изменений с уверенностью.',
        knobs: {
            everyMessages: 'Раз в N сообщений (0 — не по счёту)',
            signalThreshold: 'Сигналов, чтобы запустить',
            sceneEnd: 'В конце сцены',
            minConfidence: 'Порог уверенности (0–1)',
        },
    },
    'living.extract': {
        title: 'Живой канон',
        desc: 'Находит то, что рассказчик придумал по ходу (таверны, обычаи, вещи, фракции), и пишет это в канон — сначала пробно, потом насовсем.',
        when: 'Раз в N сообщений; в фоне.',
        sources: 'Последние 30 сообщений, пробные факты и всё, что мир уже знает (канон, лор, персонажи).',
        knobs: {
            extractEvery: 'Раз в N сообщений (0 — только вручную)',
            maxPerTurn: 'Новых фактов за раз',
            surviveTurns: 'Ходов до закрепления пробного факта',
        },
    },
    offscreen: {
        title: 'Закулисье',
        desc: 'Решает, что делали важные персонажи, пока их не было в сцене; события — в канон, смерть и плен — во «Входящие», присутствующие могут упомянуть слух.',
        when: 'Раз в N ходов (в «Экономном» — никогда) и, если включено, в конце сцены; в фоне.',
        sources: 'Отсутствующие персонажи с их каноном и отношениями, время, места, последние события.',
        knobs: {
            'every.balanced': 'Раз в N ходов («Сбалансированный»)',
            'every.cinema': 'Раз в N ходов («Кино»)',
            'sceneEnd.cinema': 'В конце сцены («Кино»)',
            maxCharacters: 'Персонажей за раз',
            minAbsentTurns: 'Ходов отсутствия, чтобы зайти',
            rumours: 'Слухи у присутствующих',
        },
    },
    'chronicle.recap': {
        title: 'Пересказ «Ранее в истории…»',
        desc: 'Когда возвращаешься после перерыва — короткий пересказ того, что было. По умолчанию собирается без модели, из памяти; модель — если выбрать «ИИ».',
        when: 'Когда открываешь чат после перерыва.',
        sources: 'Главы летописи, долгая память Qvink и последние события.',
        knobs: {
            'recap.source': 'Как писать',
            'recap.source.memory': 'из памяти (без модели)',
            'recap.source.ai': 'ИИ',
            'recap.afterHours': 'Перерыв — это (часов)',
            'recap.target': 'Куда',
            'recap.target.user': 'только тебе',
            'recap.target.userAndPrompt': 'тебе и в промпт',
            'recap.target.off': 'никуда',
        },
    },
    'quality.judge': {
        title: 'Судья качества',
        desc: 'Решает, брак ли то, что заподозрили бесплатные правила: смягчение, извинения, «говорит за игрока», повтор, обрыв.',
        when: 'После ответа, только когда правило не уверено; не в «Экономном».',
        sources: 'Ответ, последние сообщения, имена, язык и пронумерованные подозрения правил.',
    },
    'director.scene': {
        title: 'Режиссёр: тип сцены',
        desc: 'Определяет тип сцены (разговор, бой, близость…), когда правила колеблются между двумя.',
        when: 'После ответа, только при сомнении правил; не в «Экономном».',
        sources: 'Ответ, твоё сообщение, место и кто в сцене.',
    },
    'mechanics.extract': {
        title: 'Учёт механик',
        desc: 'Читает из ответа изменения значений механик (урон, трата маны, деньги, отношение), когда основная модель не написала блок или значения ведутся фоном.',
        when: 'После каждого зафиксированного ответа, где это нужно; в фоне.',
        sources: 'Ответ, твоё действие, правила механик и текущие значения.',
    },
    'contradictions.check': {
        title: 'Сверка противоречий',
        desc: 'Проверяет новое утверждение против канона и лора, когда правила подозревают противоречие. Служебный: его зовут ревизия, живой канон и закулисье.',
        when: 'По вызову других модулей.',
        sources: 'Утверждение, сущности и записи, с которыми оно может спорить.',
    },
    'dossier.compare': {
        title: 'Досье: сверить с ИИ',
        desc: 'Сравнивает сведения о персонаже из разных книг и находит расхождения.',
        when: 'По кнопке «Сверить с ИИ» в досье.',
        sources: 'Фрагменты лора о персонаже.',
    },
    'dossier.styleUp': {
        title: 'Досье: оформить',
        desc: 'Делает из досье архив BunnyMo: теги из словаря и текст.',
        when: 'По кнопке «Оформить» в досье.',
        sources: 'Что известно о персонаже и словарь тегов BunnyMo.',
    },
    'lorePassports.generate': {
        title: 'Паспорта записей',
        desc: 'Пишет паспорт NAI для записи лора (запасной путь, основной — генератор NAI Studio).',
        when: 'По кнопке в «Паспортах записей».',
        sources: 'Название, тип и текст записи.',
    },
    'promptAudit.ai': {
        title: 'Проверка промпта ИИ',
        desc: 'Ищет противоречия между инструкциями промпта: пресет, карточка, вставки расширений.',
        when: 'По кнопке «Проверить с ИИ».',
        sources: 'Карта инструкций промпта этого хода.',
    },
    'persona.create': {
        title: 'Персона для персонажа',
        desc: 'Создаёт персонажа игрока под карточку.',
        when: 'По кнопке «Создать персону».',
        sources: 'Карточка, что она говорит о {{user}}, лор, твои пожелания.',
    },
    'wardrobe.change': {
        title: 'Гардероб: переодевание',
        desc: 'Понимает, во что переоделись, когда детектор без модели не разобрал («переодеваюсь»).',
        when: 'После ответа на сообщение со сменой одежды, которую не понял детектор; в фоне.',
        sources: 'Отрывок с переодеванием, кто во что был одет, известные наряды.',
    },
    'wardrobe.persona': {
        title: 'Гардероб: твоя одежда',
        desc: 'Следит, во что одет твой персонаж, по тексту истории.',
        when: 'Раз в N ходов, если упоминалась одежда и переодевание по сообщениям выключено; в фоне.',
        sources: 'Последние сообщения и что известно о твоей одежде.',
        knobs: { personaEvery: 'Раз в N ходов' },
    },
};

const EN: Record<string, Entry> = {
    revision: {
        title: 'Canon revision',
        desc: 'Reads recent turns and notices what changed in the story: facts about characters, places, clothes, deadlines, knowledge. Changes go to the canon and the other stores through autonomy and the Inbox.',
        when: 'When signals pile up, every N messages and at scene ends; in the background.',
        sources:
            'The module gathers it: messages since the last revision, signals, Qvink memory, known characters and the world vocabulary. The answer form is a list of changes with confidence.',
        knobs: {
            everyMessages: 'Every N messages (0 — not by count)',
            signalThreshold: 'Signals to start',
            sceneEnd: 'At scene end',
            minConfidence: 'Confidence threshold (0–1)',
        },
    },
    'living.extract': {
        title: 'Living canon',
        desc: 'Finds what the narrator invented on the way (taverns, customs, items, factions) and writes it into the canon — provisionally first.',
        when: 'Every N messages; in the background.',
        sources: 'The last 30 messages, provisional facts and everything the world already knows.',
        knobs: {
            extractEvery: 'Every N messages (0 — manual only)',
            maxPerTurn: 'New facts per run',
            surviveTurns: 'Turns until a provisional fact holds',
        },
    },
    offscreen: {
        title: 'Backstage',
        desc: 'Decides what important characters did while away; events go to the canon, deaths and captivity to the Inbox, present characters may mention a rumour.',
        when: 'Every N turns (never in Economy) and, when on, at scene ends; in the background.',
        sources: 'Absent characters with their canon and relations, time, places, recent events.',
        knobs: {
            'every.balanced': 'Every N turns (Balanced)',
            'every.cinema': 'Every N turns (Cinema)',
            'sceneEnd.cinema': 'At scene end (Cinema)',
            maxCharacters: 'Characters per run',
            minAbsentTurns: 'Turns away before a visit',
            rumours: 'Rumours among the present',
        },
    },
    'chronicle.recap': {
        title: '«Previously…» recap',
        desc: 'A short recap when you come back after a break. Built from memory without a model by default; the model when «AI» is chosen.',
        when: 'When you open the chat after a break.',
        sources: 'Chronicle chapters, Qvink long memory and the latest events.',
        knobs: {
            'recap.source': 'How to write it',
            'recap.source.memory': 'from memory (no model)',
            'recap.source.ai': 'AI',
            'recap.afterHours': 'A break is (hours)',
            'recap.target': 'Where',
            'recap.target.user': 'to you only',
            'recap.target.userAndPrompt': 'to you and the prompt',
            'recap.target.off': 'nowhere',
        },
    },
    'quality.judge': {
        title: 'Quality judge',
        desc: 'Decides whether what the free rules suspected is a defect: softening, apologies, speaking for the player, repetition, a cut-off.',
        when: 'After a reply, only when a rule is unsure; not in Economy.',
        sources: 'The reply, recent messages, names, language and the numbered suspicions.',
    },
    'director.scene': {
        title: 'Director: scene type',
        desc: 'Tells the scene type (dialogue, combat, intimacy…) when the rules hesitate between two.',
        when: 'After a reply, only when the rules hesitate; not in Economy.',
        sources: 'The reply, your message, the place and who is in the scene.',
    },
    'mechanics.extract': {
        title: 'Mechanics tracking',
        desc: 'Reads changes of mechanic values from the reply (damage, mana, money, attitude) when the main model wrote no block or values are tracked in the background.',
        when: 'After every committed reply that needs it; in the background.',
        sources: "The reply, your action, the mechanics' rules and current values.",
    },
    'contradictions.check': {
        title: 'Contradiction check',
        desc: 'Checks a new statement against the canon and the lore when the rules suspect a contradiction. A helper called by revision, living canon and backstage.',
        when: 'When other modules call it.',
        sources: 'The statement, the entities and the entries it may contradict.',
    },
    'dossier.compare': {
        title: 'Dossier: compare with AI',
        desc: 'Compares what different books say about a character and finds disagreements.',
        when: 'By the «Compare with AI» button in the dossier.',
        sources: 'Lore snippets about the character.',
    },
    'dossier.styleUp': {
        title: 'Dossier: style up',
        desc: 'Turns a dossier into a BunnyMo archive: tags from the vocabulary and prose.',
        when: 'By the «Style up» button in the dossier.',
        sources: 'What is known about the character and the BunnyMo tag vocabulary.',
    },
    'lorePassports.generate': {
        title: 'Entry passports',
        desc: "Writes an NAI passport for a lore entry (the fallback; NAI Studio's generator is the main way).",
        when: 'By the button in «Entry passports».',
        sources: "The entry's name, type and text.",
    },
    'promptAudit.ai': {
        title: 'Prompt audit with AI',
        desc: "Looks for conflicts between the prompt's instructions: preset, card, extension injections.",
        when: 'By the «Check with AI» button.',
        sources: "The map of the instructions of this turn's prompt.",
    },
    'persona.create': {
        title: 'Persona for a character',
        desc: "Creates the player's character for a card.",
        when: 'By the «Create a persona» button.',
        sources: 'The card, what it says about {{user}}, the lore, your wishes.',
    },
    'wardrobe.change': {
        title: 'Wardrobe: change of clothes',
        desc: 'Understands what someone changed into when the free detector could not tell («I change»).',
        when: 'After a reply to a message with a change of clothes the detector did not understand; in the background.',
        sources: 'The excerpt, what everyone wore, the known outfits.',
    },
    'wardrobe.persona': {
        title: 'Wardrobe: your clothes',
        desc: 'Keeps track of what your character wears from the story.',
        when: 'Every N turns when clothes were mentioned and message-based changes are off; in the background.',
        sources: 'Recent messages and what is known about your clothes.',
        knobs: { personaEvery: 'Every N turns' },
    },
};

function expand(table: Record<string, Entry>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(table)) {
        out[`m44.bi.${id}.title`] = entry.title;
        out[`m44.bi.${id}.desc`] = entry.desc;
        out[`m44.bi.${id}.when`] = entry.when;
        out[`m44.bi.${id}.sources`] = entry.sources;
        for (const [path, label] of Object.entries(entry.knobs ?? {})) out[`m44.bi.${id}.knob.${path}`] = label;
    }
    return out;
}

export const BUILTIN_STRINGS: I18nParts = {
    en: {
        ...expand(EN),
        'kind.agents.builtin': 'Built-in agent changes',
        'target.agent-builtin': 'Built-in agent',
        'm44.bi.heading': 'Built-in agents',
        'm44.bi.hint':
            "Maestro's own model tasks. Their instruction, model and frequency are yours to change; what they collect and how Maestro applies the answer stay in code, so an edited instruction cannot break them.",
        'm44.bi.builtin': 'built-in',
        'm44.bi.changed': 'changed',
        'm44.bi.toggleHint': "On / off (the module's own setting)",
        'm44.bi.noSwitch': 'Works whenever its module needs it',
        'm44.biGroup.canon': 'Canon and memory',
        'm44.biGroup.story': 'Story and direction',
        'm44.biGroup.quality': 'Quality',
        'm44.biGroup.world': 'World and wardrobe',
        'm44.biGroup.mechanics': 'Mechanics',
        'm44.biGroup.button': 'By button',
        'm44.bi.reset': 'Back to default',
        'm44.bi.resetBody':
            "Return the instruction and the model parameters to Maestro's defaults? The profile and the module settings stay.",
        'm44.bi.instructionHint':
            "By default the agent works with Maestro's text. «Additional instructions» add your lines after it; «The whole text» replaces it. The answer form stays Maestro's.",
        'm44.bi.mode': 'Instruction',
        'm44.bi.mode.default': 'Default',
        'm44.bi.mode.addition': 'Additional instructions',
        'm44.bi.mode.full': 'The whole text',
        'm44.bi.addition': 'Additional instructions',
        'm44.bi.additionHint': "Your lines go right after Maestro's text. Write in any language.",
        'm44.bi.additionPlaceholder': 'e.g. «An apology for violence in a dark scene is a defect.»',
        'm44.bi.full': 'The whole text',
        'm44.bi.fullHint':
            "Replaces Maestro's text in the request. Keep it about the same job: the answer form is added by Maestro.",
        'm44.bi.defaultChanged': "Maestro's default text changed since you made yours. What changed:",
        'm44.bi.takeNew': 'Take the new text',
        'm44.bi.keepMine': 'Keep mine',
        'm44.bi.defaultText': "Maestro's text",
        'm44.bi.profileDefault': 'As Maestro decides (default profile)',
        'm44.bi.profileHint': 'The same row as in «Connection profiles».',
        'm44.bi.emptyDefault': "Empty — Maestro's value.",
        'm44.bi.reasoningDefault': 'As Maestro decides',
        'm44.bi.on': 'On',
        'm44.bi.noKnobs': 'No settings of its own.',
        'm44.bi.knobsHint': "These are the module's own settings: they change in its section too.",
        'm44.bi.sourcesHint': 'A built-in agent sees what its module collects; it cannot be changed here.',
        'm44.bi.noRuns': 'No runs in this chat yet.',
        'm44.bi.lastRun': 'Last run: {time}, {status}, ${cost}.',
        'm44.bi.checkHint':
            "The request exactly as it went out (with your instruction). A test run of a built-in agent is its module's own button or the next turn.",
        'm44.journal.builtin': 'Built-in agent «{name}» changed',
        'm44.journal.builtinReset': 'Built-in agent «{name}» back to default',
    },
    ru: {
        ...expand(RU),
        'kind.agents.builtin': 'Изменения встроенных агентов',
        'target.agent-builtin': 'Встроенный агент',
        'm44.bi.heading': 'Встроенные агенты',
        'm44.bi.hint':
            'Задачи модели, которые Maestro и так делает. Поручение, модель и частоту меняешь ты; что они собирают и как Maestro применяет ответ — в коде, поэтому правка поручения их не сломает.',
        'm44.bi.builtin': 'встроенный',
        'm44.bi.changed': 'изменён',
        'm44.bi.toggleHint': 'Вкл / выкл (собственная настройка модуля)',
        'm44.bi.noSwitch': 'Работает, когда нужен своему модулю',
        'm44.biGroup.canon': 'Канон и память',
        'm44.biGroup.story': 'Сюжет и режиссура',
        'm44.biGroup.quality': 'Качество',
        'm44.biGroup.world': 'Мир и гардероб',
        'm44.biGroup.mechanics': 'Механики',
        'm44.biGroup.button': 'По кнопке',
        'm44.bi.reset': 'Вернуть как было',
        'm44.bi.resetBody':
            'Вернуть поручение и параметры модели к тем, что у Maestro по умолчанию? Профиль и настройки модуля останутся.',
        'm44.bi.instructionHint':
            'По умолчанию агент работает с текстом Maestro. «Дополнительные указания» добавляют твои строки после него, «Весь текст» заменяет его. Форма ответа остаётся за Maestro.',
        'm44.bi.mode': 'Поручение',
        'm44.bi.mode.default': 'По умолчанию',
        'm44.bi.mode.addition': 'Дополнительные указания',
        'm44.bi.mode.full': 'Весь текст',
        'm44.bi.addition': 'Дополнительные указания',
        'm44.bi.additionHint': 'Твои строки встанут сразу после текста Maestro. Можно писать по-русски.',
        'm44.bi.additionPlaceholder': 'например: «Брак — если персонаж извиняется за насилие в тёмной сцене.»',
        'm44.bi.full': 'Весь текст',
        'm44.bi.fullHint': 'Заменяет текст Maestro в запросе. Держись той же работы: форму ответа Maestro добавит сам.',
        'm44.bi.defaultChanged': 'Текст Maestro по умолчанию изменился с тех пор, как ты сделал свой. Что поменялось:',
        'm44.bi.takeNew': 'Взять новый текст',
        'm44.bi.keepMine': 'Оставить свой',
        'm44.bi.defaultText': 'Текст Maestro',
        'm44.bi.profileDefault': 'Как решит Maestro (профиль по умолчанию)',
        'm44.bi.profileHint': 'Та же строка, что в «Профилях подключения».',
        'm44.bi.emptyDefault': 'Пусто — значение Maestro.',
        'm44.bi.reasoningDefault': 'Как решит Maestro',
        'm44.bi.on': 'Включён',
        'm44.bi.noKnobs': 'Своих настроек нет.',
        'm44.bi.knobsHint': 'Это настройки самого модуля: они меняются и в его разделе.',
        'm44.bi.sourcesHint': 'Встроенный агент видит то, что собирает его модуль; здесь это не меняется.',
        'm44.bi.noRuns': 'В этом чате запусков ещё не было.',
        'm44.bi.lastRun': 'Последний запуск: {time}, {status}, ${cost}.',
        'm44.bi.checkHint':
            'Запрос ровно таким, каким он ушёл (с твоим поручением). Пробный запуск встроенного агента — кнопка его модуля или следующий ход.',
        'm44.journal.builtin': 'Изменён встроенный агент «{name}»',
        'm44.journal.builtinReset': 'Встроенный агент «{name}» возвращён к умолчаниям',
    },
};
