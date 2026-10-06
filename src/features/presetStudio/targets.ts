// How the Preset Studio's journal records read (plan-2 §3 «Понятные уведомления»): human names of its action kinds
// (`kind.<kind>`) and descriptions of its journal targets (MaestroModule.targets). Block texts, names and parameter
// values are the user's own preset content and are shown as «было → стало»; identifiers, hashes, version ids and
// anchors stay under «Подробнее».
import { formatEnum, formatPlain } from '../../core/labels';
import { PARAMS } from '../../domain/preset-ui-params';
import type { I18n, I18nParts, TargetFieldSpec, TargetSpec } from '../../shared/contracts';
import { LAYER_JOURNAL_KIND, LAYER_TARGET } from './layer';
import { paramLabel, paramValue } from './param-labels';
import { FILE_TARGET, KEYS_TARGET, PROMPT_TARGET, STORE_JOURNAL_KINDS } from './store';

/** Every action kind the studio journals (the store's writes and «Твой слой»). */
export const PRESET_JOURNAL_KINDS: readonly string[] = [...STORE_JOURNAL_KINDS, LAYER_JOURNAL_KIND];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** In order (0) or in the chat at a depth (1). */
function positionText(value: unknown, i18n: I18n): string {
    return value === 0 || value === 1 ? i18n.t(`m34.target.position.${value}`) : '';
}

/** Generation types a block is sent for, by the editor's names. */
function triggersText(value: unknown, i18n: I18n): string {
    if (!Array.isArray(value)) return '';
    return value
        .filter((item): item is string => typeof item === 'string' && item !== '')
        .map((item) => {
            const key = `m34.trigger.${item}`;
            const label = i18n.t(key);
            return label === key ? item : label;
        })
        .join(', ');
}

/** The prompt order (a list of {identifier, enabled}) as «включено 9 из 12». */
function orderText(value: unknown, i18n: I18n): string {
    if (!Array.isArray(value)) return '';
    const items = value.filter(isDict);
    const enabled = items.filter((item) => item.enabled === true).length;
    return i18n.t('m34.target.order.state', { enabled, count: items.length });
}

/** A parameter of a layer operation by the «Параметры» tab's name (the key itself when the tab has none). */
function paramText(value: unknown, i18n: I18n): string {
    return typeof value === 'string' ? (paramLabel(value, i18n) ?? value) : '';
}

const hidden = (labelKey: string): TargetFieldSpec => ({ labelKey, hidden: true });

export const PRESET_TARGETS: TargetSpec[] = [
    {
        // A block of the preset (part 'prompt') or the active order of blocks (part 'order').
        target: PROMPT_TARGET,
        fields: {
            name: { labelKey: 'm34.target.field.name' },
            role: { labelKey: 'm34.target.field.role', format: formatEnum('m34.role.') },
            content: { labelKey: 'm34.target.field.content' },
            enabled: { labelKey: 'm34.target.field.enabled' },
            injection_position: { labelKey: 'm34.target.field.position', format: positionText },
            injection_depth: { labelKey: 'm34.target.field.depth' },
            injection_order: { labelKey: 'm34.target.field.priority' },
            injection_trigger: { labelKey: 'm34.target.field.triggers', format: triggersText },
            forbid_overrides: { labelKey: 'm34.target.field.forbid' },
            identifier: hidden('m34.target.field.identifier'),
        },
        valueLabelKey: 'm34.target.field.order',
        format: orderText,
    },
    {
        target: KEYS_TARGET,
        fields: Object.fromEntries(
            PARAMS.map((spec): [string, TargetFieldSpec] => [
                spec.key,
                {
                    labelKey: `m34.params.key.${spec.key}`,
                    format: (value, i18n) => paramValue(spec.key, value, i18n),
                },
            ]),
        ),
    },
    {
        // Save, save as, import, rollback, rename, delete: version ids and hashes are technical.
        target: FILE_TARGET,
        fields: {
            name: { labelKey: 'm34.target.field.presetName' },
            version: hidden('m34.target.field.version'),
            hash: hidden('m34.target.field.version'),
        },
    },
    {
        // One operation of «Твой слой»: a block of the user's own, a text edit, on/off, a move, a parameter.
        target: LAYER_TARGET,
        fields: {
            op: { labelKey: 'm34.target.field.layerOp', format: formatEnum('m34.target.layerOp.') },
            prompt: {
                labelKey: 'm34.target.field.ownBlock',
                format: (value) => (isDict(value) ? text(value.name) : ''),
            },
            patch: {
                labelKey: 'm34.target.field.content',
                format: (value) => (isDict(value) && typeof value.content === 'string' ? value.content : ''),
            },
            enabled: { labelKey: 'm34.target.field.enabled' },
            key: { labelKey: 'm34.target.field.param', format: paramText },
            value: { labelKey: 'm34.target.field.value', format: formatPlain },
            identifier: hidden('m34.target.field.identifier'),
            anchor: hidden('m34.target.field.anchor'),
        },
    },
];

