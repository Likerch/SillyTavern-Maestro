// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareModule } from '../../../src/features/prepare';
import type { PrepareApi } from '../../../src/features/prepare/api';
import { PREPARE_STEP_TARGET } from '../../../src/features/prepare/settings';
import type { SlashCommandSpec } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import {
    ARCHIVE,
    AVATAR,
    WORLD,
    analyse,
    clone,
    createPrepareEnv,
    greetingMessage,
    settle,
    startPrepare,
} from './helpers';
import type { PrepareEnv, Started } from './helpers';

type Dict = Record<string, unknown>;

let env: PrepareEnv;
let started: Started;

beforeEach(() => {
    env = createPrepareEnv();
    started = startPrepare(env);
});

afterEach(() => {
    started.stop();
});

function userText(index = 0): string {
    return env.llm.requests[index]?.messages.find((message) => message.role === 'user')?.content ?? '';
}

describe('prepare: which chats', () => {
    it('is offered only in a new one-on-one chat with a card', () => {
        const { service } = started;
        expect(service.eligibility()).toEqual({ ok: true });
        expect(service.isNewChat()).toBe(true);
        env.mock.chat.push({ ...greetingMessage({ name: 'Кай', data: { first_mes: 'Привет' } }), is_user: true });
        expect(service.eligibility()).toEqual({ ok: false, reason: 'started' });
        env.mock.chat.pop();
        env.host.group = true;
        expect(service.eligibility()).toEqual({ ok: false, reason: 'group' });
        env.host.group = false;
        env.mock.context.characterId = undefined;
        expect(service.eligibility()).toEqual({ ok: false, reason: 'noCard' });
        env.mock.chatId = undefined;
        expect(service.eligibility()).toEqual({ ok: false, reason: 'noChat' });
    });

    it('does not start where it is not offered', async () => {
        env.host.group = true;
        expect(await started.service.start()).toBeNull();
        expect(env.llm.requests).toHaveLength(0);
    });
});

describe('prepare: what is read and what it costs', () => {
    it('reads the card, the persona, the card book and the archives of this story only', async () => {
        const estimate = await started.service.estimate();
        expect(estimate.chunks).toBe(2);
        expect(estimate.usd).toBeGreaterThan(0);
        expect(estimate.labels).toEqual(
            expect.arrayContaining([
                'Описание карточки',
                'Выбранное приветствие',
                'Твоя персона',
                `${WORLD} · Silver Harbor`,
            ]),
        );
        expect(estimate.labels.some((label) => label.startsWith(`${ARCHIVE} · Элизабет`))).toBe(true);
        expect(estimate.labels.some((label) => label.includes('Офелия'))).toBe(false);
        expect(estimate.skippedLabels).toEqual([]);
    });

    it('splits big books into parts and leaves out what does not fit', async () => {
        env.settings.module<Dict>('prepare').chunkChars = 4000;
        env.settings.module<Dict>('prepare').maxChunks = 2;
        const estimate = await started.service.estimate();
        expect(estimate.chunks).toBe(2);
        expect(estimate.skipped).toBeGreaterThan(10);
        expect(estimate.skippedLabels.length).toBe(estimate.skipped);
    });

    it('never reads BunnyMo packs or Maestro books as story sources', async () => {
        env.mock.chatMetadata.world_info = 'BunnyMo Species';
        env.books.set('BunnyMo Species', {
            entries: { 0: { uid: 0, comment: 'Elf', key: ['<SPECIES:ELF>'], content: 'Elves.' } },
        });
        env.roles.roles.set('BunnyMo Species', 'bunnymo.pack');
        const estimate = await started.service.estimate();
        expect(estimate.labels.some((label) => label.startsWith('BunnyMo'))).toBe(false);
        // A Maestro book bound as the chat book (no role known) is Maestro's own data, not the story.
        env.mock.chatMetadata.world_info = 'Maestro · механики';
        env.books.set('Maestro · механики', {
            entries: { 0: { uid: 0, comment: 'Magic', key: [], content: 'Mechanic: Magic' } },
        });
        const again = await started.service.estimate();
        expect(again.labels.some((label) => label.startsWith('Maestro'))).toBe(false);
    });

    it('repairs a hand-edited settings slice', () => {
        const slice = env.settings.module<Dict>('prepare');
        Object.assign(slice, { chunkChars: 10, maxChunks: 'many', defaultScope: 'everywhere', passports: 1 });
        expect(env.prepareSettings()).toMatchObject({
            chunkChars: 4000,
            maxChunks: 8,
            defaultScope: 'chat',
            passports: true,
        });
    });
});

