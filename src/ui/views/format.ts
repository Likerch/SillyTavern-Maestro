import type { I18n, ModuleManager } from '../../shared/contracts';

function intlLocale(i18n: I18n): string {
    return i18n.locale() === 'ru' ? 'ru-RU' : 'en-US';
}

/** "14:05" for today, "3 окт., 14:05" for other days. */
export function formatTime(at: number, i18n: I18n, now = Date.now()): string {
    const date = new Date(at);
    const today = new Date(now);
    const sameDay = date.toDateString() === today.toDateString();
    const options: Intl.DateTimeFormatOptions = sameDay
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    try {
        return new Intl.DateTimeFormat(intlLocale(i18n), options).format(date);
    } catch {
        return date.toISOString();
    }
}

/** US dollars with precision that stays readable for cents and fractions of a cent. */
export function formatUsd(value: number, i18n: I18n): string {
    const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
    try {
        return new Intl.NumberFormat(intlLocale(i18n), {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(value);
    } catch {
        return `$${value.toFixed(digits)}`;
    }
}

/** Translated key, or the fallback when the key has no translation (I18n returns the key itself then). */
export function tOr(i18n: I18n, key: string, fallback: string, params?: Record<string, string | number>): string {
    const text = i18n.t(key, params);
    return text === key ? fallback : text;
}

/** Module title by plan id ('M1') or settings key ('loreJournal'); unknown ids are shown as is. */
export function moduleTitle(modules: ModuleManager | undefined, i18n: I18n, id: string): string {
    const entry = modules?.list().find((item) => item.module.id === id || item.module.key === id);
    return entry ? i18n.t(entry.module.titleKey) : id;
}

/**
 * Coalesces bursts of calls (cost meter ticks, inbox changes) into one call after `ms`.
 * `cancel()` drops a pending call (view unmounted).
 */
export function coalesce(run: () => void, ms = 100): { (): void; cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const call = (() => {
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            run();
        }, ms);
    }) as { (): void; cancel(): void };
    call.cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return call;
}
