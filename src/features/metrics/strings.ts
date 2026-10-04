// Strings of M21m «Замеры» (R3 criteria, plan §14).
import type { I18nParts } from '../../shared/contracts';

export const M21M_STRINGS: I18nParts = {
    en: {
        'm21m.title': 'Measurements',
        'm21m.tab': 'Measurements',
        'm21m.noData': 'no data yet',

        'm21m.view.intro':
            'How Maestro does against the success criteria of the first full version. Numbers belong to this chat; ' +
            'they collect as you play.',
        'm21m.view.summary': 'Turns measured: {turns}, since {since}. This tab: {device}.',
        'm21m.view.noChat': 'Open a chat: measurements are kept per chat.',
        'm21m.view.group': 'Maestro sleeps in group chats: nothing is measured here.',
        'm21m.view.overall.ok': 'Every measured criterion is met.',
        'm21m.view.overall.warn': 'Some criteria are not met yet.',
        'm21m.view.overall.none': 'Not enough data for a verdict yet.',

        'm21m.action.refresh': 'Refresh',
        'm21m.action.copyMd': 'Copy as Markdown',
        'm21m.action.copyJson': 'Copy as JSON',
        'm21m.action.compareLore': 'Compare without the rules',
        'm21m.action.resetBaseline': 'Start the baseline again',
        'm21m.action.checkPacks': 'Check pack files',
        'm21m.action.acceptPacks': 'Take current files as the originals',
        'm21m.copied': 'Copied.',
        'm21m.copyFailed': 'Could not copy: select the text below and copy it by hand.',
        'm21m.acceptPacks.title': 'Take the current pack files as the originals?',
        'm21m.acceptPacks.body':
            'Do this only after you updated a BunnyMo pack on purpose. Later checks compare with the files as they ' +
            'are now.',
        'm21m.compareLore.none': 'The rules module is off: nothing to compare.',

        'm21m.section.criteria': 'Criteria',
        'm21m.section.latency': 'Send path by device',
        'm21m.section.modules': 'Time of Maestro modules in a generation',
        'm21m.section.idle': 'Time of Maestro modules outside generations',
        'm21m.section.cost': 'Spend in the window',
        'm21m.section.lore': 'Lore per turn',
        'm21m.section.packs': 'BunnyMo pack files',
        'm21m.section.losses': 'Latest data-loss warnings',

        'm21m.col.criterion': 'Criterion',
        'm21m.col.target': 'Target',
        'm21m.col.current': 'Now',
        'm21m.col.status': 'Status',
        'm21m.col.how': 'How it is measured',
        'm21m.col.bench': 'Bench',
        'm21m.col.device': 'Device',
        'm21m.col.samples': 'Samples',
        'm21m.col.window': 'p95 of ST send path',
        'm21m.col.own': 'p95 of Maestro code',
        'm21m.col.module': 'Module',

        'm21m.device.desktop': 'PC',
        'm21m.device.phone': 'phone',

        'm21m.status.ok': 'met',
        'm21m.status.warn': 'not met',
        'm21m.status.none': 'no verdict',

        'm21m.bench.yes': 'measurable on the bench',
        'm21m.bench.partly': 'partly on the bench',
        'm21m.bench.no': 'only in real play',

        'm21m.v.latency': '{device}: p95 {p95} ms (p50 {p50} ms, samples: {n})',
        'm21m.v.latencyNone': '{device}: no samples',
        'm21m.v.cost': '{share} ({background} of {main}), turns: {turns}',
        'm21m.v.costNone': 'the main model cost nothing yet (turns: {turns})',
        'm21m.v.costSwipes': 'Auto-swipes: {count}.',
        'm21m.v.loreWhatIf': '{ratio} of the lore without rules (characters: {after} of {before})',
        'm21m.v.loreBaseline': '{ratio} of the baseline (characters per turn: {current} against {baseline})',
        'm21m.v.loreCurrent': 'characters per turn: {current} (turns: {turns}); press «Compare without the rules»',
        'm21m.v.dropped': 'turns with dropped messages: {with} of {turns} (at most {max} in one turn)',
        'm21m.v.droppedNone': 'Qvink does not remove messages in this chat',
        'm21m.v.assistantDepth': 'turns with such entries: {with} of {turns} (at most {max} in one turn)',
        'm21m.v.tabs': 'rollbacks: {stale}, losses: {losses}, the tab went stale: {episodes}',
        'm21m.v.tabsBlocked': 'Saves blocked now: {blocked}.',
        'm21m.v.revision': 'revision: {share} as is (decisions: {decisions})',
        'm21m.v.revisionNone': 'revision: no decisions yet',
        'm21m.v.undo': 'undone: {share} (actions: {actions})',
        'm21m.v.undoNone': 'undone: no actions yet',
        'm21m.v.living': 'dropped: {share} (provisional facts: {provisional}); contradictions: {contradicted}',
        'm21m.v.livingNone': 'the living canon reports nothing yet',
        'm21m.v.sheets': 'sheets: {sheets}, with problems: {defects}',
        'm21m.v.sheetsNone': 'no sheets in this chat',
        'm21m.v.sheet.tail': 'scene tail: {count}',
        'm21m.v.sheet.tracker': 'tracker JSON: {count}',
        'm21m.v.sheet.notCollapsed': 'not folded: {count}',
        'm21m.v.sheet.noTags': 'tags not shown: {count}',
        'm21m.v.packs': 'checked: {checked}, changed: {changed}, missing: {missing}',
        'm21m.v.packsNone': 'not checked yet',

        'm21m.c.latency.name': 'Added latency before the request (p95)',
        'm21m.c.latency.target': '≤ 200 ms on a PC, ≤ 600 ms on a phone',
        'm21m.c.latency.how':
            "Maestro's own code between the send and the request to the model: its generate interceptor plus every " +
            'Maestro listener of the lore scan and prompt assembly, on every generation; 95th percentile (nearest ' +
            "rank), at least 20 samples per device. ST's own work is shown apart («whole ST path»). Phone: a touch " +
            'screen or a window narrower than 768 px.',
        'm21m.c.cost.name': 'Background spend against the main model',
        'm21m.c.cost.target': '≤ 15 % over 100 turns, auto-swipes included',
        'm21m.c.cost.how':
            "Real cost from the usage of every response (cost meter): Maestro's own tasks plus automatic swipes " +
            'against the main model, over the last 100 generations of this chat. Qvink and other neighbours are ' +
            'counted apart. The plan sets the target for the «Balanced» mode.',
        'm21m.c.lore.name': 'Lore characters per turn',
        'm21m.c.lore.target': 'at least halved, no needed entries lost',
        'm21m.c.lore.how':
            '«Compare without the rules» runs the lore scan of this chat twice (an M1 dry run) with and without the ' +
            'lore rules (M22) and divides the totals; otherwise the average of the latest turns is divided by the ' +
            'first 50 turns if those ran without the rules. Lost entries are checked by hand in the lore journal; ' +
            'on the bench measure.mjs compares two recorded runs of the reference chat.',
        'm21m.c.dropped.name': 'Messages dropped from the prompt without a summary',
        'm21m.c.dropped.target': '0',
        'm21m.c.dropped.how':
            'After every interceptor (the gap guard included) the prompt entries Qvink still drops are checked by the ' +
            "medic's rules: an entry counts when Qvink would summarise it but has no memory for it.",
        'm21m.c.assistantDepth.name': 'Lore entries with the assistant role at depth',
        'm21m.c.assistantDepth.target': '0',
        'm21m.c.assistantDepth.how':
            'From the lore journal (M1) on every turn: activated entries that reached the prompt at depth with the ' +
            'assistant role, after the rules.',
        'm21m.c.tabs.name': 'Settings rollbacks by stale tabs; data losses',
        'm21m.c.tabs.target': '0 and 0',
        'm21m.c.tabs.how':
            'A settings, preset or lorebook save that left this tab while the guard (M4) saw it as stale is a ' +
            'rollback; saves the guard holds or refused are shown as blocked. Losses: warnings and errors about ' +
            'failed writes and actions that were not journaled.',
        'm21m.c.autonomy.name': 'Revision proposals accepted as is; undone actions',
        'm21m.c.autonomy.target': '≥ 70 % as is; < 5 % undone',
        'm21m.c.autonomy.how':
            'Autonomy statistics of the revision kinds (accepted / edited / rejected), from 10 decisions; the ' +
            "journal of this chat: the share of Maestro's actions that were undone, from 20 actions.",
        'm21m.c.living.name': 'Provisional facts dropped; confirmed facts contradicted',
        'm21m.c.living.target': '< 20 % dropped; no contradictions after 50 turns',
        'm21m.c.living.how':
            'Counts of the living canon (M26): provisional facts, the ones you dropped, confirmed facts that a later ' +
            'check found contradicted.',
        'm21m.c.sheets.name': 'BunnyMo sheets',
        'm21m.c.sheets.target': 'no scene tail or tracker JSON, folded, tags visible',
        'm21m.c.sheets.how':
            'Every sheet reply M31 marked in this chat: the stored text is checked for a scene continuation and DES ' +
            'tracker JSON, older sheets for folding, the tags for the display rule.',
        'm21m.c.packs.name': 'BunnyMo pack files unchanged',
        'm21m.c.packs.target': 'byte for byte as shipped',
        'm21m.c.packs.how':
            'The first time a core or pack book is seen, its file is fingerprinted as the server reads it; «Check ' +
            'pack files» compares again. On the bench measure.mjs compares the installed files with the pinned ' +
            'BunnyMo export byte by byte.',

        'm21m.lore.whatIf':
            'Characters without the rules: {before}, with them: {after} ({ratio}); entries fewer: {removed}.',
        'm21m.lore.baseline': 'Baseline, characters per turn: {avg} (first turns: {turns}; {rules}).',
        'm21m.lore.baselineOff': 'mostly without the lore rules',
        'm21m.lore.baselineOn': 'with the lore rules on, so it does not show their effect',
        'm21m.lore.baselinePending': 'The baseline is taken from the first turns ({size}); so far: {turns}.',
        'm21m.lore.current': 'Now, characters per turn: {avg} (turns: {turns}).',
        'm21m.packs.checkedAt': 'Checked at {at}.',
        'm21m.packs.changedList': 'Changed: {list}.',
        'm21m.packs.missingList': 'Not readable: {list}.',
        'm21m.packs.addedList': 'Seen for the first time (fingerprinted now): {list}.',
        'm21m.losses.none': 'None in this session.',

        'm21m.cost.main': 'Main model',
        'm21m.cost.maestro': 'Maestro tasks',
        'm21m.cost.autoSwipes': 'Automatic swipes',
        'm21m.cost.qvink': 'Qvink (apart)',
        'm21m.cost.other': 'Other neighbours (apart)',
        'm21m.cost.window': 'Window: the latest turns ({turns}).',

        'm21m.export.title': 'Maestro: R3 criteria',
        'm21m.export.meta': 'Generated {at}; {turns} turns measured since {since}; device: {device}.',
    },
    ru: {
        'm21m.title': 'Замеры',
        'm21m.tab': 'Замеры',
        'm21m.noData': 'пока нет данных',

        'm21m.view.intro':
            'Как Maestro справляется с критериями успеха первой полной версии. Цифры — по этому чату, ' +
            'набираются по ходу игры.',
        'm21m.view.summary': 'Замерено ходов: {turns}, с {since}. Эта вкладка: {device}.',
        'm21m.view.noChat': 'Открой чат: замеры ведутся по каждому чату отдельно.',
        'm21m.view.group': 'В групповых чатах Maestro спит — здесь ничего не замеряется.',
        'm21m.view.overall.ok': 'Все измеренные критерии выполнены.',
        'm21m.view.overall.warn': 'Часть критериев пока не выполнена.',
        'm21m.view.overall.none': 'Данных для вывода пока мало.',

        'm21m.action.refresh': 'Обновить',
        'm21m.action.copyMd': 'Скопировать в Markdown',
        'm21m.action.copyJson': 'Скопировать в JSON',
        'm21m.action.compareLore': 'Сравнить без правил',
        'm21m.action.resetBaseline': 'Начать отсчёт заново',
        'm21m.action.checkPacks': 'Проверить файлы паков',
        'm21m.action.acceptPacks': 'Считать текущие файлы исходными',
        'm21m.copied': 'Скопировано.',
        'm21m.copyFailed': 'Не удалось скопировать: выдели текст ниже и скопируй вручную.',
        'm21m.acceptPacks.title': 'Считать текущие файлы паков исходными?',
        'm21m.acceptPacks.body':
            'Делай это только после того, как сам обновил пак BunnyMo. Дальше проверки будут сравнивать с файлами ' +
            'в их нынешнем виде.',
        'm21m.compareLore.none': 'Модуль правил выключен — сравнивать нечего.',

        'm21m.section.criteria': 'Критерии',
        'm21m.section.latency': 'Путь отправки по устройствам',
        'm21m.section.modules': 'Время модулей Maestro во время генерации',
        'm21m.section.idle': 'Время модулей Maestro вне генерации',
        'm21m.section.cost': 'Расходы в окне',
        'm21m.section.lore': 'Лор на ход',
        'm21m.section.packs': 'Файлы паков BunnyMo',
        'm21m.section.losses': 'Последние предупреждения о потерях',

        'm21m.col.criterion': 'Критерий',
        'm21m.col.target': 'Цель',
        'm21m.col.current': 'Сейчас',
        'm21m.col.status': 'Статус',
        'm21m.col.how': 'Как измерено',
        'm21m.col.bench': 'Стенд',
        'm21m.col.device': 'Устройство',
        'm21m.col.samples': 'Замеров',
        'm21m.col.window': 'p95 всего пути ST',
        'm21m.col.own': 'p95 кода Maestro',
        'm21m.col.module': 'Модуль',

        'm21m.device.desktop': 'ПК',
        'm21m.device.phone': 'телефон',

        'm21m.status.ok': 'выполнен',
        'm21m.status.warn': 'не выполнен',
        'm21m.status.none': 'нет вывода',

        'm21m.bench.yes': 'проверяется на стенде',
        'm21m.bench.partly': 'на стенде частично',
        'm21m.bench.no': 'только в живой игре',

        'm21m.v.latency': '{device}: p95 {p95} мс (p50 {p50} мс, замеров: {n})',
        'm21m.v.latencyNone': '{device}: замеров нет',
        'm21m.v.cost': '{share} ({background} из {main}), ходов: {turns}',
        'm21m.v.costNone': 'основная модель пока ничего не стоила (ходов: {turns})',
        'm21m.v.costSwipes': 'Авто-свайпов: {count}.',
        'm21m.v.loreWhatIf': '{ratio} от лора без правил (символов: {after} из {before})',
        'm21m.v.loreBaseline': '{ratio} от исходного (символов на ход: {current} против {baseline})',
        'm21m.v.loreCurrent': 'символов на ход: {current} (ходов: {turns}); нажми «Сравнить без правил»',
        'm21m.v.dropped': 'ходов с выпавшими: {with} из {turns} (больше всего за ход: {max})',
        'm21m.v.droppedNone': 'Qvink в этом чате не убирает сообщения',
        'm21m.v.assistantDepth': 'ходов с такими записями: {with} из {turns} (больше всего за ход: {max})',
        'm21m.v.tabs': 'откатов: {stale}, потерь: {losses}, вкладка устаревала: {episodes}',
        'm21m.v.tabsBlocked': 'Сейчас задержано сохранений: {blocked}.',
        'm21m.v.revision': 'ревизия: {share} без правок (решений: {decisions})',
        'm21m.v.revisionNone': 'ревизия: решений пока нет',
        'm21m.v.undo': 'откачено: {share} (действий: {actions})',
        'm21m.v.undoNone': 'откаты: действий пока нет',
        'm21m.v.living': 'удалено: {share} (пробных фактов: {provisional}); противоречий: {contradicted}',
        'm21m.v.livingNone': 'живой канон пока ничего не сообщил',
        'm21m.v.sheets': 'листов: {sheets}, с проблемами: {defects}',
        'm21m.v.sheetsNone': 'в этом чате нет листов',
        'm21m.v.sheet.tail': 'хвост сцены: {count}',
        'm21m.v.sheet.tracker': 'JSON трекера: {count}',
        'm21m.v.sheet.notCollapsed': 'не свёрнуто: {count}',
        'm21m.v.sheet.noTags': 'теги не видны: {count}',
        'm21m.v.packs': 'проверено: {checked}, изменено: {changed}, не читается: {missing}',
        'm21m.v.packsNone': 'ещё не проверялись',

        'm21m.c.latency.name': 'Добавочная задержка до запроса (p95)',
        'm21m.c.latency.target': '≤ 200 мс на ПК, ≤ 600 мс на телефоне',
        'm21m.c.latency.how':
            'Собственный код Maestro между отправкой и запросом к модели: его перехватчик генерации и все его ' +
            'обработчики сканирования лора и сборки промпта, на каждой генерации; 95-й перцентиль (ближайший ранг), ' +
            'от 20 замеров на устройство. Работа самого ST показана отдельно («весь путь ST»). Телефон — сенсорный ' +
            'экран или окно уже 768 px.',
        'm21m.c.cost.name': 'Фоновые расходы к основной модели',
        'm21m.c.cost.target': '≤ 15 % на 100 ходов с учётом авто-свайпов',
        'm21m.c.cost.how':
            'Фактическая стоимость из usage каждого ответа (счётчик расходов): собственные задачи Maestro и ' +
            'авто-свайпы против основной модели за последние 100 генераций этого чата. Qvink и другие соседи ' +
            'считаются отдельно. Цель плана — для «Сбалансированного» режима.',
        'm21m.c.lore.name': 'Символы лора на ход',
        'm21m.c.lore.target': 'минимум вдвое меньше, без потери нужных записей',
        'm21m.c.lore.how':
            '«Сравнить без правил» дважды прогоняет сканирование лора этого чата (пробный прогон M1) — с правилами ' +
            'лора M22 и без них — и делит итоги; иначе среднее последних ходов делится на среднее первых 50 ходов, ' +
            'если те шли без правил. Потерю нужных записей проверяешь по журналу лора; на стенде measure.mjs ' +
            'сравнивает два записанных прогона эталонного чата.',
        'm21m.c.dropped.name': 'Сообщения, выпавшие из промпта без пересказа',
        'm21m.c.dropped.target': '0',
        'm21m.c.dropped.how':
            'После всех перехватчиков (включая возврат «дыр») проверяются записи, которые Qvink всё же убирает из ' +
            'промпта, по правилам медика: считается запись, которую Qvink пересказал бы, но памяти по ней нет.',
        'm21m.c.assistantDepth.name': 'Записи лора с ролью assistant на глубине',
        'm21m.c.assistantDepth.target': '0',
        'm21m.c.assistantDepth.how':
            'По журналу лора (M1) на каждом ходу: сработавшие записи, дошедшие до промпта на глубине с ролью ' +
            'assistant, — уже после правил.',
        'm21m.c.tabs.name': 'Откаты настроек устаревшими вкладками; потери данных',
        'm21m.c.tabs.target': '0 и 0',
        'm21m.c.tabs.how':
            'Сохранение настроек, пресета или лорбука, ушедшее из этой вкладки, когда страж (M4) считал её ' +
            'устаревшей, — откат; задержанные и отклонённые стражем сохранения показаны отдельно. Потери — ' +
            'предупреждения и ошибки о несохранённых записях и действиях без записи в журнал.',
        'm21m.c.autonomy.name': 'Предложения ревизии без правок; откаты автодействий',
        'm21m.c.autonomy.target': '≥ 70 % без правок; < 5 % откатов',
        'm21m.c.autonomy.how':
            'Статистика решений автономии по видам ревизии (принято / исправлено / отклонено), от 10 решений; ' +
            'журнал этого чата — доля откаченных действий Maestro, от 20 действий.',
        'm21m.c.living.name': 'Удалённые пробные факты; противоречия подтверждённым',
        'm21m.c.living.target': '< 20 % удалений; ни одного противоречия через 50 ходов',
        'm21m.c.living.how':
            'Счётчики живого канона (M26): пробные факты, удалённые тобой, и подтверждённые факты, которым позже ' +
            'нашлось противоречие.',
        'm21m.c.sheets.name': 'Листы BunnyMo',
        'm21m.c.sheets.target': 'без хвоста сцены и JSON трекера, свёрнуты, теги видны',
        'm21m.c.sheets.how':
            'Каждый лист, отмеченный M31 в этом чате: в сохранённом тексте ищутся продолжение сцены и JSON трекера ' +
            'DES, у старых листов проверяется сворачивание, у тегов — правило показа.',
        'm21m.c.packs.name': 'Файлы паков BunnyMo не изменены',
        'm21m.c.packs.target': 'побайтно совпадают с исходными',
        'm21m.c.packs.how':
            'Когда книга ядра или пака встречается впервые, снимается отпечаток её файла в том виде, как его читает ' +
            'сервер; «Проверить файлы паков» сравнивает заново. На стенде measure.mjs сравнивает установленные ' +
            'файлы с закреплённой выгрузкой BunnyMo побайтно.',

        'm21m.lore.whatIf':
            'Символов без правил: {before}, с правилами: {after} ({ratio}); записей меньше на {removed}.',
        'm21m.lore.baseline': 'Исходный уровень — символов на ход: {avg} (первые ходы: {turns}; {rules}).',
        'm21m.lore.baselineOff': 'в основном без правил лора',
        'm21m.lore.baselineOn': 'с включёнными правилами лора — их эффекта он не покажет',
        'm21m.lore.baselinePending': 'Исходный уровень берётся по первым ходам ({size}); пока набрано: {turns}.',
        'm21m.lore.current': 'Сейчас символов на ход: {avg} (ходов: {turns}).',
        'm21m.packs.checkedAt': 'Проверено в {at}.',
        'm21m.packs.changedList': 'Изменены: {list}.',
        'm21m.packs.missingList': 'Не читаются: {list}.',
        'm21m.packs.addedList': 'Встретились впервые (отпечаток снят сейчас): {list}.',
        'm21m.losses.none': 'В этом сеансе не было.',

        'm21m.cost.main': 'Основная модель',
        'm21m.cost.maestro': 'Задачи Maestro',
        'm21m.cost.autoSwipes': 'Авто-свайпы',
        'm21m.cost.qvink': 'Qvink (отдельно)',
        'm21m.cost.other': 'Другие соседи (отдельно)',
        'm21m.cost.window': 'Окно: последние ходы ({turns}).',

        'm21m.export.title': 'Maestro: критерии R3',
        'm21m.export.meta': 'Сформировано {at}; замерено ходов: {turns}, с {since}; устройство: {device}.',
    },
};
