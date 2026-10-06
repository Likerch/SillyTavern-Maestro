// Strings of M36 «Промпты соседей» (keys `m36.*`, plus the labels of its journal kinds and targets).
import type { I18nParts } from '../../shared/contracts';

/** Label and one-sentence description of every registry entry (descriptors.ts ids). */
const ENTRIES_EN: Record<string, [string, string]> = {
    'des.tracker': [
        'DES tracker instruction (whole)',
        'The whole block that asks the model for the tracker JSON. Empty: DES builds it from its tracker settings.',
    ],
    'des.trackerInstructions': [
        'DES tracker rules',
        'How the model fills the tracker (inside the tracker block; not used while the whole block is overridden).',
    ],
    'des.trackerContinuation': [
        'DES: continue after the tracker',
        'What the model does after the tracker JSON: continue the story with the tracker in mind.',
    ],
    'des.html': ['DES immersive HTML', 'Lets the model add HTML/CSS pieces (letters, screens, signs) to replies.'],
    'des.dialogueColoring': [
        'DES dialogue colours',
        'Asks the model to colour every speaker’s lines with their own colour.',
    ],
    'des.contextInstructions': [
        'DES scene context',
        'Tells the model how to use the scene summary DES puts before the last message.',
    ],
    'des.narrator': ['DES narrator mode', 'Tells the model to find out who is in the scene from the story itself.'],
    'nai.markers': [
        'NAI Studio picture rules',
        'Asks the chat model to place picture markers in replies (how many, how to describe them).',
    ],
    'qvink.prompt': ['Qvink summary prompt', 'How Qvink asks the model to retell one message for its memory.'],
    'qvink.shortTemplate': [
        'Qvink: recent events header',
        'The line Qvink puts before its recent memories in the prompt.',
    ],
    'qvink.longTemplate': [
        'Qvink: past events header',
        'The line Qvink puts before its long-term memories in the prompt.',
    ],
    'desru.languageLock': [
        'DES-RU language rule',
        'Tells the model that the role-play is in Russian while BunnyMo’s English instructions are in the prompt.',
    ],
    'ck.consistency': [
        'CarrotKernel character data',
        'Character tags CarrotKernel sends for the characters of the scene (built anew every turn).',
    ],
    'ck.template': [
        'CarrotKernel consistency template',
        'Your own template of CarrotKernel’s character data block (empty: its built-in one).',
    ],
    'maestro.director': ['Maestro: director’s note', 'The note of the director about pace and the next beat.'],
    'maestro.voices': ['Maestro: character voices', 'How the characters of the scene speak.'],
    'maestro.mechanics': ['Maestro: mechanics rules', 'The rules of your mechanics the model should follow.'],
    'maestro.mechanicsFacts': ['Maestro: mechanics values', 'Current values of the mechanics (health, money…).'],
    'maestro.wardrobe': ['Maestro: who wears what', 'The short line about what the characters of the scene wear.'],
    'maestro.offscreen': ['Maestro: offscreen events', 'What happened elsewhere meanwhile.'],
    'maestro.recap': ['Maestro: story so far', 'The recap of earlier chapters.'],
    'maestro.messageStyle': ['Maestro: message style', 'The hint about the look of replies.'],
    'maestro.qualityFix': ['Maestro: reply fix', 'The instruction for redoing a reply that failed the quality check.'],
};

const ENTRIES_RU: Record<string, [string, string]> = {
    'des.tracker': [
        'Инструкция трекера DES (целиком)',
        'Весь блок, который просит модель прислать JSON трекера. Пусто — DES собирает его сам из настроек трекера.',
    ],
    'des.trackerInstructions': [
        'Правила трекера DES',
        'Как модели заполнять трекер (внутри блока трекера; не действует, пока блок переписан целиком).',
    ],
    'des.trackerContinuation': [
        'DES: продолжение после трекера',
        'Что модель делает после JSON трекера: продолжает историю с учётом трекера.',
    ],
    'des.html': ['DES: оформление HTML', 'Разрешает модели вставлять в ответ HTML-фрагменты: письма, экраны, вывески.'],
    'des.dialogueColoring': ['DES: цвета реплик', 'Просит модель красить реплики каждого персонажа своим цветом.'],
    'des.contextInstructions': [
        'DES: контекст сцены',
        'Объясняет модели, как учитывать сводку сцены, которую DES ставит перед последним сообщением.',
    ],
    'des.narrator': ['DES: режим рассказчика', 'Велит модели понимать, кто в сцене, из самой истории.'],
    'nai.markers': [
        'Правила картинок NAI Studio',
        'Просит модель ставить в ответе метки для картинок: сколько и как их описывать.',
    ],
    'qvink.prompt': ['Промпт пересказа Qvink', 'Как Qvink просит модель пересказать одно сообщение для памяти.'],
    'qvink.shortTemplate': [
        'Qvink: заголовок недавних событий',
        'Строка, с которой Qvink вставляет недавние воспоминания.',
    ],
    'qvink.longTemplate': ['Qvink: заголовок давних событий', 'Строка, с которой Qvink вставляет долгую память.'],
    'desru.languageLock': [
        'Языковое правило DES-RU',
        'Напоминает модели, что игра идёт по-русски, хотя инструкции BunnyMo в промпте английские.',
    ],
    'ck.consistency': [
        'Данные персонажей CarrotKernel',
        'Теги персонажей сцены, которые CarrotKernel отправляет модели (собираются заново каждый ход).',
    ],
    'ck.template': [
        'Шаблон данных персонажей CarrotKernel',
        'Твой шаблон блока данных персонажей CarrotKernel (пусто — встроенный).',
    ],
    'maestro.director': ['Maestro: заметка режиссёра', 'Подсказка режиссёра о темпе и следующем повороте.'],
    'maestro.voices': ['Maestro: голоса персонажей', 'Как говорят персонажи сцены.'],
    'maestro.mechanics': ['Maestro: правила механик', 'Правила твоих механик, которым следует модель.'],
    'maestro.mechanicsFacts': ['Maestro: значения механик', 'Текущие значения механик: здоровье, деньги и прочее.'],
    'maestro.wardrobe': ['Maestro: кто во что одет', 'Короткая строка о том, что сейчас надето на персонажах сцены.'],
    'maestro.offscreen': ['Maestro: события за кадром', 'Что тем временем произошло в других местах.'],
    'maestro.recap': ['Maestro: ранее в истории', 'Пересказ прошлых глав.'],
    'maestro.messageStyle': ['Maestro: стиль сообщений', 'Подсказка о том, как оформлять ответ.'],
    'maestro.qualityFix': ['Maestro: исправление ответа', 'Указание переписать ответ, не прошедший проверку качества.'],
};