describe('prepare: the analysis', () => {
    it('runs as a user job and keeps the plan of the chat', async () => {
        env.canon.seed(
            {
                comment: 'Vera',
                key: ['Vera', 'Вера'],
                content: 'Character: Vera\nRole: Innkeeper of a mountain inn far away',
            },
            { type: 'character' },
        );
        const { service } = started;
        const key = await service.start();
        expect(key).toBe('prepare:chat-1');
        expect(service.state().stage).toBe('running');
        expect(await service.start()).toBeNull();
        await service.whenDone();
        await settle(5);
        const request = env.llm.requests[0]!;
        expect(request.task).toBe('prepare');
        expect(request.schema?.name).toBe('maestro_prepare');
        expect(userText()).toContain('Canon: Vera');
        const job = env.app.jobs!.get(key!);
        expect(job?.state).toBe('done');
        expect(job?.summary).toMatch(/Сценарий разобран, пунктов: \d+/);
        const plan = service.plan()!;
        expect(service.state().stage).toBe('ready');
        expect(plan.card).toEqual({ avatar: AVATAR, name: 'Хроники Серебряной Гавани' });
        expect(plan.chunks).toBe(2);
        expect(plan.costUsd).toBeCloseTo(0.002);
        expect(userText(1)).toContain('part 2 of 2');
        const ids = plan.items.map((item) => item.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                'character:elizabet',
                'character:vera',
                'place:silver harbor',
                'faction:house arden',
                'mechanic:trust',
                'time',
                'scene',
                'direction',
            ]),
        );
        // A book entry and the card both name the harbour: one place with both sources.
        const harbour = plan.items.find((item) => item.id === 'place:silver harbor')!;
        expect(harbour.sources).toEqual(expect.arrayContaining(['card.description', `book:${WORLD}#1`]));
        const vera = plan.items.find((item) => item.id === 'character:vera')!;
        expect(vera.exists).toEqual({ where: 'canon', label: 'Vera', ref: 0 });
        expect(vera.conflicts?.[0]?.field).toBe('role');
        expect(vera.russian).toMatch(/капитан портовой стражи/);
        expect(plan.sources.find((source) => source.id === 'card.description')?.label).toBe('Описание карточки');
        // The plan survives a reload of the chat document.
        await switchChat(env.mock, 'chat-1', env.mock.chatMetadata);
        await settle(10);
        expect((await service.load())?.items.length).toBe(plan.items.length);
    });

    it('keeps what was read when stopped and reports failed parts', async () => {
        env.settings.module<Dict>('prepare').chunkChars = 4000;
        let release!: () => void;
        env.llm.gate = new Promise<void>((next) => {
            release = next;
        });
        const { service } = started;
        await service.start();
        await settle(10);
        expect(env.llm.requests).toHaveLength(1);
        expect(service.cancel()).toBe(true);
        release();
        await service.whenDone();
        await settle(5);
        const plan = service.plan()!;
        expect(plan.partial).toBe(true);
        expect(env.llm.requests).toHaveLength(1);
        expect(env.app.jobs!.get('prepare:chat-1')?.state).toBe('cancelled');
    });

    it('fails clearly when the model answers nothing', async () => {
        env.llm.fail = true;
        const { service } = started;
        await analyse(service);
        expect(service.state().stage).toBe('failed');
        expect(service.state().error).toContain('boom');
        expect(env.app.jobs!.get('prepare:chat-1')?.state).toBe('failed');
    });
});

