// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsSection } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { resetRegistries } from '../../src/ui/views/registries';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;

const titles = () =>
    [...document.querySelectorAll('.maestro-settings .maestro-section-title')].map((node) => node.textContent);

function section(id: string, order: number, overrides: Partial<SettingsSection> = {}) {
    const state = { renders: 0, disposed: 0 };
    const entry: SettingsSection = {
        id,
        titleKey: `test.section.${id}`,
        order,
        render(container) {
            state.renders++;
            container.append(Object.assign(document.createElement('p'), { textContent: `${id} body` }));
            return () => {
                state.disposed++;
            };
        },
        ...overrides,
    };
    return { entry, state };
}

beforeEach(() => {
    resetRegistries();
    buildStDom();
    env = installUiEnv('en');
    env.settings.core().firstRunDone = true;
    env.i18n.register({
        en: { 'test.section.look': 'Look', 'test.section.extra': 'Extra', 'test.section.bad': 'Broken' },
        ru: { 'test.section.look': 'Оформление', 'test.section.extra': 'Дополнительно', 'test.section.bad': 'Сломано' },
    });
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    ui.registerCoreViews(coreFakes(env));
});

afterEach(() => ui.dispose());

describe('settings sections', () => {
    it('renders module sections after the built-in blocks, by order', () => {
        const look = section('look', 20);
        const extra = section('extra', 10);
        ui.addSettingsSection(look.entry);
        ui.addSettingsSection(extra.entry);
        ui.openPult('settings');
        expect(titles().slice(-2)).toEqual(['Extra', 'Look']);
        expect(titles().indexOf('Data')).toBe(titles().length - 3);
        expect(document.querySelector('.maestro-settings-extra[data-section="look"]')?.textContent).toBe('look body');
        expect(look.state.renders).toBe(1);
    });

    it('disposes section renders on re-render, on a section switch and when the window closes', () => {
        const look = section('look', 20);
        ui.addSettingsSection(look.entry);
        ui.openPult('settings');
        ui.refresh();
        expect(look.state).toEqual({ renders: 2, disposed: 1 });
        ui.openPult('overview');
        expect(look.state).toEqual({ renders: 2, disposed: 2 });
        ui.openPult('settings');
        ui.closeWindow(ui.windowOfTab('settings')!);
        expect(look.state).toEqual({ renders: 3, disposed: 3 });
    });

    it('shows sections added or removed while the tab is open; the remover only removes its own entry', () => {
        ui.openPult('settings');
        const look = section('look', 20);
        const off = ui.addSettingsSection(look.entry);
        expect(titles()).toContain('Look');
        const replacement = section('look', 5);
        const offReplacement = ui.addSettingsSection(replacement.entry);
        expect(look.state.disposed).toBe(1);
        off();
        expect(titles()).toContain('Look');
        offReplacement();
        expect(titles()).not.toContain('Look');
        expect(replacement.state.disposed).toBe(replacement.state.renders);
    });

    it('a failing section shows an error in its place and the rest still renders', () => {
        const log = vi.spyOn(env.log, 'error');
        ui.addSettingsSection(
            section('bad', 1, {
                render: () => {
                    throw new Error('boom');
                },
            }).entry,
        );
        const look = section('look', 2);
        ui.addSettingsSection(look.entry);
        ui.openPult('settings');
        expect(document.querySelector('.maestro-settings-extra[data-section="bad"] .maestro-empty')).not.toBeNull();
        expect(titles().slice(-2)).toEqual(['Broken', 'Look']);
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it('nothing is registered after dispose', () => {
        ui.dispose();
        const look = section('look', 1);
        const off = ui.addSettingsSection(look.entry);
        expect(typeof off).toBe('function');
        off();
        expect(look.state.renders).toBe(0);
    });
});
