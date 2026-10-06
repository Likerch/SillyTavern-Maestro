// lore_entry_create, lore_entry_update and passport_set (M33 part C over M23/M28/M35): writes through the Lore
// Studio's store and the passports module; BunnyMo books are refused (P13) by role, by the adapter and by content;
// typed entries keep their type in the entry (Maestro books) or in the book roles registry (base books).
import { describe, expect, it } from 'vitest';
import { fakeLore, fakePassports, fakeRoles, planError, wiEntry, writeFake } from './tools-write-fakes';
import type { FakeLore } from './tools-write-fakes';

function setup(
    options: {
        locale?: 'en' | 'ru';
        roles?: ReturnType<typeof fakeRoles> | null;
        lore?: FakeLore;
        passports?: ReturnType<typeof fakePassports>;
        bunnyBooks?: { core: string[]; packs: string[] };
    } = {},
) {
    const lore =
        options.lore ??
        fakeLore({
            World: { '0': wiEntry(0, { comment: 'Anna', key: ['Anna'], content: 'Anna is a healer.' }) },
            'Maestro Notes': {},
            'Bunny Pack': {},
        });
    const roles =
        options.roles === null
            ? undefined
            : (options.roles ??
              fakeRoles({
                  'Maestro Notes': { role: 'maestro' },
                  'Bunny Pack': { role: 'bunnymo.pack', readOnly: true },
              }));
    const apis: Record<string, unknown> = { loreStore: lore.store };
    if (roles) apis.bookRoles = roles;
    if (options.passports) apis.lorePassports = options.passports;
    const fake = writeFake({
        apis,
        locale: options.locale ?? 'en',
        adapters: { bunnymo: { books: () => ({ core: [], packs: [], archives: [], ...(options.bunnyBooks ?? {}) }) } },
    });
    return { fake, lore, roles };
}