describe('prepare: apply for the chat', () => {
    beforeEach(async () => {
        await analyse(started.service);
    });

    it('writes every part through its module and journals each part on its own', async () => {
        const { service } = started;
        const summary = await service.apply('all');
        expect(summary.failed).toEqual([]);
        // Canon: typed English entries with Russian keys from DES-RU.
        const canon = await env.canon.list();
        const elizabeth = canon.find((item) => item.entry.comment === 'Elizabet')!;
        expect(elizabeth.meta).toMatchObject({ kind: 'addition', origin: 'import', type: 'character' });
        expect(elizabeth.entry.key).toEqual(expect.arrayContaining(['Элизабет', 'Elizabet']));
        expect(String(elizabeth.entry.content)).toMatch(/^Character: Elizabet\n/);
        // Places: nested, bound to their entries.
        const harbour = env.places.resolve('Серебряная Гавань')!;
        const tavern = env.places.resolve('Солёный якорь')!;
        expect(tavern.parent).toBe(harbour.id);
        expect(harbour.aliases).toContain('Silver Harbor');
        expect(harbour.entry?.world).toBe('Maestro · канон · chat-1');
        // Passports: generated as text by NAI Studio, kept in the chat.
        expect(env.nai.generated.length).toBeGreaterThan(0);
        expect(env.nai.generated[0]!.description).toContain('Appearance:');
        expect(env.nai.saves.every((save) => save.scope === 'chat')).toBe(true);
        expect(env.nai.chat.map((passport) => passport.name)).toContain('Элизабет');
        // Secret, mechanic with its starting value, director's first scene.
        expect(env.knowledge.facts()[0]?.text).toContain('missing cargo');
        const trust = env.mechanics.list().find((def) => def.promptName === 'Trust')!;
        expect(trust.scope).toEqual({ kind: 'chat', chatId: 'chat-1' });
        expect(env.mechanics.value(trust.id, 'Элизабет', 'trust')).toBe(40);
        expect(env.director.overrideType).toBe('dialogue');
        // Outfits went into the passports generated now: the wardrobe is not asked again.
        expect(env.wardrobe.intakes).toEqual([]);
        // One record per part, kind 'prepare.apply', story words.
        const records = env.journal.records.filter((record) => record.kind === 'prepare.apply');
        expect(records.length).toBe(summary.done.length);
        expect(records.every((record) => record.changes.every((change) => change.target === PREPARE_STEP_TARGET))).toBe(
            true,
        );
        const line = summary.done.find((row) => row.itemId === 'character:elizabet')!;
        expect(line.text).toBe('Элизабет: в канон, паспорт');
        expect(line.journalId).toBeTruthy();
        expect(summary.proposals.some((text) => text.includes('tavern-rain.jpg'))).toBe(true);
        expect(env.ui.notices.at(-1)?.text).toMatch(/Подготовка применена, частей: \d+/);
        // The plan now marks it «уже есть»; the stage is applied.
        expect(service.state().stage).toBe('applied');
        expect(service.plan()!.items.find((item) => item.id === 'character:elizabet')?.exists?.where).toBe('canon');
        const status = await service.status();
        expect(status.lines).toContain('Нет портрета: Элизабет');
        expect(status.lines.some((text) => text.startsWith('Нет паспорта'))).toBe(false);
    });

    it('undoes one part and leaves the others', async () => {
        const { service } = started;
        await service.apply('all');
        const before = (await env.canon.list()).length;
        expect(await service.undoItem('character:elizabet')).toBe(true);
        const canon = await env.canon.list();
        expect(canon.length).toBe(before - 1);
        expect(canon.some((item) => item.entry.comment === 'Elizabet')).toBe(false);
        expect(env.nai.chat.some((passport) => passport.name === 'Элизабет')).toBe(false);
        expect(env.places.resolve('Серебряная Гавань')).toBeDefined();
        // A mechanic's undo takes the definition with its values; the place's undo removes it from the registry.
        const trustRecord = env.journal.records.find((record) => record.summary.startsWith('Подготовка: Доверие'))!;
        expect(await env.journal.undo(trustRecord.id)).toBe(true);
        expect(env.mechanics.list().some((def) => def.promptName === 'Trust')).toBe(false);
        const secretRecord = env.journal.records.find((record) => record.summary.includes('секрет'))!;
        expect(await env.journal.undo(secretRecord.id)).toBe(true);
        expect(env.knowledge.facts()).toEqual([]);
        const directionRecord = env.journal.records.find((record) => record.summary.includes('тип первой сцены'))!;
        expect(await env.journal.undo(directionRecord.id)).toBe(true);
        expect(env.director.overrideType).toBeNull();
    });

    it("keeps the user's edits: a changed canon entry is not removed by undo", async () => {
        const { service } = started;
        await service.apply([{ id: 'faction:house arden' }]);
        const item = (await env.canon.list()).find((row) => row.entry.comment === 'House Arden')!;
        await env.canon.put(
            { entry: { ...item.entry, content: 'Edited by hand.' }, meta: item.meta },
            { uid: item.uid },
        );
        expect(await service.undoItem('faction:house arden')).toBe(false);
        expect((await env.canon.list()).some((row) => row.uid === item.uid)).toBe(true);
    });

    it('applies only the chosen items, with edits, and skips what exists', async () => {
        const { service } = started;
        const summary = await service.apply([
            { id: 'character:vera', data: { role: 'Harbour captain.' } },
            { id: 'place:silver harbor' },
        ]);
        expect(summary.done.map((row) => row.itemId)).toEqual(['place:silver harbor', 'character:vera']);
        const vera = (await env.canon.list()).find((row) => row.entry.comment === 'Vera')!;
        expect(String(vera.entry.content)).toContain('Role: Harbour captain.');
        const again = await service.apply([{ id: 'place:silver harbor' }]);
        expect(again.done).toEqual([]);
        expect(again.skipped[0]?.text).toBe('Серебряная Гавань: место уже есть; уже есть в каноне');
    });

    it('releases the first scene after the first turn', async () => {
        await started.service.apply([{ id: 'direction' }]);
        expect(env.director.overrideType).toBe('dialogue');
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await settle(10);
        expect(env.director.overrideType).toBeNull();
        expect(env.director.calls).toEqual(['dialogue', null]);
    });

    it('works without the optional modules and passports', async () => {
        env.modules.apis.delete('knowledge');
        env.modules.apis.delete('mechanics');
        env.nai.generator = false;
        const summary = await started.service.apply('all');
        const skipped = [...summary.skipped, ...summary.done].map((row) => row.text).join('\n');
        expect(skipped).toContain('модуль «Кто что знает» выключен');
        expect(skipped).toContain('модуль «Механики» выключен');
        expect(summary.failed).toEqual([]);
        expect(env.nai.saves).toEqual([]);
    });
});

