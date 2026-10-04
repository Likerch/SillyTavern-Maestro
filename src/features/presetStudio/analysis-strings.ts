// Strings of the Preset Studio analysis (M34 п.1, п.3, п.9). Keys `m34.an.*`; registered by install() and meant to be
// part of the presetStudio module's i18n as well.
import type { I18nParts } from '../../shared/contracts';

export const ANALYSIS_STRINGS: I18nParts = {
    en: {
        // Why an enabled block is not sent (map: `dropped`).
        'm34.an.drop.missing': 'No such block: the list entry points to a block that does not exist.',
        'm34.an.drop.systemPrompt':
            'Not sent: system_prompt is {value}, and ST sends its own blocks only when it is exactly false.',
        'm34.an.drop.trigger': 'Not sent for “{type}” generations: triggers {triggers}.',
        'm34.an.drop.triggerInvalid': 'Never sent: the triggers {triggers} name no generation type ST knows.',
        'm34.an.drop.empty': 'Empty text: ST drops empty messages.',
        'm34.an.drop.depthType': 'Not inserted: depth {value} is not an integer (ST compares it strictly).',
        'm34.an.drop.depthRange': 'Not inserted: depth {value} is outside 0…10000.',
        'm34.an.drop.role': 'Not inserted: role {value} is not system, user or assistant.',
        'm34.an.drop.noHistory': 'Not inserted: the chat history is off, and in-chat blocks live inside it.',
        'm34.an.drop.unknownMarker': 'A marker ST does not fill: nothing is sent.',
        // Remarks (map: `note`).
        'm34.an.note.movedToEnd':
            'The trigger does not fit “{type}”: ST does not drop this marker but puts it at the very end, after the history.',
        'm34.an.note.notInList': 'The marker is not in the list: ST puts its text at the very end, after the history.',
        'm34.an.note.positionString':
            'The position is the string "1": the block goes out as relative, not in the chat.',
        'm34.an.note.merged': 'Sent as one message together with: {others}.',
        'm34.an.note.mergedInjections': 'extension prompts',
        'm34.an.note.mainAnchor':
            'Main’s own text is not sent, but the before/after-Main extension prompts still land here.',
        'm34.an.note.cardOverride':
            'The character card replaces this block with its own text (card prompts are preferred).',
        // Findings.
        'm34.an.f.unsaved':
            'Unsaved changes in the working copy: blocks {prompts}, settings {keys}. Switching the preset drops them silently.',
        'm34.an.f.macroEngineOff':
            '{{if}} is used in {blocks}, but the new macro engine is off: the conditions go to the model as plain text. Turn on “Experimental Macro Engine” in User Settings.',
        'm34.an.f.history':
            'The chat history is not in the prompt ({reason}): the model sees no conversation, and in-chat blocks and extension prompts are lost too.',
        'm34.an.f.history.disabled': 'switched off',
        'm34.an.f.history.missing': 'not in the list',
        'm34.an.f.history.trigger': 'its trigger does not fit “{type}”',
        'm34.an.f.dropped': '“{name}” is on but is not sent. {reason}',
        'm34.an.f.moved': '“{name}”: {note}',
        'm34.an.f.lostMain':
            'Extension prompts before/after Main ({keys}) land nowhere: the Main block is not in the list.',
        'm34.an.f.lostChat': 'In-chat extension prompts ({keys}) land nowhere: the chat history is not in the prompt.',
        'm34.an.f.type.systemPrompt':
            '“{name}”: system_prompt is {value}. ST sends your own relative blocks only when it is exactly false.',
        'm34.an.f.type.position': '“{name}”: position {value}; ST understands only the numbers 0 and 1.',
        'm34.an.f.type.depth': '“{name}”: depth {value}; it must be an integer 0…10000.',
        'm34.an.f.type.role': '“{name}”: role {value}; it must be system, user or assistant.',
        'm34.an.f.type.order': '“{name}”: order {value} is not a number.',
        'm34.an.f.type.trigger': '“{name}”: triggers {value} are not a list, ST ignores them.',
        'm34.an.f.type.triggerValues':
            '“{name}”: the triggers {value} contain unknown types (normal, continue, impersonate, swipe, regenerate, quiet, lower case).',
        'm34.an.f.type.enabled':
            '“{name}”: the switch is stored as {value}, not true/false; ST only checks truthiness.',
        'm34.an.f.empty.whitespace': '“{name}” sends a message of spaces and line breaks only.',
        'm34.an.f.empty.outsideIf':
            '“{name}” has spaces or line breaks outside its {{if}}: with the condition false an empty message still goes out. The block must consist of {{if}}…{{/if}} only.',
        'm34.an.f.quirk.prefill':
            '{model}: the prompt ends with an assistant message ({source}). Through OpenRouter such a prefill is closed by EOS and the reply ends at once.',
        'm34.an.f.quirk.systemMerge':
            '{model}: system messages inside the history ({list}) are merged into the neighbouring turns by the provider. Use the user role for in-chat instructions.',
        'm34.an.f.quirk.assistantDepth':
            '{model}: assistant blocks at a depth ({list}) read as the model’s own earlier replies.',
        'm34.an.f.contradiction': '“{a}” and “{b}” disagree on {topic}: {left} vs {right}.',
        'm34.an.f.dupBlock.same': '“{a}” and “{b}” have the same text.',
        'm34.an.f.dupBlock.near': '“{a}” largely repeats “{b}” ({percent}%).',
        'm34.an.f.dupInjection': '“{name}” repeats the {owner} extension prompt {key} ({percent}% overlap).',
        'm34.an.f.dupLore': '“{name}” repeats the lore entry “{entry}” of {book} ({percent}% overlap).',
        'm34.an.f.heavy': '“{name}” takes {tokens} tokens, {percent}% of the preset.',
        // Sources of the final assistant message.
        'm34.an.tail.bias': '“Start Reply With”',
        'm34.an.tail.continue': 'continue with prefill',
        'm34.an.tail.block': 'block “{name}”',
        'm34.an.tail.injection': 'extension prompt {key}',
        // Contradiction topics and values.
        'm34.an.topic.pov': 'the narration person',
        'm34.an.topic.tense': 'the tense',
        'm34.an.topic.language': 'the reply language',
        'm34.an.topic.length': 'the reply length',
        'm34.an.val.not': 'not {value}',
        'm34.an.val.first': 'first person',
        'm34.an.val.second': 'second person',
        'm34.an.val.third': 'third person',
        'm34.an.val.past': 'past tense',
        'm34.an.val.present': 'present tense',
        'm34.an.val.en': 'English',
        'm34.an.val.ru': 'Russian',
        'm34.an.val.ja': 'Japanese',
        'm34.an.val.zh': 'Chinese',
        'm34.an.val.de': 'German',
        'm34.an.val.fr': 'French',
        'm34.an.val.es': 'Spanish',
        // Provider hints.
        'm34.an.hint.reasoningOff':
            'Reasoning is off: ST sends effort “none” (Minimum with “Request model reasoning” off).',
        'm34.an.hint.reasoningAuto':
            'Reasoning Effort is Auto: ST sends no effort and the provider default decides. To turn reasoning off pick Minimum and untick “Request model reasoning” — ST then sends effort “none”.',
        'm34.an.hint.reasoningHiddenOnly':
            '“Request model reasoning” is off, but through OpenRouter that only hides the reasoning: the model still thinks (effort {effort}) and you pay for it. Minimum with the box unticked turns it off.',
        'm34.an.hint.reasoningOn':
            'Reasoning is on (effort {effort}): replies are slower and cost more. For roleplay V4 Flash is usually run without reasoning.',
        'm34.an.hint.thinkingOnDirect':
            'DeepSeek API: “Request model reasoning” switches thinking itself (thinking: enabled) — it is on now.',
        'm34.an.hint.thinkingOffDirect': 'DeepSeek API: thinking is off (thinking: disabled).',
        'm34.an.hint.reasoningOther': 'Check how this source switches the model’s reasoning on and off.',
        'm34.an.hint.prefillEos':
            'Through OpenRouter an assistant message at the end (prefill, “Start Reply With”) is closed by EOS — the reply ends at once. Keep a user or system message last.',
        'm34.an.hint.prefillEosContinue':
            'Through OpenRouter an assistant message at the end is closed by EOS. “Continue prefill” is on: the continued text goes last as assistant and the continuation may end at once.',
        'm34.an.hint.prefillDirect':
            'The DeepSeek API accepts a prefill: ST sends the last assistant message as the start of the reply (prefix).',
        'm34.an.hint.systemMerge':
            'System messages inside the history are merged into the neighbouring turns: give in-chat instructions the user role and keep system blocks before the history.',
        'm34.an.hint.assistantDepth':
            'Assistant messages at a depth read as the model’s own earlier replies — use user or system for instructions.',
        'm34.an.hint.temperature':
            '{model}: a starting temperature range through OpenRouter is {min}–{max} (now {current}); verify live, providers may scale it differently.',
        'm34.an.hint.temperatureDirect':
            '{model} on the DeepSeek API: DeepSeek rescales the temperature, so the working range is higher — {min}–{max} (now {current}).',
        'm34.an.hint.temperatureOutside':
            '{model}: temperature {current} is outside the usual {min}–{max} — check that it is intended.',
        'm34.an.hint.openrouterProvider':
            'OpenRouter picks the provider itself: it may change from turn to turn, and with it the quality and the prompt cache. Pin a provider in the connection settings.',
    },
    ru: {
        'm34.an.drop.missing': 'Такого блока нет: запись в списке ссылается на несуществующий блок.',
        'm34.an.drop.systemPrompt':
            'Не уходит: system_prompt равен {value}, а свои блоки ST отправляет, только когда там строго false.',
        'm34.an.drop.trigger': 'Не уходит при генерации «{type}»: триггеры {triggers}.',
        'm34.an.drop.triggerInvalid': 'Не уходит никогда: триггеры {triggers} не называют ни одного типа генерации.',
        'm34.an.drop.empty': 'Пустой текст: пустые сообщения ST выбрасывает.',
        'm34.an.drop.depthType': 'Не вставляется: глубина {value} — не целое число (ST сравнивает строго).',
        'm34.an.drop.depthRange': 'Не вставляется: глубина {value} вне диапазона 0…10000.',
        'm34.an.drop.role': 'Не вставляется: роль {value} — не system, user и не assistant.',
        'm34.an.drop.noHistory': 'Не вставляется: история чата выключена, а блоки «в чате» живут внутри неё.',
        'm34.an.drop.unknownMarker': 'Маркер, который ST не заполняет: ничего не уходит.',
        'm34.an.note.movedToEnd':
            'Триггер не подходит к «{type}»: ST не убирает этот маркер, а ставит его в самый конец, после истории.',
        'm34.an.note.notInList': 'Маркера нет в списке: его текст ST ставит в самый конец, после истории.',
        'm34.an.note.positionString': 'Позиция записана строкой "1": блок уходит как относительный, а не «в чате».',
        'm34.an.note.merged': 'Уходит одним сообщением вместе с: {others}.',
        'm34.an.note.mergedInjections': 'вставками расширений',
        'm34.an.note.mainAnchor':
            'Свой текст Main не уходит, но вставки расширений «до/после Main» остаются на его месте.',
        'm34.an.note.cardOverride':
            'Карточка персонажа заменяет этот блок своим текстом (включён приоритет промптов карточки).',
        'm34.an.f.unsaved':
            'В рабочей копии есть несохранённые правки: блоков — {prompts}, параметров — {keys}. Любое переключение пресета молча их сотрёт.',
        'm34.an.f.macroEngineOff':
            '{{if}} есть в блоках {blocks}, а новый движок макросов выключен: условия уйдут в модель простым текстом. Включи «Experimental Macro Engine» в настройках пользователя.',
        'm34.an.f.history':
            'Истории чата нет в промпте ({reason}): модель не видит переписку, а блоки и вставки «в чате» тоже пропадают.',
        'm34.an.f.history.disabled': 'выключена',
        'm34.an.f.history.missing': 'её нет в списке',
        'm34.an.f.history.trigger': 'триггер не подходит к «{type}»',
        'm34.an.f.dropped': '«{name}» включён, но не уходит. {reason}',
        'm34.an.f.moved': '«{name}»: {note}',
        'm34.an.f.lostMain': 'Вставки расширений «до/после Main» ({keys}) никуда не попадают: блока Main нет в списке.',
        'm34.an.f.lostChat': 'Вставки расширений «в чате» ({keys}) никуда не попадают: истории чата нет в промпте.',
        'm34.an.f.type.systemPrompt':
            '«{name}»: system_prompt равен {value}. Свои относительные блоки ST отправляет, только когда там строго false.',
        'm34.an.f.type.position': '«{name}»: позиция {value}, а ST понимает только числа 0 и 1.',
        'm34.an.f.type.depth': '«{name}»: глубина {value}, а нужно целое число 0…10000.',
        'm34.an.f.type.role': '«{name}»: роль {value}, а нужна system, user или assistant.',
        'm34.an.f.type.order': '«{name}»: порядок {value} — не число.',
        'm34.an.f.type.trigger': '«{name}»: триггеры {value} записаны не списком, ST их не учитывает.',
        'm34.an.f.type.triggerValues':
            '«{name}»: в триггерах {value} есть неизвестные типы (нужны normal, continue, impersonate, swipe, regenerate, quiet в нижнем регистре).',
        'm34.an.f.type.enabled':
            '«{name}»: включение записано как {value}, а не true/false — ST смотрит только на «истинность».',
        'm34.an.f.empty.whitespace': '«{name}» отправит сообщение из одних пробелов и переводов строк.',
        'm34.an.f.empty.outsideIf':
            '«{name}»: снаружи {{if}} остались пробелы или переводы строк — при ложном условии всё равно уйдёт пустое сообщение. Блок должен целиком состоять из {{if}}…{{/if}}.',
        'm34.an.f.quirk.prefill':
            '{model}: промпт кончается сообщением assistant ({source}). Через OpenRouter такой префилл закрывается EOS, и ответ обрывается сразу.',
        'm34.an.f.quirk.systemMerge':
            '{model}: системные сообщения посреди истории ({list}) провайдер склеивает с соседними репликами. Для указаний «в чате» лучше роль user.',
        'm34.an.f.quirk.assistantDepth':
            '{model}: блоки с ролью assistant на глубине ({list}) выглядят как прошлые ответы самой модели.',
        'm34.an.f.contradiction': '«{a}» и «{b}» расходятся: {topic} — {left} против {right}.',
        'm34.an.f.dupBlock.same': 'У «{a}» и «{b}» одинаковый текст.',
        'm34.an.f.dupBlock.near': '«{a}» почти целиком повторяет «{b}» ({percent}%).',
        'm34.an.f.dupInjection': '«{name}» повторяет вставку {owner} {key} (совпадение {percent}%).',
        'm34.an.f.dupLore': '«{name}» повторяет запись лора «{entry}» из книги {book} (совпадение {percent}%).',
        'm34.an.f.heavy': '«{name}» занимает {tokens} токенов — {percent}% пресета.',
        'm34.an.tail.bias': '«Начинать ответ с»',
        'm34.an.tail.continue': 'продолжение с префиллом',
        'm34.an.tail.block': 'блок «{name}»',
        'm34.an.tail.injection': 'вставка {key}',
        'm34.an.topic.pov': 'лицо повествования',
        'm34.an.topic.tense': 'время повествования',
        'm34.an.topic.language': 'язык ответа',
        'm34.an.topic.length': 'длина ответа',
        'm34.an.val.not': 'не {value}',
        'm34.an.val.first': 'первое лицо',
        'm34.an.val.second': 'второе лицо',
        'm34.an.val.third': 'третье лицо',
        'm34.an.val.past': 'прошедшее время',
        'm34.an.val.present': 'настоящее время',
        'm34.an.val.en': 'английский',
        'm34.an.val.ru': 'русский',
        'm34.an.val.ja': 'японский',
        'm34.an.val.zh': 'китайский',
        'm34.an.val.de': 'немецкий',
        'm34.an.val.fr': 'французский',
        'm34.an.val.es': 'испанский',
        'm34.an.hint.reasoningOff':
            'Рассуждения выключены: ST отправляет effort «none» («Минимум» при снятой галочке «Request model reasoning»).',
        'm34.an.hint.reasoningAuto':
            'Reasoning Effort = Auto: ST не отправляет effort, решает умолчание провайдера. Чтобы выключить рассуждения, выбери «Минимум» и сними «Request model reasoning» — тогда ST отправит effort «none».',
        'm34.an.hint.reasoningHiddenOnly':
            'Галочка «Request model reasoning» снята, но через OpenRouter это только прячет рассуждения: модель всё равно думает (effort {effort}), и это оплачивается. Выключает их «Минимум» при снятой галочке.',
        'm34.an.hint.reasoningOn':
            'Рассуждения включены (effort {effort}): ответы медленнее и дороже. Для ролевой игры V4 Flash обычно запускают без рассуждений.',
        'm34.an.hint.thinkingOnDirect':
            'API DeepSeek: галочка «Request model reasoning» включает само мышление (thinking: enabled) — сейчас оно включено.',
        'm34.an.hint.thinkingOffDirect': 'API DeepSeek: мышление выключено (thinking: disabled).',
        'm34.an.hint.reasoningOther': 'Проверь, как этот источник включает и выключает рассуждения модели.',
        'm34.an.hint.prefillEos':
            'Через OpenRouter сообщение assistant в конце (префилл, «Начинать ответ с») закрывается EOS — ответ обрывается сразу. Последним должно идти сообщение user или system.',
        'm34.an.hint.prefillEosContinue':
            'Через OpenRouter сообщение assistant в конце закрывается EOS. Включён «Continue prefill»: продолжаемый текст уходит последним сообщением assistant, и продолжение может оборваться сразу.',
        'm34.an.hint.prefillDirect':
            'API DeepSeek принимает префилл: ST отправляет последнее сообщение assistant как начало ответа (prefix).',
        'm34.an.hint.systemMerge':
            'Системные сообщения посреди истории провайдер склеивает с соседними репликами: указания «в чате» давай с ролью user, а системные блоки держи до истории.',
        'm34.an.hint.assistantDepth':
            'Сообщения assistant на глубине модель принимает за свои прошлые ответы — для указаний бери user или system.',
        'm34.an.hint.temperature':
            '{model}: начальный диапазон температуры через OpenRouter — {min}–{max} (сейчас {current}); проверь вживую, у провайдеров шкала может отличаться.',
        'm34.an.hint.temperatureDirect':
            '{model} через API DeepSeek: DeepSeek пересчитывает температуру, поэтому рабочий диапазон выше — {min}–{max} (сейчас {current}).',
        'm34.an.hint.temperatureOutside':
            '{model}: температура {current} вне обычного диапазона {min}–{max} — проверь, так ли задумано.',
        'm34.an.hint.openrouterProvider':
            'OpenRouter сам выбирает провайдера: от хода к ходу он может смениться, а с ним качество и кэш промпта. Закрепи провайдера в настройках подключения.',
    },
};
