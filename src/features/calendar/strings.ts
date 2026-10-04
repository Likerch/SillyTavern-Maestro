// Strings of M17 «Календарь и обещания» (`m17.*`). Russian is the primary UI language; the user is addressed as «ты»
// (male).
import type { I18nParts } from '../../shared/contracts';

export const CALENDAR_STRINGS: I18nParts = {
    en: {
        'm17.title': 'Calendar and promises',
        'm17.tab': 'Calendar',
        'm17.hint':
            'Agreements and deadlines from the story: who promised what to whom and by when. Story time comes from the DES tracker, promises from the revision (or add one yourself). When a deadline comes the director may remind the story of it; an overdue or broken promise is a reason for consequences.',
        'm17.noChat': 'No chat is open.',
        'm17.notLeader':
            'Another Maestro tab follows the story time and takes new promises in; here you can still mark and add them.',

        'm17.now.title': 'Story time',
        'm17.now.unknown': 'DES has not written a date or time yet. Without story time deadlines wait for your mark.',
        'm17.now.day': 'Story day {day}',
        'm17.now.date': 'Date: {date}',
        'm17.now.time': 'Time: {time}',

        'm17.status.open': 'Open',
        'm17.status.due': 'Due now',
        'm17.status.overdue': 'Overdue',
        'm17.status.done': 'Kept',
        'm17.status.cancelled': 'Cancelled',
        'm17.status.broken': 'Broken',

        'm17.section.due': 'The deadline has come ({count})',
        'm17.section.overdue': 'Overdue ({count})',
        'm17.section.open': 'Open ({count})',
        'm17.section.closed': 'Closed ({count})',
        'm17.empty.active': 'No open promises. They appear after a revision finds an agreement or a deadline.',
        'm17.empty.closed': 'Nothing closed yet.',
        'm17.closed.more': 'Showing the last {count}.',

        'm17.people': '{who} → {toWhom}',
        'm17.people.who': '{who}',
        'm17.people.unknown': 'someone',
        'm17.due.none': 'No deadline',
        'm17.due.label': 'Deadline: {label}',
        'm17.due.day': 'story day {day}',
        'm17.due.dayTime': 'story day {day}, {time}',
        'm17.due.unplaced': 'not placed in story time',
        'm17.origin.revision': 'from the revision',
        'm17.origin.user': 'added by you',
        'm17.origin.api': 'added by Maestro',
        'm17.source': 'message #{index}',
        'm17.source.hint': 'Show the message the promise comes from',

        'm17.action.done': 'Kept',
        'm17.action.done.hint': 'The promise was kept',
        'm17.action.cancelled': 'Cancelled',
        'm17.action.cancelled.hint': 'Called off, or it was a mistake',
        'm17.action.broken': 'Broken',
        'm17.action.broken.hint': 'The promise was broken: a reason for consequences',
        'm17.action.reopen': 'Reopen',
        'm17.action.reopen.hint': 'Back to the open promises (its status follows the story time again)',

        'm17.add.title': 'Add a promise',
        'm17.add.who': 'Who promised',
        'm17.add.toWhom': 'To whom',
        'm17.add.what': 'What',
        'm17.add.when': 'By when',
        'm17.add.when.hint': 'A phrase ("by sunset", "in two days", «к закату») or a date as DES writes it.',
        'm17.add.quote': 'Quote (optional)',
        'm17.add.submit': 'Add',
        'm17.add.done': 'Promise added.',

        'm17.settings.title': 'Settings',
        'm17.settings.days': 'Overdue after, story days',
        'm17.settings.days.hint':
            'A due promise not kept this many story days after its deadline is overdue (0 = never by days).',
        'm17.settings.turns': 'Overdue after, turns',
        'm17.settings.turns.hint': 'Or after this many of your turns since it came due (0 = never by turns).',

        'm17.error.what': 'Write what was promised.',
        'm17.error.noChat': 'Open a chat first.',
        'm17.error.notSaved': 'The promise was not saved; try again.',
    },
    ru: {
        'm17.title': 'Календарь и обещания',
        'm17.tab': 'Календарь',
        'm17.hint':
            'Договорённости и сроки из истории: кто, что, кому и к какому сроку пообещал. Время истории берётся из трекера DES, обещания — из ревизии (или добавь сам). Когда срок наступает, режиссёр может о нём напомнить; просроченное или нарушенное обещание — повод для последствий.',
        'm17.noChat': 'Чат не открыт.',
        'm17.notLeader':
            'За временем истории и новыми обещаниями следит другая вкладка Maestro; отмечать и добавлять обещания можно и здесь.',

        'm17.now.title': 'Время истории',
        'm17.now.unknown': 'DES ещё не записал дату или время. Пока времени истории нет, сроки ждут твоей отметки.',
        'm17.now.day': 'День истории: {day}',
        'm17.now.date': 'Дата: {date}',
        'm17.now.time': 'Время: {time}',

        'm17.status.open': 'Открыто',
        'm17.status.due': 'Срок наступил',
        'm17.status.overdue': 'Просрочено',
        'm17.status.done': 'Выполнено',
        'm17.status.cancelled': 'Отменено',
        'm17.status.broken': 'Нарушено',

        'm17.section.due': 'Срок наступил ({count})',
        'm17.section.overdue': 'Просрочено ({count})',
        'm17.section.open': 'Открытые ({count})',
        'm17.section.closed': 'Закрытые ({count})',
        'm17.empty.active': 'Открытых обещаний нет. Они появятся, когда ревизия найдёт договорённость или срок.',
        'm17.empty.closed': 'Закрытых пока нет.',
        'm17.closed.more': 'Показаны последние {count}.',

        'm17.people': '{who} → {toWhom}',
        'm17.people.who': '{who}',
        'm17.people.unknown': 'кто-то',
        'm17.due.none': 'Без срока',
        'm17.due.label': 'Срок: {label}',
        'm17.due.day': 'день истории {day}',
        'm17.due.dayTime': 'день истории {day}, {time}',
        'm17.due.unplaced': 'не привязан ко времени истории',
        'm17.origin.revision': 'из ревизии',
        'm17.origin.user': 'добавлено тобой',
        'm17.origin.api': 'добавлено Maestro',
        'm17.source': 'сообщение #{index}',
        'm17.source.hint': 'Показать сообщение, из которого взято обещание',

        'm17.action.done': 'Выполнено',
        'm17.action.done.hint': 'Обещание сдержали',
        'm17.action.cancelled': 'Отменено',
        'm17.action.cancelled.hint': 'Договорённость отменили, или это ошибка',
        'm17.action.broken': 'Нарушено',
        'm17.action.broken.hint': 'Обещание нарушено — повод для последствий',
        'm17.action.reopen': 'Вернуть',
        'm17.action.reopen.hint': 'Снова в открытые (статус опять следует за временем истории)',

        'm17.add.title': 'Добавить обещание',
        'm17.add.who': 'Кто пообещал',
        'm17.add.toWhom': 'Кому',
        'm17.add.what': 'Что',
        'm17.add.when': 'К какому сроку',
        'm17.add.when.hint': 'Фраза («к закату», «через два дня», "by sunset") или дата так, как её пишет DES.',
        'm17.add.quote': 'Цитата (необязательно)',
        'm17.add.submit': 'Добавить',
        'm17.add.done': 'Обещание добавлено.',

        'm17.settings.title': 'Настройки',
        'm17.settings.days': 'Просрочено через, дней истории',
        'm17.settings.days.hint':
            'Обещание с наступившим сроком, не выполненное за столько дней истории после срока, считается просроченным (0 — не считать по дням).',
        'm17.settings.turns': 'Просрочено через, ходов',
        'm17.settings.turns.hint': 'Или через столько твоих ходов после наступления срока (0 — не считать по ходам).',

        'm17.error.what': 'Напиши, что именно обещано.',
        'm17.error.noChat': 'Сначала открой чат.',
        'm17.error.notSaved': 'Обещание не сохранилось; попробуй ещё раз.',
    },
};