describe('lore_entry_create', () => {
    it('creates an entry through the Lore Studio store with plain fields', async () => {
        const { fake, lore } = setup({ locale: 'ru' });
        const plan = await fake.plan(
            'lore_entry_create',
            { book: 'world', title: 'Kai', keys: ['Kai', 'Кай', 'kai'], content: 'Kai is a smith.', depth: 2 },
            'ru',
        );
        expect(plan.summary).toBe('Новая запись «Kai» в «World»');
        expect(plan.target).toBe('Книга «World» · новая запись');
        expect(plan.before).toBeNull();
        expect(plan.after).toEqual({
            title: 'Kai',
            keys: ['Kai', 'Кай'],
            position: 'at_depth',
            depth: 2,
            content: 'Kai is a smith.',
        });
        expect(lore.created).toEqual([]);
        const { result } = await plan.apply();
        expect(result).toEqual({ book: 'World', uid: 1 });
        expect(lore.created).toEqual([
            {
                book: 'World',
                partial: { comment: 'Kai', content: 'Kai is a smith.', key: ['Kai', 'Кай'], position: 4, depth: 2 },
                reason: { module: 'M33', summary: 'Добавил в лор запись «Kai»' },
            },
        ]);
    });

    it('composes a typed entry and keeps the type in the entry of a Maestro book', async () => {
        const { fake, lore, roles } = setup();
        const plan = await fake.plan('lore_entry_create', {
            book: 'Maestro Notes',
            type: 'character',
            fields: { name: 'Mira', role: 'Captain', personality: 'Calm.\nStern.' },
            keys: 'Mira, captain',
        });
        expect(plan.summary).toBe('New entry «Mira» in «Maestro Notes»');
        const after = plan.after as Record<string, unknown>;
        expect(after.content).toBe('Character: Mira\nRole: Captain\nPersonality:\nCalm.\nStern.');
        expect(after.type).toBe('character');
        await plan.apply();
        expect(lore.created[0]!.partial.extensions).toEqual({
            maestro: { type: 'character', typeFields: { name: 'Mira', role: 'Captain', personality: 'Calm.\nStern.' } },
        });
        expect(roles!.metaWrites).toEqual([]);
    });

    it('keeps the type of a base book entry in the book roles registry', async () => {
        const { fake, lore, roles } = setup();
        await (
            await fake.plan('lore_entry_create', {
                book: 'World',
                type: 'place',
                fields: { name: 'Harbor' },
                constant: true,
            })
        ).apply();
        expect(lore.created[0]!.partial.extensions).toBeUndefined();
        expect(lore.created[0]!.partial.constant).toBe(true);
        expect(roles!.metaWrites).toEqual([
            { book: 'World', uid: 1, meta: { type: 'place', typeFields: { name: 'Harbor' } } },
        ]);
    });

    it('says when the type cannot be kept (no book roles module)', async () => {
        const { fake } = setup({ roles: null });
        const plan = await fake.plan('lore_entry_create', {
            book: 'World',
            type: 'item',
            fields: { name: 'Lamp' },
            keys: ['lamp'],
        });
        expect((plan.after as Record<string, unknown>).notes).toEqual([
            'The Book roles module is off: the type is not kept, only the text.',
        ]);
    });

    it('refuses BunnyMo books by role, by the adapter and by content (P13)', async () => {
        const { fake, lore } = setup({ locale: 'ru' });
        expect(
            await planError(fake.plan('lore_entry_create', { book: 'Bunny Pack', content: 'x', keys: ['x'] }, 'ru')),
        ).toBe('«Bunny Pack» — книга BunnyMo: её файлы не меняются никогда (P13).');

        const adapter = setup({ roles: null, bunnyBooks: { core: ['World'], packs: [] } });
        expect(
            await planError(adapter.fake.plan('lore_entry_create', { book: 'World', content: 'x', keys: ['x'] })),
        ).toBe('«World» is a BunnyMo book: its files are never changed (P13).');

        // A book that is a pack by its content alone: three tag-keyed entries (domain/bunnymo.ts classifyWorlds).
        const pack = fakeLore({
            Species: Object.fromEntries(
                [0, 1, 2].map((i) => [String(i), wiEntry(i, { key: [`<SPECIES:KIND${i}>`], content: `trait ${i}` })]),
            ),
        });
        const content = setup({ roles: null, lore: pack });
        expect(
            await planError(content.fake.plan('lore_entry_create', { book: 'Species', content: 'x', keys: ['x'] })),
        ).toBe('«Species» is a BunnyMo book: its files are never changed (P13).');
        expect(
            await planError(
                content.fake.plan('lore_entry_update', { book: 'Species', uid: 0, changes: { content: 'x' } }),
            ),
        ).toMatch(/P13/);
        expect(content.lore.created).toEqual([]);
        expect(content.lore.updated).toEqual([]);
        expect(lore.created).toEqual([]);
    });

    it('refuses unknown and read-only books, missing text, missing keys and bad types', async () => {
        const roles = fakeRoles({ World: { role: 'world', readOnly: true } });
        const readOnly = setup({ roles });
        expect(
            await planError(readOnly.fake.plan('lore_entry_create', { book: 'World', content: 'x', keys: ['x'] })),
        ).toBe('«World» is read-only.');
        const { fake } = setup();
        expect(await planError(fake.plan('lore_entry_create', { book: 'Atlas', content: 'x', keys: ['x'] }))).toBe(
            'There is no book «Atlas».',
        );
        expect(await planError(fake.plan('lore_entry_create', { book: 'World', keys: ['x'] }))).toBe(
            'The entry has no text: give «content» or the fields of its type.',
        );
        expect(await planError(fake.plan('lore_entry_create', { book: 'World', content: 'x' }))).toBe(
            'The entry needs keys (or constant: true).',
        );
        expect(
            await planError(fake.plan('lore_entry_create', { book: 'World', type: 'monster', content: 'x' })),
        ).toMatch(/^Unknown entry type «monster»\. Types: character, place/);
        expect(
            await planError(fake.plan('lore_entry_create', { book: 'World', type: 'item', fields: { colour: 'red' } })),
        ).toMatch(/^The type «item» has no field «colour»\. Fields: name, /);
        expect(await planError(fake.plan('lore_entry_create', { book: 'World', fields: { name: 'x' } }))).toBe(
            'The entry has no type: give «type» together with the fields.',
        );
        expect(
            await planError(
                fake.plan('lore_entry_create', { book: 'World', content: 'x', keys: ['x'], position: 'top' }),
            ),
        ).toMatch(/«position» must be one of: before_char, after_char/);
    });
});

