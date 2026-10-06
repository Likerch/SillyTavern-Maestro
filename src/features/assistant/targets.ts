// How the assistant's journal records read (plan-2 §3 «Понятные уведомления»): a module setting it changed, a module
// it switched, an autonomy level, a mechanic switched in a chat, a global SillyTavern regex added or switched. Setting
// paths, module keys, kinds and chat ids live in the change's `ref`, regex patterns are hidden fields: all of them wait
// under «Подробнее», the card and the journal show only «было → стало» in words.
import { formatClip, formatEnum, formatPlain } from '../../core/labels';
import { placementNames } from '../../domain/assistant-write-regex';
import type { I18n, TargetSpec } from '../../shared/contracts';
import { SETTING_TARGET } from './safety';
import { UNDO_TARGETS } from './tools/write/common';

/** true/false → the given «on»/«off» words (the module is masculine, the mechanic feminine in Russian). */
function onOff(onKey: string, offKey: string) {
    return (value: unknown, i18n: I18n): string =>
        typeof value === 'boolean' ? i18n.t(value ? onKey : offKey) : formatPlain(value, i18n);
}

/** ST's `disabled` flag of a regex script → its state in words. */
function regexState(value: unknown, i18n: I18n): string {
    return typeof value === 'boolean' ? i18n.t(value ? 'm33.value.off' : 'm33.value.on') : '';
}

/** ST's placement numbers → where the regex acts, in words. */
function regexPlaces(value: unknown, i18n: I18n): string {
    if (!Array.isArray(value)) return '';
    const numbers = value.filter((item): item is number => typeof item === 'number');
    return placementNames(numbers)
        .map((name) => i18n.t(`m33.regex.place.${name}`))
        .join(', ');
}

/** The journal targets of the assistant (labels `target.<target>` in M33_STRINGS). */
export const ASSISTANT_TARGETS: TargetSpec[] = [
    // A setting value: a number, yes/no, a text or a list of texts (long texts are cut).
    { target: SETTING_TARGET, format: formatClip(120) },
    { target: UNDO_TARGETS.module, format: onOff('m33.value.on', 'm33.value.off') },
    // null (the module's default level) shows as an added or removed level.
    {
        target: UNDO_TARGETS.autonomy,
        // null = the user's choice was removed: the module's default applies again.
        nullable: true,
        format: (value, i18n) =>
            value === null ? i18n.t('ui.settings.autonomyDefault') : formatEnum('ui.autonomy.')(value, i18n),
    },
    { target: UNDO_TARGETS.mechanicChat, format: onOff('m33.value.onF', 'm33.value.offF') },
    // A card's changes journaled by other modules (a preset pack): the record's line says what it was; the ids of the
    // records it gathers are technical.
    { target: UNDO_TARGETS.group, technical: true },
    {
        target: UNDO_TARGETS.regex,
        fields: {
            scriptName: { labelKey: 'm33.field.regexName' },
            placement: { labelKey: 'm33.field.regexPlace', format: regexPlaces },
            disabled: { labelKey: 'm33.field.regexState', format: regexState },
            findRegex: { labelKey: 'm33.field.regexFind', hidden: true },
            replaceString: { labelKey: 'm33.field.regexReplace', hidden: true },
        },
    },
];
