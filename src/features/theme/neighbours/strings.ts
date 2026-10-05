// Strings of the neighbour skins (M32 `m32.skin.*`): the name of each part in the look settings and what it restyles.
// Russian is the primary UI language; DES window names follow DES-RU's translation.
import type { I18nParts } from '../../../shared/contracts';

export const NEIGHBOUR_STRINGS: I18nParts = {
    en: {
        'm32.skin.des': "Doom's Enhancement Suite",
        'm32.skin.des.hint':
            "Portrait bar, scene headers and thoughts in the chat, the tracker panel and DES's windows: settings, Character Workshop, Character Roster, Lore Library.",
        'm32.skin.ck': 'CarrotKernel',
        'm32.skin.ck.hint':
            'Settings block, popups, the lorebook tracker, the RAG viewer and the BunnyMo blocks in messages.',
        'm32.skin.nai': 'NAI Studio',
        'm32.skin.nai.hint':
            'Settings panel, studio windows, generation progress, and the images and image markers in the chat.',
        'm32.skin.desru': 'DES-RU',
        'm32.skin.desru.hint': 'Settings block: status, modules, dictionaries, name merges and the log.',
        'm32.skin.qvink': 'Qvink Memory',
        'm32.skin.qvink.hint':
            'Memory lines under messages, the settings block, the memory editor and the progress bar.',
        'm32.skin.localizer': 'Lorebook Localizer',
        'm32.skin.localizer.hint': 'Settings block and the key localization window.',
    },
    ru: {
        'm32.skin.des': "Doom's Enhancement Suite",
        'm32.skin.des.hint':
            'Полоса портретов, шапки сцен и мысли в чате, панель трекера и окна DES: настройки, мастерская персонажа, каталог персонажей, библиотека лора.',
        'm32.skin.ck': 'CarrotKernel',
        'm32.skin.ck.hint':
            'Блок настроек, всплывающие окна, трекер лорбуков, просмотр RAG и блоки BunnyMo в сообщениях.',
        'm32.skin.nai': 'NAI Studio',
        'm32.skin.nai.hint': 'Панель настроек, окна студии, ход генерации, картинки и маркеры картинок в чате.',
        'm32.skin.desru': 'DES-RU',
        'm32.skin.desru.hint': 'Блок настроек: состояние, модули, словари, склейки имён и журнал.',
        'm32.skin.qvink': 'Qvink Memory',
        'm32.skin.qvink.hint': 'Строки памяти под сообщениями, блок настроек, редактор памяти и полоса прогресса.',
        'm32.skin.localizer': 'Lorebook Localizer',
        'm32.skin.localizer.hint': 'Блок настроек и окно перевода ключей.',
    },
};
