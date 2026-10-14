// @vitest-environment happy-dom
// Release 1.24.1: in a service chat (M42 pauses the story modules) the mechanics definitions stay writable through
// MAESTRO_API.mechanics — the real module manager, the real M25 with its parts, the facade and an in-memory World Info.
// The chat-level parts stay quiet there (no prompt producer, no reply or message listeners, no tabs), the per-chat
// switch answers 'off', writes are journaled under the neighbour and undone in the service chat or after it, and the
// module, back in a story chat, reads the definitions written meanwhile. With the module switched off it is 'off'.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Modules } from '../../../src/app/module-manager';
import { createServiceFacades } from '../../../src/app/public-api-services';
import type { ServiceFacades } from '../../../src/app/public-api-services';
import { mechanicsModule } from '../../../src/features/mechanics';
import type { MechanicDefinitionsApi, MechanicsApi } from '../../../src/features/mechanics/api';
import { WORKSHOP_KEEPS } from '../../../src/features/workshop/api';
import type { App } from '../../../src/shared/contracts';
import type { ApiMechanicDef } from '../../../src/shared/public-api-types';
import { listenerCount } from '../canon/helpers';
import { BOOK, createDefsEnv, mechanic, settle } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

const COAUTHOR = 'officina-coauthor.png';
/** Chat-level events M25 listens to while it runs (replies, the player's messages, generations). */
const CHAT_EVENTS = ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'GENERATION_STARTED'] as const;

let env: DefsEnv;
let modules: Modules;
let facades: ServiceFacades;

function chatListeners(): number {
    return CHAT_EVENTS.reduce((sum, key) => sum + listenerCount(env, key), 0);
}

function defsOf(result: unknown): ApiMechanicDef[] {
    expect(result).toMatchObject({ ok: true });
    return (result as { defs: ApiMechanicDef[] }).defs;
}

