// M21 «Казначей» strings (en + ru). The user is male; Russian is the primary UI language.
import type { I18nParts } from '../../shared/contracts';

export const M21_STRINGS: I18nParts = {
    en: {
        'm21.title': 'Treasurer',
        'm21.tab': 'Spending',
        'm21.view.intro':
            "What the game costs: each turn, this session and today, by source. The cost comes from the provider's " +
            'answers; NovelAI pictures are counted in Anlas.',
        'm21.view.noChat': 'Open a chat to see the spend per turn.',
        'm21.view.refresh': 'Refresh',

        'm21.section.totals': 'Totals',
        'm21.section.turns': 'By turn',
        'm21.section.days': 'By day',
        'm21.section.limits': 'Caps and limits',

        'm21.col.source': 'Source',
        'm21.col.turn': 'Last turn',
        'm21.col.session': 'Session',
        'm21.col.day': 'Today',
        'm21.col.message': 'Turn',
        'm21.col.total': 'Total',

        'm21.source.main': 'Main model',
        'm21.source.regeneration': 'Regenerations',
        'm21.source.autoSwipe': 'Auto-swipes',
        'm21.source.qvink': 'Qvink',
        'm21.source.maestro': 'Maestro tasks',
        'm21.source.nai': 'NAI Studio (LLM)',
        'm21.source.anlas': 'NAI pictures, Anlas',
        'm21.source.other': 'Other',
        'm21.source.mainShort': 'Main',
        'm21.source.regenerationShort': 'Regen.',
        'm21.source.autoSwipeShort': 'Auto-swipe',
        'm21.source.qvinkShort': 'Qvink',
        'm21.source.maestroShort': 'Maestro',
        'm21.source.naiShort': 'NAI LLM',
        'm21.source.anlasShort': 'Anlas',
        'm21.source.otherShort': 'Other',

        'm21.total': 'Total',
        'm21.estimated': 'estimate',
        'm21.estimatedHint': 'Some answers had no cost in them: only their tokens are known.',
        'm21.anlas': '{count} Anlas',
        'm21.tokens': '{prompt} in / {completion} out',
        'm21.sessionSince': 'Session since {time}.',

        'm21.turns.empty': 'No spend recorded in this chat yet.',
        'm21.turns.note': 'The latest turns, newest first; the number is the message number in the chat.',
        'm21.turn.number': '#{index}',

        'm21.days.loading': 'Loading the days…',
        'm21.days.caption': 'Over {count} days: {usd}',
        'm21.days.captionAnlas': 'Over {count} days: {usd} and {anlas} Anlas',
        'm21.days.bar': '{date}: {usd}',
        'm21.days.barAnlas': '{date}: {usd}, {anlas} Anlas',
        'm21.days.aria': 'Spend per day over the last {count} days',
        'm21.days.failed': 'Could not read the day files.',

        'm21.limits.background': "Maestro's background today",
        'm21.limits.backgroundOfCap': '{spent} of {cap}',
        'm21.limits.backgroundNoCap': '{spent} (no cap)',
        'm21.limits.capReached': "The background cap is reached: Maestro's own tasks wait until tomorrow.",
        'm21.limits.limitReached': 'The overall daily limit is reached: {spent} of {limit}.',
        'm21.limits.backgroundCap': 'Background cap per day, USD',
        'm21.limits.backgroundCapHint': "Maestro's own background AI spend; 0 means no cap.",
        'm21.limits.dailyLimit': 'Overall daily limit',
        'm21.limits.dailyLimitHint': 'Counts the main chat too. Off by default. The main generation is never blocked.',
        'm21.limits.dailyLimitUsd': 'Limit per day, USD',
        'm21.limits.dailyLimitAction': 'When reached',
        'm21.limits.action.warn': 'Warn',
        'm21.limits.action.economy': 'Switch to Economy',
        'm21.limits.action.stopBackground': 'Stop background tasks',
        'm21.limits.openSettings': 'All settings',

        'm21.mode.economy': 'Economy',
        'm21.mode.balanced': 'Balanced',
        'm21.mode.cinema': 'Cinema',

        'm21.limit.warn': "Today's spend reached the daily limit: {spent} of {limit}.",
        'm21.limit.economy':
            'The daily limit is reached ({spent} of {limit}): I switched Maestro to Economy until tomorrow.',
        'm21.limit.economyAlready': 'The daily limit is reached ({spent} of {limit}); Economy is already on.',
        'm21.limit.stopBackground':
            'The daily limit is reached ({spent} of {limit}): I stopped my background tasks until tomorrow. ' +
            'The chat works as usual.',
        'm21.limit.restore': 'Back to {mode}',
        'm21.limit.restored': 'A new day: I put the mode back to {mode}.',
        'm21.journal.economy': 'The daily limit of {limit} is reached: switched Maestro to Economy',

        'kind.treasurer.economy': 'Economy mode at the daily limit',
        'target.treasurer.mode': 'Maestro mode',
    },
    ru: {
        'm21.title': 'Казначей',
        'm21.tab': 'Расходы',
        'm21.view.intro':
            'Сколько стоит игра: каждый ход, эта сессия и сегодняшний день — по источникам. Стоимость берётся ' +
            'из ответов провайдера, картинки NovelAI считаются в Anlas.',
        'm21.view.noChat': 'Открой чат, чтобы увидеть расходы по ходам.',
        'm21.view.refresh': 'Обновить',

        'm21.section.totals': 'Итоги',
        'm21.section.turns': 'По ходам',
        'm21.section.days': 'По дням',
        'm21.section.limits': 'Потолок и лимит',

        'm21.col.source': 'Источник',
        'm21.col.turn': 'Последний ход',
        'm21.col.session': 'Сессия',
        'm21.col.day': 'Сегодня',
        'm21.col.message': 'Ход',
        'm21.col.total': 'Всего',

        'm21.source.main': 'Основная модель',
        'm21.source.regeneration': 'Перегенерации',
        'm21.source.autoSwipe': 'Авто-свайпы',
        'm21.source.qvink': 'Qvink',
        'm21.source.maestro': 'Задачи Maestro',
        'm21.source.nai': 'NAI Studio (LLM)',
        'm21.source.anlas': 'Картинки NAI, Anlas',
        'm21.source.other': 'Прочее',
        'm21.source.mainShort': 'Основная',
        'm21.source.regenerationShort': 'Перегенер.',
        'm21.source.autoSwipeShort': 'Авто-свайп',
        'm21.source.qvinkShort': 'Qvink',
        'm21.source.maestroShort': 'Maestro',
        'm21.source.naiShort': 'NAI LLM',
        'm21.source.anlasShort': 'Anlas',
        'm21.source.otherShort': 'Прочее',

        'm21.total': 'Итого',
        'm21.estimated': 'оценка',
        'm21.estimatedHint': 'В части ответов не было стоимости: известны только их токены.',
        'm21.anlas': '{count} Anlas',
        'm21.tokens': '{prompt} на входе / {completion} на выходе',
        'm21.sessionSince': 'Сессия с {time}.',

        'm21.turns.empty': 'В этом чате расходов пока не было.',
        'm21.turns.note': 'Последние ходы, свежие сверху; номер — номер сообщения в чате.',
        'm21.turn.number': '№ {index}',

        'm21.days.loading': 'Читаю дни…',
        'm21.days.caption': 'За {count} дн.: {usd}',
        'm21.days.captionAnlas': 'За {count} дн.: {usd} и {anlas} Anlas',
        'm21.days.bar': '{date}: {usd}',
        'm21.days.barAnlas': '{date}: {usd}, {anlas} Anlas',
        'm21.days.aria': 'Расходы по дням за последние {count} дн.',
        'm21.days.failed': 'Не удалось прочитать файлы дней.',

        'm21.limits.background': 'Фон Maestro сегодня',
        'm21.limits.backgroundOfCap': '{spent} из {cap}',
        'm21.limits.backgroundNoCap': '{spent} (без потолка)',
        'm21.limits.capReached': 'Потолок фона достигнут: собственные задачи Maestro ждут до завтра.',
        'm21.limits.limitReached': 'Общий дневной лимит достигнут: {spent} из {limit}.',
        'm21.limits.backgroundCap': 'Потолок фона в день, USD',
        'm21.limits.backgroundCapHint': 'Собственные фоновые запросы Maestro к ИИ; 0 — без потолка.',
        'm21.limits.dailyLimit': 'Общий дневной лимит',
        'm21.limits.dailyLimitHint':
            'Учитывает и основной чат. По умолчанию выключен. Основную генерацию Maestro не блокирует.',
        'm21.limits.dailyLimitUsd': 'Лимит в день, USD',
        'm21.limits.dailyLimitAction': 'Когда достигнут',
        'm21.limits.action.warn': 'Предупредить',
        'm21.limits.action.economy': 'Перейти в «Экономный»',
        'm21.limits.action.stopBackground': 'Остановить фоновые задачи',
        'm21.limits.openSettings': 'Все настройки',

        'm21.mode.economy': 'Экономный',
        'm21.mode.balanced': 'Сбалансированный',
        'm21.mode.cinema': 'Кино',

        'm21.limit.warn': 'Дневной лимит исчерпан: сегодня потрачено {spent} из {limit}.',
        'm21.limit.economy':
            'Дневной лимит исчерпан ({spent} из {limit}): до завтра перевёл Maestro в режим «Экономный».',
        'm21.limit.economyAlready': 'Дневной лимит исчерпан ({spent} из {limit}); режим «Экономный» и так включён.',
        'm21.limit.stopBackground':
            'Дневной лимит исчерпан ({spent} из {limit}): до завтра остановил свои фоновые задачи. ' +
            'Чат работает как обычно.',
        'm21.limit.restore': 'Вернуть «{mode}»',
        'm21.limit.restored': 'Новый день: вернул режим «{mode}».',
        'm21.journal.economy': 'Дневной лимит {limit} исчерпан: перевёл Maestro в «Экономный»',

        'kind.treasurer.economy': 'Экономный режим по дневному лимиту',
        'target.treasurer.mode': 'Режим Maestro',
    },
};
