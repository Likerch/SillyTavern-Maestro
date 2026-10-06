// @vitest-environment happy-dom
// Wiring of M25 (index.ts) with the state, tracking, checks, prompt and widgets parts replaced by recording fakes:
// the order of construction, what each part receives, the exposed API, the tab and the cleanup on disable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ log: [] as string[], args: {} as Record<string, unknown[]> }));

vi.mock('../../../src/features/mechanics/strings-state', () => ({
    STATE_STRINGS: { en: { 'm25.state.test': 'State' }, ru: { 'm25.state.test': 'Состояние' } },
}));
vi.mock('../../../src/features/mechanics/strings-checks', () => ({
    CHECK_STRINGS: { en: { 'm25.check.test': 'Check' }, ru: { 'm25.check.test': 'Проверка' } },
}));

function part(name: string, extra: Record<string, unknown> = {}) {
    return class {
        constructor(...args: unknown[]) {
            calls.log.push(`new ${name}`);
            calls.args[name] = args;
            Object.assign(this, extra);
        }
        install(): void {
            calls.log.push(`install ${name}`);
        }
        dispose(): void {
            calls.log.push(`dispose ${name}`);
        }
        onChange(): () => void {
            return () => {};
        }
    };
}

vi.mock('../../../src/features/mechanics/state', () => ({
    MechanicState: part('state', {
        holdersInScene: () => [],
        state: () => [],
    }),
    VALUE_UNDO_TARGET: 'mechanics.value',
    BATCH_UNDO_TARGET: 'mechanics.batch',
    STATUS_KIND: 'mechanics.status',
    ITEM_KIND: 'mechanics.item',
    REVEAL_KIND: 'mechanics.reveal',
}));
vi.mock('../../../src/features/mechanics/tracking', () => ({
    DES_STATS_UNDO_TARGET: 'mechanics.desStats',
    MechanicTracking: part('tracking', {
        desStatsStatus: () => [],
        enableDesStats: async () => true,
        blockInstruction: () => '',
        onRollRequests: (listener: unknown) => {
            calls.args.rollListener = [listener];
            return () => calls.log.push('roll requests off');
        },
        onCombatLines: (listener: unknown) => {
            calls.args.combatListener = [listener];
            return () => calls.log.push('combat lines off');
        },
    }),
}));
vi.mock('../../../src/features/mechanics/checks', () => ({ MechanicChecks: part('checks'), secureRng: () => 0.5 }));
vi.mock('../../../src/features/mechanics/prompt', () => ({ MechanicPrompt: part('prompt') }));
vi.mock('../../../src/features/mechanics/widgets', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    MechanicStrip: part('strip'),
    stateSection: (...args: unknown[]) => {
        calls.args.stateSection = args;
        return (container: HTMLElement) => {
            const node = document.createElement('div');
            node.className = 'fake-state-section';
            container.appendChild(node);
            return () => calls.log.push('state section off');
        };
    },
}));

import { mechanicsModule } from '../../../src/features/mechanics';
import type { MechanicsApi } from '../../../src/features/mechanics/api';
import { MechanicDefinitions } from '../../../src/features/mechanics/definitions';
import { MechanicsService } from '../../../src/features/mechanics/service';
import { MECHANICS_STRINGS } from '../../../src/features/mechanics/strings';
import { DEF_STRINGS } from '../../../src/features/mechanics/strings-defs';
import { startModule } from '../canon/helpers';
import { createDefsEnv } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;

