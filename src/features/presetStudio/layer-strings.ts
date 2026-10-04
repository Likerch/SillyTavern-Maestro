// Strings of «Твой слой» (M34 п.5–6). Registered by createPresetLayer(); keys `m34.layerSvc.*` (the studio owns `m34.layer.*`).
import type { I18nParts } from '../../shared/contracts';

export const LAYER_STRINGS: I18nParts = {
    en: {
        'm34.layerSvc.offer.layerMissing':
            'Your layer is not laid over the preset «{name}»: the working copy loaded without it. Reselect the preset to apply the layer? Unsaved changes of the working copy will be replaced.',
        'm34.layerSvc.offer.baseChanged':
            'The base preset «{name}» changed on the server. Reselect it to load the new base with your layer on top? Unsaved changes of the working copy will be replaced.',
        'm34.layerSvc.offer.action': 'Reselect the preset with the layer',
        'm34.layerSvc.dispose.notice':
            'Your layer stays in the working copy of the preset «{name}» until the next preset change.',
        'm34.layerSvc.dispose.action': 'Reselect without the layer',
        'm34.layerSvc.mergedName': '{name} (with layer)',
        'm34.layerSvc.saveFailed':
            'Your layer for «{name}» could not be saved; it will be retried with the next change.',
        'm34.layerSvc.journal.record': 'Your layer · {name}: edit',
        'm34.layerSvc.journal.remove': 'Your layer · {name}: operation removed',
        'm34.layerSvc.journal.resolve': 'Your layer · {name}: conflict resolved',
        'm34.layerSvc.journal.migrate': 'Your layer · {name}: {count} changes moved into the layer',
        'm34.layerSvc.journal.transfer': 'Your layer · {name}: {count} operations copied from «{from}»',
    },
    ru: {
        'm34.layerSvc.offer.layerMissing':
            '«Твой слой» не наложен на пресет «{name}»: рабочая копия загрузилась без него. Перевыбрать пресет, чтобы наложить слой? Несохранённые правки рабочей копии будут заменены.',
        'm34.layerSvc.offer.baseChanged':
            'Базовый пресет «{name}» изменился на сервере. Перевыбрать его, чтобы загрузить новую базу и наложить слой сверху? Несохранённые правки рабочей копии будут заменены.',
        'm34.layerSvc.offer.action': 'Перевыбрать пресет со слоем',
        'm34.layerSvc.dispose.notice':
            '«Твой слой» остаётся в рабочей копии пресета «{name}» до следующей смены пресета.',
        'm34.layerSvc.dispose.action': 'Перевыбрать без слоя',
        'm34.layerSvc.mergedName': '{name} (со слоем)',
        'm34.layerSvc.saveFailed':
            'Не удалось сохранить «Твой слой» для «{name}»; попробую снова при следующей правке.',
        'm34.layerSvc.journal.record': 'Твой слой · {name}: правка',
        'm34.layerSvc.journal.remove': 'Твой слой · {name}: операция удалена',
        'm34.layerSvc.journal.resolve': 'Твой слой · {name}: конфликт решён',
        'm34.layerSvc.journal.migrate': 'Твой слой · {name}: правок перенесено в слой — {count}',
        'm34.layerSvc.journal.transfer': 'Твой слой · {name}: операций скопировано с «{from}» — {count}',
    },
};
