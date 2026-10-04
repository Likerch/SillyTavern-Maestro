import type { I18nParts } from '../../shared/contracts';

export const SCENARIO_STRINGS: I18nParts = {
    en: {
        'scn.title': 'Generation scenarios',
        'scn.failed': 'Scenario “{id}” did not work out: the request went out with the regular prompt.',
        'scn.impersonate.title': 'Impersonate',
        'scn.impersonate.desc':
            'Writing for you: a short reply, its own stop strings, no reasoning. The prompt stays unless you set your own messages.',
        'scn.continue.title': 'Continue',
        'scn.continue.desc':
            'Continuing the last reply with its own length. The continued text goes out once, without a second prefill.',
    },
    ru: {
        'scn.title': 'Сценарии генерации',
        'scn.failed': 'Сценарий «{id}» не сработал — запрос ушёл с обычным промптом.',
        'scn.impersonate.title': 'Перевоплощение',
        'scn.impersonate.desc':
            'Ответ за тебя: короткий, со своими стоп-строками и без рассуждений. Промпт прежний, если не задать свои сообщения.',
        'scn.continue.title': 'Продолжение',
        'scn.continue.desc':
            'Продолжение последнего ответа со своей длиной. Продолжаемый текст уходит один раз, без повторного префилла.',
    },
};
