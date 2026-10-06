// @vitest-environment happy-dom
// The «Проверка промпта» tab of the Preset Studio (M38): it hosts the prompt audit's own report view, or says the
// module is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PmInfo } from '../../../src/features/presetStudio/launcher';
import { SCOPE_STRINGS } from '../../../src/features/presetStudio/scope-strings';
import { PresetStudio, STUDIO_TABS, presetStudioWindow, servicesOf } from '../../../src/features/presetStudio/studio';
import type { PromptAuditApi } from '../../../src/features/promptAudit/api';
import { click, createStand, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let studio: PresetStudio;

const openAudit = async () => {
    studio.open();
    await wait();
    click(qa('.maestro-tab').find((node) => node.dataset.tab === 'audit'));
    await wait();
};

beforeEach(() => {
    s = createStand();
    s.app.i18n.register(SCOPE_STRINGS);
    s.expose();
    studio = new PresetStudio({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        settings: s.settings,
        saveSettings: vi.fn(),
        pm: new PmInfo(s.app, s.app.log),
        showClassic: () => {},
    });
    s.app.ui.addWindow!(presetStudioWindow(studio));
});

afterEach(() => {
    studio.close();
});

describe('the prompt check tab', () => {
    it('is the last tab of the studio', () => {
        expect(STUDIO_TABS.at(-1)).toBe('audit');
    });

    it('says when the module is off', async () => {
        await openAudit();
        expect(q('.maestro-m34-pane')?.textContent).toContain('The prompt check module is off.');
    });

    it('shows the audit’s own report view', async () => {
        const renderReport = vi.fn(() => {
            const node = document.createElement('div');
            node.className = 'fake-audit-report';
            node.textContent = 'Report here';
            return node;
        });
        s.app.modules.expose('promptAudit', { renderReport } as unknown as PromptAuditApi);
        await openAudit();
        expect(renderReport).toHaveBeenCalled();
        expect(q('.maestro-m34-pane .fake-audit-report')?.textContent).toBe('Report here');
    });
});
