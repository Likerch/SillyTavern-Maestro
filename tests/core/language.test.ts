// «Язык истории» (core/language.ts): the shared resolver over Maestro's settings, the chat and the interface language,
// the core setting's default and repair.
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import { storyLanguage } from '../../src/core/language';
import { Settings, defaultCoreSettings, migrateCore } from '../../src/core/settings';
import type { App } from '../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';

function setup(locale: 'ru' | 'en', greeting: string) {
    const mock = installStMock();
    mock.chat.push({ name: 'Ophelia', is_user: false, is_system: false, send_date: '', mes: greeting, extra: {} });
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        createTestLogger(),
    );
    const app = { host: createTestHost(mock), settings, i18n: createI18n(() => locale) } as unknown as App;
    return { mock, settings, app };
}

const ENGLISH = 'Ophelia looks up from the ledger as the door of the Salt Anchor Tavern bangs open in the storm.';

describe('core: the story language', () => {
    it('auto: a new chat with an English card under a Russian interface is told in Russian', () => {
        const { app, settings } = setup('ru', ENGLISH);
        expect(settings.core().storyLanguage).toBe('auto');
        expect(storyLanguage(app)).toBe('ru');
        expect(storyLanguage(setup('en', ENGLISH).app)).toBe('en');
    });

    it('the explicit setting wins', () => {
        const { app, settings } = setup('ru', ENGLISH);
        settings.core().storyLanguage = 'en';
        expect(storyLanguage(app)).toBe('en');
        settings.core().storyLanguage = 'ru';
        const english = setup('en', ENGLISH);
        english.settings.core().storyLanguage = 'ru';
        expect(storyLanguage(english.app)).toBe('ru');
    });

    it("auto follows the player's messages once there are some", () => {
        const { app, mock } = setup('ru', ENGLISH);
        mock.chat.push({
            name: 'Kai',
            is_user: true,
            is_system: false,
            send_date: '',
            mes: 'I shake the rain off my cloak and sit down by the fire without a word.',
            extra: {},
        });
        expect(storyLanguage(app)).toBe('en');
    });

    it('never throws in an app without settings, a chat or i18n', () => {
        expect(storyLanguage({})).toBe('en');
        const broken = {
            settings: {
                core() {
                    throw new Error('no');
                },
            },
            host: {
                ctx() {
                    throw new Error('no');
                },
            },
            i18n: { locale: () => 'ru' },
        } as unknown as App;
        expect(storyLanguage(broken)).toBe('ru');
    });

    it("the core setting defaults to 'auto' and junk is repaired", () => {
        expect(defaultCoreSettings().storyLanguage).toBe('auto');
        expect(migrateCore({ ...defaultCoreSettings(), storyLanguage: 'de' as never }).storyLanguage).toBe('auto');
        expect(migrateCore({ ...defaultCoreSettings(), storyLanguage: 'ru' }).storyLanguage).toBe('ru');
        const stored = { ...defaultCoreSettings() } as Record<string, unknown>;
        delete stored.storyLanguage;
        expect(migrateCore(stored as never).storyLanguage).toBe('auto');
    });
});
