// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { LorePassportsService, defaultLorePassportsSettings } from '../../../src/features/lorePassports/service';
import { LORE_PASSPORTS_STRINGS } from '../../../src/features/lorePassports/strings';
import { rebaseOnEntry } from '../../../src/features/loreStudio/form/passport';
import type { WiEntry } from '../../../src/features/loreStudio/store-api';
import type { App } from '../../../src/shared/contracts';
import { memoryLogger } from '../../helpers/host-fakes';
import { FakeJournal, FakeTasks } from '../../helpers/rules-app';
import {
    FakeRoles,
    buttonByText,
    choose,
    createStand,
    entry,
    field,
    hasButton,
    mount,
    role,
    section,
    settle,
    type,
} from '../loreStudio/form/harness';
import type { Mounted, Stand } from '../loreStudio/form/harness';
import { fakeNai } from './helpers';
import type { FakeNai } from './helpers';

const TOWER = 'Place: Silver Tower\nDescription: A tall white tower.';

function passportOf(stand: Stand, book: string, uid: number): Record<string, unknown> | undefined {
    const extensions = stand.store.entry(book, uid)?.extensions as { maestro?: { passport?: Record<string, unknown> } };
    return extensions?.maestro?.passport;
}

async function press(root: ParentNode, label: string): Promise<void> {
    buttonByText(root, label).click();
    await settle(12);
}

