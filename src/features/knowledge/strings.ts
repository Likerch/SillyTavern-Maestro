// Strings of M18 «Кто что знает» (`m18.*`, action kinds `kind.knowledge.*`, journal targets `target.knowledge.*`) and
// how those targets read in the journal. Russian is the primary UI language; the user is addressed as «ты» (male).
import { formatClip, formatPlain, formatTime } from '../../core/labels';
import type { I18n, I18nParts, TargetSpec } from '../../shared/contracts';

function messageNumber(value: unknown, i18n: I18n): string {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? i18n.t('m18.field.messageIndex', { index: value })
        : '';
}

const TECHNICAL = { labelKey: 'm18.field.technical', hidden: true };

/**
 * A secret reads by the chat's own words, who knows it, its message and when it was noted; the statement itself is a
 * short English line for the model (under «Подробнее», with the id and the topic words). A «knows» mark is yes/no.
 */
export const KNOWLEDGE_TARGETS: TargetSpec[] = [
    {
        target: 'knowledge.secret',
        fields: {
            quote: { labelKey: 'm18.field.quote', format: formatClip(160) },
            knownBy: { labelKey: 'm18.field.knownBy', format: formatPlain },
            sourceMessage: { labelKey: 'm18.field.message', format: messageNumber },
            at: { labelKey: 'm18.field.at', format: formatTime },
            text: { labelKey: 'm18.field.text', hidden: true },
            id: TECHNICAL,
            topics: TECHNICAL,
            secret: TECHNICAL,
        },
    },
    // before/after: whether the character (ref.character) knows the fact.
    { target: 'knowledge.known', valueLabelKey: 'm18.field.knows', format: formatPlain },
];

