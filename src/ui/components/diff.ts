// "Before / after" views for Inbox cards and journal records: word-level diff for strings, field-by-field
// diff for JSON objects. The diff functions are pure (no DOM) so they are cheap to test.
import type { I18n, JournalChange } from '../../shared/contracts';
import { el } from './dom';
import type { Child } from './dom';

export interface DiffPart {
    kind: 'same' | 'added' | 'removed';
    text: string;
}

/** Words (letters/digits, any script), runs of whitespace and single punctuation marks. */
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export function tokenize(text: string): string[] {
    return text.match(TOKEN) ?? [];
}

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
}

/**
 * Word-level diff (LCS over tokens). Common prefix and suffix are trimmed first; if the remaining middle is
 * too large for the O(n·m) table, it is shown as one removed and one added block.
 */
export function wordDiff(before: string, after: string, maxCells = 250_000): DiffPart[] {
    const a = tokenize(before);
    const b = tokenize(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const parts: DiffPart[] = [];
    push(parts, 'same', a.slice(0, start).join(''));
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    if (midA.length * midB.length > maxCells) {
        push(parts, 'removed', midA.join(''));
        push(parts, 'added', midB.join(''));
    } else {
        lcsDiff(midA, midB, parts);
    }
    push(parts, 'same', a.slice(endA).join(''));
    return parts;
}

function lcsDiff(a: string[], b: string[], parts: DiffPart[]): void {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    // table[i * width + j] = LCS length of a[i:] and b[j:]
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * width + j] =
                a[i] === b[j]
                    ? (table[(i + 1) * width + j + 1] ?? 0) + 1
                    : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const tokenA = a[i] ?? '';
        const tokenB = b[j] ?? '';
        if (tokenA === tokenB) {
            push(parts, 'same', tokenA);
            i++;
            j++;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
            push(parts, 'removed', tokenA);
            i++;
        } else {
            push(parts, 'added', tokenB);
            j++;
        }
    }
    while (i < n) push(parts, 'removed', a[i++] ?? '');
    while (j < m) push(parts, 'added', b[j++] ?? '');
}

export interface FieldDiff {
    /** Dotted path; '' for a root value that is not an object. */
    path: string;
    kind: 'added' | 'removed' | 'changed' | 'same';
    before?: unknown;
    after?: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with sorted keys, so field order does not count as a change. */
export function stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    return JSON.stringify(value, (_key, item: unknown) => {
        if (!isPlainObject(item)) return item;
        return Object.fromEntries(
            Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
        );
    });
}

/** Field-by-field diff of two JSON values; nested objects recurse, arrays compare as whole values. */
export function jsonDiff(before: unknown, after: unknown, path = ''): FieldDiff[] {
    if (isPlainObject(before) && isPlainObject(after)) {
        const keys = [...Object.keys(before), ...Object.keys(after).filter((key) => !Object.hasOwn(before, key))];
        return keys.flatMap((key) => jsonDiff(before[key], after[key], path ? `${path}.${key}` : key));
    }
    if (before === undefined && after !== undefined) return [{ path, kind: 'added', after }];
    if (after === undefined && before !== undefined) return [{ path, kind: 'removed', before }];
    const same = stableStringify(before) === stableStringify(after);
    return [{ path, kind: same ? 'same' : 'changed', before, after }];
}

type Translate = I18n['t'];

type Primitive = string | number | boolean | null;

