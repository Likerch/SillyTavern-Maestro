// Controls of the entry form bound to the draft: every control writes `env.state.draft[field]` and calls
// env.changed(). Labels are real <label for> pairs; numbers are text inputs with our own validation (ST's
// `Number('')` = 0 would store junk), so the user sees what is wrong instead of a silent 0.
import { NUMBER_FIELDS, numberText, parseNumber, parseTriState, triStateOf } from '../../../domain/lore-form-fields';
import type { NumberField, NumberResult } from '../../../domain/lore-form-fields';
import { uid as domId } from '../../../ui/components/controls';
import { el, icon } from '../../../ui/components/dom';
import type { Child } from '../../../ui/components/dom';
import type { FormEnv } from './env';

export interface RowOptions {
    label: string;
    control: Child;
    /** id of the labelled control. */
    for?: string;
    hint?: Child | Child[];
    /** Draft field whose validation message shows under the row. */
    field?: string;
    className?: string;
}

/** Label, control, hint and an error line (bound to `field`). Stacked on phones, two columns on wide screens. */
export function row(env: FormEnv, options: RowOptions): HTMLElement {
    const error = el('div', { class: 'maestro-m23f-error', attrs: { role: 'alert' } });
    error.hidden = true;
    if (options.field) env.own(bindError(env, options.field, error));
    return el('div', { class: ['maestro-m23f-row', options.className] }, [
        el('label', { class: 'maestro-m23f-label', text: options.label, attrs: { for: options.for } }),
        el('div', { class: 'maestro-m23f-control' }, [options.control]),
        options.hint !== undefined ? el('div', { class: 'maestro-m23f-hint' }, options.hint) : null,
        error,
    ]);
}

const errorSlots = new WeakMap<FormEnv, Map<string, HTMLElement>>();

function bindError(env: FormEnv, field: string, node: HTMLElement): () => void {
    let slots = errorSlots.get(env);
    if (!slots) {
        slots = new Map();
        errorSlots.set(env, slots);
    }
    slots.set(field, node);
    return () => {
        if (slots.get(field) === node) slots.delete(field);
    };
}

/** Shows (or clears) the validation message of a field; called by the form's setError. */
export function showFieldError(env: FormEnv, field: string, message: string | null): void {
    const node = errorSlots.get(env)?.get(field);
    if (!node) return;
    node.textContent = message ?? '';
    node.hidden = !message;
    const control = node.parentElement?.querySelector<HTMLElement>('input, select, textarea');
    control?.setAttribute('aria-invalid', message ? 'true' : 'false');
}

/** A note under a field (ST differences, warnings). */
export function note(text: string, level: 'info' | 'warn' = 'info', action?: HTMLElement | null): HTMLElement {
    return el('div', { class: ['maestro-m23f-note', `maestro-level-${level}`] }, [
        icon(level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'),
        el('span', { text }),
        action ?? null,
    ]);
}

export interface TextFieldOptions {
    label: string;
    multiline?: boolean;
    rows?: number;
    placeholder?: string;
    hint?: Child | Child[];
    /** Trim the stored value (ST trims `group`). */
    trim?: boolean;
    /** Suggestions (a <datalist>). */
    suggestions?: string[];
    className?: string;
}

/** A string field of the draft. */
export function textField(
    env: FormEnv,
    field: string,
    options: TextFieldOptions,
): { node: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement } {
    const id = domId('maestro-m23f');
    const value = env.state.draft[field];
    const listId = options.suggestions?.length ? domId('maestro-m23f-list') : undefined;
    const input = options.multiline
        ? el('textarea', {
              class: 'text_pole maestro-m23f-textarea',
              attrs: { id, rows: options.rows ?? 3, placeholder: options.placeholder, name: field },
          })
        : el('input', {
              class: 'text_pole',
              attrs: {
                  id,
                  type: 'text',
                  placeholder: options.placeholder,
                  list: listId,
                  name: field,
                  autocomplete: 'off',
              },
          });
    input.value = typeof value === 'string' ? value : '';
    input.addEventListener('input', () => {
        const next = options.trim ? input.value.trim() : input.value;
        // A missing field stays missing while the input is empty (no hidden change).
        if (next === '' && env.state.stored[field] === undefined) delete env.state.draft[field];
        else env.state.draft[field] = next;
        env.changed();
    });
    const datalist = listId
        ? el(
              'datalist',
              { attrs: { id: listId } },
              (options.suggestions ?? []).map((item) => el('option', { attrs: { value: item } })),
          )
        : null;
    const node = row(env, {
        label: options.label,
        control: datalist ? el('div', {}, [input, datalist]) : input,
        for: id,
        hint: options.hint,
        field,
        className: options.className,
    });
    return { node, input };
}

export interface CheckOptions {
    label: string;
    hint?: string;
    /** The checkbox shows the opposite of the stored boolean (`disable` → «Включена»). */
    invert?: boolean;
    onChange?(checked: boolean): void;
}

/** A boolean field of the draft (ST's `!!value` display; writes true/false). */
export function checkField(
    env: FormEnv,
    field: string,
    options: CheckOptions,
): { node: HTMLElement; input: HTMLInputElement } {
    const id = domId('maestro-m23f-check');
    const input = el('input', { attrs: { type: 'checkbox', id, name: field } });
    const stored = !!env.state.draft[field];
    input.checked = options.invert ? !stored : stored;
    input.addEventListener('change', () => {
        const value = options.invert ? !input.checked : input.checked;
        // The engine reads these flags by truthiness: back to «off» on a field that was missing keeps it missing.
        if (!value && env.state.stored[field] === undefined) delete env.state.draft[field];
        else env.state.draft[field] = value;
        options.onChange?.(input.checked);
        env.changed();
    });
    const node = el('div', { class: 'maestro-m23f-check' }, [
        el('label', { class: 'checkbox_label', attrs: { for: id } }, [input, el('span', { text: options.label })]),
        options.hint ? el('div', { class: 'maestro-m23f-hint', text: options.hint }) : null,
    ]);
    return { node, input };
}

/** «Global / Yes / No» select of a `boolean?` field; the global option shows the current global value. */
export function triField(
    env: FormEnv,
    field: string,
    label: string,
    global: boolean | undefined,
    hint?: string,
): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-tri');
    const globalLabel =
        global === undefined
            ? t('m23f.tri.global')
            : t('m23f.tri.globalNow', { value: global ? t('m23f.tri.yes') : t('m23f.tri.no') });
    const node = el('select', { class: 'text_pole', attrs: { id, name: field } }, [
        el('option', { text: globalLabel, attrs: { value: 'null' } }),
        el('option', { text: t('m23f.tri.yes'), attrs: { value: 'true' } }),
        el('option', { text: t('m23f.tri.no'), attrs: { value: 'false' } }),
    ]);
    node.value = triStateOf(env.state.draft[field]);
    node.addEventListener('change', () => {
        const value = parseTriState(node.value);
        // `undefined` and `null` both mean «global» (`entry.x ?? global`): keep a missing field missing.
        if (value === null && env.state.stored[field] === undefined) delete env.state.draft[field];
        else env.state.draft[field] = value;
        env.changed();
    });
    return row(env, { label, control: node, for: id, hint, field });
}