function bookIds(): string[] {
    return Object.values(env.world.entries(BOOK))
        .map((entry) => (entry.extensions as { maestro?: { mechanic?: { id?: string } } })?.maestro?.mechanic?.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
}

beforeEach(async () => {
    env = createDefsEnv();
    modules = new Modules(env.settings, env.log);
    (env.app as { modules: App['modules'] }).modules = modules;
    modules.expose('bookRoles', env.roles);
    modules.register([mechanicsModule], (module) => {
        if (module.i18n) env.app.i18n.register(module.i18n);
    });
    await modules.startAll(env.app);
    facades = createServiceFacades({ app: env.app, log: env.log, disposed: () => false, own: (off) => off });
    await settle();
});

afterEach(async () => {
    await modules.stopAll();
    document.body.replaceChildren();
});

describe('mechanics definitions in a service chat', () => {
    it('stay writable through the facade while everything chat-level of M25 is paused', async () => {
        expect(await facades.mechanics.save(mechanic({ id: 'magic' }), { scope: { kind: 'global' } })).toMatchObject({
            ok: true,
        });
        const story = modules.api<MechanicsApi>('mechanics')!;
        const storyListeners = chatListeners();
        const worldListeners = listenerCount(env, 'WORLDINFO_UPDATED');
        expect(storyListeners).toBeGreaterThan(0);
        expect(env.ephemeral.producers.size).toBeGreaterThan(0);

        await modules.suspend(WORKSHOP_KEEPS);
        await settle();
        // Chat-level: gone (no prompt, no reply or message handling, no tabs or styles, no full API).
        expect(modules.api('mechanics')).toBeUndefined();
        expect(chatListeners()).toBe(0);
        expect(env.ephemeral.producers.size).toBe(0);
        expect(env.ui.tabs.some((tab) => tab.id.startsWith('mechanics'))).toBe(false);
        expect(env.ui.styles.has('maestro-m25-defs')).toBe(false);
        // The definitions alone: one listener of book updates, the books read again.
        expect(listenerCount(env, 'WORLDINFO_UPDATED')).toBe(1);
        expect(modules.api<MechanicDefinitionsApi>('mechanicsDefinitions')).toBeDefined();
        expect(defsOf(facades.mechanics.list()).map((def) => def.id)).toEqual(['magic']);

        // Officina publishes a mechanic into its card from the co-author chat.
        const saved = await facades.mechanics.save(mechanic({ id: 'trust', name: 'Доверие' }), {
            scope: { kind: 'card', avatar: COAUTHOR },
        });
        expect(saved).toMatchObject({ ok: true, def: { id: 'trust', book: BOOK, scope: { avatar: COAUTHOR } } });
        expect(bookIds()).toEqual(['magic', 'trust']);
        expect(facades.mechanics.get('trust')).toMatchObject({ ok: true, def: { id: 'trust' } });
        expect(defsOf(facades.mechanics.list({ scope: 'card', avatar: COAUTHOR })).map((def) => def.id)).toEqual([
            'trust',
        ]);
        const record = env.journal.records.at(-1)!;
        expect(record).toMatchObject({ module: 'officina', kind: 'mechanics.def.create' });
        // A template with the module's own data: a fresh id next to what the books hold.
        const made = facades.mechanics.fromTemplate('health', { scope: { kind: 'card', avatar: COAUTHOR } });
        expect(made).toMatchObject({ ok: true, def: { template: 'health', scope: { avatar: COAUTHOR } } });
        expect(facades.mechanics.templates()).toMatchObject({ ok: true });
        // The per-chat switch is chat-level: off here.
        expect(await facades.mechanics.setEnabledInChat('trust', false)).toEqual({ ok: false, error: 'off' });

        // Undo in the service chat: the entry goes, the door sees it at once.
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(bookIds()).toEqual(['magic']);
        expect(defsOf(facades.mechanics.list()).map((def) => def.id)).toEqual(['magic']);
        expect(await facades.mechanics.save(mechanic({ id: 'trust' }), { scope: { kind: 'global' } })).toMatchObject({
            ok: true,
        });
        expect(await facades.mechanics.remove('magic')).toEqual({ ok: true });
        expect(bookIds()).toEqual(['trust']);
        const removal = env.journal.records.at(-1)!;
        expect(removal).toMatchObject({ module: 'officina', kind: 'mechanics.def.remove' });
        // Still nothing chat-level after the writes.
        expect(chatListeners()).toBe(0);
        expect(env.ephemeral.producers.size).toBe(0);

        // Back in a story chat: a fresh module that read what was written meanwhile, listeners as before.
        await modules.resume();
        await settle();
        const back = modules.api<MechanicsApi>('mechanics')!;
        expect(back).toBeDefined();
        expect(back).not.toBe(story);
        expect(back.all!().map((def) => def.id)).toEqual(['trust']);
        expect(modules.api('mechanicsDefinitions')).toBe(back);
        expect(chatListeners()).toBe(storyListeners);
        expect(listenerCount(env, 'WORLDINFO_UPDATED')).toBe(worldListeners);
        expect(env.ui.tabs.some((tab) => tab.id === 'mechanics')).toBe(true);
        // A write of the service chat is undone from the story chat by the module itself.
        expect(await env.journal.undo(removal.id)).toBe(true);
        await settle();
        expect(back.all!().map((def) => def.id)).toEqual(['magic', 'trust']);
        expect(await facades.mechanics.setEnabledInChat('trust', false)).toEqual({ ok: true });
    });

    it('a write in flight lands before the module reads the books again', async () => {
        await modules.suspend(WORKSHOP_KEEPS);
        await settle();
        const pending = facades.mechanics.save(mechanic({ id: 'luck' }), { scope: { kind: 'global' } });
        await modules.resume();
        expect(await pending).toMatchObject({ ok: true });
        await settle();
        expect(modules.api<MechanicsApi>('mechanics')!.all!().map((def) => def.id)).toEqual(['luck']);
    });

    it("answer 'off' when the user switched the module off, in a service chat and out of it", async () => {
        await modules.suspend(WORKSHOP_KEEPS);
        await modules.disable('mechanics');
        expect(modules.api('mechanicsDefinitions')).toBeUndefined();
        expect(listenerCount(env, 'WORLDINFO_UPDATED')).toBe(0);
        expect(facades.mechanics.list()).toEqual({ ok: false, error: 'off' });
        expect(await facades.mechanics.save(mechanic(), { scope: { kind: 'global' } })).toEqual({
            ok: false,
            error: 'off',
        });
        await modules.resume();
        expect(facades.mechanics.list()).toEqual({ ok: false, error: 'off' });
        // Switched off before the pause: nothing is kept either.
        await modules.suspend(WORKSHOP_KEEPS);
        expect(modules.api('mechanicsDefinitions')).toBeUndefined();
        expect(facades.mechanics.get('magic')).toEqual({ ok: false, error: 'off' });
        // Switched on in the service chat: the definitions only, until a story chat opens.
        await modules.enable('mechanics');
        await settle();
        expect(modules.api('mechanics')).toBeUndefined();
        expect(defsOf(facades.mechanics.list())).toEqual([]);
        expect(chatListeners()).toBe(0);
    });

    it('a service chat opened at page load keeps the definitions once the modules are up', async () => {
        await modules.stopAll();
        const boot = new Modules(env.settings, env.log);
        (env.app as { modules: App['modules'] }).modules = boot;
        boot.expose('bookRoles', env.roles);
        boot.register([mechanicsModule], () => {});
        await boot.suspend(WORKSHOP_KEEPS);
        await boot.startAll(env.app);
        await settle();
        modules = boot;
        expect(boot.api('mechanics')).toBeUndefined();
        expect(env.roles.listenerCount()).toBe(1);
        expect(await facades.mechanics.save(mechanic(), { scope: { kind: 'global' } })).toMatchObject({ ok: true });
        expect(bookIds()).toEqual(['magic']);
    });
});
