import type { I18nParts } from '../../shared/contracts';

export const SHEET_STRINGS: I18nParts = {
    en: {
        'm31.title': 'Character sheets',
        'm31.toggle.show': '📋 Show sheet: {name}',
        'm31.toggle.hide': '📋 Collapse sheet',
        'm31.trim.title': 'Sheet for {name}: removed the scene continuation and tracker data after the sheet',
        'm31.hide.title': 'Sheet for {name} hidden from the prompt and lore scan',
        'm31.capture.title': 'Sheet for {name} sent to Baby Bunny',
        'm31.cmd.tags.help':
            'Compares the tags of a sheet reply with the stored CarrotKernel archive (index of the sheet reply; default: the last sheet).',
        'm31.cmd.tags.index': 'Index of the sheet reply',
        'm31.cmd.tags.none': 'No sheet reply found.',
        'kind.sheets.trim': 'Sheet clean-up',
        'kind.sheets.hide': 'Hiding sheets from the prompt',
        'kind.sheets.capture': 'Sheet capture to CarrotKernel',
    },
    ru: {
        'm31.title': 'Листы персонажей',
        'm31.toggle.show': '📋 Показать лист: {name}',
        'm31.toggle.hide': '📋 Свернуть лист',
        'm31.trim.title': 'Лист «{name}»: убраны продолжение сцены и данные трекера после листа',
        'm31.hide.title': 'Лист «{name}» скрыт из промпта и сканирования лора',
        'm31.capture.title': 'Лист «{name}» передан в Baby Bunny',
        'm31.cmd.tags.help':
            'Сравнивает теги листа с сохранённым архивом CarrotKernel (номер сообщения с листом; по умолчанию — последний лист).',
        'm31.cmd.tags.index': 'Номер сообщения с листом',
        'm31.cmd.tags.none': 'Лист не найден.',
        'kind.sheets.trim': 'Очистка листов',
        'kind.sheets.hide': 'Скрытие листов из промпта',
        'kind.sheets.capture': 'Передача листов в CarrotKernel',
    },
};
