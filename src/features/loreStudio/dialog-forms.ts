// Form contents for the Lore Studio's dialogs: «Apply current sorting as Order» (start, step, ascending, live
// clamp warning — L-114), the bulk editor (M23 п. 8: common fields of many entries; mixed values left alone unless
// ticked) and the move/copy target picker (L-110).
import { BULK_FIELDS, MIXED, POSITION_CHOICES, commonValues, expandBulkPatch } from '../../domain/lore-studio-entries';
import type { BulkField, LoreEntry } from '../../domain/lore-studio-entries';
import { clampedTail, validateApplyOrder } from '../../domain/lore-studio-sort';
import type { ApplyOrderError, ApplyOrderOptions } from '../../domain/lore-studio-sort';
import { el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';

export interface FormHandle<T> {
    content: HTMLElement;
    read(): T;
}

export function applyOrderForm(
    app: App,
    count: number,
): FormHandle<ApplyOrderOptions & { error: ApplyOrderError | null }> {
    const t = app.i18n.t.bind(app.i18n);
    const start = el('input', {
        class: 'text_pole',
        attrs: { type: 'number', min: 0, step: 1, 'aria-label': t('m23.order.start') },
    });
    start.value = '100';
    const step = el('input', {
        class: 'text_pole',
        attrs: { type: 'number', min: 1, step: 1, 'aria-label': t('m23.order.step') },
    });
    step.value = '1';
    const ascending = el('input', { attrs: { type: 'checkbox' } });
    const warning = el('div', { class: 'maestro-warn-text', attrs: { role: 'status' } });
    const read = (): ApplyOrderOptions & { error: ApplyOrderError | null } => {
        const options = { start: Number(start.value), step: Number(step.value), ascending: ascending.checked };
        return { ...options, error: validateApplyOrder(options) };
    };
    const update = () => {
        const options = read();
        const tail = options.error ? null : clampedTail(count, options);
        warning.textContent = tail === null ? '' : t('m23.order.clamped', { value: tail, count, step: options.step });
    };
    for (const input of [start, step]) input.addEventListener('input', update);
    ascending.addEventListener('change', update);
    update();
    const content = el('div', { class: 'maestro-m23-order-form' }, [
        el('p', { text: t('m23.order.intro') }),
        el('p', { class: 'maestro-muted', text: t('m23.order.count', { count }) }),
        el('label', { class: 'maestro-m23-binding' }, [el('span', { text: t('m23.order.start') }), start]),
        el('label', { class: 'maestro-m23-binding' }, [el('span', { text: t('m23.order.step') }), step]),
        el('label', { class: 'checkbox_label' }, [ascending, el('span', { text: t('m23.order.ascending') })]),
        warning,
    ]);
    return { content, read };
}

const SELECT_OPTIONS: Partial<Record<BulkField, readonly string[]>> = {
    status: ['normal', 'constant', 'vectorized'],
    positionChoice: POSITION_CHOICES,
    selectiveLogic: ['0', '3', '1', '2'],
};

const TRISTATE: readonly BulkField[] = ['caseSensitive', 'matchWholeWords', 'useGroupScoring'];
const NULLABLE_NUMBERS: readonly BulkField[] = ['scanDepth', 'sticky', 'cooldown', 'delay'];
const TEXT: readonly BulkField[] = ['group', 'automationId', 'outletName'];

function optionLabel(app: App, field: BulkField, value: string): string {
    if (field === 'status') return app.i18n.t(`m23.status.${value}`);
    if (field === 'positionChoice') return app.i18n.t(`m23.position.${value}`);
    if (field === 'selectiveLogic') return app.i18n.t(`m23.logic.${value}`);
    return value;
}

/** Bulk editor: one row per field with a «change» tick; the control starts at the common value (blank when mixed). */
export function bulkEditForm(app: App, entries: readonly LoreEntry[]): FormHandle<Record<string, unknown>> {
    const t = app.i18n.t.bind(app.i18n);
    const common = commonValues([...entries]);
    const rows: { field: BulkField; tick: HTMLInputElement; value(): unknown }[] = [];
    const grid = el('div', { class: 'maestro-m23-bulk-grid' });
    for (const field of BULK_FIELDS) {
        const current = common[field];
        const mixed = current === MIXED;
        const tick = el('input', {
            attrs: { type: 'checkbox', 'aria-label': t('m23.bulkEdit.change', { field: t(`m23.field.${field}`) }) },
        });
        let control: HTMLElement;
        let value: () => unknown;
        const options = SELECT_OPTIONS[field];
        if (options) {
            const select = el('select', { class: 'text_pole' });
            for (const option of options)
                select.append(el('option', { text: optionLabel(app, field, option), attrs: { value: option } }));
            if (mixed) select.selectedIndex = -1;
            else select.value = String(current);
            control = select;
            value = () => (field === 'selectiveLogic' ? Number(select.value) : select.value);
        } else if (TRISTATE.includes(field)) {
            const select = el('select', { class: 'text_pole' });
            for (const [key, label] of [
                ['null', t('m23.bulkEdit.global')],
                ['true', t('m23.bulkEdit.yes')],
                ['false', t('m23.bulkEdit.no')],
            ] as const) {
                select.append(el('option', { text: label, attrs: { value: key } }));
            }
            if (mixed) select.selectedIndex = -1;
            else select.value = String(current ?? 'null');
            control = select;
            value = () => (select.value === 'null' ? null : select.value === 'true');
        } else if (TEXT.includes(field)) {
            const input = el('input', { class: 'text_pole', attrs: { type: 'text' } });
            input.value = mixed ? '' : String(current ?? '');
            control = input;
            value = () => input.value.trim();
        } else if (typeof current === 'boolean' || (mixed && isBooleanField(field))) {
            const box = el('input', { attrs: { type: 'checkbox' } });
            box.checked = current === true;
            box.indeterminate = mixed;
            control = box;
            value = () => box.checked;
        } else {
            const input = el('input', { class: 'text_pole', attrs: { type: 'number', step: 1 } });
            input.value = mixed || current === null || current === undefined ? '' : String(current);
            if (NULLABLE_NUMBERS.includes(field)) input.placeholder = t('m23.bulkEdit.emptyGlobal');
            control = input;
            value = () =>
                input.value.trim() === '' ? (NULLABLE_NUMBERS.includes(field) ? null : 0) : Number(input.value);
        }
        // Editing a control ticks its row: what you touch is what changes.
        const autoTick = () => {
            tick.checked = true;
        };
        control.addEventListener('change', autoTick);
        control.addEventListener('input', autoTick);
        rows.push({ field, tick, value });
        grid.append(
            el('label', { class: 'maestro-m23-bulk-row' }, [
                tick,
                el('span', { class: 'maestro-m23-bulk-label', text: t(`m23.field.${field}`) }),
                mixed ? el('span', { class: 'maestro-muted', text: t('m23.bulkEdit.mixed') }) : el('span'),
                control,
            ]),
        );
    }
    const content = el('div', { class: 'maestro-m23-bulk-form' }, [
        el('p', { class: 'maestro-muted', text: t('m23.bulkEdit.intro', { count: entries.length }) }),
        grid,
    ]);
    return {
        content,
        read: () => {
            const patch: Partial<Record<BulkField, unknown>> = {};
            for (const row of rows) if (row.tick.checked) patch[row.field] = row.value();
            return expandBulkPatch(patch);
        },
    };
}

const BOOLEAN_FIELDS: readonly BulkField[] = [
    'disable',
    'useProbability',
    'groupOverride',
    'excludeRecursion',
    'preventRecursion',
    'ignoreBudget',
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
];

function isBooleanField(field: BulkField): boolean {
    return BOOLEAN_FIELDS.includes(field);
}

export function moveTargetForm(app: App, targets: readonly string[]): FormHandle<string> {
    const t = app.i18n.t.bind(app.i18n);
    const select = el('select', { class: 'text_pole', attrs: { 'aria-label': t('m23.move.target') } });
    for (const book of targets) select.append(el('option', { text: book, attrs: { value: book } }));
    return {
        content: el('label', { class: 'maestro-m23-binding' }, [el('span', { text: t('m23.move.target') }), select]),
        read: () => select.value,
    };
}
