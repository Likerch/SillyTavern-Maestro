// Strings of M20 «Архитектор промпта» (plan M20).
import type { I18nParts } from '../../shared/contracts';

export const ARCHITECT_STRINGS: I18nParts = {
    en: {
        'm20.title': 'Prompt architect',
        'm20.tab': 'Architect',
        'kind.architect.duplicate': 'Repeated facts in the prompt',
        'target.m20.consent': 'Repeated fact',
        'm20.consent.fact': 'Fact',
        'm20.intro':
            'A smaller and sharper prompt with the same knowledge: budgets per source, lore of who is here and ' +
            'where, repeated facts and the provider cache. Nothing changes the prompt until you turn it on here.',
        'm20.noChat': 'Open a chat: the architect works on its prompts.',
        'm20.rulesMissing':
            'The lore part of the architect runs inside the «Rules» module (M22), which is off: the lore budget, ' +
            'damping, pinning and repeats in lore do nothing now.',

        'm20.budgets.title': 'Budgets',
        'm20.budgets.hint':
            'Tokens per turn for each source; 0 means no budget. Counts are estimates (about 3.6 characters per ' +
            'token).',
        'm20.source.lore': 'Lore (all books)',
        'm20.source.ckRag': 'CarrotKernel RAG',
        'm20.source.qvink': 'Qvink short-term memory',
        'm20.source.des': 'DES context block',
        'm20.source.voices': 'Voice cards',
        'm20.source.mechanics': 'Mechanics',
        'm20.source.director': 'Director',
        'm20.source.lore.hint':
            'Over the budget the lowest-order entries go first. Pinned entries, the canon, entries of present ' +
            'characters and of the current place, and «ignore budget» entries are never cut. Caps of single books ' +
            'are in «Rules».',
        'm20.source.ckRag.hint': 'Whole chunks go from the end (CK lists the best ones first).',
        'm20.source.qvink.hint': 'The oldest memories go first; long-term memory is never touched.',
        'm20.source.des.hint':
            "Only DES's optional context block is shortened (oldest sentences first). Tracker instructions, the " +
            'format and the example tracker are never cut.',
        'm20.source.voices.hint':
            'Voice cards fit themselves to this budget (dropping goals, bonds, then speech details).',
        'm20.source.noSource': 'No source yet: the value is kept and works once the source arrives.',
        'm20.usage': '{used} of {limit}',
        'm20.usage.free': 'last turn: {used}',
        'm20.status.off': 'no budget',
        'm20.status.ok': 'fits',
        'm20.status.trimmed': 'shortened by {cut}',
        'm20.status.cut': 'cut {cut}',
        'm20.status.over': 'still over the budget',
        'm20.status.empty': 'sent nothing',
        'm20.status.notFound': 'its text was not found in the prompt',
        'm20.status.noSource': 'no source yet',
        'm20.status.na': 'nothing may be cut',

        'm20.presence.title': 'Presence and place',
        'm20.presence.hint':
            'Who is here comes from the DES tracker of the last committed reply, places from the place registry. ' +
            'Constant entries, the canon, its pins and BunnyMo are never damped.',
        'm20.presence.damp': 'Damp lore about absent characters and far places',
        'm20.presence.pin': 'Pin lore about present characters and the current place',
        'm20.presence.window': 'A mention in the last K messages keeps an entry',
        'm20.presence.noWorld': 'The world model (M7) is off: there is nothing to judge presence by.',
        'm20.presence.damped': 'Damped last turn: {count}',
        'm20.presence.pinned': 'Pinned last turn: {count}',
        'm20.presence.cuts': 'Cut by the lore budget last turn: {count}',
        'm20.reason.absent': 'not in the scene',
        'm20.reason.farPlace': 'far place',
        'm20.reason.present': 'in the scene',
        'm20.reason.currentPlace': 'current place',
        'm20.since': 'last mention {count} messages ago',
        'm20.since.never': 'not mentioned lately',
        'm20.col.entry': 'Entry',
        'm20.col.about': 'About',
        'm20.col.why': 'Why',
        'm20.col.tokens': 'Tokens',

        'm20.dup.title': 'Repeated facts',
        'm20.dup.hint':
            'The same fact reached the prompt from several sources. Nothing is removed until you choose the source ' +
            'to keep; then the other copies are dropped on the fly (the books stay as they are).',
        'm20.dup.detect': 'Look for repeated facts after every turn',
        'm20.dup.none': 'No repeated facts in the last prompt.',
        'm20.dup.off': 'The search is off.',
        'm20.dup.keep': 'Keep only {source}',
        'm20.dup.reportOnly': 'Report only',
        'm20.dup.kept': 'Kept: {source}. The other copies are dropped.',
        'm20.dup.journal.keep': 'Repeated fact: keep only {source}',
        'm20.dup.journal.report': 'Repeated fact: let every copy through again',
        'm20.dup.proposal.keep':
            'The same fact reaches the prompt several times. I will cut the other copies out on the fly; books and ' +
            'memories stay as they are.',
        'm20.dup.proposal.report':
            'Every copy of the fact goes into the prompt again; the repeat only shows in the Architect tab.',
        'm20.dup.details': 'Found in: {sources}',
        'm20.dup.notice.keep': 'The repeated fact now reaches the prompt from one place only: {source}.',
        'm20.dup.notice.report': 'The repeated fact reaches the prompt from every place again; I only point it out.',
        'm20.owner.lore': 'lore',
        'm20.owner.canon': 'canon',
        'm20.owner.ckArchive': 'character sheet',
        'm20.owner.ck': 'CK RAG',
        'm20.owner.qvink': 'Qvink memory',
        'm20.owner.des': 'DES',
        'm20.owner.desru': 'DES-RU',
        'm20.owner.nai': 'NAI Studio',
        'm20.owner.summary': 'Summary',
        'm20.owner.authorsNote': "Author's note",
        'm20.owner.card': 'card',
        'm20.owner.maestro': 'Maestro',
        'm20.owner.other': 'other',

        'm20.cache.title': 'Provider cache',
        'm20.cache.measure': 'Measure the provider cache',
        'm20.cache.orderCheck': "Check the order of Maestro's injections (changing ones go last)",
        'm20.cache.summary':
            'Hits {rate} over {requests} requests: {cached} of {prompt} prompt tokens came from the cache.',
        'm20.cache.firstChange': 'The prompt usually starts to change at message {index}.',
        'm20.cache.none': 'No measured requests yet.',
        'm20.cache.noUsage': 'The provider sent no cache numbers.',
        'm20.order.title': "Maestro's changing injections before unchanged text",
        'm20.order.item': '{key}: message {index}, unchanged messages after it: {count}',
        'm20.order.none': "Maestro's changing injections sit at the end.",

        'm20.report.title': 'Last turn',
        'm20.report.none': 'No turn yet.',
        'm20.report.at': 'Turn of {time}',
        'm20.col.rule': 'Rule',
        'm20.col.before': 'Before',
        'm20.col.after': 'After',
        'm20.col.count': 'How many',
        'm20.effect.damp': 'Damping',
        'm20.effect.pin': 'Pinning',
        'm20.effect.loreBudget': 'Lore budget',
        'm20.effect.ckRag': 'CK RAG budget',
        'm20.effect.qvink': 'Qvink budget',
        'm20.effect.des': 'DES budget',
        'm20.effect.dedup': 'Repeats dropped',
        'm20.inspector.title': 'Architect',
        'm20.inspector.none': 'The architect changed nothing in this prompt.',

        'm20.rule.damp.title': 'Architect: damp absent and far',
        'm20.rule.damp.description':
            'Lore about characters who are not in the scene and about far places is left out of the scan unless ' +
            'they were mentioned in the last messages. Set it up in the «Architect» tab.',
        'm20.rule.pin.title': 'Architect: pin present and current place',
        'm20.rule.pin.description':
            'Lore about the characters in the scene and about the current place joins the prompt even without a ' +
            'keyword. Set it up in the «Architect» tab.',
        'm20.rule.loreBudget.title': 'Architect: lore budget',
        'm20.rule.loreBudget.description':
            'Total lore of a turn over the budget: the lowest-order entries leave first; pinned, canon and present ' +
            'stay. Set the budget in the «Architect» tab.',
        'm20.rule.dedup.title': 'Architect: drop repeated facts in lore',
        'm20.rule.dedup.description':
            'A fact you chose to keep in another source is cut out of the lore entry for this turn (the book stays ' +
            'as it is).',
    },
    ru: {
        'm20.title': 'Архитектор промпта',
        'm20.tab': 'Архитектор',
        'kind.architect.duplicate': 'Повторы фактов в промпте',
        'target.m20.consent': 'Повтор факта',
        'm20.consent.fact': 'Факт',
        'm20.intro':
            'Промпт меньше и точнее при тех же знаниях: бюджеты по источникам, лор тех, кто рядом, повторы фактов ' +
            'и кэш провайдера. Пока ты ничего не включил здесь, промпт не меняется.',
        'm20.noChat': 'Открой чат: архитектор работает с его промптами.',
        'm20.rulesMissing':
            'Лорная часть архитектора работает внутри модуля «Правила» (M22), а он выключен: бюджет лора, ' +
            'приглушение, закрепление и повторы в лоре сейчас не действуют.',

        'm20.budgets.title': 'Бюджеты',
        'm20.budgets.hint':
            'Токены на ход для каждого источника; 0 — без ограничения. Счёт примерный (около 3,6 символа на токен).',
        'm20.source.lore': 'Лор (все книги)',
        'm20.source.ckRag': 'RAG CarrotKernel',
        'm20.source.qvink': 'Краткосрочная память Qvink',
        'm20.source.des': 'Блок контекста DES',
        'm20.source.voices': 'Голосовые карточки',
        'm20.source.mechanics': 'Механики',
        'm20.source.director': 'Режиссёр',
        'm20.source.lore.hint':
            'При превышении первыми уходят записи с наименьшим порядком. Закреплённые записи, канон, записи ' +
            'присутствующих и текущего места и записи с «игнорировать бюджет» не снимаются. Потолки отдельных книг — ' +
            'в «Правилах».',
        'm20.source.ckRag.hint': 'Целые фрагменты убираются с конца (CK ставит лучшие первыми).',
        'm20.source.qvink.hint': 'Первыми уходят самые старые воспоминания; долгосрочная память не трогается.',
        'm20.source.des.hint':
            'Сокращается только необязательный блок контекста DES (сначала старые предложения). Инструкции трекера, ' +
            'формат и пример трекера не трогаются никогда.',
        'm20.source.voices.hint':
            'Голосовые карточки сами укладываются в этот бюджет (сначала уходят цели, потом связи, потом детали речи).',
        'm20.source.noSource': 'Источника пока нет: значение сохранится и заработает, когда он появится.',
        'm20.usage': '{used} из {limit}',
        'm20.usage.free': 'в прошлом ходе: {used}',
        'm20.status.off': 'без ограничения',
        'm20.status.ok': 'в пределах',
        'm20.status.trimmed': 'сокращено на {cut}',
        'm20.status.cut': 'снято {cut}',
        'm20.status.over': 'всё ещё больше бюджета',
        'm20.status.empty': 'ничего не прислал',
        'm20.status.notFound': 'текст не найден в промпте',
        'm20.status.noSource': 'источника пока нет',
        'm20.status.na': 'резать нечего',

        'm20.presence.title': 'Присутствие и место',
        'm20.presence.hint':
            'Кто в сцене — по трекеру DES последнего принятого ответа, места — из реестра мест. Постоянные записи, ' +
            'канон, его закрепления и BunnyMo не приглушаются никогда.',
        'm20.presence.damp': 'Приглушать лор об отсутствующих и далёких местах',
        'm20.presence.pin': 'Закреплять лор присутствующих и текущего места',
        'm20.presence.window': 'Упоминание в последних K сообщениях сохраняет запись',
        'm20.presence.noWorld': 'Модель мира (M7) выключена — присутствие определить не по чему.',
        'm20.presence.damped': 'Приглушено в прошлом ходе: {count}',
        'm20.presence.pinned': 'Закреплено в прошлом ходе: {count}',
        'm20.presence.cuts': 'Снято бюджетом лора в прошлом ходе: {count}',
        'm20.reason.absent': 'нет в сцене',
        'm20.reason.farPlace': 'далёкое место',
        'm20.reason.present': 'в сцене',
        'm20.reason.currentPlace': 'текущее место',
        'm20.since': 'последнее упоминание — сообщений назад: {count}',
        'm20.since.never': 'давно не упоминался',
        'm20.col.entry': 'Запись',
        'm20.col.about': 'О ком / о чём',
        'm20.col.why': 'Почему',
        'm20.col.tokens': 'Токены',

        'm20.dup.title': 'Повторы фактов',
        'm20.dup.hint':
            'Один и тот же факт пришёл в промпт из нескольких источников. Ничего не убирается, пока ты не выберешь, ' +
            'какой источник оставить; после этого остальные копии убираются на лету (книги не меняются).',
        'm20.dup.detect': 'Искать повторы после каждого хода',
        'm20.dup.none': 'В последнем промпте повторов нет.',
        'm20.dup.off': 'Поиск выключен.',
        'm20.dup.keep': 'Оставить только {source}',
        'm20.dup.reportOnly': 'Только отчёт',
        'm20.dup.kept': 'Оставлено: {source}. Остальные копии убираются.',
        'm20.dup.journal.keep': 'Повтор факта: оставить только {source}',
        'm20.dup.journal.report': 'Повтор факта: снова пускать все копии',
        'm20.dup.proposal.keep':
            'Один и тот же факт попадает в промпт несколько раз. Остальные копии я буду убирать на лету; книги и ' +
            'память при этом не меняются.',
        'm20.dup.proposal.report':
            'Все копии факта снова пойдут в промпт, повтор останется только в отчёте на вкладке «Архитектор».',
        'm20.dup.details': 'Где встречается: {sources}',
        'm20.dup.notice.keep': 'Повторяющийся факт теперь идёт в промпт только из одного места: {source}.',
        'm20.dup.notice.report': 'Повторяющийся факт снова идёт в промпт из всех мест — я только отмечаю повтор.',
        'm20.owner.lore': 'лор',
        'm20.owner.canon': 'канон',
        'm20.owner.ckArchive': 'лист характера',
        'm20.owner.ck': 'RAG CK',
        'm20.owner.qvink': 'память Qvink',
        'm20.owner.des': 'DES',
        'm20.owner.desru': 'DES-RU',
        'm20.owner.nai': 'NAI Studio',
        'm20.owner.summary': 'сводка',
        'm20.owner.authorsNote': 'заметка автора',
        'm20.owner.card': 'карточка',
        'm20.owner.maestro': 'Maestro',
        'm20.owner.other': 'другое',

        'm20.cache.title': 'Кэш провайдера',
        'm20.cache.measure': 'Замерять кэш провайдера',
        'm20.cache.orderCheck': 'Проверять порядок вставок Maestro (изменчивое — в конце)',
        'm20.cache.summary': 'Попадания {rate} за {requests} запросов: {cached} из {prompt} токенов промпта — из кэша.',
        'm20.cache.firstChange': 'Обычно промпт начинает меняться с сообщения № {index}.',
        'm20.cache.none': 'Замеров пока нет.',
        'm20.cache.noUsage': 'Провайдер не прислал данных о кэше.',
        'm20.order.title': 'Изменчивые вставки Maestro перед неизменным текстом',
        'm20.order.item': '{key}: сообщение № {index}, неизменных сообщений после него: {count}',
        'm20.order.none': 'Изменчивые вставки Maestro стоят в конце.',

        'm20.report.title': 'Последний ход',
        'm20.report.none': 'Ходов ещё не было.',
        'm20.report.at': 'Ход в {time}',
        'm20.col.rule': 'Правило',
        'm20.col.before': 'До',
        'm20.col.after': 'После',
        'm20.col.count': 'Сколько',
        'm20.effect.damp': 'Приглушение',
        'm20.effect.pin': 'Закрепление',
        'm20.effect.loreBudget': 'Бюджет лора',
        'm20.effect.ckRag': 'Бюджет RAG CK',
        'm20.effect.qvink': 'Бюджет Qvink',
        'm20.effect.des': 'Бюджет DES',
        'm20.effect.dedup': 'Убранные повторы',
        'm20.inspector.title': 'Архитектор',
        'm20.inspector.none': 'В этом промпте архитектор ничего не менял.',

        'm20.rule.damp.title': 'Архитектор: приглушение отсутствующих и далёких',
        'm20.rule.damp.description':
            'Лор о персонажах, которых нет в сцене, и о далёких местах не участвует в сканировании, если о них не ' +
            'говорили в последних сообщениях. Настройка — во вкладке «Архитектор».',
        'm20.rule.pin.title': 'Архитектор: закрепление присутствующих и текущего места',
        'm20.rule.pin.description':
            'Лор о персонажах в сцене и о текущем месте попадает в промпт даже без ключевого слова. Настройка — во ' +
            'вкладке «Архитектор».',
        'm20.rule.loreBudget.title': 'Архитектор: бюджет лора',
        'm20.rule.loreBudget.description':
            'Если лора за ход больше бюджета, первыми уходят записи с наименьшим порядком; закреплённые, канон и ' +
            'записи присутствующих остаются. Бюджет задаётся во вкладке «Архитектор».',
        'm20.rule.dedup.title': 'Архитектор: повторы фактов в лоре',
        'm20.rule.dedup.description':
            'Факт, который ты решил оставить в другом источнике, убирается из записи лора на этот ход (книга не ' +
            'меняется).',
    },
};
