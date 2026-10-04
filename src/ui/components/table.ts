// Simple data table. On phones the stylesheet turns rows into stacked blocks and shows `data-label` before
// every cell, so wide tables never scroll sideways.
import { el } from './dom';
import type { Child } from './dom';
import { emptyState } from './card';

export interface Column<R> {
    key: string;
    label: string;
    cell(row: R, index: number): Child | Child[];
    className?: string;
    /** Numbers are right-aligned. */
    numeric?: boolean;
}

export interface TableOptions {
    empty?: string;
    className?: string;
    /** Accessible caption (visually hidden). */
    caption?: string;
}

export function table<R>(columns: Column<R>[], rows: R[], options: TableOptions = {}): HTMLElement {
    if (!rows.length && options.empty) return emptyState(options.empty, 'fa-inbox');
    const head = el(
        'tr',
        {},
        columns.map((column) =>
            el('th', {
                class: [column.className, column.numeric ? 'maestro-num' : null],
                text: column.label,
                attrs: { scope: 'col' },
            }),
        ),
    );
    const body = rows.map((row, index) =>
        el(
            'tr',
            {},
            columns.map((column) =>
                el(
                    'td',
                    { class: [column.className, column.numeric ? 'maestro-num' : null], data: { label: column.label } },
                    column.cell(row, index),
                ),
            ),
        ),
    );
    return el('div', { class: ['maestro-table-wrap', options.className] }, [
        el('table', { class: 'maestro-table' }, [
            options.caption ? el('caption', { class: 'maestro-sr-only', text: options.caption }) : null,
            el('thead', {}, [head]),
            el('tbody', {}, body),
        ]),
    ]);
}
