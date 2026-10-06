import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NaiPassport } from '../../../src/adapters/nai';
import {
    defaultWardrobeSettings,
    isWardrobePayload,
    readWardrobeSettings,
    WARDROBE_KINDS,
    WARDROBE_STRINGS,
    WARDROBE_UNDO_TARGET,
    wardrobeModule,
} from '../../../src/features/wardrobe';
import type { WardrobePayload } from '../../../src/features/wardrobe';
import { createWardrobeEnv, INTAKE, passport, SETTLE } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;

beforeEach(() => {
    vi.useFakeTimers();
    env = createWardrobeEnv();
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const anna = (): NaiPassport => env.nai.getPassport('p-anna')!;
const tavern = (): NaiPassport => env.nai.getPassport('loc-tavern')!;
const enabledStates = (value: NaiPassport) => value.states.filter((state) => state.enabled).map((state) => state.id);
const lastJournal = () => env.journal.records[env.journal.records.length - 1]!;

describe('module', () => {
    it('registers the tab, the style, the API and the Inbox appliers, and leaves nothing when off', async () => {
        await env.start();
        expect(wardrobeModule).toMatchObject({ id: 'M27', key: 'wardrobe', stage: 10, titleKey: 'm27.title' });
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['wardrobe', 'm27.tab', 60]]);
        expect(env.ui.styles.has('maestro-m27')).toBe(true);
        const api = env.service();
        for (const name of ['outfits', 'changes', 'wear', 'onChange', 'intakeOutfit', 'placeStates'] as const) {
            expect(typeof api[name]).toBe('function');
        }
        expect([...env.inbox.appliers.keys()].sort()).toEqual(Object.values(WARDROBE_KINDS).sort());
        expect(env.journal.handlers.has(WARDROBE_UNDO_TARGET)).toBe(true);
        expect(env.nai.listenerCount()).toBe(1);
        await env.stop();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        expect(env.inbox.appliers.size).toBe(0);
        expect(env.revision.runListeners.size + env.revision.changeListeners.size).toBe(0);
        expect(env.places.enterListeners.size).toBe(0);
        expect(env.nai.listenerCount()).toBe(0);
        // Journal records outlive the module: the undo handler stays.
        expect(env.journal.handlers.has(WARDROBE_UNDO_TARGET)).toBe(true);
    });

    it('has the same keys in both languages and repairs its settings', () => {
        expect(Object.keys(WARDROBE_STRINGS.ru).sort()).toEqual(Object.keys(WARDROBE_STRINGS.en).sort());
        for (const key of Object.keys(WARDROBE_STRINGS.en)) expect(key.startsWith('m27.')).toBe(true);
        expect(wardrobeModule.defaults()).toEqual({
            outfits: true,
            states: true,
            places: true,
            promptLine: true,
            promptDepth: 1,
            redrawPortrait: true,
            persona: true,
            personaEvery: 6,
        });
        const slice: Record<string, unknown> = { outfits: 'yes', states: false, promptDepth: 99.4, personaEvery: 'x' };
        expect(readWardrobeSettings(slice)).toEqual({
            ...defaultWardrobeSettings(),
            states: false,
            promptDepth: 20,
            personaEvery: 6,
        });
        expect(readWardrobeSettings({ promptDepth: -3, personaEvery: 2.6 })).toMatchObject({
            promptDepth: 0,
            personaEvery: 3,
        });
        expect(defaultWardrobeSettings()).toEqual({
            outfits: true,
            states: true,
            places: true,
            promptLine: true,
            promptDepth: 1,
            redrawPortrait: true,
            persona: true,
            personaEvery: 6,
        });
    });

    it('recognises its own payloads only', () => {
        expect(isWardrobePayload({ m27: 1, op: 'x', passportId: 'p' })).toBe(true);
        expect(isWardrobePayload({ m8: 1, op: 'x', passportId: 'p' })).toBe(false);
        expect(isWardrobePayload(null)).toBe(false);
    });
});

