// Strings of M43 «Сцена и вокруг» (`m43.*`). Russian is the primary UI language; the user is addressed as «ты» (male).
import type { I18nParts } from '../../shared/contracts';

export const SCENE_SPLIT_STRINGS: I18nParts = {
    en: {
        'm43.title': 'Scene and around',
        'm43.summary': 'Around',
        'm43.settings.title': 'Scene and around',
        'm43.settings.hint':
            'The reply tells only the scene: the characters who are here and what they notice. A character who left is out of it — the model does not follow them. What happens elsewhere meanwhile goes after the scene into one block, folded under the reply; click it to read. The saved message keeps the block as written.',
        'm43.settings.enabled': 'Keep the scene apart from what goes on around it',
        'm43.settings.enabled.hint':
            'Off: no note to the model, the block is not folded, and characters who walked out still count as present until DES drops them.',
        'm43.settings.keep': 'Replies that keep «Around» in the prompt',
        'm43.settings.keep.hint':
            'The latest replies keep what happened around as one short line, so the model remembers it; older ones lose it. 0 — none.',
        'm43.settings.label': 'Name of the folded block',
        'm43.settings.label.hint': 'Empty — «Around».',
        'm43.settings.noHook':
            'This SillyTavern has no message formatter (it came in 1.19): the block cannot be folded and shows as the last paragraph. The rest works.',
    },
    ru: {
        'm43.title': 'Сцена и вокруг',
        'm43.summary': 'Вокруг',
        'm43.settings.title': 'Сцена и вокруг',
        'm43.settings.hint':
            'Ответ рассказывает только сцену: тех, кто здесь, и то, что они замечают. Ушедший персонаж из сцены выбывает — модель не идёт за ним следом. Что тем временем происходит в других местах, модель пишет после сцены одним блоком — он свёрнут под ответом, нажми, чтобы прочитать. В сохранённом сообщении блок остаётся как есть.',
        'm43.settings.enabled': 'Отделять сцену от того, что происходит вокруг',
        'm43.settings.enabled.hint':
            'Выключено: модель не получает указания, блок не сворачивается, а ушедшие персонажи считаются в сцене, пока их не уберёт DES.',
        'm43.settings.keep': 'Сколько последних ответов держат «Вокруг» в промпте',
        'm43.settings.keep.hint':
            'В последних ответах то, что было вокруг, остаётся одной короткой строкой — модель это помнит; в старых блок убирается. 0 — нигде.',
        'm43.settings.label': 'Подпись свёрнутого блока',
        'm43.settings.label.hint': 'Пусто — «Вокруг».',
        'm43.settings.noHook':
            'В этой версии SillyTavern нет обработчика сообщений (он появился в 1.19): блок не сворачивается и виден последним абзацем. Остальное работает.',
    },
};
