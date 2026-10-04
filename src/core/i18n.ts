import type { Dict, I18n, I18nParts } from '../shared/contracts';

/**
 * Both dictionaries are bundled: modules register their parts at load time, so the manifest needs no
 * i18n files and there is no merge step. The language follows the core setting, then ST's locale.
 */
export class Translations implements I18n {
    private readonly en: Dict = {};
    private readonly ru: Dict = {};

    constructor(private readonly resolveLocale: () => 'ru' | 'en') {}

    register(parts: I18nParts): void {
        Object.assign(this.en, parts.en);
        Object.assign(this.ru, parts.ru);
    }

    locale(): 'ru' | 'en' {
        return this.resolveLocale();
    }

    t(key: string, params?: Record<string, string | number>): string {
        const primary = this.locale() === 'ru' ? this.ru[key] : this.en[key];
        const text = primary ?? this.en[key] ?? key;
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
    }

    has(key: string): boolean {
        return Object.hasOwn(this.en, key);
    }

    /** Keys present in English but missing in Russian (used by tests). */
    missingRussian(): string[] {
        return Object.keys(this.en).filter((key) => !Object.hasOwn(this.ru, key));
    }
}

/** ST stores the UI language in localStorage 'language' (e.g. 'ru-ru'); getCurrentLocale() exists in 1.19. */
export function hostLocale(getLocale?: () => string | undefined): 'ru' | 'en' {
    let value: string | undefined;
    try {
        value = getLocale?.() ?? globalThis.localStorage?.getItem('language') ?? undefined;
    } catch {
        value = undefined;
    }
    return value?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function createI18n(resolveLocale: () => 'ru' | 'en'): Translations {
    return new Translations(resolveLocale);
}