describe('outfits from the DES tracker', () => {
    it('creates a named outfit from a Russian wording in the chat-level passport and puts it on', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'Тёмно-синее шёлковое платье, кожаные сапоги', { messageIndex: 4 });
        const saves = env.nai.of('savePassport');
        expect(saves).toHaveLength(1);
        const [saved, scope, target] = saves[0] as [NaiPassport, string, unknown];
        expect(scope).toBe('chat');
        expect(target).toEqual({ avatar: 'Anna.png' });
        expect(saved.outfits).toEqual([
            { name: 'ballgown', tags: 'white ball gown, long gloves, tiara' },
            {
                name: 'blue silk dress',
                tags: 'dark blue silk dress, leather boots',
                looks: ['Тёмно-синее шёлковое платье, кожаные сапоги'],
            },
        ]);
        expect(saved.activeOutfit).toBe('blue silk dress');
        expect(anna().activeOutfit).toBe('blue silk dress');
        const record = lastJournal();
        expect(record).toMatchObject({ module: 'M27', kind: 'wardrobe.outfit', sourceMessage: 4 });
        expect(record.summary).toBe('Anna: new outfit «blue silk dress»');
        expect(record.changes[0]).toMatchObject({
            target: WARDROBE_UNDO_TARGET,
            ref: { action: 'outfit.create', passportId: 'p-anna', name: 'blue silk dress' },
            before: { activeOutfit: '' },
            after: { activeOutfit: 'blue silk dress' },
        });
        const library = service.outfits('Анна');
        expect(library.map((outfit) => [outfit.name, outfit.active])).toEqual([
            ['blue silk dress', true],
            ['ballgown', false],
        ]);
        expect(library[0]).toMatchObject({
            passportId: 'p-anna',
            character: 'Anna',
            seenAs: ['Тёмно-синее шёлковое платье, кожаные сапоги'],
        });
        expect(service.history({ kind: 'outfit' })[0]).toMatchObject({ created: true, state: 'blue silk dress' });
    });

    it('takes the outfit of a character who enters the scene already dressed (no change signal), once', async () => {
        await env.start();
        const dressed = { name: 'Anna', details: { outfit: 'Тёмно-синее шёлковое платье, кожаные сапоги' } };
        await env.turn({ characters: [dressed] });
        expect(env.nai.of('savePassport')).toHaveLength(0);
        await env.turn({ characters: [dressed] });
        expect(env.nai.of('savePassport')).toHaveLength(1);
        expect(anna().activeOutfit).toBe('blue silk dress');
        await env.turn({ characters: [dressed] });
        expect(env.nai.of('savePassport')).toHaveLength(1);
        expect(env.nai.of('setOutfit')).toHaveLength(0);
    });

    it('recognises the outfit when it comes back and puts it on with the new wording in one save', async () => {
        await env.start();
        await env.outfitSignal('Anna', 'Тёмно-синее шёлковое платье, кожаные сапоги', { messageIndex: 4 });
        await env.outfitSignal('Anna', 'white ball gown and long gloves', { messageIndex: 6 });
        expect(env.nai.of('setOutfit')).toEqual([]);
        expect(env.nai.of('savePassport')).toHaveLength(2);
        expect(anna().activeOutfit).toBe('ballgown');
        expect(anna().outfits[0]).toEqual({
            name: 'ballgown',
            tags: 'white ball gown, long gloves, tiara',
            looks: ['white ball gown and long gloves'],
        });
        expect(lastJournal().changes[0]).toMatchObject({
            before: { activeOutfit: 'blue silk dress', looks: [] },
            after: { activeOutfit: 'ballgown', looks: ['white ball gown and long gloves'] },
        });
        await env.outfitSignal('Anna', 'синее шёлковое платье и сапоги', { messageIndex: 8 });
        expect(anna().activeOutfit).toBe('blue silk dress');
        expect(anna().outfits[1]!.looks).toEqual([
            'Тёмно-синее шёлковое платье, кожаные сапоги',
            'синее шёлковое платье и сапоги',
        ]);
        expect(env.nai.of('savePassport')).toHaveLength(3);
        expect(anna().outfits).toHaveLength(2);
        expect(lastJournal().summary).toBe('Anna: outfit «blue silk dress» again');
        // A wording the outfit knows already (case, punctuation): only put on.
        await env.outfitSignal('Anna', 'White ball gown and long gloves!', { messageIndex: 10 });
        expect(env.nai.of('setOutfit')).toEqual([['p-anna', 'ballgown', 'chat']]);
        expect(anna().outfits[0]!.looks).toEqual(['white ball gown and long gloves']);
        expect(lastJournal().changes[0]!.after).toEqual({ activeOutfit: 'ballgown' });
    });

    it('adds the wording of an outfit already on to its looks with one save, once', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'blue silk dress with boots', { messageIndex: 4 });
        const worn = () => anna().outfits.find((outfit) => outfit.name === anna().activeOutfit)!;
        expect(worn().looks).toEqual(['blue silk dress with boots']);
        const writes = env.nai.calls.length;
        await env.outfitSignal('Anna', 'синее шёлковое платье', { messageIndex: 6 });
        expect(env.nai.calls).toHaveLength(writes + 1);
        expect(env.nai.calls.at(-1)).toMatchObject({
            method: 'savePassport',
            args: [{}, 'chat', { avatar: 'Anna.png' }],
        });
        expect(worn().looks).toEqual(['blue silk dress with boots', 'синее шёлковое платье']);
        expect(service.outfits('Anna')[0]!.seenAs).toEqual(['blue silk dress with boots', 'синее шёлковое платье']);
        // Known there already after reduction (case, ё, punctuation): nothing is written.
        await env.outfitSignal('Anna', 'Синее шелковое платье!', { messageIndex: 8 });
        expect(env.nai.calls).toHaveLength(writes + 1);
        // At a level that does not let outfit changes through by themselves the wording is only remembered.
        env.autonomy.levels.set('wardrobe.outfit', 'inbox');
        await env.outfitSignal('Anna', 'blue silk dress, leather boots', { messageIndex: 10 });
        expect(env.nai.calls).toHaveLength(writes + 1);
        expect(env.autonomy.proposals.filter((proposal) => proposal.kind === 'wardrobe.outfit')).toHaveLength(1);
    });

    it('keeps the wordings other outfits have, caps them at the newest 12, and undo of a switch takes back its own', async () => {
        const base = env.nai.cards.get('Anna.png')![0]!;
        base.outfits[0]!.looks = Array.from({ length: 12 }, (_, i) => `old ball gown wording ${i}`);
        await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка, рваные джинсы', { messageIndex: 2 });
        expect(anna().outfits[0]!.looks).toHaveLength(12);
        await env.outfitSignal('Anna', 'white ball gown and long gloves', { messageIndex: 4 });
        const wear = lastJournal();
        const looks = anna().outfits[0]!.looks!;
        expect(looks).toHaveLength(12);
        expect(looks[0]).toBe('old ball gown wording 1');
        expect(looks.at(-1)).toBe('white ball gown and long gloves');
        await env.outfitSignal('Anna', 'White ball gown, long gloves', { messageIndex: 6 });
        expect(anna().outfits[0]!.looks!.at(-1)).toBe('White ball gown, long gloves');
        expect(await env.journal.undo(wear.id)).toBe(true);
        expect(anna().activeOutfit).toBe('leather jacket and torn jeans');
        expect(anna().outfits[0]!.looks).not.toContain('white ball gown and long gloves');
        expect(anna().outfits[0]!.looks!.at(-1)).toBe('White ball gown, long gloves');
        expect(anna().outfits[1]!.looks).toEqual(['Кожаная куртка, рваные джинсы']);
    });

    it('remembers what was worn before the first change, so the clothing slot comes back', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'Красное вечернее платье', { from: 'Джинсы, серая толстовка', messageIndex: 4 });
        expect(anna().activeOutfit).toBe('red evening dress');
        await env.outfitSignal('Anna', 'джинсы и серая толстовка', { messageIndex: 6 });
        expect(env.nai.of('setOutfit')).toEqual([]);
        expect(anna().activeOutfit).toBe('');
        // The wording of the own clothes goes to the clothing slot's stand-in (same tags as the slot).
        expect(anna().outfits.at(-1)).toEqual({
            name: 'Own clothes',
            tags: 'blue jeans, grey hoodie, sneakers',
            looks: ['джинсы и серая толстовка'],
        });
        expect(lastJournal().summary).toBe('Anna: own clothes again');
        expect(service.outfits('Anna').map((outfit) => outfit.name)).toEqual(['red evening dress', 'ballgown']);
        // Undo takes the wording back and the stand-in with it.
        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(anna().activeOutfit).toBe('red evening dress');
        expect(anna().outfits.map((outfit) => outfit.name)).toEqual(['ballgown', 'red evening dress']);
    });

    it('resolves chat-only and persona passports, and skips characters without one', async () => {
        await env.start();
        await env.outfitSignal('Борис', 'Кольчуга и стальной шлем', { messageIndex: 3 });
        expect(env.nai.getPassport('p-boris')!.activeOutfit).toBe('chainmail and steel helmet');
        expect((env.nai.of('savePassport')[0] as unknown[])[2]).toBeUndefined();
        await env.outfitSignal('Алекс', 'Плащ', { messageIndex: 3 });
        expect((env.nai.of('savePassport')[1] as unknown[])[2]).toEqual({ persona: true });
        await env.outfitSignal('Незнакомец', 'Плащ', { messageIndex: 3 });
        expect(env.nai.of('savePassport')).toHaveLength(2);
    });

    it('does nothing without a garment, off, in another tab, in a group chat or for other signals', async () => {
        await env.start();
        await env.outfitSignal('Anna', 'Нет');
        await env.outfitSignal('Anna', 'в красном');
        env.leader.value = false;
        await env.outfitSignal('Anna', 'Кожаная куртка');
        env.leader.value = true;
        env.host.group = true;
        await env.outfitSignal('Anna', 'Кожаная куртка');
        env.host.group = false;
        env.slices.wardrobe!.outfits = false;
        await env.outfitSignal('Anna', 'Кожаная куртка');
        env.slices.wardrobe!.outfits = true;
        await env.app.bus.emit('signal', {
            kind: 'appearance.changed',
            chatId: 'chat-1',
            messageIndex: 2,
            data: { name: 'Anna', changes: [{ field: 'hair', aspect: 'appearance', from: 'a', to: 'b' }] },
            at: 1,
        });
        await env.app.bus.emit('signal', { kind: 'appearance.changed', chatId: 'other', data: {}, at: 1 });
        await env.tick(50);
        expect(env.nai.calls).toEqual([]);
    });

    it('goes to the Inbox at that level, and the applier writes the card later', async () => {
        env.autonomy.levels.set('wardrobe.outfit', 'inbox');
        await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка, рваные джинсы', { messageIndex: 4 });
        expect(env.nai.calls).toEqual([]);
        const proposal = env.autonomy.proposals[0]!;
        expect(proposal).toMatchObject({ kind: 'wardrobe.outfit', module: 'M27', sourceMessage: 4 });
        const payload = JSON.parse(JSON.stringify(proposal.payload)) as WardrobePayload;
        await env.inbox.appliers.get('wardrobe.outfit')!(payload);
        expect(anna().activeOutfit).toBe('leather jacket and torn jeans');
        expect(anna().outfits.at(-1)!.looks).toEqual(['Кожаная куртка, рваные джинсы']);
        await expect(env.inbox.appliers.get('wardrobe.outfit')!({ nope: true })).rejects.toThrow('bad wardrobe card');
    });

    it('undoes a new outfit and a switch through the journal', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'white ball gown and long gloves', { messageIndex: 2 });
        await env.outfitSignal('Anna', 'Кожаная куртка, рваные джинсы', { messageIndex: 4 });
        expect(anna().activeOutfit).toBe('leather jacket and torn jeans');
        const create = lastJournal();
        expect(await env.journal.undo(create.id)).toBe(true);
        expect(anna().outfits.map((outfit) => outfit.name)).toEqual(['ballgown']);
        expect(anna().activeOutfit).toBe('ballgown');
        expect(service.outfits('Anna').map((outfit) => outfit.name)).toEqual(['ballgown']);
        expect(service.history({ kind: 'outfit' })[0]).toMatchObject({ created: true, undone: true });
        const wear = env.journal.records[0]!;
        expect(await env.journal.undo(wear.id)).toBe(true);
        expect(anna().activeOutfit).toBe('');
    });

    it('refuses to undo without NAI Studio or the passport', async () => {
        await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка', { messageIndex: 4 });
        const record = lastJournal();
        env.naiPresent.value = false;
        expect(await env.journal.undo(record.id)).toBe(false);
        env.naiPresent.value = true;
        const handler = env.journal.handlers.get(WARDROBE_UNDO_TARGET)!;
        expect(
            await handler({
                target: WARDROBE_UNDO_TARGET,
                ref: { passportId: 'gone', action: 'state' },
                before: null,
                after: null,
            }),
        ).toBe(false);
        expect(
            await handler({
                target: WARDROBE_UNDO_TARGET,
                ref: { passportId: 'p-anna', action: 'odd' },
                before: null,
                after: null,
            }),
        ).toBe(false);
    });
});

