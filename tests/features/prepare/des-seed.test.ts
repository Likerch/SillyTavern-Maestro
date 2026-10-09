// @vitest-environment happy-dom
// «Персонажи в DES» (M37, release 1.18): applying the preparation gives every greeting of the stand's card (the tavern
// in the rain, the harbour at dawn, the guild archive at night — the swipes of message 0) DES's tracker record: who is
// there with looks, behaviour, clothes, relationship, thoughts and stats, and the scene's date, time, place, weather.
// The shown one is what DES shows and generates from; the records come back after DES's own empty record of the
// greeting; a swipe of message 0 switches DES to that greeting's cast; the first turn in together mode gets the opening
// tracker once; the Workshop blocks writes; undo takes everything back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechanicDef } from '../../../src/domain/mechanics-defs';
import { DES_SEED_TASK } from '../../../src/domain/prepare-des-seed';
import { DES_DOC, DES_INJECTION, DES_ITEM } from '../../../src/features/prepare/des-seed';
import { SCENES_DOC } from '../../../src/features/prepare/scenes';
import { preparedStart } from '../../../src/features/medic/tracker-repair';
import type { GenerationInfo, InjectionSpec } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { analyse, createPrepareEnv, settle, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

type Dict = Record<string, unknown>;

const DES_NAME = 'third-party/Dooms-Enhancement-Suite';
const BASE = `/scripts/extensions/${DES_NAME}/`;

interface FakeDes {
    present: boolean;
    mode: 'together' | 'separate';
    workshop: boolean;
    perChat: boolean;
    settings: Dict;
    state: { lastGeneratedData: Dict; committedTrackerData: Dict };
    roster: Dict;
    renders: string[];
    saves: number;
    rosterSaves: number;
}

/** DES 2.6 as the user's server has it: Russian fields (DES-RU's fieldKeys), Russian relationships, Trust as a stat. */
function installDes(env: PrepareEnv): FakeDes {
    const des: FakeDes = {
        present: true,
        mode: 'together',
        workshop: false,
        perChat: true,
        settings: {
            enabled: true,
            showInfoBox: true,
            showCharacterThoughts: true,
            showQuests: false,
            perChatCharacterTracking: true,
            npcAvatars: { Вера: 'vera.png' },
            trackerConfig: {
                infoBox: {
                    widgets: {
                        date: { enabled: true },
                        time: { enabled: true },
                        location: { enabled: true },
                        recentEvents: { enabled: true },
                        weather: { enabled: true },
                        temperature: { enabled: true, unit: 'C' },
                    },
                },
                presentCharacters: {
                    relationships: { enabled: true },
                    relationshipFields: ['Друг', 'Враг', 'Нейтральный'],
                    customFields: [
                        { id: 'appearance', name: 'Внешность', enabled: true, description: 'Как выглядит' },
                        { id: 'demeanor', name: 'Поведение', enabled: true, description: 'Как держится' },
                        { id: 'outfit', name: 'Одежда', enabled: true, description: 'Во что одет' },
                    ],
                    thoughts: { enabled: true, description: 'Мысли' },
                    characterStats: { enabled: true, customStats: [{ id: 'trust', name: 'Trust', enabled: true }] },
                },
            },
        },
        state: {
            lastGeneratedData: { quests: null, infoBox: null, characterThoughts: null, html: null },
            committedTrackerData: { quests: null, infoBox: null, characterThoughts: null },
        },
        roster: { Старик: { emoji: '🧓' } },
        renders: [],
        saves: 0,
        rosterSaves: 0,
    };
    const modules = new Map<string, Dict>();
    const add = (path: string, namespace: Dict) => modules.set(`${BASE}${path}`, namespace);
    const render = (name: string) => () => void des.renders.push(name);
    add('src/core/state.js', {
        get lastGeneratedData() {
            return des.state.lastGeneratedData;
        },
        get committedTrackerData() {
            return des.state.committedTrackerData;
        },
        isGenerating: false,
        updateLastGeneratedData: (patch: Dict) => Object.assign(des.state.lastGeneratedData, patch),
        updateCommittedTrackerData: (patch: Dict) => Object.assign(des.state.committedTrackerData, patch),
    });
    add('src/core/persistence.js', {
        saveChatData: async () => {
            des.saves++;
        },
        getActiveKnownCharacters: () => des.roster,
        saveCharacterRosterChange: () => {
            des.rosterSaves++;
        },
    });
    add('src/systems/generation/parser.js', { parseResponse: () => ({}), parseQuests: () => {} });
    add('src/systems/rendering/infoBox.js', { renderInfoBox: render('infoBox') });
    add('src/systems/rendering/thoughts.js', {
        renderThoughts: render('thoughts'),
        updateChatThoughts: render('chatThoughts'),
    });
    add('src/systems/rendering/sceneHeaders.js', {
        updateChatSceneHeaders: render('sceneHeaders'),
        resetSceneHeaderCache: render('sceneReset'),
    });
    add('src/systems/ui/portraitBar.js', { updatePortraitBar: render('portraitBar') });
    add('src/systems/ui/weatherEffects.js', { updateWeatherEffect: render('weather') });
    add('src/systems/rendering/trackerJsonInline.js', {
        syncTrackerJsonForMessage: (index: number) => void des.renders.push(`json:${index}`),
    });
    env.host.modules.load = async (path: string) => {
        const namespace = modules.get(path);
        if (!namespace) throw new Error(`no module ${path}`);
        return namespace;
    };
    (env.app.adapters as unknown as Dict).des = {
        id: 'des',
        present: () => des.present,
        enabled: () => true,
        version: () => '2.6.0',
        capabilities: () => [],
        ready: async () => {},
        settings: () => des.settings,
        generationMode: () => des.mode,
        isWorkshopOpen: () => des.workshop,
        extensionName: () => DES_NAME,
        rosterPerChat: () => des.perChat,
    };
    return des;
}

interface FakeEphemeral {
    producers: Map<string, (gen: GenerationInfo) => void | Promise<void>>;
    injections: Map<string, InjectionSpec>;
    run(gen?: Partial<GenerationInfo>): Promise<void>;
}

function installEphemeral(env: PrepareEnv): FakeEphemeral {
    const fake: FakeEphemeral = {
        producers: new Map(),
        injections: new Map(),
        async run(gen = {}) {
            fake.injections.clear();
            for (const producer of fake.producers.values()) {
                await producer({ type: 'normal', dryRun: false, quiet: false, ...gen });
            }
        },
    };
    env.app.ephemeral = {
        setFlag() {},
        setInjection: (key, spec) => void fake.injections.set(key, spec),
        addProducer: (name, producer) => {
            fake.producers.set(name, producer);
            return () => fake.producers.delete(name);
        },
        clearAll: () => fake.injections.clear(),
    };
    return fake;
}

/** NAI Studio 0.14's portrait redraw (recorded). */
function installPortraits(env: PrepareEnv): string[] {
    const asked: string[] = [];
    const nai = (env.app.adapters as unknown as Dict).nai as Dict;
    nai.canRequestDesPortrait = () => true;
    nai.requestDesPortrait = async (name: string) => {
        asked.push(name);
        return true;
    };
    return asked;
}

/** «Доверие» tracked as a DES stat (DES's «Trust»). */
function trustMechanic(): MechanicDef {
    return {
        id: 'trust',
        name: 'Доверие',
        promptName: 'Trust',
        summary: 'How much they trust the player.',
        rules: '',
        attributes: [
            { id: 'trust', name: 'Доверие', promptName: 'Trust', kind: 'number', min: 0, max: 100, initial: 50 },
        ],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'desStats',
        scope: { kind: 'chat', chatId: 'chat-1' },
    } as MechanicDef;
}

let env: PrepareEnv;
let des: FakeDes;
let ephemeral: FakeEphemeral;
let portraits: string[];
let started: Started;
let dramatis: InstalledDramatis | null = null;

/** The greetings of the stand's card as message 0 carries them (its swipes, raw like ST keeps them). */
function greetings(): string[] {
    const data = (env.mock.context.characters[0] as unknown as Dict).data as Dict;
    return [String(data.first_mes), ...(data.alternate_greetings as string[])];
}

/** A greeting-only chat that opened on greeting n (ST: swipes, swipe_info with empty extras). */
function openOn(n: number): void {
    const list = greetings();
    const first = env.mock.chat[0]!;
    first.swipes = list;
    first.swipe_id = n;
    first.mes = list[n]!;
    first.extra = {};
    first.swipe_info = list.map(() => ({ send_date: '', extra: {} })) as never;
}

/** ST's swipe of message 0: syncMesToSwipe, syncSwipeToMes, then MESSAGE_SWIPED. */
async function stSwipe(n: number): Promise<void> {
    const first = env.mock.chat[0]! as unknown as Dict;
    const info = first.swipe_info as Dict[];
    info[first.swipe_id as number]!.extra = structuredClone(first.extra);
    first.swipe_id = n;
    first.mes = (first.swipes as string[])[n];
    first.extra = structuredClone(info[n]!.extra ?? {});
    await env.mock.eventSource.emit('message_swiped', 0);
    await settle(30);
}

/** Records of message 0 by swipe, where ST keeps them. */
function recordOf(n: number): Dict | undefined {
    const first = env.mock.chat[0]! as unknown as Dict;
    const holder = n === first.swipe_id ? first : (first.swipe_info as Dict[])[n];
    const swipes = ((holder?.extra as Dict | undefined)?.dooms_tracker_swipes ?? {}) as Dict;
    return swipes[String(n)] as Dict | undefined;
}

function charactersOf(record: Dict | undefined): Dict[] {
    return JSON.parse(String(record?.characterThoughts ?? '[]')) as Dict[];
}

function namesOf(record: Dict | undefined): string[] {
    return charactersOf(record).map((item) => String(item.name));
}

function presentOf(record: Dict | undefined): string[] {
    return charactersOf(record)
        .filter((item) => !/off-scene/.test(String((item.thoughts as Dict | undefined)?.content ?? '')))
        .map((item) => String(item.name));
}

async function scenes(): Promise<{ greeting: number; data: { present: string[]; place: string } }[]> {
    const doc = await env.app.chat.get<Dict>(SCENES_DOC, () => ({}));
    return (doc.scenes ?? []) as never;
}

async function applyAll(options: Dict = {}) {
    await analyse(started.service);
    const summary = await started.service.apply('all', { passports: false, ...options });
    await settle(30);
    return summary;
}

function seedRequests() {
    return env.llm.requests.filter((request) => request.task === DES_SEED_TASK);
}

beforeEach(() => {
    env = createPrepareEnv();
    des = installDes(env);
    ephemeral = installEphemeral(env);
    portraits = installPortraits(env);
    env.mechanics.defs = [trustMechanic()];
    openOn(0);
    started = startPrepare(env);
});

afterEach(() => {
    started.stop();
    dramatis?.remove();
    dramatis = null;
});

describe('applying: every greeting gets its DES record', () => {
    it('writes the shown greeting into extra, the others into swipe_info, from one model task per greeting', async () => {
        const summary = await applyAll();
        const requests = seedRequests();
        expect(requests).toHaveLength(3);
        expect(
            requests.every((request) => request.interactive === true && request.schema?.name === 'maestro_des_seed'),
        ).toBe(true);
        const stored = await scenes();
        expect(stored.map((scene) => scene.greeting)).toEqual([0, 1, 2]);
        for (const scene of stored) {
            const record = recordOf(scene.greeting);
            expect(record?.quests).toBeNull();
            const persona = 'Кай';
            expect(namesOf(record)).not.toContain(persona);
            // Presence is the prepared scene's.
            expect(presentOf(record).sort()).toEqual(scene.data.present.filter((name) => name !== persona).sort());
            const box = JSON.parse(String(record?.infoBox)) as Dict;
            expect(box.location).toEqual({ value: scene.data.place });
            expect(box.time).toMatchObject({ start: expect.stringMatching(/^\d\d:\d\d$/) });
        }
        // The tavern in the rain: rain, the evening, the cloak in Russian in «Одежда».
        const tavern = JSON.parse(String(recordOf(0)?.infoBox)) as Dict;
        expect(tavern.weather).toEqual({ emoji: '🌧️', forecast: 'дождь' });
        expect(tavern.time).toEqual({ start: '19:00', end: '19:00' });
        const first = charactersOf(recordOf(0))[0]!;
        expect(first.details).toMatchObject({ Одежда: 'тёмно-зелёный плащ' });
        expect(first.relationship).toEqual({ status: 'Нейтральный' });
        expect(first.thoughts).toMatchObject({ content: expect.stringContaining('наёмник') });
        // The archive at night: the robe, 23:00.
        const archive = charactersOf(recordOf(2));
        expect(archive.map((item) => item.name)).toContain('Мартин');
        expect(archive.find((item) => item.name === 'Мартин')?.details).toMatchObject({
            Одежда: 'потёртая мантия архивариуса',
        });
        expect(JSON.parse(String(recordOf(2)?.infoBox)).time).toEqual({ start: '23:00', end: '23:00' });

        // DES shows and generates from the shown greeting's record.
        expect(des.state.lastGeneratedData.characterThoughts).toBe(recordOf(0)?.characterThoughts);
        expect(des.state.committedTrackerData.infoBox).toBe(recordOf(0)?.infoBox);
        expect(des.renders).toEqual(
            expect.arrayContaining(['infoBox', 'thoughts', 'portraitBar', 'weather', 'json:0']),
        );
        expect(des.saves).toBeGreaterThan(0);
        // The roster: the present characters in, the old name kept.
        expect(Object.keys(des.roster).sort()).toEqual(['Старик', ...presentOf(recordOf(0))].sort());

        const line = summary.done.find((item) => item.itemId === DES_ITEM)!;
        expect(line.kind).toBe('des');
        expect(line.text).toMatch(/^Персонажи в DES: Сцена 1 \(Солёный якорь\) — /);
        expect(line.journalId).toBeTruthy();
        const record = env.journal.records.find((item) => item.id === line.journalId)!;
        expect(record.changes[0]!.ref).toMatchObject({ step: 'desSeed', chatId: 'chat-1' });
        expect(env.ui.notices.some((notice) => notice.text.startsWith('В DES — персонажи первой сцены:'))).toBe(true);
        expect(started.service.api().desSeeded()).toBe(true);
        expect(preparedStart(env.app, 0)).toBe(true);
        expect(preparedStart(env.app, 2)).toBe(false);
    });

    it('takes stats from the mechanics and asks NAI Studio for the portraits of new faces only', async () => {
        await applyAll();
        const tavern = charactersOf(recordOf(0));
        const elizabeth = tavern.find((item) => item.name === 'Элизабет');
        // The preparation set Elizabeth's Trust to 40; the others get the attribute's initial 50.
        if (elizabeth) expect(elizabeth.stats).toEqual([{ name: 'Trust', value: 40 }]);
        for (const item of tavern.filter((one) => one.name !== 'Элизабет')) {
            expect(item.stats).toEqual([{ name: 'Trust', value: 50 }]);
        }
        const seedText = seedRequests()[0]!.messages[1]!.content;
        expect(seedText).toContain('DES stats: Trust');
        // Вера already has a DES portrait; the card's own character and the player never.
        expect(portraits).not.toContain('Вера');
        expect(portraits).not.toContain('Кай');
        expect(portraits.length).toBeGreaterThan(0);
        expect(new Set(portraits).size).toBe(portraits.length);
        const doc = await env.app.chat.get<Dict>(DES_DOC, () => ({}));
        expect(doc.portraits).toEqual(portraits);
    });

    it("takes Dramatis's starting scene: presence, doings and the stance toward the player", async () => {
        dramatis = installDramatis(env.app);
        dramatis.api.starts = {
            0: [
                { name: 'Томас', present: true, doing: 'polishes mugs', stance: -2, stanceLabel: 'Враждебен' },
                { name: 'Мартин', present: true, goal: 'find the register' },
            ],
        };
        await applyAll();
        const tavern = charactersOf(recordOf(0));
        expect(presentOf(recordOf(0))).toContain('Мартин');
        expect(tavern.find((item) => item.name === 'Томас')?.relationship).toEqual({ status: 'Враг' });
        const text = seedRequests().find((request) => request.messages[1]!.content.includes('Солёный якорь'))!
            .messages[1]!.content;
        expect(text).toContain('Doing: polishes mugs.');
        expect(text).toContain('Stance toward Кай: Враждебен (-2 of -3..+3).');
    });

    it('gives a greeting the model failed for its names only and says so', async () => {
        await analyse(started.service);
        env.llm.fail = true;
        const summary = await started.service.apply('all', { passports: false });
        await settle(30);
        const record = recordOf(1);
        const scene = (await scenes()).find((item) => item.greeting === 1)!;
        expect(charactersOf(record).every((item) => item.emoji === '👤' && !item.details)).toBe(true);
        expect(presentOf(record).sort()).toEqual(scene.data.present.filter((name) => name !== 'Кай').sort());
        expect(summary.failed.some((line) => line.itemId === DES_ITEM && /модель не ответила/.test(line.text))).toBe(
            true,
        );
    });

    it('the saved preparation of the character seeds the next new chat without the model', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply(['scene:0', 'scene:1', 'scene:2'].map((id) => ({ id, scope: 'character' as const })), {
            passports: false,
        });
        await settle(30);
        // A new chat of the card that opened on the archive at night.
        env.mock.chat.splice(0, env.mock.chat.length, { ...env.mock.chat[0]!, extra: {} });
        openOn(2);
        await switchChat(env.mock, 'chat-2', {});
        await settle(10);
        const requests = seedRequests().length;
        const summary = await service.applySaved({ passports: false });
        await settle(30);
        expect(seedRequests()).toHaveLength(requests);
        expect(summary.done.some((line) => line.itemId === DES_ITEM)).toBe(true);
        const archive = charactersOf(recordOf(2));
        expect(archive.map((item) => item.name)).toEqual(['Мартин']);
        expect(archive[0]).toMatchObject({ emoji: '👤' });
        expect(archive[0]!.details).toBeUndefined();
        expect(des.state.lastGeneratedData.characterThoughts).toBe(recordOf(2)?.characterThoughts);
    });

    it('does nothing when switched off, without DES, or when DES shows nothing', async () => {
        await applyAll({ desSeed: false });
        expect(seedRequests()).toHaveLength(0);
        expect(recordOf(0)).toBeUndefined();
        expect(started.service.api().desSeedOffered()).toBe(true);
        des.settings.showInfoBox = false;
        des.settings.showCharacterThoughts = false;
        expect(started.service.api().desSeedOffered()).toBe(false);
        des.present = false;
        const summary = await started.service.apply('all', { passports: false });
        expect(summary.done.some((line) => line.itemId === DES_ITEM)).toBe(false);
    });

    it("writes nothing while DES's Workshop is open", async () => {
        des.workshop = true;
        const summary = await applyAll();
        expect(recordOf(0)).toBeUndefined();
        expect(summary.failed.some((line) => line.itemId === DES_ITEM && /Мастерская DES/.test(line.text))).toBe(true);
    });
});