export function numberMessage(env: FormEnv, result: NumberResult, spec: { min?: number; max?: number }): string | null {
    if (result.ok) {
        if (result.adjusted === 'min') return env.t('m23f.num.clampedMin', { value: spec.min ?? 0 });
        if (result.adjusted === 'max') return env.t('m23f.num.clampedMax', { value: spec.max ?? 0 });
        if (result.adjusted === 'floor') return env.t('m23f.num.floored', { value: result.value ?? '' });
        return null;
    }
    return env.t(`m23f.num.${result.error}`, { min: spec.min ?? 0 });
}

export interface NumberFieldOptions {
    label: string;
    placeholder?: string;
    hint?: Child | Child[];
}

/**
 * A number field with ST's limits (NUMBER_FIELDS). Valid input goes into the draft at once (clamped like ST);
 * invalid input shows an error and blocks saving. An empty input of a missing non-nullable field keeps it missing.
 */
export function numberField(
    env: FormEnv,
    field: NumberField,
    options: NumberFieldOptions,
): { node: HTMLElement; input: HTMLInputElement } {
    const spec = NUMBER_FIELDS[field] as { nullable?: boolean; min?: number; max?: number };
    const id = domId('maestro-m23f-num');
    const input = el('input', {
        class: 'text_pole maestro-m23f-number',
        attrs: {
            id,
            type: 'text',
            inputmode: 'numeric',
            placeholder: options.placeholder,
            name: field,
            autocomplete: 'off',
        },
    });
    input.value = numberText(env.state.draft[field]);
    const apply = (commit: boolean) => {
        const text = input.value;
        const stored = env.state.stored[field];
        const draft: Record<string, unknown> = env.state.draft;
        if (text.trim() === '' && !spec.nullable && (stored === undefined || stored === null)) {
            draft[field] = stored;
            if (stored === undefined) delete draft[field];
            env.setError(field, null);
            env.changed();
            return;
        }
        const result = parseNumber(text, NUMBER_FIELDS[field]);
        if (!result.ok) {
            env.setError(field, numberMessage(env, result, spec));
            env.changed();
            return;
        }
        env.setError(field, null);
        if (result.value === null && stored === undefined) delete draft[field];
        else draft[field] = result.value;
        if (commit && result.adjusted) {
            input.value = numberText(result.value);
            env.status(numberMessage(env, result, spec) ?? '', 'warn');
        }
        env.changed();
    };
    input.addEventListener('input', () => apply(false));
    input.addEventListener('change', () => apply(true));
    const node = row(env, { label: options.label, control: input, for: id, hint: options.hint, field });
    return { node, input };
}

/** Clickable suggestion chips (groups, outlets): `pick` receives the chosen value. */
export function suggestionChips(values: string[], label: string, pick: (value: string) => void): HTMLElement | null {
    if (!values.length) return null;
    return el(
        'div',
        { class: 'maestro-m23f-suggest', attrs: { role: 'group', 'aria-label': label } },
        values.map((value) =>
            el('button', {
                class: 'maestro-m23f-chip maestro-m23f-chip-btn',
                text: value,
                attrs: { type: 'button' },
                on: { click: () => pick(value) },
            }),
        ),
    );
}

/** A collapsible section of the form (<details>), open when `open`. */
export function formSection(
    title: string,
    children: Child[],
    options: { open?: boolean; id?: string; className?: string } = {},
): HTMLDetailsElement {
    const node = el(
        'details',
        {
            class: ['maestro-section', 'maestro-m23f-section', options.className],
            data: options.id ? { section: options.id } : undefined,
        },
        [
            el('summary', { class: 'maestro-m23f-summary' }, [
                el('span', { class: 'maestro-section-title', text: title }),
            ]),
            el('div', { class: 'maestro-section-body maestro-m23f-body' }, children),
        ],
    );
    node.open = options.open !== false;
    return node;
}

/** Disables every control inside `root` (read-only mode; the fieldset alone is not enough for custom widgets). */
export function disableAll(root: HTMLElement): void {
    for (const node of root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button')) {
        node.disabled = true;
    }
}
