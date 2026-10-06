import { describe, expect, it } from 'vitest';
import { PROVIDER_ID, PROVIDER_PRIORITY } from '../../../src/features/lorePassports';
import type { LorePassportsApi } from '../../../src/features/lorePassports/api';
import { ANNA_PASSPORT, TOWER_PASSPORT, createEnv, entry, fakeNai, seedBooks, settle } from './helpers';
import type { Env } from './helpers';

async function withPassports(env: Env): Promise<void> {
    seedBooks(env);
    const service = env.service();
    await service.set('World', 0, ANNA_PASSPORT);
    await service.set('Places', 0, TOWER_PASSPORT);
}

function chatMessage(mes: string) {
    return { mes, is_user: false, is_system: false, name: 'Narrator', send_date: '' };
}

describe('lore passports: the scene (§16)', () => {
    it('takes the passports of the entries activated on the last turn (not cut), read lazily', async () => {
        const env = createEnv();
        await withPassports(env);
        const service = env.service();
        service.scene.invalidate(null);
        env.loreJournal.push(3, [
            { world: 'World', uid: 1 },
            { world: 'Places', uid: 0 },
            { world: 'World', uid: 0, cut: true },
        ]);
        env.loreJournal.push(5, [
            { world: 'Places', uid: 0 },
            { world: 'World', uid: 0 },
            { world: 'World', uid: 1 },
            { world: 'Places', uid: 1, cut: true },
        ]);
        // Books are read in the background: the first answer may be empty.
        expect(service.forScene()).toEqual([]);
        await settle();
        const scene = service.forScene();
        expect(scene.map((item) => `${item.world}#${item.uid}`)).toEqual(['Places#0', 'World#0']);
        expect(scene[1]).toMatchObject({ name: 'Anna', passport: { kind: 'character', name: 'Anna' } });
    });

    it('gives no passport of a namesake’s entry of another story, even when ST activated it (plan-2 §9)', async () => {
        const env = createEnv();
        await withPassports(env);
        env.world.foreign = ['World#0'];
        env.loreJournal.push(3, [
            { world: 'World', uid: 0 },
            { world: 'Places', uid: 0 },
        ]);
        const service = env.service();
        service.forScene();
        await settle();
        expect(service.forScene().map((item) => `${item.world}#${item.uid}`)).toEqual(['Places#0']);
    });

    it('adds the entries of entities mentioned in the last messages and drops duplicates', async () => {
        const env = createEnv();
        await withPassports(env);
        env.store.put('NPCs', [entry(4, { comment: 'Anna (copy)', content: 'Anna again.' })]);
        await env.service().set('NPCs', 4, { ...ANNA_PASSPORT, aliases: [] });
        env.world.add({
            name: 'Silver Tower',
            kind: 'place',
            sources: [{ kind: 'lore.entry', ref: 'Places#0', label: 'Silver Tower', world: 'Places', uid: 0 }],
        });
        env.world.add({
            name: 'Anna',
            forms: ['Анну'],
            sources: [
                { kind: 'lore.entry', ref: 'World#0', label: 'Anna', world: 'World', uid: 0 },
                { kind: 'lore.entry', ref: 'NPCs#4', label: 'Anna', world: 'NPCs', uid: 4 },
                { kind: 'card', ref: 'Anna.png', label: 'Anna' },
            ],
        });
        env.chat.push(chatMessage('Они пришли к Silver Tower.'), chatMessage('Там он увидел Анну.'));
        const service = env.service();
        service.forScene();
        await settle();
        const scene = service.forScene();
        expect(scene.map((item) => `${item.world}#${item.uid}`)).toEqual(['Places#0', 'World#0']);
        env.settings.maxPerScene = 1;
        expect(service.forScene()).toHaveLength(1);
    });

    it('lets a canon override with its own passport speak for its base entry', async () => {
        const env = createEnv();
        await withPassports(env);
        env.apis.set('canon', { bookName: () => 'Canon' });
        env.roles.roles.set('Canon', { ...env.roles.roles.get('Places')!, book: 'Canon', role: 'canon' });
        env.store.put('Canon', [
            entry(7, {
                comment: 'Override: Anna',
                content: 'Anna cut her hair.',
                extensions: {
                    maestro: {
                        kind: 'override',
                        status: 'active',
                        origin: 'user',
                        base: { world: 'World', uid: 0, contentHash: 'h' },
                    },
                },
            }),
        ]);
        await env.service().set('Canon', 7, { ...ANNA_PASSPORT, slots: { base: '1girl, elf', hair: 'short hair' } });
        env.loreJournal.push(1, [{ world: 'World', uid: 0 }]);
        const service = env.service();
        service.forScene();
        await settle();
        const scene = service.forScene();
        expect(scene).toHaveLength(1);
        expect(scene[0]).toMatchObject({ world: 'Canon', uid: 7 });
        expect((scene[0]!.passport.slots as Record<string, string>).hair).toBe('short hair');
    });

    it('reads a book again after WORLDINFO_UPDATED', async () => {
        const env = createEnv();
        await withPassports(env);
        env.loreJournal.push(1, [{ world: 'World', uid: 0 }]);
        const service = env.service();
        service.forScene();
        await settle();
        expect(service.forScene()).toHaveLength(1);
        env.roles.meta.delete('World\u00000');
        expect(service.forScene()).toHaveLength(1);
        await env.emitEvent('WORLDINFO_UPDATED', 'World');
        service.forScene();
        await settle();
        expect(service.forScene()).toHaveLength(0);
    });

    it('registers the passport provider with NAI Studio 0.12.0+, owned by the module', async () => {
        const env = createEnv({ nai: fakeNai() });
        seedBooks(env);
        env.loreJournal.push(4, [{ world: 'World', uid: 0 }]);
        const running = await env.start();
        await (env.apis.get('lorePassports') as LorePassportsApi).set('World', 0, ANNA_PASSPORT);
        expect(env.nai.registerPassportProvider).toHaveBeenCalledTimes(1);
        const provider = env.nai.providers[0]!;
        expect(provider).toMatchObject({ id: PROVIDER_ID, priority: PROVIDER_PRIORITY });
        expect(PROVIDER_ID).toBe('maestro-lore');
        expect(PROVIDER_PRIORITY).toBe(40);
        const passports = (await provider.passports({ messageIndex: 4, text: 'Silver Tower' })) as Record<
            string,
            unknown
        >[];
        expect(passports).toHaveLength(1);
        expect(passports[0]).toMatchObject({
            id: 'maestro:World#0',
            kind: 'character',
            name: 'Anna',
            aliases: ['Анна'],
            tags: '',
            outfits: [],
            states: [],
            negative: '',
        });
        const api = env.apis.get('lorePassports') as LorePassportsApi;
        expect(api.lastSent?.()).toMatchObject({
            messageIndex: 4,
            passports: [{ world: 'World', uid: 0, name: 'Anna', kind: 'character' }],
        });
        // Re-sync on a reply does not register twice.
        await env.app.bus.emit('reply:ready', { messageIndex: 4, type: 'normal' });
        expect(env.nai.registerPassportProvider).toHaveBeenCalledTimes(1);
        await running.stop();
        expect(env.nai.unregistered).toBe(1);
        expect(env.nai.providers).toHaveLength(0);
        expect(env.apis.has('lorePassports')).toBe(false);
        expect(env.tabs).toHaveLength(0);
    });

    it('feature-detects NAI Studio: nothing for old versions, waits for the API, follows a new API object', async () => {
        const old = createEnv({ nai: fakeNai({ provider: false }) });
        const stopOld = await old.start();
        expect(old.nai.registerPassportProvider).toBeUndefined();
        await stopOld.stop();

        const env = createEnv({ nai: fakeNai({ api: false }) });
        const running = await env.start();
        expect(env.nai.registerPassportProvider).not.toHaveBeenCalled();
        env.nai.apiObject = { version: 1 };
        await env.app.bus.emit('chat:changed', { chatId: 'chat1' });
        expect(env.nai.registerPassportProvider).toHaveBeenCalledTimes(1);
        // NAI Studio was reloaded: a new API object means a new registration.
        env.nai.apiObject = { version: 1, again: true };
        await env.app.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(env.nai.registerPassportProvider).toHaveBeenCalledTimes(2);
        expect(env.nai.unregistered).toBe(1);
        // Switched off in the settings: dropped on the next sync, and answers nothing meanwhile.
        env.settings.provider = false;
        expect(await env.nai.providers[0]!.passports({ messageIndex: 0, text: '' })).toEqual([]);
        await env.app.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(env.nai.providers).toHaveLength(0);
        await running.stop();
    });

    it('answers NAI Studio within its wait even when the lore journal and world model are off', async () => {
        const env = createEnv({ nai: fakeNai() });
        seedBooks(env);
        env.apis.delete('loreJournal');
        env.apis.delete('world');
        const running = await env.start();
        expect(await env.nai.providers[0]!.passports(undefined)).toEqual([]);
        await running.stop();
    });
});