describe('DES writes over the greeting', () => {
    it('puts the seeds back after first_message while the player has not written', async () => {
        await applyAll();
        const seeded = { ...recordOf(0)! };
        // DES's together-mode handler of MESSAGE_RECEIVED(0, 'first_message'): an empty record of the greeting.
        (env.mock.chat[0]!.extra as Dict).dooms_tracker_swipes = {
            0: { quests: null, infoBox: null, characterThoughts: null },
        };
        await env.mock.eventSource.emit('message_received', 0, 'first_message');
        await settle(30);
        expect(recordOf(0)).toEqual(seeded);
    });

    it('rebuilds every record after the card is saved again (ST makes message 0 anew)', async () => {
        await applyAll();
        const before = [0, 1, 2].map((n) => recordOf(n));
        openOn(0);
        await env.mock.eventSource.emit('message_received', 0, 'first_message');
        await settle(30);
        expect([0, 1, 2].map((n) => recordOf(n))).toEqual(before);
    });

    it('leaves the greeting alone once the player has written', async () => {
        await applyAll();
        env.mock.chat.push({ name: 'Кай', is_user: true, is_system: false, send_date: '', mes: 'Привет', extra: {} });
        (env.mock.chat[0]!.extra as Dict).dooms_tracker_swipes = {
            0: { quests: null, infoBox: null, characterThoughts: null },
        };
        await env.mock.eventSource.emit('message_received', 0, 'first_message');
        await settle(30);
        expect(recordOf(0)).toEqual({ quests: null, infoBox: null, characterThoughts: null });
        expect(started.service.api().desSeeded()).toBe(true);
    });
});

