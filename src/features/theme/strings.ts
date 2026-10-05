// Strings of M32 «Оформление» (the theme layer). Neighbour part names are normally the skins' own titleKey; the
// `m32.theme.part.<id>` keys here are the fallback when a skin's key has no translation.
import type { I18nParts } from '../../shared/contracts';

export const THEME_STRINGS: I18nParts = {
    en: {
        'm32.theme.title': 'Appearance',
        'm32.theme.tab': 'Appearance',
        'm32.theme.intro':
            'One look for SillyTavern, the chat and the extensions. Colours, blur, shadows and font size come from your ST theme; Maestro adds rounded corners, spacing and consistent controls.',
        'm32.theme.enabled': 'Unified Maestro style',
        'm32.theme.enabledHint':
            'Off: everything looks exactly as without Maestro. ST and extension settings are never changed.',
        'm32.theme.offHint':
            'The unified style is off: SillyTavern and the extensions look as they do without Maestro.',
        'm32.theme.parts': 'What to restyle',
        'm32.theme.partsHint': 'Extensions appear here when they are installed and enabled.',
        'm32.theme.part.st': 'SillyTavern interface',
        'm32.theme.part.st.hint':
            'Top bar, panels and popups, the start page with recent chats, chat files, personas and the character list. Chat lists show the last message without service blocks (DES tracker, HTML); the chats themselves are not changed.',
        'm32.theme.part.chat': 'Chat messages',
        'm32.theme.part.chat.hint': 'Messages in all three ST chat styles and the message box under the chat.',
        'm32.theme.part.des': 'DES (scene headers, windows)',
        'm32.theme.part.ck': 'CarrotKernel',
        'm32.theme.part.nai': 'NAI Studio',
        'm32.theme.part.desru': 'DES-RU',
        'm32.theme.part.qvink': 'Qvink Memory',
        'm32.theme.part.localizer': 'Lorebook Localizer',
        'm32.theme.density': 'Density',
        'm32.theme.density.comfortable': 'Comfortable',
        'm32.theme.density.compact': 'Compact',
        'm32.theme.radius': 'Corners',
        'm32.theme.radius.0': 'Square',
        'm32.theme.radius.0.5': 'Slightly rounded',
        'm32.theme.radius.1': 'Rounded',
        'm32.theme.radius.1.5': 'Round',
        'm32.theme.compareLabel': 'Compare',
        'm32.theme.compare': 'Show the original look',
        'm32.theme.compareBack': 'Back to the unified style',
        'm32.theme.compareHint':
            'Shows the page without Maestro’s style for 10 seconds, then the style comes back by itself. Nothing is saved.',
    },
    ru: {
        'm32.theme.title': 'Оформление',
        'm32.theme.tab': 'Оформление',
        'm32.theme.intro':
            'Один стиль для SillyTavern, чата и расширений. Цвета, размытие, тени и размер шрифта берутся из твоей темы ST, а Maestro добавляет скругления, отступы и единые элементы управления.',
        'm32.theme.enabled': 'Единый стиль Maestro',
        'm32.theme.enabledHint':
            'Если выключить, всё будет выглядеть ровно как без Maestro. Настройки ST и расширений не меняются.',
        'm32.theme.offHint': 'Единый стиль выключен: SillyTavern и расширения выглядят как без Maestro.',
        'm32.theme.parts': 'Что оформлять',
        'm32.theme.partsHint': 'Расширения появятся в списке, когда они установлены и включены.',
        'm32.theme.part.st': 'Интерфейс SillyTavern',
        'm32.theme.part.st.hint':
            'Верхняя панель, панели и окна, стартовая страница с недавними чатами, список чатов, персоны и список персонажей. В списках чатов последнее сообщение показано без служебных блоков (трекер DES, HTML), сами чаты не меняются.',
        'm32.theme.part.chat': 'Сообщения чата',
        'm32.theme.part.chat.hint': 'Сообщения во всех трёх стилях чата ST и поле ввода под чатом.',
        'm32.theme.part.des': 'DES (шапки сцен, окна)',
        'm32.theme.part.ck': 'CarrotKernel',
        'm32.theme.part.nai': 'NAI Studio',
        'm32.theme.part.desru': 'DES-RU',
        'm32.theme.part.qvink': 'Память Qvink',
        'm32.theme.part.localizer': 'Lorebook Localizer',
        'm32.theme.density': 'Плотность',
        'm32.theme.density.comfortable': 'Свободно',
        'm32.theme.density.compact': 'Плотно',
        'm32.theme.radius': 'Углы',
        'm32.theme.radius.0': 'Прямые',
        'm32.theme.radius.0.5': 'Чуть скруглённые',
        'm32.theme.radius.1': 'Скруглённые',
        'm32.theme.radius.1.5': 'Круглые',
        'm32.theme.compareLabel': 'Сравнить',
        'm32.theme.compare': 'Показать, как было',
        'm32.theme.compareBack': 'Вернуть единый стиль',
        'm32.theme.compareHint':
            'На 10 секунд покажет страницу без стиля Maestro, потом стиль вернётся сам. Ничего не сохраняется.',
    },
};