describe('lore_entry_update', () => {
    it('changes only the fields that differ and shows them before/after', async () => {
        const { fake, lore } = setup({ locale: 'ru' });
        const plan = await fake.plan(
            'lore_entry_update',
            { book: 'World', uid: 0, changes: { content: 'Anna is a surgeon.', keys: ['Anna'], enabled: false } },
            'ru',
        );
        expect(plan.summary).toBe('Запись «Anna» в «World»: enabled, content');
        expect(plan.target).toBe('Книга «World» · запись 0');
        expect(plan.before).toEqual({ enabled: true, content: 'Anna is a healer.' });
        expect(plan.after).toEqual({ enabled: false, content: 'Anna is a surgeon.' });
        await plan.apply();
        expect(lore.updated).toEqual([
            {
                book: 'World',
                uid: 0,
                patch: { content: 'Anna is a surgeon.', disable: true },
                reason: { module: 'M33', summary: 'Поправил запись лора «Anna»' },
            },
        ]);
    });

    it('recomposes a typed entry from merged fields and re-binds its registry record', async () => {
        const { fake, lore, roles } = setup();
        roles!.meta.set('World#0', {
            type: 'character',
            typeFields: { name: 'Anna', role: 'Healer' },
            passport: { x: 1 },
        });
        const plan = await fake.plan('lore_entry_update', {
            book: 'World',
            uid: 0,
            changes: { fields: { role: 'Surgeon' } },
        });
        const after = plan.after as Record<string, unknown>;
        expect(after.content).toBe('Character: Anna\nRole: Surgeon');
        expect(after.type).toBe('character');
        expect(after.fields).toEqual({ name: 'Anna', role: 'Surgeon' });
        await plan.apply();
        expect(lore.updated[0]!.patch).toEqual({ content: 'Character: Anna\nRole: Surgeon' });
        expect(roles!.metaWrites).toEqual([
            {
                book: 'World',
                uid: 0,
                meta: { type: 'character', typeFields: { name: 'Anna', role: 'Surgeon' }, passport: { x: 1 } },
            },
        ]);
    });

    it('re-binds a registry record when only the text of a base entry with a passport changes', async () => {
        const { fake, roles } = setup();
        roles!.meta.set('World#0', { passport: { kind: 'character' } });
        await (await fake.plan('lore_entry_update', { book: 'World', uid: 0, changes: { content: 'New.' } })).apply();
        expect(roles!.metaWrites).toEqual([{ book: 'World', uid: 0, meta: { passport: { kind: 'character' } } }]);
    });

    it('refuses missing entries, no-op changes and BunnyMo books', async () => {
        const { fake } = setup();
        expect(
            await planError(fake.plan('lore_entry_update', { book: 'World', uid: 9, changes: { content: 'x' } })),
        ).toBe('There is no entry 9 in «World».');
        expect(
            await planError(fake.plan('lore_entry_update', { book: 'World', uid: 0, changes: { keys: ['Anna'] } })),
        ).toBe('Nothing changes.');
        expect(
            await planError(fake.plan('lore_entry_update', { book: 'Bunny Pack', uid: 0, changes: { content: 'x' } })),
        ).toBe('«Bunny Pack» is a BunnyMo book: its files are never changed (P13).');
        expect(
            await planError(fake.plan('lore_entry_update', { book: 'World', uid: 0, changes: { content: '  ' } })),
        ).toBe('The entry has no text: give «content» or the fields of its type.');
        expect(
            await planError(fake.plan('lore_entry_update', { book: 'World', uid: 0, changes: { fields: { a: 'b' } } })),
        ).toBe('The entry has no type: give «type» together with the fields.');
    });

    it('is offered only with the Lore Studio', () => {
        const fake = writeFake();
        expect(fake.tools.find((item) => item.name === 'lore_entry_update')!.available?.(fake.app)).toBe(false);
    });
});