describe('wear by hand', () => {
    it('puts an outfit on at chat level, journals it and undoes it', async () => {
        const service = await env.start();
        await service.wear('p-anna', 'BALLGOWN');
        expect(env.nai.of('setOutfit')).toEqual([['p-anna', 'ballgown', 'chat']]);
        const record = lastJournal();
        expect(record).toMatchObject({
            module: 'M27',
            kind: 'wardrobe.wear',
            summary: 'Anna: «ballgown» put on by hand',
        });
        expect(service.history()[0]).toMatchObject({ origin: 'user', state: 'ballgown', messageIndex: -1 });
        await service.wear('p-anna', 'ballgown');
        expect(env.nai.of('setOutfit')).toHaveLength(1);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(anna().activeOutfit).toBe('');
    });

    it('explains what is missing', async () => {
        const service = await env.start();
        await expect(service.wear('p-anna', 'pajamas')).rejects.toThrow('The passport has no outfit «pajamas».');
        await expect(service.wear('nope', '')).rejects.toThrow('The passport is no longer in this chat.');
        env.naiPresent.value = false;
        await expect(service.wear('p-anna', '')).rejects.toThrow('NAI Studio 0.10 or newer is needed');
        env.mock.chatId = undefined;
        await expect(service.wear('p-anna', '')).rejects.toThrow('No chat is open.');
    });
});