describe('a swipe of message 0', () => {
    it("switches DES to that greeting's cast and takes the previous greeting's names off the roster", async () => {
        await applyAll();
        const tavern = presentOf(recordOf(0));
        await stSwipe(2);
        const archive = presentOf(recordOf(2));
        expect(des.state.lastGeneratedData.characterThoughts).toBe(recordOf(2)?.characterThoughts);
        expect(des.state.committedTrackerData.characterThoughts).toBe(recordOf(2)?.characterThoughts);
        const roster = Object.keys(des.roster);
        for (const name of archive) expect(roster).toContain(name);
        for (const name of tavern.filter((one) => !archive.includes(one))) expect(roster).not.toContain(name);
        expect(roster).toContain('Старик');
        // Back to the tavern: its record is still where ST keeps it.
        await stSwipe(0);
        expect(presentOf(recordOf(0))).toEqual(tavern);
        expect(des.state.lastGeneratedData.characterThoughts).toBe(recordOf(0)?.characterThoughts);
    });
});

describe('the first turn in together mode', () => {
    async function firstTurn(): Promise<InjectionSpec | undefined> {
        await env.mock.eventSource.emit('generation_started', 'normal', {}, false);
        env.mock.chat.push({ name: 'Кай', is_user: true, is_system: false, send_date: '', mes: 'Привет', extra: {} });
        await ephemeral.run();
        return ephemeral.injections.get(DES_INJECTION);
    }

    it('puts the opening tracker in once, as DES would put the previous one', async () => {
        await applyAll();
        const injection = await firstTurn();
        expect(injection).toMatchObject({ position: 1, depth: 1, role: 0, scan: false });
        expect(injection!.text).toContain('```json');
        expect(injection!.text).toContain('"characters"');
        expect(injection!.text).toContain(presentOf(recordOf(0))[0]!);
        // The next generation (the chat has grown) gets nothing.
        await ephemeral.run();
        expect(ephemeral.injections.has(DES_INJECTION)).toBe(false);
    });

    it('stays out in separate mode, when DES left its own block out, or without a seed', async () => {
        await applyAll();
        des.mode = 'separate';
        expect(await firstTurn()).toBeUndefined();
        env.mock.chat.pop();
        des.mode = 'together';
        env.mock.context.extensionPrompts = {
            'dooms-tracker-inject': { value: '', position: 1, depth: 0, scan: false, role: 1 },
        };
        expect(await firstTurn()).toBeUndefined();
    });

    it('stays out for a regeneration (DES already has an assistant message to hang its block on)', async () => {
        await applyAll();
        env.mock.chat.push({ name: 'Кай', is_user: true, is_system: false, send_date: '', mes: 'Привет', extra: {} });
        await env.mock.eventSource.emit('generation_started', 'regenerate', {}, false);
        await ephemeral.run({ type: 'regenerate' });
        expect(ephemeral.injections.has(DES_INJECTION)).toBe(false);
    });
});

