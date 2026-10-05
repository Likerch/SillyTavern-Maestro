// @vitest-environment happy-dom
// The real parts wired by index.ts start and stop in the test app, and a definition saved through the API is seen by
// the other parts (state, prompt) — a smoke test of the module as the app runs it.
import { describe, expect, it } from 'vitest';
import { mechanicsModule } from '../../../src/features/mechanics';
import type { MechanicsApi } from '../../../src/features/mechanics/api';
import { startModule } from '../canon/helpers';
import { BOOK, createDefsEnv, mechanic, settle } from './helpers-defs';

describe('mechanics module with its real parts', () => {
    it('starts, saves a definition from a template, renders the tab and stops without leftovers', async () => {
        const env = createDefsEnv();
        env.settings.registerModule('mechanics', mechanicsModule.defaults, true);
        env.app.i18n.register(mechanicsModule.i18n!);
        const started = await startModule(env, mechanicsModule);
        const api = env.modules.api<MechanicsApi>('mechanics')!;
        const draft = api.fromTemplate('health')!;
        expect(draft.scope).toEqual({ kind: 'card', avatar: 'kai.png' });
        const saved = await api.save(draft);
        await settle();
        expect(saved.book).toBe(BOOK);
        expect(api.list().map((def) => def.id)).toEqual(['health']);
        expect(api.active().map((def) => def.id)).toEqual(['health']);
        await api.save(mechanic({ id: 'magic' }));
        await api.setEnabledInChat('magic', false);
        expect(api.active().map((def) => def.id)).toEqual(['health']);

        const tab = env.ui.tabs.find((item) => item.id === 'mechanics')!;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const unmount = tab.render(container);
        await settle();
        expect(container.textContent).toContain('Health and stamina');
        if (typeof unmount === 'function') unmount();

        await started.stop();
        expect(env.ui.tabs.find((item) => item.id === 'mechanics')).toBeUndefined();
        expect(env.mock.eventSource.events.get('worldinfo_updated')?.length ?? 0).toBe(0);
        expect(env.ephemeral.producers.size).toBe(0);
    });
});
