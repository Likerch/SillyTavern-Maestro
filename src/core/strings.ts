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
        'core.autonomy.stale': 'The suggestion is out of date: the data has changed since it was made.',
        'core.autonomy.failed': 'Could not apply: {title}',
        'core.autonomy.promote':
            'You accepted “{kind}” suggestions {count} times in a row without changes. Apply them automatically from now on?',
        'core.autonomy.promoteAction': 'Switch to Auto',
        'core.autonomy.promoted': '“{kind}” is now set to Auto. You can change this in the autonomy settings.',
    },
    ru: {
        'core.name': 'Maestro',

        'core.autonomy.level.auto': 'Само',
        'core.autonomy.level.notify': 'Уведомить',
        'core.autonomy.level.inbox': 'Входящие',
        'core.autonomy.level.ask': 'Спросить',
        'core.autonomy.level.off': 'Выкл',
        'core.autonomy.apply': 'Применить',
        'core.autonomy.stale': 'Предложение устарело: данные изменились с тех пор, как оно появилось.',
        'core.autonomy.failed': 'Не получилось применить: {title}',
        'core.autonomy.promote':
            'Ты принимаешь предложения «{kind}» без правок (подряд: {count}). Применять их дальше автоматически?',
        'core.autonomy.promoteAction': 'Перевести в «Само»',
        'core.autonomy.promoted': 'Теперь «{kind}» — в режиме «Само». Поменять можно в настройках автономии.',
    },
};