beforeEach(() => {
    calls.log.length = 0;
    for (const key of Object.keys(calls.args)) delete calls.args[key];
    env = createDefsEnv();
    env.settings.registerModule('mechanics', mechanicsModule.defaults, true);
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('mechanics module', () => {
    it('is M25 of stage 11 with repaired default settings and merged strings', () => {
        expect(mechanicsModule).toMatchObject({ id: 'M25', key: 'mechanics', stage: 11, titleKey: 'm25.title' });
        expect(mechanicsModule.defaults()).toEqual({
            book: 'Maestro · механики',
            autoChecks: true,
            strip: true,
            promptBudget: 400,
            depth: 1,
            background: true,
            modelRolls: true,
            autoCombat: true,
            personaFallback: 'background',
            relevance: 4,
            hud: true,
            hudAttrs: [],
            hudHolders: [],
            desAttrs: [],
            desPersona: true,
        });
        expect(mechanicsModule.i18n).toBe(MECHANICS_STRINGS);
        expect(MECHANICS_STRINGS.en['m25.title']).toBe('Mechanics');
        expect(MECHANICS_STRINGS.ru['m25.state.test']).toBe('Состояние');
        expect(MECHANICS_STRINGS.ru['m25.check.test']).toBe('Проверка');
    });

    it('builds the parts in order, exposes the API and the tab, and disposes everything', async () => {
        const started = await startModule(env, mechanicsModule);
        expect(calls.log).toEqual([
            'new state',
            'install state',
            'new tracking',
            'install tracking',
            'new checks',
            'install checks',
            'new prompt',
            'install prompt',
            'new strip',
            'install strip',
        ]);
        const [deps, defs] = calls.args.state as [{ settings(): unknown }, unknown];
        expect(defs).toBeInstanceOf(MechanicDefinitions);
        expect(deps.settings()).toMatchObject({ book: 'Maestro · механики' });
        expect(calls.args.tracking).toEqual([deps, defs, expect.anything()]);
        expect(calls.args.checks?.[1]).toBe(defs);
        expect(calls.args.prompt).toHaveLength(5);
        expect(calls.args.strip?.[1]).toBe(defs);
        // The model's roll requests go to the checks part, the block's fight lines to the combat part.
        expect(calls.args.rollListener).toHaveLength(1);
        expect(calls.args.combatListener).toHaveLength(1);

        const api = env.modules.api<MechanicsApi>('mechanics');
        expect(api).toBeInstanceOf(MechanicsService);
        expect(api?.list()).toEqual([]);

        // The «Механики» window: «В игре», «История», «Конструктор».
        expect(env.ui.tabs.map((item) => [item.id, item.group ?? null, item.order])).toEqual(
            expect.arrayContaining([
                ['mechanics', 'mechanics', 63],
                ['mechanicsLog', 'mechanics', 64],
                ['mechanicsBuild', 'mechanics', 65],
            ]),
        );
        const tab = env.ui.tabs.find((item) => item.id === 'mechanics')!;
        expect(tab).toMatchObject({ titleKey: 'm25.tab', icon: 'fa-dice-d20', order: 63 });
        expect(env.ui.styles.has('maestro-m25-defs')).toBe(true);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const unmount = tab.render(container);
        expect(calls.args.stateSection?.[1]).toBe(defs);
        // The API goes to the state section (hidden values, pins, resets).
        expect(calls.args.stateSection?.[4]).toBe(api);
        const parts = [...container.querySelectorAll('.maestro-m25-part')];
        expect(parts).toHaveLength(3);
        expect(parts[1]!.querySelector('.fake-state-section')).not.toBeNull();
        if (typeof unmount === 'function') unmount();
        expect(calls.log).toContain('state section off');
        expect(container.children).toHaveLength(0);

        const build = env.ui.tabs.find((item) => item.id === 'mechanicsBuild')!;
        const buildBox = document.createElement('div');
        document.body.appendChild(buildBox);
        const offBuild = build.render(buildBox);
        const buildParts = [...buildBox.querySelectorAll('.maestro-m25-part')];
        expect(buildParts).toHaveLength(2);
        expect(buildParts[0]!.textContent).toContain(DEF_STRINGS.en['m25.def.section']);
        expect(buildParts[1]!.textContent).toContain(DEF_STRINGS.en['m25.def.settings.title']);
        if (typeof offBuild === 'function') offBuild();
        expect(buildBox.children).toHaveLength(0);

        calls.log.length = 0;
        await started.stop();
        expect(calls.log).toEqual([
            'dispose strip',
            'dispose prompt',
            'combat lines off',
            'roll requests off',
            'dispose checks',
            'dispose tracking',
            'dispose state',
        ]);
        expect(env.ui.tabs.find((item) => item.id === 'mechanics')).toBeUndefined();
        expect(env.ui.styles.has('maestro-m25-defs')).toBe(false);
        expect(env.mock.eventSource.events.get('worldinfo_updated')?.length ?? 0).toBe(0);
    });

    it('keeps the tab working when a section fails', async () => {
        const { composeSections } = await import('../../../src/features/mechanics/view');
        const root = document.createElement('div');
        const off = composeSections(env.deps, root, [
            () => {
                throw new Error('broken');
            },
            (container) => {
                container.textContent = 'ok';
                return () => {
                    throw new Error('cleanup');
                };
            },
        ]);
        expect(root.textContent).toBe('ok');
        expect(() => off()).not.toThrow();
        expect(env.logLines.some((line) => line.level === 'error')).toBe(true);
    });
});