describe('character states', () => {
    it('switches states on from DES details and off after two turns without them', async () => {
        const service = await env.start();
        await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'Мокрая насквозь, уставшая', mood: 'пьяна' } }],
        });
        expect(env.nai.of('setState')).toEqual([
            ['p-anna', 'wet', true, 'chat'],
            ['p-anna', 'sleepy', true, 'chat'],
        ]);
        const drunk = env.nai.of('savePassport').at(-1) as [NaiPassport, string, unknown];
        expect(drunk[0].states.at(-1)).toEqual({ id: 'drunk', tags: 'drunk, blush', enabled: true });
        expect(drunk[1]).toBe('chat');
        expect(enabledStates(anna())).toEqual(['wet', 'sleepy', 'drunk']);
        expect(service.changes().map((change) => [change.state, change.enabled])).toEqual([
            ['drunk', true],
            ['tired', true],
            ['wet', true],
        ]);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'уставшая, пьяная' } }] });
        expect(enabledStates(anna())).toEqual(['wet', 'sleepy', 'drunk']);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая, пьяная' } }] });
        expect(enabledStates(anna())).toEqual(['wet', 'sleepy', 'drunk']);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'спокойна' } }] });
        expect(enabledStates(anna())).toEqual(['wet', 'drunk']);
        expect(lastJournal().summary).toBe('Anna: no longer tiredness');
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'спокойна' } }] });
        expect(enabledStates(anna())).toEqual([]);
        expect(env.nai.of('setState').slice(-2)).toEqual([
            ['p-anna', 'wet', false, 'chat'],
            ['p-anna', 'drunk', false, 'chat'],
        ]);
    });

    it('leaves states that are on by the card and characters that are off scene or missing', async () => {
        env.nai.cards.get('Anna.png')![0]!.states.find((state) => state.id === 'wet')!.enabled = true;
        await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        await env.turn({ characters: [{ name: 'Boris', details: { appearance: 'ранен' }, offScene: true }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'сухая' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'сухая' } }] });
        expect(env.nai.calls).toEqual([]);
        expect(enabledStates(anna())).toEqual(['wet']);
    });

    it('keeps an undone state off while its wording lasts and lets it come back later', async () => {
        await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'В слезах' } }] });
        expect(enabledStates(anna())).toEqual(['tears']);
        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(enabledStates(anna())).toEqual([]);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'В слезах' } }] });
        expect(enabledStates(anna())).toEqual([]);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'спокойна' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'спокойна' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'В слезах' } }] });
        expect(enabledStates(anna())).toEqual(['tears']);
    });

    it('removes a new state on undo and gives back an undone «off»', async () => {
        await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'drunk' } }] });
        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(anna().states.some((state) => state.id === 'drunk')).toBe(false);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Wounded' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'fine' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'fine' } }] });
        expect(enabledStates(anna())).toEqual([]);
        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(enabledStates(anna())).toEqual(['injured']);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'fine' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'fine' } }] });
        expect(enabledStates(anna())).toEqual(['injured']);
    });

    it('proposes once at the Inbox level and forgets a proposal that was never accepted', async () => {
        env.autonomy.levels.set('wardrobe.state', 'inbox');
        await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        expect(env.autonomy.proposals).toHaveLength(1);
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'сухая' } }] });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'сухая' } }] });
        expect(env.autonomy.proposals).toHaveLength(1);
        expect(env.nai.calls).toEqual([]);
    });

    it('does nothing when switched off, in another tab or twice for one turn', async () => {
        await env.start();
        env.slices.wardrobe!.states = false;
        env.slices.wardrobe!.places = false;
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        env.slices.wardrobe!.states = true;
        env.leader.value = false;
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        env.leader.value = true;
        expect(env.nai.calls).toEqual([]);
        const index = await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        expect(env.nai.calls).toHaveLength(1);
        await env.app.bus.emit('turn:committed', { messageIndex: index });
        await env.tick(SETTLE);
        expect(env.nai.calls).toHaveLength(1);
    });
});

