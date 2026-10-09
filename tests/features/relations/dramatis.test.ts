// @vitest-environment happy-dom
// M19 with Dramatis (release 1.17): the graph also shows the engine's stances — characters toward the persona and
// toward one another — read live from DRAMATIS_API, named canonically and marked as Dramatis's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relationsModule } from '../../../src/features/relations';
import type { RelationsApi } from '../../../src/features/relations/api';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import type { Dict, WorldEnv } from '../world/helpers';
import { createWorldEnv, startModule } from '../world/helpers';

let env: WorldEnv;
let relations: RelationsApi;
let dramatis: InstalledDramatis;
let stop: () => Promise<void>;

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWorldEnv();
    (env.mock.context as unknown as Dict).name1 = 'Алекс';
    env.modules.expose('world', {
        resolve: (name: string) =>
            name === 'Лиза' ? { name: 'Elizabeth' } : name === 'Алекс' ? { name: 'Алекс' } : undefined,
        onChange: () => () => {},
    });
    dramatis = installDramatis(env.app);
    dramatis.api.stanceList = [
        { from: 'Bob', to: 'Лиза', stance: -1, label: 'Насторожен', reasons: ['she lied about the map'] },
        { from: 'Лиза', to: 'Алекс', stance: 2, label: 'Тепло', reasons: ['he paid her debt', 'shared the road'] },
        { from: 'Bob', to: 'Алекс', stance: -3, label: 'Враждебен', reasons: [] },
    ];
    const started = await startModule(env, relationsModule);
    stop = () => started.stop();
    relations = env.modules.api<RelationsApi>('relations')!;
    await vi.advanceTimersByTimeAsync(10);
});

afterEach(async () => {
    await stop();
    dramatis.remove();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('M19 with Dramatis', () => {
    it('lists the engine’s stances: toward the persona first, strongest first, canonical names', () => {
        expect(relations.engine?.()).toEqual([
            {
                from: 'Bob',
                to: 'Алекс',
                stance: -3,
                label: 'Враждебен',
                reasons: [],
                toPersona: true,
                source: 'dramatis',
            },
            {
                from: 'Elizabeth',
                to: 'Алекс',
                stance: 2,
                label: 'Тепло',
                reasons: ['he paid her debt', 'shared the road'],
                toPersona: true,
                source: 'dramatis',
            },
            {
                from: 'Bob',
                to: 'Elizabeth',
                stance: -1,
                label: 'Насторожен',
                reasons: ['she lied about the map'],
                toPersona: false,
                source: 'dramatis',
            },
        ]);
        // DES's own history is not mixed with them (the voice cards read all()).
        expect(relations.all()).toEqual([]);
    });

    it('is empty without Dramatis or a chat', () => {
        env.mock.chatId = undefined;
        expect(relations.engine?.()).toEqual([]);
        env.mock.chatId = 'chat-2';
        dramatis.remove();
        expect(relations.engine?.()).toEqual([]);
    });

    it('shows them in the tab marked as Dramatis’s and redraws when Dramatis changes', async () => {
        const tab = env.ui.tabs.find((item) => item.id === 'relations')!;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const cleanup = tab.render(container);
        const text = () => container.textContent ?? '';
        expect(text()).toContain('Relationships by Dramatis');
        expect(text()).toContain('Bob → Алекс');
        expect(text()).toContain('Враждебен (-3)');
        expect(text()).toContain('Тепло (+2)');
        expect(text()).toContain('he paid her debt; shared the road');
        expect(container.querySelectorAll('.maestro-m19-pair .maestro-badge-pill')).toHaveLength(3);

        dramatis.api.stanceList = [{ from: 'Bob', to: 'Алекс', stance: 0, label: '', reasons: [] }];
        dramatis.api.emit();
        await vi.advanceTimersByTimeAsync(200);
        expect(text()).not.toContain('Тепло');
        expect(text()).toContain('Bob → Алекс');

        dramatis.api.stanceList = [];
        dramatis.api.emit();
        await vi.advanceTimersByTimeAsync(200);
        expect(text()).not.toContain('Relationships by Dramatis');
        if (typeof cleanup === 'function') cleanup();
    });
});