describe('undo', () => {
    it('takes the records, the display and the roster names back', async () => {
        const summary = await applyAll();
        const line = summary.done.find((item) => item.itemId === DES_ITEM)!;
        expect(await started.service.api().undoItem(DES_ITEM)).toBe(true);
        expect(env.journal.records.find((item) => item.id === line.journalId)?.undone).toBe(true);
        expect(recordOf(0)).toBeUndefined();
        expect(recordOf(1)).toBeUndefined();
        expect(des.state.lastGeneratedData.characterThoughts).toBeNull();
        expect(Object.keys(des.roster)).toEqual(['Старик']);
        const doc = await env.app.chat.get<Dict>(DES_DOC, () => ({}));
        expect(doc.seeds).toEqual([]);
        expect(started.service.api().desSeeded()).toBe(false);
    });

    it('after the first message takes only the records back: DES shows the later replies', async () => {
        await applyAll();
        env.mock.chat.push({ name: 'Кай', is_user: true, is_system: false, send_date: '', mes: 'Привет', extra: {} });
        des.state.lastGeneratedData.characterThoughts = '[{"name":"Позже"}]';
        const roster = Object.keys(des.roster);
        expect(await started.service.api().undoItem(DES_ITEM)).toBe(true);
        expect(recordOf(0)).toBeUndefined();
        expect(des.state.lastGeneratedData.characterThoughts).toBe('[{"name":"Позже"}]');
        expect(Object.keys(des.roster)).toEqual(roster);
    });

    it("is refused while DES's Workshop is open", async () => {
        const summary = await applyAll();
        const line = summary.done.find((item) => item.itemId === DES_ITEM)!;
        des.workshop = true;
        expect(await env.journal.undo(line.journalId!)).toBe(false);
        expect(recordOf(0)).toBeDefined();
        expect(env.ui.notices.some((notice) => /Мастерскую DES/.test(notice.text))).toBe(true);
    });
});

describe('neighbours', () => {
    it("keeps DES's global roster untouched without per-chat tracking", async () => {
        des.perChat = false;
        await applyAll();
        expect(Object.keys(des.roster)).toEqual(['Старик']);
        expect(des.rosterSaves).toBe(0);
        expect(recordOf(0)).toBeDefined();
    });

    it('works without the NAI portrait feature', async () => {
        const nai = (env.app.adapters as unknown as Dict).nai as Dict;
        delete nai.requestDesPortrait;
        const spy = vi.fn();
        nai.canRequestDesPortrait = spy;
        await applyAll();
        expect(recordOf(0)).toBeDefined();
        expect(spy).not.toHaveBeenCalled();
    });
});