describe('place states', () => {
    beforeEach(() => {
        env.places.add('tavern', 'Таверна', { passportId: 'loc-tavern' });
        env.places.add('square', 'Площадь');
        env.places.currentId = 'tavern';
    });

    it('writes scene states as location passport states and tags, and drops transient ones on leaving', async () => {
        const service = await env.start();
        await env.turn({ location: 'Таверна', time: '23:10', weather: 'Дождь', events: ['Таверну разгромили'] });
        expect(tavern().tags).toBe('tavern, wooden interior, rain, ruins, rubble, night, dark');
        expect(enabledStates(tavern())).toEqual(['rain', 'ruined', 'night']);
        expect(service.placeStates('tavern')).toEqual(['rain', 'ruined', 'night']);
        expect(env.nai.of('savePassport').every((call) => call[1] === 'chat')).toBe(true);
        expect(lastJournal()).toMatchObject({ kind: 'wardrobe.placeState', summary: 'Таверна: night' });
        env.places.enter('square');
        await env.tick(50);
        expect(tavern().tags).toBe('tavern, wooden interior, ruins, rubble');
        expect(enabledStates(tavern())).toEqual(['ruined']);
        expect(service.placeStates('tavern')).toEqual(['ruined']);
        expect(service.changes(2).map((change) => [change.kind, change.subject, change.state, change.enabled])).toEqual(
            [
                ['place', 'Таверна', 'night', false],
                ['place', 'Таверна', 'rain', false],
            ],
        );
    });

    it('finds the location passport by name, keeps tags the card had, and undoes through the journal', async () => {
        env.places.places[0]!.passportId = undefined;
        env.places.places[0]!.aliases = ['Tavern'];
        env.nai.cards.get('Anna.png')![1]!.tags = 'tavern, night';
        await env.start();
        await env.turn({ location: 'Tavern', time: '22:30', weather: 'Snowfall' });
        expect(tavern().tags).toBe('tavern, night, snow, snowing');
        expect(enabledStates(tavern())).toEqual(['snow']);
        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(tavern().tags).toBe('tavern, night');
        expect(enabledStates(tavern())).toEqual([]);
    });

    it('turns transient states off after two turns without them and leaves places without a passport', async () => {
        await env.start();
        await env.turn({ location: 'Таверна', weather: 'Туман' });
        expect(enabledStates(tavern())).toEqual(['fog']);
        await env.turn({ location: 'Таверна', weather: 'Ясно' });
        await env.turn({ location: 'Таверна', weather: 'Ясно' });
        expect(enabledStates(tavern())).toEqual([]);
        expect(tavern().tags).toBe('tavern, wooden interior');
        env.places.currentId = 'square';
        const before = env.nai.calls.length;
        await env.turn({ location: 'Площадь', weather: 'Ливень' });
        expect(env.nai.calls).toHaveLength(before);
        expect(env.service().currentPlace()).toMatchObject({ place: { id: 'square' }, target: null, states: [] });
    });
});