describe('prepare: for the character', () => {
    beforeEach(async () => {
        await analyse(started.service);
    });

    const forCard = (ids: string[]) => ids.map((id) => ({ id, scope: 'character' as const }));

    it('asks first and writes nothing when declined', async () => {
        env.ui.confirmAnswer = false;
        const summary = await started.service.apply(forCard(['character:elizabet']));
        expect(summary.cancelled).toBe(true);
        expect(await env.canon.list()).toEqual([]);
        expect(env.ui.confirms).toHaveLength(1);
    });

    it('keeps the texts in the card book, passports in the card and mechanics for the card', async () => {
        const { service } = started;
        const summary = await service.apply(
            forCard(['character:elizabet', 'place:silver harbor', 'mechanic:trust', 'secret:' + secretId()]),
        );
        expect(summary.failed).toEqual([]);
        expect(env.ui.confirms[0]?.body).toContain('Пунктов для персонажа: 4');
        const book = env.books.get('Maestro · подготовка · Хроники Серебряной Гавани')!;
        expect((book.extensions as Dict).maestro).toEqual({ role: 'maestro', kind: 'prepare', avatar: AVATAR });
        expect(env.roles.set).toContainEqual(['Maestro · подготовка · Хроники Серебряной Гавани', 'maestro']);
        const entries = Object.values(book.entries as Dict) as Dict[];
        expect(entries.every((entry) => entry.disable === true)).toBe(true);
        const ids = entries
            .map((entry) => ((entry.extensions as Dict).maestro as Dict).prepare as Dict)
            .map((row) => row.itemId);
        expect(ids).toEqual(expect.arrayContaining(['character:elizabet', 'place:silver harbor']));
        expect(env.nai.saves.find((save) => save.scope === 'card')).toMatchObject({ avatar: AVATAR });
        const trust = env.mechanics.list().find((def) => def.promptName === 'Trust')!;
        expect(trust.scope).toEqual({ kind: 'card', avatar: AVATAR });
        // Chat stores get it now as well.
        expect((await env.canon.list()).some((item) => item.entry.comment === 'Elizabet')).toBe(true);
        const saved = await service.savedFor();
        expect(saved?.items.map((item) => item.id)).toEqual(
            expect.arrayContaining(['character:elizabet', 'place:silver harbor', 'mechanic:trust']),
        );
        expect(saved?.book).toBe('Maestro · подготовка · Хроники Серебряной Гавани');
        expect(saved?.changed).toEqual([]);
    });

    it('a card passport cannot be undone by Maestro: the rest is, and the user is told', async () => {
        const { service } = started;
        await service.apply(forCard(['character:elizabet']));
        expect(await service.undoItem('character:elizabet')).toBe(false);
        expect((await env.canon.list()).some((item) => item.entry.comment === 'Elizabet')).toBe(false);
        const book = env.books.get('Maestro · подготовка · Хроники Серебряной Гавани')!;
        expect(Object.keys(book.entries as Dict)).toEqual([]);
        expect(env.ui.notices.at(-1)?.text).toContain('удали его в NAI Studio');
        // The item left the saved preparation with its book entry.
        expect((await service.savedFor())?.items ?? []).toEqual([]);
    });

    it('the next new chat of the card takes the saved preparation without the model', async () => {
        const { service } = started;
        await service.apply(forCard(['character:elizabet', 'place:silver harbor', 'mechanic:trust']));
        // The user edits the saved text in the Lore Studio.
        const name = 'Maestro · подготовка · Хроники Серебряной Гавани';
        const book = clone(env.books.get(name)!);
        for (const entry of Object.values(book.entries as Dict) as Dict[]) {
            if (entry.comment === 'Elizabet') entry.content = 'Character: Elizabet\nRole: Edited heiress.';
        }
        env.books.set(name, book);
        // A new chat of the same card.
        env.mock.chat.splice(
            0,
            env.mock.chat.length,
            greetingMessage(env.mock.context.characters[0] as unknown as Dict),
        );
        await switchChat(env.mock, 'chat-2', {});
        await settle(10);
        const requests = env.llm.requests.length;
        const info = await service.savedFor();
        expect(info?.items.length).toBe(3);
        const summary = await service.applySaved();
        expect(env.llm.requests.length).toBe(requests);
        const canon = await env.canon.list();
        expect(canon.find((item) => item.entry.comment === 'Elizabet')?.entry.content).toBe(
            'Character: Elizabet\nRole: Edited heiress.',
        );
        expect(env.places.list().filter((place) => place.name === 'Серебряная Гавань')).toHaveLength(1);
        // The card's mechanic and passport exist already: the mechanic only gets its starting values here.
        const lines = [...summary.done, ...summary.skipped].map((row) => row.text).join('\n');
        expect(lines).toContain('Элизабет: в канон');
        expect(env.nai.saves.filter((save) => save.scope === 'card')).toHaveLength(1);
        expect(env.journal.records.some((record) => record.kind === 'prepare.import')).toBe(true);
        expect(started.service.plan()?.reused).toBe(true);
    });

    it('reads again only what changed in the card and its books', async () => {
        const { service } = started;
        await service.apply(forCard(['character:elizabet', 'place:silver harbor']));
        const world = clone(env.books.get(WORLD)!);
        ((world.entries as Dict)['7'] as Dict).content = 'The Old Fort was rebuilt by the council last spring.';
        env.books.set(WORLD, world);
        env.mock.chat.splice(
            0,
            env.mock.chat.length,
            greetingMessage(env.mock.context.characters[0] as unknown as Dict),
        );
        await switchChat(env.mock, 'chat-3', {});
        await settle(10);
        const info = await service.savedFor();
        expect(info?.changed).toEqual([`${WORLD} · Old Fort`]);
        const estimate = await service.estimate({ reuse: true });
        expect(estimate.reuse).toBe(true);
        expect(estimate.labels).toEqual([`${WORLD} · Old Fort`]);
        const requests = env.llm.requests.length;
        await analyse(service, { reuse: true });
        expect(env.llm.requests.length).toBe(requests + 1);
        const text = userText(requests);
        expect(text).toContain('rebuilt by the council');
        expect(text).not.toContain('Salt Anchor');
        const plan = service.plan()!;
        expect(plan.reused).toBe(true);
        const elizabeth = plan.items.find((item) => item.id === 'character:elizabet')!;
        expect(elizabeth).toMatchObject({ saved: true, scope: 'character' });
        expect(plan.items.find((item) => item.id === 'place:old fort')?.saved).toBeUndefined();
    });
});

