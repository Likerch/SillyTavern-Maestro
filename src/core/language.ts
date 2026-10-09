// «Язык истории» (M37): the one place that says which language the story is told in. The core setting
// `storyLanguage` wins when it is 'ru' or 'en'; 'auto' reads the chat (the player's messages first, then Russian
// greetings or replies) and falls back to Maestro's interface language (domain/story-language.ts). Everything a module
// may lack in a test app (settings, the host, i18n) is read defensively: no throw, the interface language or English.
import { resolveStoryLanguage, storyTexts } from '../domain/story-language';
import type { StoryLanguage } from '../domain/story-language';
import type { App } from '../shared/contracts';

export type { StoryLanguage, StoryLanguageChoice } from '../domain/story-language';

function safely<T>(read: () => T, fallback: T): T {
    try {
        return read() ?? fallback;
    } catch {
        return fallback;
    }
}

/** The language the story is told in now (the setting, else the chat, else the interface language). */
export function storyLanguage(app: Partial<Pick<App, 'settings' | 'host' | 'i18n'>>): StoryLanguage {
    const choice = safely(() => app.settings?.core().storyLanguage, undefined);
    if (choice === 'ru' || choice === 'en') return choice;
    const chat = safely(() => (app.host?.ctx().chat ?? []) as readonly unknown[], [] as readonly unknown[]);
    const ui = safely(() => app.i18n?.locale(), 'en') === 'ru' ? 'ru' : 'en';
    return resolveStoryLanguage(choice, storyTexts(chat), ui);
}