describe('deferred outfit cards', () => {
    it('takes the backlog on start: creates outfits, puts on the newest, dismisses the cards', async () => {
        env.revision.card('Anna wears a black leather jacket and torn jeans.', 4);
        env.revision.card('Changed into a white ball gown with long gloves.', 2);
        env.revision.card('Anna now wears a green cloak.', 6, 'Анна');
        const unknown = env.revision.card('Wears a red hat.', 7, 'Nobody');
        env.revision.card('A promise', 3, 'Anna', 'deferred.promise');
        const service = await env.start();
        await env.tick(50);
        expect(env.nai.of('setOutfit')).toEqual([['p-anna', 'ballgown', 'chat']]);
        expect(anna().outfits.map((outfit) => outfit.name)).toEqual([
            'ballgown',
            'black leather jacket',
            'green cloak',
        ]);
        expect(anna().activeOutfit).toBe('green cloak');
        // A card about nobody of this chat can never be taken: dismissed with the reason (not retried forever).
        expect(env.revision.dismissed).toEqual(['def-2', 'def-1', 'def-3', unknown.id]);
        expect(env.revision.cards.map((card) => card.id)).toEqual(['def-5']);
        expect(service.droppedCards()).toMatchObject([{ id: unknown.id, entityName: 'Nobody', reason: 'unknown' }]);
        expect(service.history({ kind: 'outfit' }).map((entry) => entry.origin)).toEqual([
            'revision',
            'revision',
            'revision',
        ]);
    });

    it('does not put on an older outfit than the one already known', async () => {
        await env.start();
        await env.outfitSignal('Anna', 'Красное вечернее платье', { messageIndex: 10 });
        env.revision.card('Anna wears a black leather jacket.', 5);
        env.revision.finish();
        await env.tick(INTAKE);
        expect(anna().outfits.map((outfit) => outfit.name)).toContain('black leather jacket');
        expect(anna().activeOutfit).toBe('red evening dress');
        expect(env.revision.dismissed).toEqual(['def-1']);
    });

    it('answers the direct route and refuses removals, unknown people and the switched-off part', async () => {
        const service = await env.start();
        const statement = { entityName: 'Anna', value: 'Puts on a fur coat.', evidence: '«…»', sourceMessage: 3 };
        expect(await service.intakeOutfit(statement)).toBe('fur coat');
        expect(anna().outfits.find((outfit) => outfit.name === 'fur coat')!.looks).toBeUndefined();
        expect(await service.intakeOutfit({ ...statement, value: 'Took off her coat.' })).toBeNull();
        expect(await service.intakeOutfit({ ...statement, entityName: 'Nobody' })).toBeNull();
        expect(await service.intakeOutfit({ ...statement, value: 42 as unknown as string })).toBeNull();
        env.slices.wardrobe!.outfits = false;
        expect(await service.intakeOutfit(statement)).toBeNull();
    });

    it('keeps cards when the level refuses them', async () => {
        env.autonomy.levels.set('wardrobe.outfit', 'off');
        env.revision.card('Anna wears a black leather jacket.', 5);
        await env.start();
        await env.tick(50);
        expect(env.revision.dismissed).toEqual([]);
    });
});