export const KNOWLEDGE_STRINGS: I18nParts = {
    en: {
        'm18.title': 'Who knows what',
        'm18.tab': 'Who knows',
        'kind.knowledge.secret': "Characters' secrets",
        'kind.knowledge.known': 'Marks of who knows what',
        'target.knowledge.secret': 'Secret',
        'target.knowledge.known': 'Does the character know',
        'm18.field.knows': 'Knows',
        'm18.field.quote': 'Words from the chat',
        'm18.field.knownBy': 'Known to',
        'm18.field.message': 'Message',
        'm18.field.messageIndex': '#{index}',
        'm18.field.at': 'Noted',
        'm18.field.text': 'Statement',
        'm18.field.technical': 'Technical data',
        'm18.experimental':
            'Experimental module: it guesses who saw what from the DES tracker and may be wrong. Check the marks below; the voice cards trust them.',
        'm18.noChat': 'No chat is open.',
        'm18.hint':
            'Characters in the scene know what happened in it (by the DES tracker of each turn): quests, changed attitudes, moves, who came and went, revealed names, and replies with a kiss, a death, a theft and the like. Secrets come from the revision. When a topic comes up in the last messages, the voice card of a present character who does not know it says «Unaware of: …».',
        'm18.empty': 'Nothing known yet: facts appear after your next answers.',
        'm18.filter': 'Character',
        'm18.filter.all': 'Everyone',
        'm18.facts.title': 'Facts and secrets',
        'm18.more': 'Showing the latest {shown} of {total}.',
        'm18.unknown.title': '{name} does not know ({count})',
        'm18.known.title': '{name} knows ({count})',
        'm18.none': 'Nothing here.',
        'm18.secret': 'secret',
        'm18.message': 'message #{index}',
        'm18.knownBy': 'Known to: {names}',
        'm18.knownBy.none': 'nobody',
        'm18.topics': 'Comes up with: {list}',
        'm18.knows': '{name} knows',
        'm18.now.title': 'In the voice cards now',
        'm18.now.hint':
            'What each character in the scene does not know among the topics of the last messages. The voice cards add it as «Unaware of: …».',
        'm18.now.empty': 'Nothing: no topic came up that someone in the scene does not know.',
        'm18.now.line': '{name}: {facts}',
        'm18.now.noVoices': 'The «Character voices» module is off, so none of this reaches the model.',
        'm18.settings.title': 'Settings',
        'm18.settings.maxFacts': 'Facts kept per chat',
        'm18.settings.maxFacts.hint': 'Over the limit the oldest scene facts go first; secrets go last.',
        'm18.settings.replyEvents': 'Also read replies for key events (a kiss, a death, a theft…) that name someone',
        'm18.journal.secret': 'Noted a secret: {text}',
        'm18.journal.known': '{name} knows now: {fact}',
        'm18.journal.unknown': '{name} does not know now: {fact}',
        'm18.journal.quote': '«{text}»',
        'm18.error.noChat': 'No chat is open.',
        'm18.error.empty': 'The secret has no text.',
        'm18.error.notSaved': 'The change was not saved (another tab or a chat switch). Try again.',
        'm18.error.noFact': 'This fact is gone.',
        'm18.error.noName': 'No character name.',
    },
    ru: {
        'm18.title': 'Кто что знает',
        'm18.tab': 'Кто знает',
        'kind.knowledge.secret': 'Секреты персонажей',
        'kind.knowledge.known': 'Отметки, кто что знает',
        'target.knowledge.secret': 'Секрет',
        'target.knowledge.known': 'Знает ли персонаж',
        'm18.field.knows': 'Знает',
        'm18.field.quote': 'Слова из чата',
        'm18.field.knownBy': 'Знают',
        'm18.field.message': 'Сообщение',
        'm18.field.messageIndex': '№{index}',
        'm18.field.at': 'Записан',
        'm18.field.text': 'Формулировка',
        'm18.field.technical': 'Служебные данные',
        'm18.experimental':
            'Экспериментальный модуль: кто что видел, он угадывает по трекеру DES и может ошибаться. Проверь отметки ниже — голосовые карточки им верят.',
        'm18.noChat': 'Чат не открыт.',
        'm18.hint':
            'Кто был в сцене, тот знает, что в ней произошло (по трекеру DES каждого хода): квесты, перемены в отношениях, переходы, кто пришёл и ушёл, раскрытые имена, а ещё ответы с поцелуем, смертью, кражей и тому подобным. Секреты приходят из ревизии. Если тема всплывает в последних сообщениях, голосовая карточка присутствующего, который об этом не знает, получает «Unaware of: …».',
        'm18.empty': 'Пока ничего не известно: факты появятся после твоих следующих ответов.',
        'm18.filter': 'Персонаж',
        'm18.filter.all': 'Все',
        'm18.facts.title': 'Факты и секреты',
        'm18.more': 'Показаны последние {shown} из {total}.',
        'm18.unknown.title': '{name} не знает ({count})',
        'm18.known.title': '{name} знает ({count})',
        'm18.none': 'Здесь пусто.',
        'm18.secret': 'секрет',
        'm18.message': 'сообщение №{index}',
        'm18.knownBy': 'Знают: {names}',
        'm18.knownBy.none': 'никто',
        'm18.topics': 'Всплывает при словах: {list}',
        'm18.knows': '{name} знает',
        'm18.now.title': 'Сейчас в голосовых карточках',
        'm18.now.hint':
            'Чего не знает каждый, кто сейчас в сцене, среди тем последних сообщений. Голосовые карточки добавляют это как «Unaware of: …».',
        'm18.now.empty': 'Ничего: не всплыло ни одной темы, о которой кто-то в сцене не знает.',
        'm18.now.line': '{name}: {facts}',
        'm18.now.noVoices': 'Модуль «Голоса персонажей» выключен, так что до модели это не доходит.',
        'm18.settings.title': 'Настройки',
        'm18.settings.maxFacts': 'Сколько фактов хранить в чате',
        'm18.settings.maxFacts.hint':
            'Сверх предела первыми уходят самые старые факты сцен, секреты — в последнюю очередь.',
        'm18.settings.replyEvents':
            'Искать в ответах ключевые события (поцелуй, смерть, кража…), где кто-то назван по имени',
        'm18.journal.secret': 'Запомнил секрет: {text}',
        'm18.journal.known': 'Теперь {name} знает: {fact}',
        'm18.journal.unknown': 'Теперь {name} не знает: {fact}',
        'm18.journal.quote': '«{text}»',
        'm18.error.noChat': 'Чат не открыт.',
        'm18.error.empty': 'У секрета нет текста.',
        'm18.error.notSaved': 'Изменение не сохранилось (другая вкладка или смена чата). Попробуй ещё раз.',
        'm18.error.noFact': 'Этого факта уже нет.',
        'm18.error.noName': 'Не указано имя персонажа.',
    },
};