describe('prepare: the module', () => {
    it('registers its API, tab and command; the command analyses and lists the plan', async () => {
        started.stop();
        const owned: (() => void)[] = [];
        const tabs: string[] = [];
        let command: SlashCommandSpec | null = null;
        env.ui.addTab = (tab) => {
            tabs.push(tab.id);
            return () => {};
        };
        env.ui.addSlashCommand = (spec) => {
            command = spec;
            return () => {};
        };
        await prepareModule.init({
            app: env.app,
            settings: prepareModule.defaults(),
            log: env.app.log,
            own: (off) => void owned.push(off as () => void),
        });
        expect(tabs).toEqual(['prepare']);
        const api = env.modules.api<PrepareApi>('prepare')!;
        expect(api.isNewChat()).toBe(true);
        const text = await command!.callback({}, '');
        expect(text).toContain('Персонажи (');
        expect(text).toContain('• ');
        expect(api.plan()?.items.length).toBeGreaterThan(5);
        const status = await command!.callback({}, 'status');
        expect(status).toContain('Подготовка ещё не применена');
        for (const off of owned) off();
    });
});

/** The id of the mock's secret (a hash of its text). */
function secretId(): string {
    const plan = started.service.plan()!;
    const secret = plan.items.find((item) => item.kind === 'secret')!;
    return secret.id.slice('secret:'.length);
}