export const TARGET_STRINGS: I18nParts = {
    en: {
        'kind.presetStudio.prompt': 'Preset block edit',
        'kind.presetStudio.promptAdd': 'New preset block',
        'kind.presetStudio.promptRemove': 'Preset block deletion',
        'kind.presetStudio.detach': 'Block taken out of the order',
        'kind.presetStudio.toggle': 'Preset blocks on and off',
        'kind.presetStudio.reorder': 'Order of preset blocks',
        'kind.presetStudio.keys': 'Preset parameters',
        'kind.presetStudio.save': 'Preset save',
        'kind.presetStudio.saveAs': 'Preset copy',
        'kind.presetStudio.import': 'Preset import',
        'kind.presetStudio.restore': 'Preset rollback',
        'kind.presetStudio.rename': 'Preset rename',
        'kind.presetStudio.remove': 'Preset deletion',
        'kind.preset.layer': 'Edits in your layer',

        'target.preset-prompt': 'Preset block',
        'target.preset-keys': 'Preset parameters',
        'target.preset-file': 'Preset',
        'target.preset-layer': 'Your layer',

        'm34.target.field.name': 'Name',
        'm34.target.field.role': 'Role',
        'm34.target.field.content': 'Block text',
        'm34.target.field.enabled': 'On',
        'm34.target.field.position': 'Placement',
        'm34.target.field.depth': 'Depth',
        'm34.target.field.priority': 'Priority',
        'm34.target.field.triggers': 'Sent for',
        'm34.target.field.forbid': 'A card cannot replace it',
        'm34.target.field.identifier': 'Block id',
        'm34.target.field.order': 'Blocks in the order',
        'm34.target.field.presetName': 'Name',
        'm34.target.field.version': 'Version',
        'm34.target.field.layerOp': 'Change',
        'm34.target.field.ownBlock': 'Your block',
        'm34.target.field.param': 'Parameter',
        'm34.target.field.value': 'Value',
        'm34.target.field.anchor': 'Place',
        'm34.target.position.0': 'in the block order',
        'm34.target.position.1': 'in the chat at a depth',
        'm34.target.order.state': '{enabled} of {count} on',
        'm34.target.layerOp.add': 'your own block',
        'm34.target.layerOp.edit': 'block edit',
        'm34.target.layerOp.toggle': 'block on or off',
        'm34.target.layerOp.move': 'block moved',
        'm34.target.layerOp.key': 'parameter',
    },
    ru: {
        'kind.presetStudio.prompt': 'Правка блока пресета',
        'kind.presetStudio.promptAdd': 'Новый блок пресета',
        'kind.presetStudio.promptRemove': 'Удаление блока пресета',
        'kind.presetStudio.detach': 'Блок убран из порядка',
        'kind.presetStudio.toggle': 'Включение и выключение блоков',
        'kind.presetStudio.reorder': 'Порядок блоков пресета',
        'kind.presetStudio.keys': 'Параметры пресета',
        'kind.presetStudio.save': 'Сохранение пресета',
        'kind.presetStudio.saveAs': 'Копия пресета',
        'kind.presetStudio.import': 'Импорт пресета',
        'kind.presetStudio.restore': 'Откат пресета к версии',
        'kind.presetStudio.rename': 'Переименование пресета',
        'kind.presetStudio.remove': 'Удаление пресета',
        'kind.preset.layer': 'Правки в твоём слое',

        'target.preset-prompt': 'Блок пресета',
        'target.preset-keys': 'Параметры пресета',
        'target.preset-file': 'Пресет',
        'target.preset-layer': 'Твой слой',

        'm34.target.field.name': 'Название',
        'm34.target.field.role': 'Роль',
        'm34.target.field.content': 'Текст блока',
        'm34.target.field.enabled': 'Включён',
        'm34.target.field.position': 'Где стоит',
        'm34.target.field.depth': 'Глубина',
        'm34.target.field.priority': 'Приоритет',
        'm34.target.field.triggers': 'Для каких генераций',
        'm34.target.field.forbid': 'Карточка не может заменить',
        'm34.target.field.identifier': 'Код блока',
        'm34.target.field.order': 'Блоки в порядке',
        'm34.target.field.presetName': 'Название',
        'm34.target.field.version': 'Версия',
        'm34.target.field.layerOp': 'Что изменено',
        'm34.target.field.ownBlock': 'Твой блок',
        'm34.target.field.param': 'Параметр',
        'm34.target.field.value': 'Значение',
        'm34.target.field.anchor': 'Место',
        'm34.target.position.0': 'по порядку блоков',
        'm34.target.position.1': 'в чате на глубине',
        'm34.target.order.state': 'включено {enabled} из {count}',
        'm34.target.layerOp.add': 'свой блок',
        'm34.target.layerOp.edit': 'правка блока',
        'm34.target.layerOp.toggle': 'включение или выключение блока',
        'm34.target.layerOp.move': 'перенос блока',
        'm34.target.layerOp.key': 'параметр',
    },
};
