// Strings of the first-run wizard v1 (`w1.*`). Russian is the primary UI language; the user is addressed as «ты».
import type { I18nParts } from '../../shared/contracts';

export const WIZARD_STRINGS: I18nParts = {
    en: {
        'w1.title': 'First-run wizard',

        'w1.stack.title': 'Your stack',
        'w1.stack.intro': 'What Maestro found next to it and what each neighbour can do right now.',
        'w1.stack.notFound': 'not found',
        'w1.stack.version': 'version {version}',
        'w1.stack.caps': 'checks passed: {ok} of {total}',
        'w1.stack.missing': 'What does not work ({count})',
        'w1.stack.recheck': 'Check again',
        'w1.stack.unsupported': 'Not supported',
        'w1.stack.group': 'This is a group chat: Maestro sleeps in group chats.',
        'w1.stack.textCompletion':
            'The main API is Text Completion: studios and generation scenarios are built for Chat Completion and fall back to the classic windows.',
        'w1.stack.noCm':
            'The Connection Manager is off or missing: background tasks are impossible, everything else works.',
        'w1.stack.allSupported': 'Everything Maestro needs is in place.',

        'w1.macros.title': 'Macro engine',
        'w1.macros.on': 'The new ST macro engine is on: conditional blocks {{if}} in the preset work.',
        'w1.macros.off':
            'The new ST macro engine is off. Without it, conditional blocks {{if}}…{{/if}} that Maestro uses in the preset reach the model as plain text.',
        'w1.macros.enable': 'Turn on the new macro engine',
        'w1.macros.enabled': 'Done: the new macro engine is on. Reload the page so ST picks it up everywhere.',
        'w1.macros.reload': 'Reload the page',
        'w1.macros.unsupported':
            'This ST has no switch for the new macro engine. Conditional blocks may not work; Maestro will avoid them.',
        'w1.macros.journal': 'Turned on the new ST macro engine',

        'w1.baseline.title': 'Settings baseline',
        'w1.baseline.intro':
            'The baseline is a snapshot of the settings and the preset as they are now. Later the Guardian compares against it and shows what changed — by you, by a neighbour or by another tab.',
        'w1.baseline.none': 'No baseline yet.',
        'w1.baseline.has': 'A baseline is already taken.',
        'w1.baseline.take': 'Take the baseline',
        'w1.baseline.retake': 'Take it again',
        'w1.baseline.taken': 'Baseline taken.',
        'w1.baseline.off': 'The Guardian (M4) is off: the baseline can be taken later from its tab.',

        'w1.findings.title': 'Regexes and findings',
        'w1.findings.intro':
            'The Doctor has read the active lorebooks and every regex script. Nothing was changed: fixes come as rules (next step) or as file edits at stage 2.',
        'w1.findings.scanning': 'The Doctor is checking lorebooks and regexes…',
        'w1.findings.counts': 'Errors: {error} · warnings: {warn} · notes: {info}',
        'w1.findings.none': 'The Doctor found nothing.',
        'w1.findings.top': 'Most important',
        'w1.findings.regexes': 'Regex scripts: {count}',
        'w1.findings.open': 'Open the Doctor tab',
        'w1.findings.rescan': 'Check again',
        'w1.findings.failed': 'The check failed: {error}',
        'w1.findings.off': 'The Doctor (M5) is off: this step is skipped.',

        'w1.rules.title': 'Rules',
        'w1.rules.intro':
            'On-the-fly fixes of stage 1. They work on copies while the prompt is built and never touch files; each one can be switched off later. Your choice is applied when you press «Next».',
        'w1.rules.none': 'No stage 1 rules are registered yet.',
        'w1.rules.off': 'The Rules module (M22) is off: this step is skipped.',
        'w1.rules.compare': 'Compare before/after',
        'w1.rules.comparing': 'Simulating the current chat…',
        'w1.rules.delta': 'Lore per turn: {delta} characters.',
        'w1.rules.noChange': 'No difference on the current chat.',
        'w1.rules.removed': 'Leave the prompt ({count}): {list}',
        'w1.rules.added': 'Come in ({count}): {list}',
        'w1.rules.compareFailed': 'Comparison failed: {error}',
        'w1.rules.apply': 'Apply',
        'w1.rules.applied': 'Rules applied.',
        'w1.rules.applyFailed': 'The rules were not applied: {error}',
        'w1.rules.journal': 'First-run wizard: rules ({count})',
        'w1.caps.title': 'Book caps',
        'w1.caps.intro':
            'The heaviest books and a suggested cap in tokens per turn (about a third of what they send now). 0 means no cap.',
        'w1.caps.current': 'now about {tokens} tokens per turn',
        'w1.caps.static': 'about {tokens} tokens in total (no turns recorded yet)',
        'w1.caps.none': 'No book is heavy enough to need a cap.',
        'w1.caps.loading': 'Counting book sizes…',
        'w1.caps.label': 'Cap for “{book}”, tokens',

        'w1.background.title': 'Background tasks',
        'w1.background.intro':
            'Maestro does part of its work in the background (revisions, summaries, checks) through a separate connection profile.',
        'w1.background.cap': 'Daily cap for background tasks, $',
        'w1.background.capHint': 'When it is reached, the queue stops until tomorrow or your decision. 0 means no cap.',
        'w1.background.profile': 'Profile for background tasks',
        'w1.background.profileNone': 'Not chosen',
        'w1.background.profileMissing': 'Missing profile ({id})',
        'w1.background.profileHint':
            'A cheap fast model is enough, e.g. DeepSeek V4 Flash. The main chat model stays as it is.',
        'w1.background.noCm':
            'The Connection Manager is off: background tasks are impossible until it is on and has a profile.',

        'w1.oldChats.title': 'Old chats',
        'w1.oldChats.intro':
            'What to do with long chats that started before Maestro: parse their history once (canon, places, chapters) or keep track only from now on.',
        'w1.oldChats.fromNow': 'From now on',
        'w1.oldChats.bootstrap': 'Parse the history',
        'w1.oldChats.fromNowHint': 'Free: Maestro learns the story from the next turns.',
        'w1.oldChats.bootstrapHint': 'One background pass over the history of each old chat you open.',
        'w1.oldChats.cost':
            'This chat has {messages} messages, about {tokens} tokens. Parsing it on a cheap background model costs roughly {usd}; the exact price depends on the profile.',
        'w1.oldChats.noChat': 'Open a chat to see what parsing its history would cost.',
        'w1.oldChats.stage': 'History parsing arrives in stage 4; for now only your choice is remembered.',
    },
    ru: {
        'w1.title': 'Мастер первого запуска',

        'w1.stack.title': 'Стек',
        'w1.stack.intro': 'Что Maestro нашёл рядом с собой и что каждый сосед умеет прямо сейчас.',
        'w1.stack.notFound': 'не найден',
        'w1.stack.version': 'версия {version}',
        'w1.stack.caps': 'проверок пройдено: {ok} из {total}',
        'w1.stack.missing': 'Что не работает ({count})',
        'w1.stack.recheck': 'Проверить заново',
        'w1.stack.unsupported': 'Не поддерживается',
        'w1.stack.group': 'Это групповой чат: в групповых чатах Maestro спит.',
        'w1.stack.textCompletion':
            'Основной API — Text Completion: студии и сценарии генерации рассчитаны на Chat Completion и уступают место классическим окнам.',
        'w1.stack.noCm':
            'Connection Manager выключен или не найден: фоновые задачи невозможны, всё остальное работает.',
        'w1.stack.allSupported': 'Всё, что нужно Maestro, на месте.',

        'w1.macros.title': 'Движок макросов',
        'w1.macros.on': 'Новый движок макросов ST включён: условные блоки {{if}} в пресете работают.',
        'w1.macros.off':
            'Новый движок макросов ST выключен. Без него условные блоки {{if}}…{{/if}}, которые Maestro использует в пресете, уйдут модели обычным текстом.',
        'w1.macros.enable': 'Включить новый движок макросов',
        'w1.macros.enabled':
            'Готово: новый движок макросов включён. Перезагрузи страницу, чтобы ST подхватил его везде.',
        'w1.macros.reload': 'Перезагрузить страницу',
        'w1.macros.unsupported':
            'В этой версии ST нет переключателя нового движка макросов. Условные блоки могут не работать — Maestro будет обходиться без них.',
        'w1.macros.journal': 'Включён новый движок макросов ST',

        'w1.baseline.title': 'Эталон настроек',
        'w1.baseline.intro':
            'Эталон — снимок настроек и пресета в нынешнем виде. Потом Страж сверяется с ним и показывает, что изменилось — тобой, соседом или другой вкладкой.',
        'w1.baseline.none': 'Эталона пока нет.',
        'w1.baseline.has': 'Эталон уже снят.',
        'w1.baseline.take': 'Снять эталон',
        'w1.baseline.retake': 'Снять заново',
        'w1.baseline.taken': 'Эталон снят.',
        'w1.baseline.off': 'Страж (M4) выключен: эталон можно будет снять позже на его вкладке.',

        'w1.findings.title': 'Регексы и находки',
        'w1.findings.intro':
            'Доктор прочитал активные лорбуки и все регексы. Ничего не изменено: исправления — правилами (следующий шаг) или правкой файлов на этапе 2.',
        'w1.findings.scanning': 'Доктор проверяет лорбуки и регексы…',
        'w1.findings.counts': 'Ошибок: {error} · предупреждений: {warn} · заметок: {info}',
        'w1.findings.none': 'Доктор ничего не нашёл.',
        'w1.findings.top': 'Самое важное',
        'w1.findings.regexes': 'Регексов: {count}',
        'w1.findings.open': 'Открыть вкладку «Доктор»',
        'w1.findings.rescan': 'Проверить заново',
        'w1.findings.failed': 'Проверка не удалась: {error}',
        'w1.findings.off': 'Доктор (M5) выключен — шаг пропускается.',

        'w1.rules.title': 'Правила',
        'w1.rules.intro':
            'Исправления этапа 1 на лету. Они работают на копиях при сборке промпта и не трогают файлы; любое потом можно выключить. Выбор применится, когда нажмёшь «Далее».',
        'w1.rules.none': 'Правила этапа 1 пока не зарегистрированы.',
        'w1.rules.off': 'Модуль «Правила» (M22) выключен — шаг пропускается.',
        'w1.rules.compare': 'Сравнить до/после',
        'w1.rules.comparing': 'Прогоняю текущий чат…',
        'w1.rules.delta': 'Лор за ход: {delta} символов.',
        'w1.rules.noChange': 'На текущем чате разницы нет.',
        'w1.rules.removed': 'Уходят из промпта ({count}): {list}',
        'w1.rules.added': 'Добавляются ({count}): {list}',
        'w1.rules.compareFailed': 'Сравнить не удалось: {error}',
        'w1.rules.apply': 'Применить',
        'w1.rules.applied': 'Правила применены.',
        'w1.rules.applyFailed': 'Правила не применились: {error}',
        'w1.rules.journal': 'Мастер первого запуска: правила ({count})',
        'w1.caps.title': 'Потолки книг',
        'w1.caps.intro':
            'Самые тяжёлые книги и предлагаемый потолок в токенах за ход — примерно треть того, что они отправляют сейчас. 0 — без потолка.',
        'w1.caps.current': 'сейчас около {tokens} токенов за ход',
        'w1.caps.static': 'всего около {tokens} токенов (ходов ещё не записано)',
        'w1.caps.none': 'Ни одна книга не настолько тяжела, чтобы ей нужен был потолок.',
        'w1.caps.loading': 'Считаю размеры книг…',
        'w1.caps.label': 'Потолок для «{book}», токенов',

        'w1.background.title': 'Фоновые задачи',
        'w1.background.intro':
            'Часть работы Maestro делает в фоне (ревизии, пересказы, проверки) — через отдельный профиль подключения.',
        'w1.background.cap': 'Дневной потолок фоновых задач, $',
        'w1.background.capHint':
            'Когда он достигнут, очередь останавливается до завтра или до твоего решения. 0 — без потолка.',
        'w1.background.profile': 'Профиль для фоновых задач',
        'w1.background.profileNone': 'Не выбран',
        'w1.background.profileMissing': 'Профиль не найден ({id})',
        'w1.background.profileHint':
            'Хватит дешёвой быстрой модели, например DeepSeek V4 Flash. Основная модель чата остаётся как есть.',
        'w1.background.noCm':
            'Connection Manager выключен: фоновые задачи невозможны, пока он не включён и в нём нет профиля.',

        'w1.oldChats.title': 'Старые чаты',
        'w1.oldChats.intro':
            'Что делать с длинными чатами, начатыми до Maestro: один раз разобрать их историю (канон, места, главы) или вести только с текущего момента.',
        'w1.oldChats.fromNow': 'С текущего момента',
        'w1.oldChats.bootstrap': 'Разобрать историю',
        'w1.oldChats.fromNowHint': 'Бесплатно: Maestro узнаёт историю из следующих ходов.',
        'w1.oldChats.bootstrapHint': 'Один фоновый проход по истории каждого старого чата, который ты откроешь.',
        'w1.oldChats.cost':
            'В этом чате сообщений: {messages}, это около {tokens} токенов. Разбор на дешёвой фоновой модели обойдётся примерно в {usd}; точная цена зависит от профиля.',
        'w1.oldChats.noChat': 'Открой чат, чтобы увидеть, во что обойдётся разбор его истории.',
        'w1.oldChats.stage': 'Разбор истории появится на этапе 4, а пока запоминается только твой выбор.',
    },
};
