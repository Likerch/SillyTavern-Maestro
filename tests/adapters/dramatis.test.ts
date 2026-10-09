// @vitest-environment happy-dom
// Dramatis (release 1.17): the adapter finds DRAMATIS_API v1 (also when it appears later, on `dramatis-api-ready`),
// reports `dramatis.present` / `dramatis.api`, reads the engine safely and keeps the quiet-mode claims.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters, dramatisOf } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import {
    DRAMATIS_API_GLOBAL,
    DRAMATIS_API_READY_EVENT,
    isDramatisManifest,
    readAgenda,
    readCharacterView,
    readDramatisApi,
    readIntentState,
    readReadOutcome,
    readStance,
    readStartMember,
} from '../../src/adapters/dramatis';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';
import { FakeDramatisApi } from '../helpers/dramatis';

const globals = globalThis as unknown as Record<string, unknown>;
const NAME = 'third-party/SillyTavern-Dramatis';
const MANIFEST = {
    display_name: 'Dramatis',
    version: '0.1.0',
    js: 'dist/index.js',
    homePage: 'https://github.com/Likerch/SillyTavern-Dramatis',
};

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    adapters.dramatis.dispose();
    clearScripts();
    delete globals[DRAMATIS_API_GLOBAL];
});

describe('detection', () => {
    it('recognises the manifest and accepts only a complete version 1 API', () => {
        expect(isDramatisManifest(MANIFEST)).toBe(true);
        expect(isDramatisManifest({ homePage: 'https://github.com/x/sillytavern-dramatis' })).toBe(true);
        expect(isDramatisManifest({ display_name: 'Other' })).toBe(false);

        const api = new FakeDramatisApi();
        expect(readDramatisApi(api)).toBe(api);
        expect(readDramatisApi({ ...api, version: 2 })).toBeUndefined();
        const partial = Object.assign(Object.create(null) as Record<string, unknown>, {
            version: 1,
            active: () => true,
        });
        expect(readDramatisApi(partial)).toBeUndefined();
        expect(readDramatisApi(null)).toBeUndefined();
    });

    it('reports nothing without Dramatis, then the API once it is published', async () => {
        await adapters.dramatis.ready();
        await stand.caps.refresh();
        expect(adapters.dramatis.present()).toBe(false);
        expect(stand.caps.has('dramatis.present')).toBe(false);
        expect(adapters.dramatis.castBlockActive()).toBe(false);
        expect(adapters.dramatis.stances()).toEqual([]);

        stand.install(NAME, MANIFEST, { loaded: true });
        const late = createAdapters(stand.host, silentLog, {
            importModule: stand.importModule,
            fetch: stand.fetchManifest,
        });
        await late.dramatis.ready();
        expect(late.dramatis.present()).toBe(true);
        expect(late.dramatis.api()).toBeUndefined();
        await stand.caps.refresh();
        expect(stand.caps.has('dramatis.present')).toBe(true);
        expect(stand.caps.has('dramatis.api')).toBe(false);

        const api = new FakeDramatisApi();
        api.dramatisVersion = '0.2.0';
        globals[DRAMATIS_API_GLOBAL] = api;
        await stand.caps.refresh();
        expect(stand.caps.has('dramatis.api')).toBe(true);
        expect(late.dramatis.version()).toBe('0.2.0');

        stand.disable(NAME);
        await stand.caps.refresh();
        expect(late.dramatis.present()).toBe(false);
        expect(late.dramatis.api()).toBeUndefined();
        expect(stand.caps.has('dramatis.api')).toBe(false);
        late.dramatis.dispose();
    });

    it('refreshes capabilities and tells listeners on dramatis-api-ready', async () => {
        let changes = 0;
        const off = adapters.dramatis.onChange(() => changes++);
        globals[DRAMATIS_API_GLOBAL] = new FakeDramatisApi();
        window.dispatchEvent(new CustomEvent(DRAMATIS_API_READY_EVENT, { detail: { version: 1 } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(changes).toBe(1);
        expect(stand.caps.has('dramatis.api')).toBe(true);
        // The adapter follows the published API's own change events from then on.
        (globals[DRAMATIS_API_GLOBAL] as FakeDramatisApi).emit();
        expect(changes).toBe(2);
        off();
        (globals[DRAMATIS_API_GLOBAL] as FakeDramatisApi).emit();
        expect(changes).toBe(2);
    });

    it('follows a new API object (Dramatis restarted) and stops after dispose', () => {
        let changes = 0;
        const first = new FakeDramatisApi();
        globals[DRAMATIS_API_GLOBAL] = first;
        adapters.dramatis.onChange(() => changes++);
        first.emit();
        expect(changes).toBe(1);
        const second = new FakeDramatisApi();
        globals[DRAMATIS_API_GLOBAL] = second;
        adapters.dramatis.api();
        second.emit();
        expect(changes).toBe(2);
        expect(first.listeners.size).toBe(0);
        adapters.dramatis.dispose();
        second.emit();
        expect(changes).toBe(2);
    });
});

describe('reads', () => {
    it('cleans what Dramatis returns and survives a throwing API', () => {
        const api = new FakeDramatisApi();
        api.owned = [' Ilva ', '', 'Ilva', 'Bram'];
        api.stanceList = [
            { from: 'Ilva', to: 'Kai', stance: 5, label: 'Враждебна', reasons: ['an imperial', ''] },
            { from: '', to: 'Kai', stance: 1, label: 'x', reasons: [] },
        ];
        api.briefs = { Ilva: 'Goal: raise the tax\n\nTried: bribe the guard\n  Outcome: failed  ' };
        api.agendas = [
            { text: 'The guild calls in its debt', weight: 3 },
            { text: '', weight: 2 },
            { text: 'zero', weight: 0 },
        ];
        api.goalMap = { Ilva: ['tax', 'tax', ' revenge '] };
        api.replaces = true;
        globals[DRAMATIS_API_GLOBAL] = api;
        const dramatis = adapters.dramatis;
        expect(dramatis.active()).toBe(true);
        expect(dramatis.castBlockActive()).toBe(true);
        expect(dramatis.dependenceOwned()).toEqual(['Ilva', 'Bram']);
        expect(dramatis.stances()).toEqual([
            { from: 'Ilva', to: 'Kai', stance: 3, label: 'Враждебна', reasons: ['an imperial'] },
        ]);
        expect(dramatis.offscreenBrief('Ilva')).toEqual([
            'Goal: raise the tax',
            'Tried: bribe the guard',
            'Outcome: failed',
        ]);
        expect(dramatis.offscreenBrief('Bram')).toEqual([]);
        expect(dramatis.matureAgendas()).toEqual([{ text: 'The guild calls in its debt', weight: 3 }]);
        expect(dramatis.goals('Ilva')).toEqual(['tax', 'revenge']);
        expect(dramatis.replacesSocialMechanics()).toBe(true);

        api.stances = () => {
            throw new Error('broken');
        };
        expect(dramatis.stances()).toEqual([]);
        expect(readStance({ from: 'a', to: 'b', stance: 'x' })).toBeNull();
        expect(readAgenda({ text: 'x', weight: Number.NaN })).toBeNull();
    });
});

describe('starting scenes (Dramatis 1.2, startCast)', () => {
    it('reads the cast of a greeting, cleaned, and nothing without the optional method', () => {
        const api = new FakeDramatisApi();
        api.starts = {
            1: [
                {
                    name: ' Вера ',
                    present: true,
                    doing: ' checks the hold ',
                    goal: '',
                    stance: 7,
                    stanceLabel: 'Союзница',
                    reason: 'saved her brother',
                    mood: 'tired',
                    gender: 'female',
                },
                { name: 'вера', present: false },
                { name: '', present: true },
                { name: 'Томас', present: 'yes', stance: 'x', gender: 'other' } as never,
            ],
        };
        globals[DRAMATIS_API_GLOBAL] = api;
        const dramatis = adapters.dramatis;
        expect(dramatis.startCast(1)).toEqual([
            {
                name: 'Вера',
                present: true,
                doing: 'checks the hold',
                stance: 3,
                stanceLabel: 'Союзница',
                reason: 'saved her brother',
                mood: 'tired',
                gender: 'female',
            },
            { name: 'Томас', present: false },
        ]);
        expect(dramatis.startCast(0)).toEqual([]);
        expect(dramatis.startCast(-1)).toEqual([]);
        expect(readStartMember('junk')).toBeNull();
        delete api.startCast;
        expect(dramatis.startCast(1)).toEqual([]);
        api.startCast = () => {
            throw new Error('broken');
        };
        expect(dramatis.startCast(1)).toEqual([]);
    });
});

describe("the card's intent and the summaries (Dramatis 1.3)", () => {
    it('does without them on an older Dramatis and without Dramatis', async () => {
        const dramatis = adapters.dramatis;
        expect(dramatis.canReadIntent()).toBe(false);
        expect(dramatis.intentState()).toBeNull();
        expect(await dramatis.readIntent()).toEqual({ ok: false, characters: 0, error: 'unsupported' });
        expect(dramatis.canDescribe()).toBe(false);
        expect(dramatis.describe('Вера')).toBeNull();
        expect(dramatis.canOpenSheet()).toBe(false);
        expect(dramatis.openSheet('Вера')).toBe(false);
        globals[DRAMATIS_API_GLOBAL] = new FakeDramatisApi();
        expect(dramatis.canReadIntent()).toBe(false);
        expect(dramatis.intentState()).toBeNull();
        expect(await dramatis.readIntent({ force: true })).toMatchObject({ ok: false, error: 'unsupported' });
        expect(dramatis.canDescribe()).toBe(false);
        expect(dramatis.describe('Вера')).toBeNull();
        expect(dramatis.openSheet()).toBe(false);
    });

    it('reads where the reading stands and reads the card on request, force passed on', async () => {
        const api = new FakeDramatisApi().upgrade();
        globals[DRAMATIS_API_GLOBAL] = api;
        const dramatis = adapters.dramatis;
        expect(dramatis.canReadIntent()).toBe(true);
        api.intent = { read: false, characters: -2, groups: 1.7, running: 'yes' as never, at: Number.NaN };
        expect(dramatis.intentState()).toEqual({ read: false, characters: 0, groups: 1, running: false });
        api.intent = null;
        expect(dramatis.intentState()).toBeNull();
        api.intent = { read: false, characters: 0, groups: 0, running: false };
        expect(await dramatis.readIntent()).toEqual({
            ok: true,
            characters: 3,
            message: 'Замысел прочитан: 3 персонажа',
        });
        expect(dramatis.intentState()).toMatchObject({ read: true, characters: 3, at: 1 });
        await dramatis.readIntent({ force: true });
        expect(api.readCalls).toEqual([{}, { force: true }]);
        api.readAnswer = { ok: false, characters: 0, error: ' no-profile ' };
        expect(await dramatis.readIntent()).toEqual({ ok: false, characters: 0, error: 'no-profile' });
        api.readIntent = async () => {
            throw new Error('model down');
        };
        expect(await dramatis.readIntent()).toEqual({ ok: false, characters: 0, error: 'model down' });
        api.readIntent = async () => 'junk' as never;
        expect(await dramatis.readIntent()).toEqual({ ok: false, characters: 0, error: 'bad-answer' });
        api.intentState = () => {
            throw new Error('broken');
        };
        expect(dramatis.intentState()).toBeNull();
        delete api.readIntent;
        expect(dramatis.canReadIntent()).toBe(false);
    });

    it('describes a character, cleaned, and opens the sheet', () => {
        const api = new FakeDramatisApi().upgrade();
        globals[DRAMATIS_API_GLOBAL] = api;
        api.views['Вера'] = {
            name: ' Вера ',
            headline: ' Капитан «Чайки» ',
            detail: '',
            secrets: 'whatever' as never,
            sections: [
                {
                    id: 'motives',
                    title: 'Мотивы',
                    lines: [
                        { text: '  Хочет вернуть корабль  ' },
                        { text: '   ' },
                        { text: 'Боится моря', secret: true },
                    ],
                },
                { id: 'empty', title: 'Пусто', lines: [{ text: '' }] },
                { id: '', title: '', lines: ['Строка как текст'] as never },
                'junk' as never,
            ],
        };
        const dramatis = adapters.dramatis;
        expect(dramatis.canDescribe()).toBe(true);
        expect(dramatis.describe(' Вера ')).toEqual({
            name: 'Вера',
            headline: 'Капитан «Чайки»',
            secrets: 'spoiler',
            sections: [
                {
                    id: 'motives',
                    title: 'Мотивы',
                    lines: [{ text: 'Хочет вернуть корабль' }, { text: 'Боится моря', secret: true }],
                },
                { id: 'section-2', title: '', lines: [{ text: 'Строка как текст' }] },
            ],
        });
        expect(api.described).toEqual(['Вера']);
        expect(dramatis.describe('  ')).toBeNull();
        expect(dramatis.describe('Томас')).toBeNull();
        api.describe = () => {
            throw new Error('broken');
        };
        expect(dramatis.describe('Вера')).toBeNull();
        expect(dramatis.canOpenSheet()).toBe(true);
        expect(dramatis.openSheet(' Вера ')).toBe(true);
        expect(dramatis.openSheet()).toBe(true);
        expect(api.opened).toEqual(['Вера', undefined]);
    });

    it('cleans the 1.3 answers', () => {
        expect(readIntentState('x')).toBeNull();
        expect(readIntentState({ read: true, characters: '4', groups: null, running: true, at: 5 })).toEqual({
            read: true,
            characters: 4,
            groups: 0,
            running: true,
            at: 5,
        });
        expect(readReadOutcome(null)).toEqual({ ok: false, characters: 0, error: 'bad-answer' });
        expect(readReadOutcome({ ok: true, characters: 2, skipped: true, message: ' ' })).toEqual({
            ok: true,
            characters: 2,
            skipped: true,
        });
        expect(readCharacterView({ name: '' })).toBeNull();
        expect(readCharacterView({ name: 'Вера', secrets: 'known' })).toEqual({
            name: 'Вера',
            sections: [],
            secrets: 'known',
        });
        expect(readCharacterView({ name: 'Вера', secrets: 'open', sections: 'x' })?.secrets).toBe('open');
    });
});

describe('quiet modes', () => {
    it('keeps claims per owner and silences only while Dramatis is present and its block goes out', () => {
        const dramatis = adapters.dramatis;
        let changes = 0;
        dramatis.onQuietChange(() => changes++);
        const offVoices = dramatis.quiet('voices', 'dramatis');
        const offAgain = dramatis.quiet('voices', 'dramatis.merge');
        const offCk = dramatis.quiet('ck.consistency', 'dramatis');
        expect(changes).toBe(3);
        expect(dramatis.isClaimed('voices')).toBe(true);
        expect(dramatis.claims()).toEqual([
            { fn: 'voices', owners: ['dramatis', 'dramatis.merge'] },
            { fn: 'ck.consistency', owners: ['dramatis'] },
        ]);
        // Claimed, but Dramatis is not on the page.
        expect(dramatis.silences('voices')).toBe(false);

        const api = new FakeDramatisApi();
        globals[DRAMATIS_API_GLOBAL] = api;
        expect(dramatis.silences('voices')).toBe(true);
        expect(dramatis.silences('ck.consistency')).toBe(true);
        api.cast = false;
        expect(dramatis.silences('voices')).toBe(false);
        api.cast = true;

        offVoices();
        offVoices();
        expect(dramatis.isClaimed('voices')).toBe(true);
        offAgain();
        expect(dramatis.isClaimed('voices')).toBe(false);
        expect(dramatis.silences('voices')).toBe(false);
        offCk();
        expect(dramatis.claims()).toEqual([]);
        expect(changes).toBe(6);

        expect(dramatis.claimsMedicineCheck()).toBe(false);
        dramatis.quiet('bunnymo.medicineCheck', 'dramatis');
        expect(dramatis.claimsMedicineCheck()).toBe(true);
        dramatis.quiet('nope' as never, 'x')();
        expect(dramatis.claims().map((claim) => claim.fn)).toEqual(['bunnymo.medicineCheck']);

        dramatis.dispose();
        expect(dramatis.claims()).toEqual([]);
    });

    it('is found on a test App without the adapter as undefined', () => {
        expect(dramatisOf({ adapters: {} })).toBeUndefined();
        expect(dramatisOf({ adapters: adapters })).toBe(adapters.dramatis);
    });
});
