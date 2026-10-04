// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';

type Entry = Record<string, unknown>;

function book(...entries: Entry[]): { entries: Record<string, Entry> } {
    return { entries: Object.fromEntries(entries.map((entry, uid) => [String(uid), { uid, ...entry }])) };
}

const CORE = book(
    { key: ['!fullsheet'], comment: 'Full sheet', content: '<BunnymoTags><Name:NAME>, <GENRE:BLANK></BunnymoTags>' },
    { key: ['!quicksheet'], comment: 'Quick sheet' },
    { key: [], comment: '🔮 AUTO-TRIGGER: Jealousy Detection System' },
);
const PACK = book({ key: ['<SPECIES:ELF>'] }, { key: ['<SPECIES:ORC>'] }, { key: ['<DEPRESSION>'] });
const ARCHIVE = book(
    { key: ['Аня'], content: '<BunnymoTags><Name:Аня>, <SPECIES:HUMAN></BunnymoTags>' },
    { key: ['Боря'], content: '<BunnymoTags><Name:Боря></BunnymoTags>', disable: true },
);
const DISABLED_ARCHIVE = book({ key: ['Вера'], content: '<BunnymoTags><Name:Вера></BunnymoTags>', disable: true });
const LORE = book({ key: ['таверна'], content: 'A tavern.' });

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
    for (const [name, data] of Object.entries({
        BunnyMo: CORE,
        Species: PACK,
        Архив: ARCHIVE,
        Off: DISABLED_ARCHIVE,
        Лор: LORE,
    })) {
        stand.books.set(name, data);
    }
});

describe('BunnyMoAdapter', () => {
    it('classifies only the active books', async () => {
        stand.worldInfo.selected_world_info = ['BunnyMo', 'Species', 'Deleted book'];
        await adapters.bunnymo.ready();
        expect(adapters.bunnymo.present()).toBe(true);
        expect(adapters.bunnymo.books()).toEqual({ core: ['BunnyMo'], packs: ['Species'], archives: [] });
        expect(adapters.bunnymo.version()).toBeUndefined();
        await stand.caps.refresh();
        expect(stand.caps.has('bunnymo.core')).toBe(true);
        expect(stand.caps.has('bunnymo.packs')).toBe(true);
        expect(stand.caps.has('bunnymo.archives')).toBe(false);
    });

    it('collects chat, persona, character and extra character books', async () => {
        const ctx = stand.mock.context;
        stand.mock.chatMetadata.world_info = 'Лор';
        (ctx.powerUserSettings as Record<string, unknown>).persona_description_lorebook = 'Species';
        ctx.characters.push({ name: 'Аня', avatar: 'anya.png', data: { extensions: { world: 'Архив' } } });
        ctx.characterId = 0;
        stand.worldInfo.world_info.charLore = [
            { name: 'anya', extraBooks: ['BunnyMo', 'Off'] },
            { name: 'other', extraBooks: ['X'] },
        ];
        expect((await adapters.bunnymo.activeBooks()).sort()).toEqual(['BunnyMo', 'Off', 'Species', 'Архив', 'Лор']);
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.books()).toEqual({ core: ['BunnyMo'], packs: ['Species'], archives: ['Архив'] });
    });

    it('collects the books of every group member', async () => {
        const ctx = stand.mock.context;
        ctx.characters.push(
            { name: 'A', avatar: 'a.png', data: { extensions: { world: 'Архив' } } },
            { name: 'B', avatar: 'b.png', data: { extensions: { world: 'Species' } } },
        );
        ctx.groups.push({ id: 'g1', name: 'Group', members: ['a.png', 'b.png', 'gone.png'] });
        ctx.groupId = 'g1';
        expect((await adapters.bunnymo.activeBooks()).sort()).toEqual(['Species', 'Архив']);
    });

    it('caches books until ST reports them saved, and follows chat changes', async () => {
        stand.worldInfo.selected_world_info = ['Лор'];
        await adapters.bunnymo.ready();
        expect(adapters.bunnymo.present()).toBe(false);
        // The cached result survives a change ST did not report.
        stand.books.set('Лор', CORE);
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.books().core).toEqual([]);
        await stand.mock.eventSource.emit('worldinfo_updated', 'Лор', CORE);
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.books().core).toEqual(['Лор']);
        // A chat change re-reads which books are active.
        stand.worldInfo.selected_world_info = ['Species'];
        await stand.mock.eventSource.emit('chat_id_changed');
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.books()).toEqual({ core: [], packs: ['Species'], archives: [] });
        adapters.bunnymo.dispose();
        expect(stand.mock.eventSource.events.get('worldinfo_updated')).toEqual([]);
    });

    it('degrades without world-info.js, loadWorldInfo or the book list', async () => {
        stand.host.modules.worldInfo = async () => {
            throw new Error('missing');
        };
        stand.mock.chatMetadata.world_info = 'BunnyMo';
        stand.setCtx('getWorldInfoNames', undefined);
        expect(await adapters.bunnymo.activeBooks()).toEqual(['BunnyMo']);
        stand.setCtx('loadWorldInfo', async () => {
            throw new Error('network');
        });
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.present()).toBe(false);
        stand.setCtx('loadWorldInfo', undefined);
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.present()).toBe(false);
        stand.setCtx('loadWorldInfo', async () => ({ entries: 'junk' }));
        await adapters.bunnymo.refresh();
        expect(adapters.bunnymo.present()).toBe(false);
    });

    it('shares one run between concurrent refreshes', async () => {
        stand.worldInfo.selected_world_info = ['BunnyMo'];
        let loads = 0;
        stand.setCtx('loadWorldInfo', async () => {
            loads++;
            return structuredClone(CORE);
        });
        await Promise.all([adapters.bunnymo.refresh(), adapters.bunnymo.refresh(), stand.caps.refresh()]);
        expect(loads).toBe(1);
        expect(stand.caps.has('bunnymo.core')).toBe(true);
    });
});
