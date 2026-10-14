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

        describe('whileSuspended (1.24.1)', () => {
            /** A module with a part kept during the pause; both log, both expose an API. */
            function kept(key: string, log: string[], stage = 5, fail = false): MaestroModule {
                return {
                    ...counted(key, log, stage),
                    init: ({ app, own }) => {
                        log.push(`start ${key}`);
                        app.modules.expose(key, { full: true });
                        app.modules.expose(`${key}Defs`, { from: 'module' });
                        own(() => {
                            log.push(`stop ${key}`);
                        });
                    },
                    whileSuspended: ({ app, own }) => {
                        log.push(`keep ${key} (roles ${app.modules.api('roles') ? 'up' : 'down'})`);
                        app.modules.expose(`${key}Defs`, { from: 'part' });
                        own(() => {
                            log.push(`release ${key}`);
                        });
                        if (fail) throw new Error('boom');
                    },
                };
            }

            async function setupKept(log: string[], fail = false) {
                const { modules, app } = setup();
                (app as unknown as { modules: Modules }).modules = modules;
                modules.register(
                    [
                        counted('workshop', log, 0),
                        {
                            ...counted('roles', log, 2),
                            init: ({ app, own }) => {
                                log.push('start roles');
                                app.modules.expose('roles', {});
                                own(() => log.push('stop roles'));
                            },
                        },
                        kept('mech', log, 11, fail),
                        counted('late', log, 13),
                    ],
                    () => {},
                );
                return { modules, app };
            }

            it('runs only while the pause holds the module, after the stops, released before it starts again', async () => {
                const log: string[] = [];
                const { modules, app } = await setupKept(log);
                await modules.startAll(app);
                log.length = 0;
                await modules.suspend(['workshop', 'roles']);
                expect(log).toEqual(['stop late', 'stop mech', 'keep mech (roles up)']);
                expect(modules.api('mech')).toBeUndefined();
                expect(modules.api('mechDefs')).toEqual({ from: 'part' });
                // A second suspend (another service chat) keeps the same part.
                await modules.suspend(['workshop', 'roles']);
                expect(log).toHaveLength(3);
                log.length = 0;
                await modules.resume();
                expect(log).toEqual(['release mech', 'start mech', 'start late']);
                expect(modules.api('mechDefs')).toEqual({ from: 'module' });
                expect(modules.api('mech')).toEqual({ full: true });
            });

            it('follows the switch: not for a module off, released when switched off, started when switched on', async () => {
                const log: string[] = [];
                const { modules, app } = await setupKept(log);
                await modules.startAll(app);
                await modules.suspend(['workshop', 'roles']);
                log.length = 0;
                await modules.disable('mech');
                expect(log).toEqual(['release mech']);
                expect(modules.api('mechDefs')).toBeUndefined();
                await modules.resume();
                await modules.suspend(['workshop', 'roles']);
                expect(log).toEqual(['release mech', 'start late', 'stop late']);
                log.length = 0;
                await modules.enable('mech');
                expect(log).toEqual(['keep mech (roles up)']);
                await modules.stopAll();
                expect(log).toContain('release mech');
                expect(log).not.toContain('start mech');
                expect(modules.api('mechDefs')).toBeUndefined();
            });

            it('a part that fails is released with its API', async () => {
                const log: string[] = [];
                const { modules, app } = await setupKept(log, true);
                await modules.startAll(app);
                await modules.suspend(['workshop', 'roles']);
                expect(log.slice(-2)).toEqual(['keep mech (roles up)', 'release mech']);
                expect(modules.api('mechDefs')).toBeUndefined();
                log.length = 0;
                await modules.resume();
                expect(log).toEqual(['start mech', 'start late']);
            });

            it('a pause that comes while the modules start: the part waits for the kept modules to be up', async () => {
                const log: string[] = [];
                const { modules, app } = await setupKept(log);
                // The workshop decides during startAll (as at page load in a service chat).
                const entry = modules.list().find((item) => item.module.key === 'workshop')!.module;
                entry.init = async () => {
                    log.push('start workshop');
                    await modules.suspend(['workshop', 'roles']);
                };
                await modules.startAll(app);
                expect(log).toEqual(['start workshop', 'start roles', 'keep mech (roles up)']);
                expect(modules.list().find((item) => item.module.key === 'mech')).toMatchObject({
                    running: false,
                    suspended: true,
                });
            });
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
