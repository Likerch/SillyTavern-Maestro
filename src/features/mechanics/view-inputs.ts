// M25 «Механики», small inputs of the constructor: a text line, a text area, an optional number (empty = none), a list
// written as «a, b, c», and a collapsible «Подробнее» block for technical fields (ids, English for the model).
import { el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';

export interface InputOptions {
    label: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

export function textInput(value: string, onInput: (value: string) => void, options: InputOptions): HTMLInputElement {
    const node = el('input', {
        class: ['text_pole', 'maestro-m25-input', options.className],
        attrs: {
            type: 'text',
            'aria-label': options.label,
            placeholder: options.placeholder,
            disabled: options.disabled === true,
        },
    });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

export function textArea(
    value: string,
    onInput: (value: string) => void,
    label: string,
    rows = 3,
    className?: string,
): HTMLTextAreaElement {
    const node = el('textarea', {
        class: ['text_pole', 'maestro-m25-input', className],
        attrs: { rows, 'aria-label': label },
    });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

/** A number input where empty means "none" (bounds, difficulty). */
export function optionalNumber(
    value: number | null | undefined,
    onInput: (value: number | undefined) => void,
    label: string,
    placeholder?: string,
    className?: string,
): HTMLInputElement {
    const node = el('input', {
        class: ['text_pole', 'maestro-m25-input', 'maestro-number', className],
        attrs: { type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': label, placeholder },
    });
    node.value = value === null || value === undefined ? '' : String(value);
    node.addEventListener('input', () => {
        const raw = node.value.trim();
        const parsed = raw === '' ? undefined : Number(raw);
        onInput(parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
    });
    return node;
}

export function listText(value: readonly string[] | undefined): string {
    return (value ?? []).join(', ');
}

/** «Подробнее»: technical fields (ids, English for the model), closed unless `open`. */
export function moreBlock(summary: string, children: Child | Child[], className?: string, open = false): HTMLElement {
    const node = el('details', { class: ['maestro-m25-more', className] }, [
        el('summary', { text: summary }),
        el('div', { class: 'maestro-m25-more-body' }, children),
    ]);
    if (open) node.setAttribute('open', '');
    return node;
}
