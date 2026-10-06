// @vitest-environment happy-dom
// «Обсудить с ассистентом» in the Preset Studio (plan-2 §1 п. 7): a button on the preset (the header) and on every block
// row opens the assistant with that preset or block attached; without the assistant the buttons are not there; what
// the assistant changes reaches the open studio through the store's change events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantContextItem } from '../../../src/features/assistant/api';
import { PmInfo } from '../../../src/features/presetStudio/launcher';
import { SCOPE_STRINGS } from '../../../src/features/presetStudio/scope-strings';
import { PresetStudio, servicesOf } from '../../../src/features/presetStudio/studio';
import { click, createStand, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let studio: PresetStudio;
let discussed: AssistantContextItem[];

const row = (id: string) => qa('.maestro-m34-block').find((node) => node.dataset.id === id) as HTMLElement;

function build(): PresetStudio {
    return new PresetStudio({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        settings: s.settings,
        saveSettings: vi.fn(),
        pm: new PmInfo(s.app, s.app.log),
        showClassic: () => {},
    });
}

beforeEach(() => {
    s = createStand();
    s.app.i18n.register(SCOPE_STRINGS);
    s.expose();
    discussed = [];
    s.app.modules.expose('assistant', { discuss: (item: AssistantContextItem) => discussed.push(item) });
    studio = build();
});

afterEach(() => {
    studio.close();
});

describe('«Обсудить с ассистентом»', () => {
    it('attaches the preset from the header and a block from its row', async () => {
        studio.open();
        await wait();
        const header = q('.maestro-m34-discuss');
        expect(header?.getAttribute('title')).toBe('Discuss the preset with the assistant');
        click(header);
        expect(discussed).toEqual([{ kind: 'preset', preset: 'Marinara', label: 'Marinara' }]);
        const button = row('style').querySelector('.maestro-m34-discuss-block');
        expect(button?.getAttribute('title')).toBe('Discuss with the assistant');
        click(button);
        expect(discussed[1]).toEqual({ kind: 'presetBlock', preset: 'Marinara', identifier: 'style', label: 'Style' });
    });

    it('shows no button without the assistant', async () => {
        s.app.modules.expose('assistant', undefined);
        studio.open();
        await wait();
        expect(q('.maestro-m34-discuss')).toBeNull();
        expect(qa('.maestro-m34-discuss-block')).toHaveLength(0);
    });

    it('refreshes the open studio when the assistant changes a block', async () => {
        studio.open();
        await wait();
        await s.store.updatePrompt('style', { name: 'Style by the assistant' });
        await wait();
        expect(row('style').querySelector('.maestro-m34-block-title')?.textContent).toBe('Style by the assistant');
    });
});