describe('invalidation and chats', () => {
    it('undoes what came from a deleted committed reply', async () => {
        await env.start();
        const index = await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        expect(enabledStates(anna())).toEqual(['wet']);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(50);
        expect(enabledStates(anna())).toEqual(['wet']);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(50);
        expect(enabledStates(anna())).toEqual([]);
    });

    it('starts over in another chat', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка', { messageIndex: 2 });
        expect(service.history()).toHaveLength(1);
        await env.switchTo('chat-2');
        expect(service.history()).toEqual([]);
        expect(service.changes()).toEqual([]);
        await env.switchTo('chat-1');
        expect(service.history()).toHaveLength(1);
    });

    it('lists remembered outfits without NAI Studio', async () => {
        const service = await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка', { messageIndex: 2 });
        env.naiPresent.value = false;
        expect(service.outfits().map((outfit) => [outfit.name, outfit.active])).toEqual([['leather jacket', false]]);
        expect(service.outfits('Anna').map((outfit) => outfit.name)).toEqual(['leather jacket']);
        expect(service.outfits('Nobody')).toEqual([]);
        env.naiPresent.value = true;
        expect(service.outfits().map((outfit) => outfit.name)).toEqual(['leather jacket', 'ballgown']);
        expect(passport('x', 'y').kind).toBe('character');
    });
});
