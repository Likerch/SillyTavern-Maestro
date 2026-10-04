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
});