function isPrimitive(value: unknown): value is Primitive {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Lists of keys, tags, aliases: short arrays of primitives. */
export function isPrimitiveArray(value: unknown): value is Primitive[] {
    return Array.isArray(value) && value.every(isPrimitive);
}

/** Item-level diff of two primitive lists (order kept: before's items first, then new ones). */
export function listDiff(
    before: Primitive[],
    after: Primitive[],
): { kind: 'same' | 'added' | 'removed'; value: Primitive }[] {
    const kept = new Set(after.map((item) => JSON.stringify(item)));
    const old = new Set(before.map((item) => JSON.stringify(item)));
    return [
        ...before.map((value) => ({
            kind: kept.has(JSON.stringify(value)) ? ('same' as const) : ('removed' as const),
            value,
        })),
        ...after.filter((value) => !old.has(JSON.stringify(value))).map((value) => ({ kind: 'added' as const, value })),
    ];
}

export function formatValue(value: unknown): string {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isPrimitiveArray(value)) return value.map((item) => (item === null ? '—' : String(item))).join(', ');
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/** Renders word-diff parts as <del>/<ins> inline. */
export function renderParts(parts: DiffPart[], t: Translate): HTMLElement {
    return el(
        'div',
        { class: 'maestro-diff-text' },
        parts.map((part) => {
            if (part.kind === 'added')
                return el('ins', { class: 'maestro-diff-add', title: t('ui.diff.added'), text: part.text });
            if (part.kind === 'removed')
                return el('del', { class: 'maestro-diff-del', title: t('ui.diff.removed'), text: part.text });
            return el('span', { text: part.text });
        }),
    );
}

function isTextual(value: unknown): boolean {
    return typeof value === 'string' || value === undefined || value === null;
}

/** Diff view for any pair of values: strings → word diff, objects → field table, other → before/after. */
export function diffView(before: unknown, after: unknown, t: Translate): HTMLElement {
    if (isTextual(before) && isTextual(after) && (typeof before === 'string' || typeof after === 'string')) {
        const a = typeof before === 'string' ? before : '';
        const b = typeof after === 'string' ? after : '';
        if (a === b) return el('div', { class: 'maestro-diff maestro-diff-none', text: t('ui.diff.noChanges') });
        return el('div', { class: 'maestro-diff' }, [renderParts(wordDiff(a, b), t)]);
    }
    if (isPrimitiveArray(before) && isPrimitiveArray(after)) {
        if (stableStringify(before) === stableStringify(after)) {
            return el('div', { class: 'maestro-diff maestro-diff-none', text: t('ui.diff.noChanges') });
        }
        return el('div', { class: 'maestro-diff' }, [renderList(before, after)]);
    }
    if (isPlainObject(before) || isPlainObject(after)) {
        const fields = jsonDiff(isPlainObject(before) ? before : {}, isPlainObject(after) ? after : {});
        return fieldTable(fields, t);
    }
    if (stableStringify(before) === stableStringify(after)) {
        return el('div', { class: 'maestro-diff maestro-diff-none', text: t('ui.diff.noChanges') });
    }
    return el('div', { class: 'maestro-diff maestro-diff-pair' }, [
        valueBlock(t('ui.diff.before'), before, 'maestro-diff-del'),
        valueBlock(t('ui.diff.after'), after, 'maestro-diff-add'),
    ]);
}

function valueBlock(label: string, value: unknown, className: string): HTMLElement {
    return el('div', { class: 'maestro-diff-side' }, [
        el('div', { class: 'maestro-diff-label', text: label }),
        el('pre', { class: ['maestro-diff-value', className], text: formatValue(value) }),
    ]);
}

function fieldCell(field: FieldDiff, t: Translate): Child {
    if (field.kind === 'added') return el('ins', { class: 'maestro-diff-add', text: formatValue(field.after) });
    if (field.kind === 'removed') return el('del', { class: 'maestro-diff-del', text: formatValue(field.before) });
    if (typeof field.before === 'string' && typeof field.after === 'string')
        return renderParts(wordDiff(field.before, field.after), t);
    if (isPrimitiveArray(field.before) && isPrimitiveArray(field.after)) return renderList(field.before, field.after);
    return el('span', { class: 'maestro-diff-change' }, [
        el('del', { class: 'maestro-diff-del', text: formatValue(field.before) }),
        el('span', { class: 'maestro-diff-arrow', text: ' → ' }),
        el('ins', { class: 'maestro-diff-add', text: formatValue(field.after) }),
    ]);
}

function renderList(before: Primitive[], after: Primitive[]): HTMLElement {
    const items = listDiff(before, after);
    const nodes: Child[] = [];
    items.forEach((item, index) => {
        if (index) nodes.push(', ');
        const text = item.value === null ? '—' : String(item.value);
        if (item.kind === 'added') nodes.push(el('ins', { class: 'maestro-diff-add', text }));
        else if (item.kind === 'removed') nodes.push(el('del', { class: 'maestro-diff-del', text }));
        else nodes.push(el('span', { text }));
    });
    return el('span', { class: 'maestro-diff-list' }, nodes);
}

function fieldTable(fields: FieldDiff[], t: Translate): HTMLElement {
    const changed = fields.filter((field) => field.kind !== 'same');
    const same = fields.filter((field) => field.kind === 'same');
    const row = (field: FieldDiff) =>
        el('div', { class: ['maestro-diff-row', `maestro-diff-${field.kind}`] }, [
            el('div', { class: 'maestro-diff-path', text: field.path || t('ui.diff.value') }),
            el('div', { class: 'maestro-diff-cell' }, [
                field.kind === 'same' ? el('span', { text: formatValue(field.after) }) : fieldCell(field, t),
            ]),
        ]);
    return el('div', { class: 'maestro-diff maestro-diff-fields' }, [
        changed.length ? null : el('div', { class: 'maestro-diff-none', text: t('ui.diff.noChanges') }),
        ...changed.map(row),
        same.length
            ? el('details', { class: 'maestro-diff-same' }, [
                  el('summary', { text: t('ui.diff.unchanged', { count: same.length }) }),
                  ...same.map(row),
              ])
            : null,
    ]);
}

/** One journal/inbox change: target and locator, then the diff. */
export function changeView(change: JournalChange, t: Translate): HTMLElement {
    const ref = Object.entries(change.ref)
        .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(', ');
    return el('div', { class: 'maestro-change' }, [
        el('div', { class: 'maestro-change-head' }, [
            el('span', { class: 'maestro-change-target', text: change.target }),
            ref ? el('span', { class: 'maestro-change-ref', text: ref }) : null,
        ]),
        diffView(change.before, change.after, t),
    ]);
}
