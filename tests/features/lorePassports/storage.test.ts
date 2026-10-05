import { describe, expect, it } from 'vitest';
import { PASSPORT_TARGET } from '../../../src/features/lorePassports/service';
import { LORE_PASSPORTS_STRINGS } from '../../../src/features/lorePassports/strings';
import { ANNA_PASSPORT, TOWER_PASSPORT, createEnv, seedBooks } from './helpers';

describe('lore passports: storage by book role (P2, P13)', () => {
    it('keeps the passport of a Maestro book inside the entry, through the LoreStore', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        await service.set('Places', 0, TOWER_PASSPORT);
        const stored = env.store.entry('Places', 0)!;
        const maestro = (stored.extensions as { maestro: Record<string, unknown> }).maestro;
        // The typed meta stays next to the passport.
        expect(maestro.type).toBe('place');
        expect(maestro.passport).toMatchObject({
            generatedBy: 'user',
            passport: { kind: 'location', name: 'Silver Tower', tags: 'tower, white walls, silver spires' },
        });
        expect(env.store.updates).toHaveLength(1);
        expect(env.store.updates[0]!.reason.module).toBe('M28');
        // The store journals its own writes: no second record.
        expect(env.journal.records).toHaveLength(0);
        const got = await service.get('Places', 0);
        expect(got).toMatchObject({ storage: 'entry', generatedBy: 'user', passport: { kind: 'location' } });
        expect(typeof got!.contentHash).toBe('string');
        expect(env.roles.setEntryMeta).not.toHaveBeenCalled();
    });

    it('keeps the passport of a base book in the sidecar, merged with the record already there', async () => {
        const env = createEnv();
        seedBooks(env);
        env.roles.meta.set('World\u00000', { type: 'character', typeFields: { name: 'Anna' } });
        const service = env.service();
        await service.set('World', 0, ANNA_PASSPORT, 'model');
        // The book file is not touched.
        expect(env.store.updates).toHaveLength(0);
        const meta = env.roles.meta.get('World\u00000')!;
        expect(meta.type).toBe('character');
        expect(meta.typeFields).toEqual({ name: 'Anna' });
        expect(meta.passport).toMatchObject({ generatedBy: 'model', passport: { name: 'Anna', aliases: ['Анна'] } });
        const got = await service.get('World', 0);
        expect(got).toMatchObject({ storage: 'sidecar', generatedBy: 'model' });
        expect((got!.passport.slots as Record<string, string>).hair).toBe('silver hair');
        expect(env.journal.records).toHaveLength(1);
        expect(env.journal.records[0]!.changes[0]).toMatchObject({
            target: PASSPORT_TARGET,
            ref: { world: 'World', uid: 0, storage: 'sidecar' },
            before: null,
        });
        await service.remove('World', 0);
        expect(env.roles.meta.get('World\u00000')).toEqual({ type: 'character', typeFields: { name: 'Anna' } });
        expect(await service.get('World', 0)).toBeNull();
    });

    it('drops the sidecar record when the passport was its only key', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        await service.set('World', 1, { kind: 'object', name: 'Sword', tags: 'sword, rust' });
        expect(env.roles.meta.has('World\u00001')).toBe(true);
        await service.remove('World', 1);
        expect(env.roles.meta.has('World\u00001')).toBe(false);
        expect(env.roles.setEntryMeta).toHaveBeenLastCalledWith('World', 1, undefined);
    });

    it('refuses BunnyMo books, also when only the adapter knows them', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        await expect(service.set('Bunny', 0, ANNA_PASSPORT)).rejects.toThrow(/BunnyMo/);
        expect(await service.get('Bunny', 0)).toBeNull();
        expect(await service.storageOf('Bunny')).toBe('bunnymo');
        env.roles.roles.delete('Bunny');
        env.bunnymo.packs.push('Bunny');
        await expect(service.set('Bunny', 0, ANNA_PASSPORT)).rejects.toThrow(/P13/);
        expect(env.roles.setEntryMeta).not.toHaveBeenCalled();
        expect(env.store.updates).toHaveLength(0);
    });

    it('needs the registry for base books and reports missing entries', async () => {
        const env = createEnv({ roles: false });
        seedBooks(env);
        const service = env.service();
        expect(await service.storageOf('World')).toBe('noRegistry');
        await expect(service.set('World', 0, ANNA_PASSPORT)).rejects.toThrow(/Book roles/);
        await expect(service.set('World', 9, ANNA_PASSPORT)).rejects.toThrow(/#9/);
        const withRoles = createEnv();
        seedBooks(withRoles);
        await expect(withRoles.service().set('Places', 0, 'junk' as never)).rejects.toThrow(/not a passport/);
    });

    it('writes canon entries in place: an entry with canon meta is a canon entry without any role', async () => {
        const env = createEnv();
        env.store.put('Some canon', [
            {
                uid: 3,
                key: ['Anna'],
                keysecondary: [],
                comment: 'Override: Anna',
                content: 'Anna has short hair now.',
                extensions: { maestro: { kind: 'override', status: 'active', origin: 'user' } },
            },
        ]);
        await env.service().set('Some canon', 3, ANNA_PASSPORT);
        const maestro = (env.store.entry('Some canon', 3)!.extensions as { maestro: Record<string, unknown> }).maestro;
        expect(maestro.kind).toBe('override');
        expect(maestro.passport).toBeDefined();
    });

    it('without the Lore Studio writes the book itself, reloads ST and DES, and journals with undo', async () => {
        const env = createEnv({ store: false });
        seedBooks(env);
        const service = env.service();
        await service.set('Places', 0, TOWER_PASSPORT);
        expect(env.saves).toEqual(['Places']);
        expect(env.des.invalidateLoreCache).toHaveBeenCalledWith('Places');
        const saved = env.books.get('Places')!.entries['0']!;
        expect((saved.extensions as { maestro: Record<string, unknown> }).maestro.passport).toBeDefined();
        expect(env.journal.records).toHaveLength(1);
        await service.set('Places', 0, { ...TOWER_PASSPORT, tags: 'tower, ruins' });
        expect(env.journal.records).toHaveLength(2);
        // Undo the second write: the first passport comes back.
        expect(await env.journal.undo(env.journal.records[1]!.id)).toBe(true);
        expect((await service.get('Places', 0))!.passport.tags).toBe('tower, white walls, silver spires');
        // The first record no longer matches what is stored after another change: undo refuses.
        await service.set('Places', 0, { ...TOWER_PASSPORT, tags: 'tower, night' });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(false);
        // Removing it and undoing the removal.
        await service.remove('Places', 0);
        expect(await service.get('Places', 0)).toBeNull();
        expect(await env.journal.undo(env.journal.records[env.journal.records.length - 1]!.id)).toBe(true);
        expect((await service.get('Places', 0))!.passport.tags).toBe('tower, night');
    });

    it('undoes a sidecar write and ignores broken journal refs', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        await service.set('World', 0, ANNA_PASSPORT);
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(await service.get('World', 0)).toBeNull();
        const undo = env.journal.handlers.get(PASSPORT_TARGET)!;
        expect(await undo({ target: PASSPORT_TARGET, ref: {}, before: null, after: null })).toBe(false);
        expect(await undo({ target: PASSPORT_TARGET, ref: { world: 'Gone', uid: 1 }, before: null, after: null })).toBe(
            false,
        );
    });

    it('notifies listeners on every change', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        let calls = 0;
        const off = service.onChange(() => calls++);
        await service.set('World', 0, ANNA_PASSPORT);
        await service.remove('World', 0);
        await service.remove('World', 0);
        off();
        await service.set('World', 0, ANNA_PASSPORT);
        expect(calls).toBe(2);
    });
});

describe('lore passports: strings', () => {
    it('have the same non-empty m28 keys in English and Russian', () => {
        expect(Object.keys(LORE_PASSPORTS_STRINGS.ru).sort()).toEqual(Object.keys(LORE_PASSPORTS_STRINGS.en).sort());
        for (const [key, text] of Object.entries(LORE_PASSPORTS_STRINGS.ru)) {
            expect(key.startsWith('m28.'), key).toBe(true);
            expect(text, key).not.toBe('');
        }
    });
});
