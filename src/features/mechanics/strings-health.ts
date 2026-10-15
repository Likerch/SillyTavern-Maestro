// Strings of M25 «Механики», what keeps the values from following the story (`m25.health.*`, release 1.25) and the
// background parse's line in «Профили». Russian is the primary UI language; the user is addressed as «ты» (male).
import type { I18nParts } from '../../shared/contracts';

export const HEALTH_STRINGS: I18nParts = {
    en: {
        'm25.profileTask': 'Mechanics: reading replies',
        'm25.health.title': 'Tracking',
        'm25.health.noProfile':
            'The background parse has no connection profile, so {list} do not change by themselves. Pick a profile in Maestro → Settings → «Connection profiles» (the main background profile or «Mechanics: reading replies»).',
        'm25.health.cap':
            "Today's background limit is reached: {list} stop changing by themselves until tomorrow (or raise the limit in the settings).",
        'm25.health.backgroundOff':
            'The background parse is off in the mechanics settings, so {list} do not change by themselves.',
        'm25.health.extractFailed': 'The latest background parse of a reply failed; the next reply is tried again.',
        'm25.health.desStatsPending':
            'DES does not track the stats of {list} yet — the background parse reads them meanwhile. Make them DES stats to read them from the tracker.',
        'm25.health.noDes': 'DES is off: the stats of {list} are read by the background parse.',
        'm25.health.otherTab': 'Another tab of this chat counts the values; this one only shows them.',
        'm25.health.noProfile.auto':
            'The background parse has no connection profile: when the model leaves out its service block, the changes of that reply are lost (mechanics: {list}). Pick a profile in Maestro → Settings → «Connection profiles» (the main background profile or «Mechanics: reading replies»).',
        'm25.health.cap.auto':
            "Today's background limit is reached: until tomorrow, when the model leaves out its service block, the changes of that reply are lost (mechanics: {list}). Or raise the limit in the settings.",
        'm25.health.backgroundOff.auto':
            'The background parse is off in the mechanics settings: when the model leaves out its service block, the changes of that reply are lost (mechanics: {list}).',
        'm25.health.action.profiles': 'Profiles',
        'm25.health.action.settings': 'Settings',
        'm25.health.action.desStats': 'DES stats: {name}',
    },
    ru: {
        'm25.profileTask': 'Механики: разбор ответа',
        'm25.health.title': 'Учёт',
        'm25.health.noProfile':
            'У фонового разбора нет профиля подключения — {list} сами не меняются. Выбери профиль: Maestro → Настройки → «Профили подключения» (основной фоновый или «Механики: разбор ответа»).',
        'm25.health.cap':
            'Дневной лимит фоновых запросов исчерпан: {list} сами не меняются до завтра (или подними лимит в настройках).',
        'm25.health.backgroundOff': 'Фоновый разбор выключен в настройках механик — {list} сами не меняются.',
        'm25.health.extractFailed': 'Последний фоновый разбор ответа не удался; со следующим ответом попробую снова.',
        'm25.health.desStatsPending':
            'DES ещё не ведёт статы {list} — пока их читает фоновый разбор. Сделай их статами DES, чтобы брать из трекера.',
        'm25.health.noDes': 'DES выключен: статы {list} читает фоновый разбор.',
        'm25.health.otherTab': 'Значения этого чата считает другая вкладка; эта только показывает.',
        'm25.health.noProfile.auto':
            'У фонового разбора нет профиля подключения: если модель забудет служебный блок, изменения этого ответа потеряются (механики: {list}). Выбери профиль: Maestro → Настройки → «Профили подключения» (основной фоновый или «Механики: разбор ответа»).',
        'm25.health.cap.auto':
            'Дневной лимит фоновых запросов исчерпан: до завтра, если модель забудет служебный блок, изменения этого ответа потеряются (механики: {list}). Или подними лимит в настройках.',
        'm25.health.backgroundOff.auto':
            'Фоновый разбор выключен в настройках механик: если модель забудет служебный блок, изменения этого ответа потеряются (механики: {list}).',
        'm25.health.action.profiles': 'Профили',
        'm25.health.action.settings': 'Настройки',
        'm25.health.action.desStats': 'Статы DES: {name}',
    },
};
