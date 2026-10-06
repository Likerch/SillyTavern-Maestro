// Strings of M31 «Листы персонажей» (`m31.*`, plus `kind.sheets.*` / `target.sheets.*`). A sheet is a character sheet
// the model writes on a BunnyMo command; cards say what happens to it in the chat and for the model.
import type { I18nParts } from '../../shared/contracts';

export const SHEET_STRINGS: I18nParts = {
    en: {
        'm31.title': 'Character sheets',
        'm31.toggle.show': '📋 Show sheet: {name}',
        'm31.toggle.hide': '📋 Collapse sheet',
        'm31.trim.title': 'Sheet of {name}: cut what the model wrote after it',
        'm31.trim.body':
            'After the sheet the model went on with the scene and the tracker. Cut that off, so the message holds only the sheet?',
        'm31.trim.done': 'Cut the scene the model wrote after the sheet of {name}.',
        'm31.hide.title': 'Hide the sheet of {name} from the model',
        'm31.hide.body':
            'The sheet is read. Hidden, it no longer goes to the model in the next replies and lore does not fire on its words; the message stays in the chat.',
        'm31.hide.done': 'Hid the sheet of {name} from the model; it stays in the chat.',
        'm31.capture.title': 'Keep the sheet of {name} in CarrotKernel',
        'm31.capture.body':
            'Baby Bunny reads the sheet and keeps the character, so CarrotKernel reminds the model of it in later scenes.',
        'm31.capture.done': 'Sent the sheet of {name} to CarrotKernel (Baby Bunny).',
        'target.sheets.text': 'Sheet message',
        'target.sheets.hidden': 'Sheet in the chat',
        'm31.field.model': 'For the model',
        'm31.value.hidden': 'hidden',
        'm31.value.shown': 'visible',
        'm31.cmd.tags.help':
            'Compares the tags of a sheet reply with the stored CarrotKernel archive (index of the sheet reply; default: the last sheet).',
        'm31.cmd.tags.index': 'Index of the sheet reply',
        'm31.cmd.tags.none': 'No sheet reply found.',
        'kind.sheets.trim': 'Cleaning up character sheets',
        'kind.sheets.hide': 'Hiding read sheets from the model',
        'kind.sheets.capture': 'Keeping sheets in CarrotKernel',
    },
    ru: {
        'm31.title': 'Листы персонажей',
        'm31.toggle.show': '📋 Показать лист: {name}',
        'm31.toggle.hide': '📋 Свернуть лист',
        'm31.trim.title': 'Лист «{name}»: убрать то, что модель дописала после него',
        'm31.trim.body':
            'После листа модель продолжила сцену и дописала трекер. Убрать это, чтобы в сообщении остался только сам лист?',
        'm31.trim.done': 'Убрал сцену, которую модель дописала после листа «{name}».',
        'm31.hide.title': 'Спрятать лист «{name}» от модели',
        'm31.hide.body':
            'Лист прочитан. Спрятанный, он больше не уходит модели в следующих ответах, и лор не срабатывает на его слова; в чате сообщение останется.',
        'm31.hide.done': 'Спрятал лист «{name}» от модели; в чате он остался.',
        'm31.capture.title': 'Сохранить лист «{name}» в CarrotKernel',
        'm31.capture.body':
            'Baby Bunny разберёт лист и сохранит характер персонажа, чтобы CarrotKernel напоминал о нём модели в следующих сценах.',
        'm31.capture.done': 'Отправил лист «{name}» в CarrotKernel (Baby Bunny).',
        'target.sheets.text': 'Сообщение с листом',
        'target.sheets.hidden': 'Лист в чате',
        'm31.field.model': 'Для модели',
        'm31.value.hidden': 'спрятан',
        'm31.value.shown': 'виден',
        'm31.cmd.tags.help':
            'Сравнивает теги листа с сохранённым архивом CarrotKernel (номер сообщения с листом; по умолчанию — последний лист).',
        'm31.cmd.tags.index': 'Номер сообщения с листом',
        'm31.cmd.tags.none': 'Лист не найден.',
        'kind.sheets.trim': 'Очистка листов характера',
        'kind.sheets.hide': 'Скрытие прочитанных листов от модели',
        'kind.sheets.capture': 'Сохранение листов в CarrotKernel',
    },
};