describe('Lore Studio form: section «Паспорт» (M28)', () => {
    let stand: Stand;
    let roles: FakeRoles;
    let nai: FakeNai;
    let service: LorePassportsService;
    let mounted: Mounted | null;

    beforeEach(() => {
        stand = createStand();
        stand.app.i18n.register(LORE_PASSPORTS_STRINGS);
        roles = new FakeRoles();
        roles.roles.set('Places', role('Places', 'maestro'));
        roles.roles.set('World', role('World', 'world'));
        roles.roles.set('Bunny', role('Bunny', 'bunnymo.pack'));
        stand.apis.set('bookRoles', roles);
        stand.apis.set('loreStore', stand.store);
        stand.store.put('Places', [
            entry(0, {
                comment: 'Silver Tower',
                key: ['Silver Tower'],
                content: TOWER,
                extensions: { maestro: { type: 'place', typeFields: { name: 'Silver Tower' } } },
            }),
        ]);
        stand.store.put('World', [entry(1)]);
        stand.store.put('Bunny', [entry(0, { comment: 'Trait' })]);
        nai = fakeNai({ provider: false, generator: true });
        const app = stand.app as unknown as Record<string, unknown>;
        const log = memoryLogger();
        Object.assign(app, {
            journal: new FakeJournal(),
            tasks: new FakeTasks(),
            bus: createBus(log),
            leader: { isLeader: () => true },
            llm: { available: () => true, request: vi.fn() },
            cost: { backgroundCapReached: () => false },
            adapters: { ...(app.adapters as object), nai, des: { invalidateLoreCache: vi.fn() } },
        });
        Object.assign(app.host as object, { isGroupChat: () => false, events: { name: () => undefined } });
        service = new LorePassportsService(stand.app as App, log, defaultLorePassportsSettings);
        service.install();
        stand.apis.set('lorePassports', service);
        mounted = null;
    });

    afterEach(() => {
        mounted?.dispose();
        mounted = null;
        service.dispose();
    });

    it('is hidden while the module is off', async () => {
        stand.apis.delete('lorePassports');
        mounted = await mount(stand, 'Places', 0);
        expect(section(mounted.container, 'passport').hidden).toBe(true);
    });

    it('makes a passport by hand in a Maestro book, validates, fixes and saves it into the entry', async () => {
        mounted = await mount(stand, 'Places', 0);
        const node = section(mounted.container, 'passport');
        expect(node.hidden).toBe(false);
        expect(node.textContent).toContain('in the entry');
        expect(node.textContent).toContain('The entry has no passport yet.');
        await press(node, 'Make by hand');
        expect(field<HTMLSelectElement>(node, 'passportKind').value).toBe('location');
        expect(field(node, 'passportName').value).toBe('Silver Tower');
        type(field(node, 'passportTags'), 'Tower, white_walls, башня');
        expect(node.textContent).toContain('«Tower» must be in lower case');
        expect(node.textContent).toContain('NovelAI reads spaces');
        expect(node.textContent).toContain('«башня» is not an English tag');
        expect(buttonByText(node, 'Save passport').disabled).toBe(true);
        await press(node, 'Fix automatically');
        expect(field(node, 'passportTags').value).toBe('tower, white walls, башня');
        type(field(node, 'passportTags'), 'tower, white walls');
        expect(buttonByText(node, 'Save passport').disabled).toBe(false);
        await press(node, 'Save passport');
        expect(passportOf(stand, 'Places', 0)).toMatchObject({
            generatedBy: 'user',
            passport: { kind: 'location', name: 'Silver Tower', tags: 'tower, white walls' },
        });
        expect(node.textContent).toContain('Passport saved.');
        expect(node.textContent).toContain('Made: by hand');
        // The form follows its own write: nothing dirty, no «changed outside» warning.
        expect(mounted.form()!.isDirty()).toBe(false);
        expect(mounted.container.textContent).not.toContain('changed outside');
    });

    it('takes the kind of an untyped entry from the world model when made by hand', async () => {
        stand.apis.set('world', {
            entities: () => [
                {
                    id: 'e1',
                    name: 'Old Fort',
                    kind: 'place',
                    sources: [{ kind: 'lore.entry', world: 'World', uid: 1 }],
                },
            ],
        });
        mounted = await mount(stand, 'World', 1);
        const node = section(mounted.container, 'passport');
        await press(node, 'Make by hand');
        expect(field<HTMLSelectElement>(node, 'passportKind').value).toBe('location');
    });

    it('keeps the passport when the entry is saved later with a changed type', async () => {
        mounted = await mount(stand, 'Places', 0);
        const node = section(mounted.container, 'passport');
        // An unsaved type edit (it lives in extensions.maestro of this book).
        choose(field<HTMLSelectElement>(mounted.container, 'entryType'), 'item');
        await press(node, 'Make by hand');
        type(field(node, 'passportTags'), 'tower');
        await press(node, 'Save passport');
        expect(mounted.form()!.isDirty()).toBe(true);
        await mounted.form()!.save();
        const maestro = (stand.store.entry('Places', 0)!.extensions as { maestro: Record<string, unknown> }).maestro;
        expect(maestro.type).toBe('item');
        expect(maestro.passport).toMatchObject({ passport: { tags: 'tower' } });
    });

    it('shows a base book passport from the registry and flags anatomy outside the NSFW layer', async () => {
        await service.set('World', 1, {
            kind: 'character',
            name: 'Anna',
            aliases: ['Анна'],
            slots: { base: '1girl, elf', hair: 'silver hair' },
        });
        mounted = await mount(stand, 'World', 1);
        const node = section(mounted.container, 'passport');
        expect(node.textContent).toContain('Maestro registry');
        expect(node.textContent).toContain('the book file is not changed');
        expect(node.querySelector('summary')!.textContent).toContain('Character or creature');
        expect(field(node, 'passportAliases').value).toBe('Анна');
        expect(field(node, 'passportSlot-hair').value).toBe('silver hair');
        type(field(node, 'passportSlot-body'), 'slim, nipples');
        expect(node.textContent).toContain('«nipples» is explicit anatomy');
        expect(buttonByText(node, 'Save passport').disabled).toBe(true);
        await press(node, 'Fix automatically');
        expect(field(node, 'passportSlot-body').value).toBe('slim');
        expect(field(node, 'passportNsfw').value).toBe('nipples');
        await press(node, 'Save passport');
        const meta = roles.meta.get('World\u00001')!;
        expect(meta.passport).toMatchObject({ passport: { nsfw: { enabled: false, tags: 'nipples' } } });
        expect(stand.store.updates).toEqual([]);
    });

    it('keeps a registry passport bound when the entry text is edited in the form', async () => {
        await service.set('World', 1, { kind: 'object', name: 'Ring', tags: 'ring, gold' });
        mounted = await mount(stand, 'World', 1);
        type(field<HTMLTextAreaElement>(mounted.container, 'content'), 'A golden ring.');
        await mounted.form()!.save();
        expect(roles.setEntryMeta).toHaveBeenLastCalledWith(
            'World',
            1,
            expect.objectContaining({ passport: expect.objectContaining({ passport: expect.any(Object) }) }),
        );
        await settle(12);
        // Made for the older text: the section says so.
        expect(section(mounted.container, 'passport').textContent).toContain('The entry text changed');
    });

    it('generates through NAI Studio and asks before replacing a passport made by hand', async () => {
        mounted = await mount(stand, 'World', 1);
        const node = section(mounted.container, 'passport');
        await press(node, 'Generate');
        expect(nai.generatePassport).toHaveBeenCalledTimes(1);
        expect(node.textContent).toContain('Passport generated (NAI Studio) and saved.');
        expect(roles.meta.get('World\u00001')!.passport).toMatchObject({ generatedBy: 'nai' });
        // Edited by hand, then generated again: the user is asked.
        type(field(node, 'passportTags'), 'elf, blue eyes');
        await press(node, 'Save passport');
        stand.confirm.mockResolvedValueOnce(false);
        await press(node, 'Generate');
        expect(stand.confirm).toHaveBeenLastCalledWith('Replace the passport?', expect.any(String));
        expect(node.textContent).toContain('The passport stays as it was.');
        expect(roles.meta.get('World\u00001')!.passport).toMatchObject({ generatedBy: 'user' });
    });

    it('shows generation errors and removes a passport after a confirmation', async () => {
        nai.generatePassport!.mockRejectedValue(new Error('no key'));
        stand.chatId = null;
        await service.set('World', 1, { kind: 'object', name: 'Ring', tags: 'ring' });
        mounted = await mount(stand, 'World', 1);
        const node = section(mounted.container, 'passport');
        await press(node, 'Generate');
        expect(node.textContent).toContain('NAI Studio could not write the passport');
        stand.confirm.mockResolvedValueOnce(false);
        await press(node, 'Remove');
        expect(roles.meta.get('World\u00001')).toBeDefined();
        await press(node, 'Remove');
        expect(roles.meta.get('World\u00001')).toBeUndefined();
        expect(node.textContent).toContain('Passport removed.');
        expect(node.textContent).toContain('The entry has no passport yet.');
    });

    it('drops unsaved passport edits only when asked, and reverts them', async () => {
        await service.set('World', 1, { kind: 'object', name: 'Ring', tags: 'ring' });
        mounted = await mount(stand, 'World', 1);
        const node = section(mounted.container, 'passport');
        type(field(node, 'passportTags'), 'ring, gold');
        expect(node.textContent).toContain('passport edits not saved');
        stand.confirm.mockResolvedValueOnce(false);
        await press(node, 'Generate');
        expect(nai.generatePassport).not.toHaveBeenCalled();
        await press(node, 'Undo passport edits');
        expect(field(node, 'passportTags').value).toBe('ring');
        choose(field<HTMLSelectElement>(node, 'passportKind'), 'character');
        expect(hasButton(node, 'Save passport')).toBe(true);
        expect(node.querySelector('[name="passportSlot-base"]')).not.toBeNull();
    });

    it('is read-only for BunnyMo entries (P13)', async () => {
        mounted = await mount(stand, 'Bunny', 0);
        const node = section(mounted.container, 'passport');
        expect(node.textContent).toContain('BunnyMo pack entries never get passports');
        expect(hasButton(node, 'Generate')).toBe(false);
        expect(hasButton(node, 'Make by hand')).toBe(false);
    });

    it('says a base book needs the registry when the roles module is off', async () => {
        stand.apis.delete('bookRoles');
        mounted = await mount(stand, 'World', 1);
        expect(section(mounted.container, 'passport').textContent).toContain('turn on the «Book roles» module');
    });
});

describe('rebaseOnEntry', () => {
    it('moves the stored copy to the fresh entry and keeps unsaved edits and the fresh passport', () => {
        const stored = entry(1, { content: 'old', extensions: { maestro: { type: 'place' } } }) as WiEntry;
        const draft = { ...structuredClone(stored), content: 'edited', extensions: { maestro: { type: 'item' } } };
        const fresh = {
            ...structuredClone(stored),
            normalized: true,
            extensions: { maestro: { type: 'place', passport: { passport: { kind: 'object', tags: 'x' } } } },
        } as WiEntry;
        const state = { stored, draft: draft as WiEntry };
        rebaseOnEntry(state, fresh);
        expect(state.stored).toBe(stored);
        expect(state.stored).toEqual(fresh);
        expect(state.draft.content).toBe('edited');
        expect(state.draft.normalized).toBe(true);
        expect(state.draft.extensions).toEqual({
            maestro: { type: 'item', passport: { passport: expect.objectContaining({ tags: 'x' }), updatedAt: 0 } },
        });
    });
});