describe('passport_set', () => {
    it('tidies the tags, shows before/after and saves through the passports module', async () => {
        const passports = fakePassports('sidecar');
        passports.stored.set('World#0', {
            passport: { kind: 'character', name: 'Anna' },
            storage: 'sidecar',
            updatedAt: 1,
        });
        const { fake } = setup({ passports, locale: 'ru' });
        const plan = await fake.plan(
            'passport_set',
            {
                book: 'World',
                uid: 0,
                passport: { kind: 'character', name: 'Anna', slots: { hair: 'Long_Hair, RED hair' } },
            },
            'ru',
        );
        expect(plan.summary).toBe('Паспорт записи «Anna» в «World»');
        expect(plan.target).toBe('Книга «World» · запись 0 · паспорт');
        expect(plan.before).toEqual({ kind: 'character', name: 'Anna' });
        const after = plan.after as Record<string, unknown>;
        expect((after.slots as Record<string, string>).hair).toBe('long hair, red hair');
        expect(after.notes).toEqual([
            'Теги приведены в порядок: строчные, без подчёркиваний, откровенная анатомия — в NSFW.',
        ]);
        await plan.apply();
        expect(passports.sets).toHaveLength(1);
        expect(passports.sets[0]).toMatchObject({ world: 'World', uid: 0, by: 'model' });
        expect((passports.sets[0]!.passport.slots as Record<string, string>).hair).toBe('long hair, red hair');
    });

    it('refuses non-English tags, BunnyMo books, books without a registry and junk', async () => {
        const { fake } = setup({ passports: fakePassports('sidecar') });
        expect(
            await planError(
                fake.plan('passport_set', { book: 'World', uid: 0, passport: { kind: 'character', tags: 'рыжая' } }),
            ),
        ).toBe('The passport cannot be saved: tags: «рыжая» is not an English tag');
        expect(
            await planError(fake.plan('passport_set', { book: 'Bunny Pack', uid: 0, passport: { tags: 'x' } })),
        ).toBe('«Bunny Pack» is a BunnyMo book: its files are never changed (P13).');
        expect(await planError(fake.plan('passport_set', { book: 'World', uid: 4, passport: { tags: 'x' } }))).toBe(
            'There is no entry 4 in «World».',
        );
        const noRegistry = setup({ passports: fakePassports('noRegistry') });
        expect(
            await planError(noRegistry.fake.plan('passport_set', { book: 'World', uid: 0, passport: { tags: 'x' } })),
        ).toBe('Passports of base books live in the Maestro registry: switch on the Book roles module.');
        const bunny = setup({ passports: fakePassports('bunnymo') });
        expect(
            await planError(bunny.fake.plan('passport_set', { book: 'World', uid: 0, passport: { tags: 'x' } })),
        ).toMatch(/BunnyMo/);
    });

    it('notes an empty passport', async () => {
        const { fake } = setup({ passports: fakePassports('entry') });
        const plan = await fake.plan('passport_set', { book: 'World', uid: 0, passport: { kind: 'character' } });
        expect((plan.after as Record<string, unknown>).notes).toEqual([
            'The passport is empty: there is nothing to draw.',
        ]);
    });

    it('is offered only with the passports module', () => {
        const fake = writeFake();
        expect(fake.tools.find((item) => item.name === 'passport_set')!.available?.(fake.app)).toBe(false);
        const { fake: withPassports } = setup({ passports: fakePassports() });
        expect(withPassports.tools.find((item) => item.name === 'passport_set')!.available?.(withPassports.app)).toBe(
            true,
        );
    });
});
