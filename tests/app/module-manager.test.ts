import { describe, expect, it } from 'vitest';
import { Modules } from '../../src/app/module-manager';
import { Settings } from '../../src/core/settings';
import type { App, MaestroModule } from '../../src/shared/contracts';
import { memoryLogger } from '../helpers/host-fakes';

function setup() {
    const log = memoryLogger();
    const store: Record<string, unknown> = {};
    const settings = new Settings(
        () => store,
        () => {},
        log,
    );
    const modules = new Modules(settings, log);
    const app = { host: { caps: { has: () => true } } } as unknown as App;
    return { modules, app };
}

function module(key: string, init: MaestroModule['init']): MaestroModule {
    return { id: key, key, stage: 1, titleKey: key, enabledByDefault: true, defaults: () => ({}), init };
}

describe('Modules', () => {
    it('drops every API a module exposed when it stops', async () => {
        const { modules, app } = setup();
        modules.register(
            [
                module('studio', async ({ app }) => {
                    app.modules.expose('studio', { a: 1 });
                    app.modules.expose('store', { b: 2 });
                }),
            ],
            () => {},
        );
        (app as unknown as { modules: Modules }).modules = modules;
        await modules.startAll(app);
        expect(modules.api('studio')).toEqual({ a: 1 });
        expect(modules.api('store')).toEqual({ b: 2 });
        await modules.disable('studio');
        expect(modules.api('studio')).toBeUndefined();
        expect(modules.api('store')).toBeUndefined();
    });

    it('drops the APIs of a module whose init failed, and expose(key, undefined) removes one', async () => {
        const { modules, app } = setup();
        modules.register(
            [
                module('broken', async ({ app }) => {
                    app.modules.expose('half', {});
                    throw new Error('boom');
                }),
            ],
            () => {},
        );
        (app as unknown as { modules: Modules }).modules = modules;
        await modules.startAll(app);
        expect(modules.api('half')).toBeUndefined();
        modules.expose('free', 1);
        expect(modules.api('free')).toBe(1);
        modules.expose('free', undefined);
        expect(modules.api('free')).toBeUndefined();
    });

    describe('suspend / resume («Мастерская»)', () => {
        function counted(key: string, log: string[], stage = 1): MaestroModule {
            return {
                ...module(key, ({ own }) => {
                    log.push(`start ${key}`);
                    own(() => {
                        log.push(`stop ${key}`);
                    });
                }),
                stage,
            };
        }

        async function started(log: string[]) {
            const { modules, app } = setup();
            modules.register(
                [counted('workshop', log, 0), counted('canon', log, 2), counted('theme', log, 12), counted('off', log)],
                () => {},
            );
            (app as unknown as { modules: Modules }).modules = modules;
            await modules.disable('off');
            await modules.startAll(app);
            log.length = 0;
            return modules;
        }

        it('stops all but the kept modules without touching their switches, and starts them again', async () => {
            const log: string[] = [];
            const modules = await started(log);
            await modules.suspend(['workshop', 'theme']);
            expect(log).toEqual(['stop canon']);
            expect(modules.isSuspended()).toBe(true);
            const listed = Object.fromEntries(modules.list().map((item) => [item.module.key, item]));
            expect(listed.canon).toMatchObject({ enabled: true, running: false, suspended: true });
            expect(listed.off).toMatchObject({ enabled: false, running: false });
            expect(listed.off?.suspended).toBeUndefined();
            expect(listed.theme).toMatchObject({ running: true });
            await modules.resume();
            expect(log).toEqual(['stop canon', 'start canon']);
            expect(modules.isSuspended()).toBe(false);
            expect(modules.list().some((item) => item.suspended)).toBe(false);
        });

        it('a module switched on during the pause waits for resume; one switched off is not started then', async () => {
            const log: string[] = [];
            const modules = await started(log);
            await modules.suspend(['workshop']);
            await modules.enable('off');
            expect(log).toEqual(['stop theme', 'stop canon']);
            await modules.disable('canon');
            await modules.resume();
            // Stage order: `off` (stage 1) before `theme` (stage 12).
            expect(log).toEqual(['stop theme', 'stop canon', 'start off', 'start theme']);
        });

        it('stopAll forgets the pause: a stop of the workshop module afterwards starts nothing', async () => {
            const log: string[] = [];
            const modules = await started(log);
            await modules.suspend(['workshop']);
            await modules.stopAll();
            expect(modules.isSuspended()).toBe(false);
            await modules.resume();
            expect(log.filter((line) => line.startsWith('start'))).toEqual([]);
        });
    });
});
