import type { I18nParts } from '../shared/contracts';

/** Strings of core services (`core.*`). Russian is the primary UI language. */
export const CORE_STRINGS: I18nParts = {
    en: {
        'core.name': 'Maestro',

        'core.autonomy.level.auto': 'Auto',
        'core.autonomy.level.notify': 'Notify',
        'core.autonomy.level.inbox': 'Inbox',
        'core.autonomy.level.ask': 'Ask',
        'core.autonomy.level.off': 'Off',
        'core.autonomy.apply': 'Apply',
        'core.autonomy.dismiss': 'No, thanks',
        'core.autonomy.stale':
            'The suggestion is out of date: things changed since it appeared, so nothing was changed.',
        'core.autonomy.failed': 'Could not apply: {title}',
        'core.autonomy.promote':
            'You have accepted “{kind}” {count} times in a row without changes. Shall I do it myself from now on, without asking?',
        'core.autonomy.promoteAction': 'Yes, do it yourself',
        'core.autonomy.promoted':
            'Fine: I do “{kind}” myself now. The questions can be brought back in Settings → Autonomy levels.',
        'core.autonomy.done': 'Done: {title}',
        'core.autonomy.doneMany.one': 'Made {count} change myself — {kind}',
        'core.autonomy.doneMany.few': 'Made {count} changes myself — {kind}',
        'core.autonomy.doneMany.many': 'Made {count} changes myself — {kind}',
        'core.autonomy.doneManyPlain.one': 'Made {count} change myself',
        'core.autonomy.doneManyPlain.few': 'Made {count} changes myself',
        'core.autonomy.doneManyPlain.many': 'Made {count} changes myself',
        'core.autonomy.undo': 'Undo',
        'core.autonomy.undone': 'Undone: {title}',
        'core.autonomy.undoFailed': 'Could not undo: {title}. The journal shows what is left.',

        'core.value.yes': 'yes',
        'core.value.no': 'no',

        'core.dramatis.target': 'Dramatis',
        'core.module.dramatis': 'Dramatis',
    },
    ru: {
        'core.name': 'Maestro',

        'core.autonomy.level.auto': 'Само',
        'core.autonomy.level.notify': 'Уведомить',
        'core.autonomy.level.inbox': 'Входящие',
        'core.autonomy.level.ask': 'Спросить',
        'core.autonomy.level.off': 'Выкл',
        'core.autonomy.apply': 'Применить',
        'core.autonomy.dismiss': 'Не надо',
        'core.autonomy.stale': 'Предложение устарело: с тех пор всё изменилось, поэтому я ничего не менял.',
        'core.autonomy.failed': 'Не получилось применить: {title}',
        'core.autonomy.promote':
            'Ты уже {count} раз подряд принимаешь «{kind}» без правок. Делать это дальше самому, не спрашивая?',
        'core.autonomy.promoteAction': 'Да, делай сам',
        'core.autonomy.promoted':
            'Хорошо: «{kind}» теперь делаю сам. Вернуть вопросы можно в настройках, раздел «Уровни автономии».',
        'core.autonomy.done': 'Сделал: {title}',
        'core.autonomy.doneMany.one': 'Сделал сам {count} изменение — {kind}',
        'core.autonomy.doneMany.few': 'Сделал сам {count} изменения — {kind}',
        'core.autonomy.doneMany.many': 'Сделал сам {count} изменений — {kind}',
        'core.autonomy.doneManyPlain.one': 'Сделал сам {count} изменение',
        'core.autonomy.doneManyPlain.few': 'Сделал сам {count} изменения',
        'core.autonomy.doneManyPlain.many': 'Сделал сам {count} изменений',
        'core.autonomy.undo': 'Отменить',
        'core.autonomy.undone': 'Отменил: {title}',
        'core.autonomy.undoFailed': 'Не получилось отменить: {title}. Что осталось — видно в журнале.',

        'core.value.yes': 'да',
        'core.value.no': 'нет',

        'core.dramatis.target': 'Dramatis',
        'core.module.dramatis': 'Dramatis',
    },
};
