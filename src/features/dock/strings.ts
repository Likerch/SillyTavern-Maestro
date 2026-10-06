// Strings of the dock, M32 п.5 (`m32.dock.*`). Russian is the primary UI language; the user is addressed as «ты» (male).
import type { I18nParts } from '../../shared/contracts';

export const DOCK_STRINGS: I18nParts = {
    en: {
        'm32.dock.title': 'Extensions dock',
        'm32.dock.tab': 'Extensions',
        'm32.dock.intro':
            "The neighbour extensions' own settings blocks, gathered here while this section is shown. They keep working as usual; when you switch the section, collapse or close the window, each block goes back to its place in the Extensions panel. Maestro never changes their settings.",
        'm32.dock.none': 'No neighbour extensions found.',
        'm32.dock.keep': 'Keep in the Maestro window',
        'm32.dock.keepHint': 'Off: the block stays in the Extensions panel.',
        'm32.dock.atHome': 'The block stays in the Extensions panel.',
        'm32.dock.missing':
            'The settings block is not on the page: the extension has not drawn it yet or is turned off.',
        'm32.dock.taken': 'The extension took its block back — it is where the extension put it.',
        'm32.dock.redrawn': 'The extension keeps redrawing its block, so it stays in the Extensions panel this time.',

        'm32.dock.shortcuts': 'Shortcuts',
        'm32.dock.shortcutsHint':
            "Open the extensions' own windows. This window closes first, so the blocks are back home when they open.",
        'm32.dock.shortcutMissing':
            'Could not open «{name}»: the extension does not show its button right now. It may be off or still loading.',

        'm32.dock.portraits': 'DES portrait bar',
        'm32.dock.portraitsToggle': 'Move the portrait bar here',
        'm32.dock.portraitsHint':
            "It goes back above the chat input when the section is hidden, the window closes or Maestro is turned off. If it ever ends up in the wrong place, pick its position in DES's settings (Present Characters Panel → Position): DES puts it back itself.",
        'm32.dock.portraitsMissing': 'The portrait bar is not on the page (DES has it switched off).',

        'm32.dock.n.des': "Doom's Enhancement Suite",
        'm32.dock.n.desru': 'DES-RU',
        'm32.dock.n.ck': 'CarrotKernel',
        'm32.dock.n.qvink': 'Qvink Memory',
        'm32.dock.n.nai': 'NAI Studio',
        'm32.dock.n.localizer': 'Lorebook Localizer',

        'm32.dock.qvinkPopout':
            "Qvink's settings are open in their own window right now, so the block stays in the Extensions panel.",
        'm32.dock.naiNote':
            'Tag suggestions in the prompt fields only appear while the panel is in the Extensions panel.',

        'm32.dock.open.ckRepository': 'Repository manager',
        'm32.dock.open.ckTemplates': 'Templates',
        'm32.dock.open.ckPacks': 'Pack manager',
        'm32.dock.open.qvinkMemory': 'Qvink memory editor',
        'm32.dock.open.naiGallery': 'NAI Studio gallery',
        'm32.dock.open.naiScene': 'NAI Studio scene composer',
        'm32.dock.open.localizer': 'Lorebook Localizer',
        'm32.dock.open.desSettings': 'DES settings',
        'm32.dock.open.desRoster': 'DES character roster (Workshop)',
        'm32.dock.open.desLore': 'DES Lore Library',
        'm32.dock.open.desTracker': 'DES tracker editor',
    },
    ru: {
        'm32.dock.title': 'Док расширений',
        'm32.dock.tab': 'Расширения',
        'm32.dock.intro':
            'Собственные блоки настроек соседних расширений — здесь, пока открыт этот раздел. Они работают как обычно, а когда ты переключаешь раздел, сворачиваешь или закрываешь окно, каждый блок возвращается на своё место в панели расширений. Их настройки Maestro не меняет.',
        'm32.dock.none': 'Соседних расширений не нашлось.',
        'm32.dock.keep': 'Держать в окне Maestro',
        'm32.dock.keepHint': 'Если выключить, блок останется в панели расширений.',
        'm32.dock.atHome': 'Блок остаётся в панели расширений.',
        'm32.dock.missing': 'Блока настроек нет на странице: расширение ещё не нарисовало его или выключено.',
        'm32.dock.taken': 'Расширение забрало свой блок — он там, куда его поставило расширение.',
        'm32.dock.redrawn':
            'Расширение раз за разом перерисовывает свой блок, поэтому сейчас он остаётся в панели расширений.',

        'm32.dock.shortcuts': 'Ярлыки',
        'm32.dock.shortcutsHint':
            'Открывают собственные окна расширений. Это окно сначала закрывается, чтобы блоки успели вернуться на место.',
        'm32.dock.shortcutMissing':
            'Не получилось открыть «{name}»: расширение сейчас не показывает нужную кнопку. Возможно, оно выключено или ещё загружается.',

        'm32.dock.portraits': 'Полоса портретов DES',
        'm32.dock.portraitsToggle': 'Перенести полосу портретов сюда',
        'm32.dock.portraitsHint':
            'Она вернётся на место над полем ввода, когда раздел скроется, окно закроется или Maestro выключится. Если полоса всё же окажется не там, выбери её положение в настройках DES («Панель персонажей в сцене» → «Положение») — DES сам поставит её на место.',
        'm32.dock.portraitsMissing': 'Полосы портретов нет на странице (в DES она выключена).',

        'm32.dock.n.des': "Doom's Enhancement Suite",
        'm32.dock.n.desru': 'DES-RU',
        'm32.dock.n.ck': 'CarrotKernel',
        'm32.dock.n.qvink': 'Qvink Memory',
        'm32.dock.n.nai': 'NAI Studio',
        'm32.dock.n.localizer': 'Lorebook Localizer',

        'm32.dock.qvinkPopout':
            'Настройки Qvink сейчас открыты в отдельном окне, поэтому блок остаётся в панели расширений.',
        'm32.dock.naiNote':
            'Подсказки тегов в полях промпта появляются, только когда панель стоит в панели расширений.',

        'm32.dock.open.ckRepository': 'Менеджер репозиториев',
        'm32.dock.open.ckTemplates': 'Шаблоны',
        'm32.dock.open.ckPacks': 'Менеджер паков',
        'm32.dock.open.qvinkMemory': 'Редактор памяти Qvink',
        'm32.dock.open.naiGallery': 'Галерея NAI Studio',
        'm32.dock.open.naiScene': 'Сцена NAI Studio',
        'm32.dock.open.localizer': 'Локализатор лорбуков',
        'm32.dock.open.desSettings': 'Настройки DES',
        'm32.dock.open.desRoster': 'Мастерская DES: каталог персонажей',
        'm32.dock.open.desLore': 'Библиотека лора DES',
        'm32.dock.open.desTracker': 'Настройка трекера DES',
    },
};
