// Strings of «Твой слой» (M34 п.5–6). Registered by createPresetLayer(); keys `m34.layerSvc.*` (the studio owns `m34.layer.*`).
import type { I18nParts } from '../../shared/contracts';

export const LAYER_STRINGS: I18nParts = {
    en: {
        'm34.layerSvc.offer.layerMissing':
            'The preset «{name}» loaded without your layer: your edits are not laid over it. Select the preset again with your layer? Unsaved changes of the preset will be lost.',
        'm34.layerSvc.offer.baseChanged':
            'The preset «{name}» changed on the server. Select it again so your layer goes on top of the new version? Unsaved changes of the preset will be lost.',
        'm34.layerSvc.offer.action': 'Select again with the layer',
        'm34.layerSvc.dispose.notice': 'Your layer’s edits stay in the preset «{name}» until the next preset change.',
        'm34.layerSvc.dispose.action': 'Select the preset without the layer',
        'm34.layerSvc.mergedName': '{name} (with layer)',
        'm34.layerSvc.saveFailed': 'I could not save your layer for «{name}»; I will try again with the next edit.',
        'm34.layerSvc.journal.add': 'Block «{block}» added to your layer of «{name}»',
        'm34.layerSvc.journal.edit': 'Block «{block}» edited in your layer of «{name}»',
        'm34.layerSvc.journal.on': 'Block «{block}» switched on in your layer of «{name}»',
        'm34.layerSvc.journal.off': 'Block «{block}» switched off in your layer of «{name}»',
        'm34.layerSvc.journal.move': 'Block «{block}» moved in your layer of «{name}»',
        'm34.layerSvc.journal.key': 'Parameter «{param}» changed in your layer of «{name}»',
        'm34.layerSvc.journal.remove': 'Edit of the block «{block}» removed from your layer of «{name}»',
        'm34.layerSvc.journal.removeKey': 'Edit of the parameter «{param}» removed from your layer of «{name}»',
        'm34.layerSvc.journal.resolve': 'Conflict in the block «{block}» settled in your layer of «{name}»',
        'm34.layerSvc.journal.migrate.one': '{count} edit moved into your layer of «{name}»',
        'm34.layerSvc.journal.migrate.few': '{count} edits moved into your layer of «{name}»',
        'm34.layerSvc.journal.migrate.many': '{count} edits moved into your layer of «{name}»',
        'm34.layerSvc.journal.transfer.one': '{count} edit copied from «{from}» into your layer of «{name}»',
        'm34.layerSvc.journal.transfer.few': '{count} edits copied from «{from}» into your layer of «{name}»',
        'm34.layerSvc.journal.transfer.many': '{count} edits copied from «{from}» into your layer of «{name}»',
    },
    ru: {
        'm34.layerSvc.offer.layerMissing':
            'Пресет «{name}» загрузился без твоего слоя: твои правки на него не наложены. Выбрать пресет заново вместе со слоем? Несохранённые изменения пресета пропадут.',
        'm34.layerSvc.offer.baseChanged':
            'Пресет «{name}» изменился на сервере. Выбрать его заново, чтобы твой слой лёг поверх новой версии? Несохранённые изменения пресета пропадут.',
        'm34.layerSvc.offer.action': 'Выбрать заново со слоем',
        'm34.layerSvc.dispose.notice': 'Правки из твоего слоя останутся в пресете «{name}» до следующей смены пресета.',
        'm34.layerSvc.dispose.action': 'Выбрать пресет без слоя',
        'm34.layerSvc.mergedName': '{name} (со слоем)',
        'm34.layerSvc.saveFailed': 'Не смог сохранить твой слой для «{name}» — попробую ещё раз при следующей правке.',
        'm34.layerSvc.journal.add': 'В слой «{name}» добавлен блок «{block}»',
        'm34.layerSvc.journal.edit': 'В слое «{name}» изменён блок «{block}»',
        'm34.layerSvc.journal.on': 'В слое «{name}» включён блок «{block}»',
        'm34.layerSvc.journal.off': 'В слое «{name}» выключен блок «{block}»',
        'm34.layerSvc.journal.move': 'В слое «{name}» перенесён блок «{block}»',
        'm34.layerSvc.journal.key': 'В слое «{name}» изменён параметр «{param}»',
        'm34.layerSvc.journal.remove': 'Из слоя «{name}» убрана правка блока «{block}»',
        'm34.layerSvc.journal.removeKey': 'Из слоя «{name}» убрана правка параметра «{param}»',
        'm34.layerSvc.journal.resolve': 'В слое «{name}» решён конфликт в блоке «{block}»',
        'm34.layerSvc.journal.migrate.one': 'В слой «{name}» перенесена {count} правка',
        'm34.layerSvc.journal.migrate.few': 'В слой «{name}» перенесены {count} правки',
        'm34.layerSvc.journal.migrate.many': 'В слой «{name}» перенесено {count} правок',
        'm34.layerSvc.journal.transfer.one': 'В слой «{name}» скопирована {count} правка из «{from}»',
        'm34.layerSvc.journal.transfer.few': 'В слой «{name}» скопированы {count} правки из «{from}»',
        'm34.layerSvc.journal.transfer.many': 'В слой «{name}» скопировано {count} правок из «{from}»',
    },
};