function entries(source: Record<string, [string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, [label, description]] of Object.entries(source)) {
        out[`m36.p.${id}.label`] = label;
        out[`m36.p.${id}.description`] = description;
    }
    return out;
}

export const NEIGHBOUR_STRINGS: I18nParts = {
    en: {
        'm36.title': 'Neighbour prompts',
        'm36.saveFailed': 'I could not save your copy of a neighbour’s prompt; I will try again with the next change.',
        'm36.note.absent': 'The extension is not installed or is off.',
        'm36.note.background': 'Used in its own requests, not in the main prompt: it can only be changed everywhere.',
        'm36.note.memories': 'Goes into the prompt together with the memories: it can only be changed everywhere.',
        'm36.note.desru': 'DES-RU has no setting for this text: Maestro can only send its own copy in a chat.',
        'm36.note.ckScene': 'Built anew every turn from the scene: nothing to edit or copy.',
        'm36.note.ckTemplate': 'Edited in CarrotKernel’s template editor.',
        'm36.note.maestro': 'Maestro’s own text: it changes in the settings of «{module}».',
        'm36.note.unknownGlobal':
            'The extension does not show its built-in text: write the text everywhere first, then copies work.',
        'm36.journal.global': '«{name}» changed everywhere',
        'm36.journal.reset': '«{name}» is the extension’s own again',
        'm36.journal.copy.character': 'Own «{name}» for {character}',
        'm36.journal.copy.chat': 'Own «{name}» for this chat',
        'm36.journal.copyRemoved.character': '{character} no longer has an own «{name}»',
        'm36.journal.copyRemoved.chat': 'This chat no longer has an own «{name}»',
        'kind.neighbourPrompts.global': 'Prompt of another extension',
        'kind.neighbourPrompts.copy': 'Own copy of another extension’s prompt',
        'target.neighbour-prompt': 'Prompt of an extension',
        'target.neighbour-prompt-copy': 'Copy of a prompt',
        'm36.target.text': 'Text',
        'm36.target.none': 'none',
        'm36.target.builtin': 'the extension’s own text',
        ...entries(ENTRIES_EN),
    },
    ru: {
        'm36.title': 'Промпты соседей',
        'm36.saveFailed': 'Не смог сохранить твою копию промпта соседа — попробую ещё раз при следующей правке.',
        'm36.note.absent': 'Расширение не установлено или выключено.',
        'm36.note.background':
            'Работает в его собственных запросах, а не в основном промпте: менять можно только везде.',
        'm36.note.memories': 'Уходит в промпт вместе с воспоминаниями: менять можно только везде.',
        'm36.note.desru': 'У DES-RU нет настройки для этого текста: Maestro может только подставить свою копию в чате.',
        'm36.note.ckScene': 'Собирается заново каждый ход из сцены: править и копировать нечего.',
        'm36.note.ckTemplate': 'Меняется в редакторе шаблонов CarrotKernel.',
        'm36.note.maestro': 'Это текст самого Maestro: он меняется в настройках «{module}».',
        'm36.note.unknownGlobal':
            'Расширение не показывает свой встроенный текст: сначала задай текст «везде», тогда заработают копии.',
        'm36.journal.global': '«{name}» изменён везде',
        'm36.journal.reset': '«{name}» снова свой у расширения',
        'm36.journal.copy.character': 'Свой «{name}» для персонажа {character}',
        'm36.journal.copy.chat': 'Свой «{name}» для этого чата',
        'm36.journal.copyRemoved.character': 'У персонажа {character} больше нет своего «{name}»',
        'm36.journal.copyRemoved.chat': 'У этого чата больше нет своего «{name}»',
        'kind.neighbourPrompts.global': 'Промпт другого расширения',
        'kind.neighbourPrompts.copy': 'Своя копия промпта другого расширения',
        'target.neighbour-prompt': 'Промпт расширения',
        'target.neighbour-prompt-copy': 'Копия промпта',
        'm36.target.text': 'Текст',
        'm36.target.none': 'нет',
        'm36.target.builtin': 'свой текст расширения',
        ...entries(ENTRIES_RU),
    },
};
