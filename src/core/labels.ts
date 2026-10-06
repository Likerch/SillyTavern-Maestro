// How journal targets and action kinds read to the user (plan-2 §3 «Понятные уведомления»). Modules describe their
// journal targets (MaestroModule.targets: label, fields with human labels and value formatters) and name their action
// kinds with `kind.<kind>` strings. Inbox cards, the journal and Settings show these words; whatever nobody described
// (unknown fields, `ref` locators, raw values) goes to «Подробнее» instead of being shown raw.
import { pluralForm } from '../domain/plural';
import type { I18n, JournalChange, TargetFieldSpec, TargetSpec, Unsubscribe } from '../shared/contracts';

export interface Labels {
    /** Adds target descriptions (a later registration of the same target replaces the earlier one). */
    register(specs: readonly TargetSpec[]): Unsubscribe;
    target(target: string): TargetSpec | undefined;
    targets(): TargetSpec[];
}

export function createLabels(): Labels {
    const specs = new Map<string, TargetSpec>();
    return {
        register(list: readonly TargetSpec[]): Unsubscribe {
            const added = list.filter((spec) => spec && typeof spec.target === 'string' && spec.target);
            for (const spec of added) specs.set(spec.target, spec);
            return () => {
                for (const spec of added) if (specs.get(spec.target) === spec) specs.delete(spec.target);
            };
        },
        target: (target) => specs.get(target),
        targets: () => [...specs.values()],
    };
}

/** Translation of `key`, or undefined when there is none (I18n returns the key itself then). */
function maybe(i18n: I18n, key: string, params?: Record<string, string | number>): string | undefined {
    const text = i18n.t(key, params);
    return text === key ? undefined : text;
}

/** A counted phrase: `${key}.one|few|many` with {count} (and other params) filled in. */
export function tPlural(i18n: I18n, key: string, count: number, params: Record<string, string | number> = {}): string {
    return i18n.t(`${key}.${pluralForm(count, i18n.locale())}`, { ...params, count });
}

/** Human name of an action kind (`kind.<kind>`); undefined when the module did not name it. */
export function kindLabel(i18n: I18n, kind: string): string | undefined {
    return maybe(i18n, `kind.${kind}`);
}

/** Human name of a journal target: its spec's label, else `target.<target>`; undefined when nobody named it. */
export function targetLabel(i18n: I18n, labels: Labels | undefined, target: string): string | undefined {
    const spec = labels?.target(target);
    return maybe(i18n, spec?.labelKey ?? `target.${target}`);
}

/* ------------------------------------------------------------------ value formatters for modules */

type Formatter = (value: unknown, i18n: I18n) => string;

function isPlain(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveText(value: unknown, i18n: I18n): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return i18n.t(value ? 'core.value.yes' : 'core.value.no');
    return '';
}

/** Default: strings, numbers, yes/no, short lists joined with commas; objects are not shown (details only). */
export const formatPlain: Formatter = (value, i18n) => {
    if (Array.isArray(value)) {
        return value
            .map((item) => primitiveText(item, i18n))
            .filter(Boolean)
            .join(', ');
    }
    return primitiveText(value, i18n);
};

/** Enum value → `${prefix}${value}` string (e.g. 'm26.type.' + 'tradition' → «традиция»); unknown values as is. */
export function formatEnum(prefix: string): Formatter {
    return (value, i18n) => {
        if (typeof value !== 'string' || !value) return formatPlain(value, i18n);
        return maybe(i18n, `${prefix}${value}`) ?? value;
    };
}

/** Epoch milliseconds → local date and time. */
export const formatTime: Formatter = (value, i18n) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
    try {
        return new Intl.DateTimeFormat(i18n.locale() === 'ru' ? 'ru-RU' : 'en-US', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(value));
    } catch {
        return new Date(value).toISOString();
    }
};

/** Long text cut to `max` characters with an ellipsis. */
export function formatClip(max: number): Formatter {
    return (value, i18n) => {
        const text = formatPlain(value, i18n).replace(/\s+/g, ' ');
        return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
    };
}

/* ------------------------------------------------------------------ the human part of a change */

export interface HumanRow {
    /** Field label; '' for the value of a plain change without a value label. */
    label: string;
    kind: 'added' | 'removed' | 'changed';
    before?: string;
    after?: string;
}

export interface HumanChange {
    /** Target label (undefined when the module named the fields but not the target). */
    label?: string;
    rows: HumanRow[];
}

function row(label: string, before: string, after: string, created: boolean, removed: boolean): HumanRow | null {
    if (!before && !after) return null;
    if (created || (!before && after)) return { label, kind: 'added', after };
    if (removed || (before && !after)) return { label, kind: 'removed', before };
    if (before === after) return null;
    return { label, kind: 'changed', before, after };
}

function fieldText(spec: TargetFieldSpec, value: unknown, i18n: I18n): string {
    if (value === undefined || (value === null && !spec.nullable)) return '';
    try {
        return (spec.format ?? formatPlain)(value, i18n).trim();
    } catch {
        return '';
    }
}

/**
 * The part of a change the user reads in the main body: the target's label and its described fields as
 * «label: before → after». Null when nothing can be shown in plain words (undescribed or technical target, only
 * unknown fields): the change then lives under «Подробнее» only.
 */
export function describeChange(change: JournalChange, labels: Labels | undefined, i18n: I18n): HumanChange | null {
    const spec = labels?.target(change.target);
    if (!spec || spec.technical) return null;
    const label = targetLabel(i18n, labels, change.target);
    const absent = (value: unknown) => value === undefined || (value === null && !spec.nullable);
    const created = absent(change.before);
    const removed = absent(change.after);
    const rows: HumanRow[] = [];
    const objects =
        (isPlain(change.before) || change.before === undefined || change.before === null) &&
        (isPlain(change.after) || change.after === undefined || change.after === null);
    if (spec.fields && objects && (isPlain(change.before) || isPlain(change.after))) {
        const before = isPlain(change.before) ? change.before : {};
        const after = isPlain(change.after) ? change.after : {};
        for (const [key, field] of Object.entries(spec.fields)) {
            if (field.hidden) continue;
            const next = row(
                i18n.t(field.labelKey),
                fieldText(field, before[key], i18n),
                fieldText(field, after[key], i18n),
                created,
                removed,
            );
            if (next) rows.push(next);
        }
    } else if (!isPlain(change.before) && !isPlain(change.after)) {
        const format = spec.format ?? formatPlain;
        const text = (value: unknown) => {
            if (absent(value)) return '';
            try {
                return format(value, i18n).trim();
            } catch {
                return '';
            }
        };
        const valueLabel = spec.valueLabelKey ? i18n.t(spec.valueLabelKey) : '';
        const next = row(valueLabel, text(change.before), text(change.after), created, removed);
        if (next) rows.push(next);
    }
    if (!rows.length) return null;
    return label ? { label, rows } : { rows };
}
