// @vitest-environment happy-dom
// Every starting scene of the card (plan-2 §7): the stand's card has three greetings — the tavern in the rain, the
// harbour at dawn, the guild archive at night — and the analysis gives a scene for each. Applying keeps all of them for
// the chat; the scene of the greeting message 0 shows is the active one (outfits, the type of the first scene, the
// canon note «Story start»). A swipe of message 0 switches it until the player's first message; undo takes a scene
// back; a preparation saved for the character brings every scene into the next new chat, where the start follows the
// greeting shown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrepareItem } from '../../../src/domain/prepare-plan';
import { SCENES_DOC } from '../../../src/features/prepare/scenes';
import { switchChat } from '../../helpers/core-host';
import { analyse, createPrepareEnv, greetingMessage, settle, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

type Dict = Record<string, unknown>;

let env: PrepareEnv;
let started: Started;

beforeEach(() => {
    env = createPrepareEnv();
    started = startPrepare(env);
    show(0);
});

afterEach(() => {
    started.stop();
});

/** The greetings of the stand's card as message 0 carries them (its swipes). */
function greetings(): string[] {
    const data = (env.mock.context.characters[0] as unknown as Dict).data as Dict;
    return [String(data.first_mes), ...(data.alternate_greetings as string[])].map((text) =>
        text.replace(/\{\{user\}\}/g, 'Кай'),
    );
}

/** Message 0 shows greeting n. */
function show(n: number): void {
    const list = greetings();
    const first = env.mock.chat[0]!;
    first.swipes = list;
    first.swipe_id = n;
    first.mes = list[n]!;
}

async function until(check: () => boolean, ms = 1000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await settle(5);
    }
    await settle(5);
}

/** The player swipes message 0 to greeting n. */
async function swipe(n: number): Promise<void> {
    show(n);
    await env.mock.eventSource.emit('message_swiped', 0);
    await settle(20);
}

async function startNotes() {
    return (await env.canon.list()).filter((item) => item.entry.comment === 'Story start');
}

describe('prepare: every starting scene', () => {
    it('reads a scene per greeting and keeps the first words of each for the review', async () => {
        await analyse(started.service);
        const plan = started.service.plan()!;
        const scenes = plan.items.filter((item): item is PrepareItem<'scene'> => item.kind === 'scene');
        expect(scenes.map((item) => [item.id, item.data.place, item.data.time, item.data.firstScene])).toEqual([
            ['scene:0', 'Солёный якорь', 'вечер', 'dialogue'],
            ['scene:1', 'Серебряная Гавань', 'рассвет', 'exploration'],
            ['scene:2', 'Архив гильдии картографов', 'ночь', 'drama'],
        ]);
        // A Russian story («Язык истории» auto: a Russian greeting): the outfits are Russian.
        expect(scenes[1]!.data.outfits).toEqual([{ name: 'Вера', wearing: 'стёганая куртка портовой стражи' }]);
        expect(scenes[2]!.sources).toEqual(['greeting:2']);
        expect(scenes[2]!.russian).toContain('Архив гильдии картографов, ночь: Мартин');
        expect(plan.openings).toHaveLength(3);
        expect(plan.openings![1]).toMatch(/^Рассвет над Серебряной Гаванью/);
        expect(
            plan.sources.filter((source) => source.id.startsWith('greeting:')).map((source) => source.label),
        ).toEqual(['Стартовая сцена 1 (первое сообщение)', 'Стартовая сцена 2', 'Стартовая сцена 3']);
        // The model is told what is common and what belongs to one start; each greeting is a source of its own.
        const request = env.llm.requests[0]!.messages.find((message) => message.role === 'user')!.content;
        expect(request).toContain('Starting scene — greeting 0 (the first message, the one this chat opened with)');
        expect(request).toContain('Starting scene — greeting 2 (alternate greeting 2)');
        expect(request).toContain('Мартин в потёртой мантии архивариуса');
    });

    it('prepares all of them; the one shown is active: outfits, type of the first scene, the note of the start', async () => {
        const { service } = started;
        await analyse(service);
        const summary = await service.apply('all');
        expect(summary.failed).toEqual([]);
        const line = (id: string) => summary.done.find((row) => row.itemId === id)?.text;
        // The outfits of the shown start went into the passports made now: the wardrobe is not asked again.
        expect(line('scene:0')).toBe(
            'Сцена 1 (Солёный якорь): подготовлена, тип первой сцены, начало истории в каноне',
        );
        expect(line('scene:1')).toBe('Сцена 2 (Серебряная Гавань): подготовлена');
        expect(line('scene:2')).toBe('Сцена 3 (Архив гильдии картографов): подготовлена');
        expect(summary.skipped.find((row) => row.itemId === 'direction')?.text).toContain(
            'тип первой сцены задаёт стартовая сцена',
        );
        expect(service.startScenes()).toEqual({ shown: 0, prepared: [0, 1, 2], active: 0, locked: false });
        expect(env.director.overrideType).toBe('dialogue');
        expect(env.wardrobe.intakes).toEqual([]);
        expect(env.nai.generated.find((input) => input.name === 'Elizabet')).toMatchObject({
            language: 'ru',
            description: expect.stringContaining('Wearing when the story starts: тёмно-зелёный плащ'),
        });
        const notes = await startNotes();
        expect(notes).toHaveLength(1);
        // The canon note names the place and the cast in English; the Russian place name is a key.
        expect(String(notes[0]!.entry.content)).toContain('Where: Solenyy yakor');
        expect(String(notes[0]!.entry.content)).toContain('Present: Elizabet');
        expect(notes[0]!.entry.key).toContain('Солёный якорь');
        // Every scene is kept in the chat's document, each journaled as a part of its own.
        const doc = await env.app.chat.get<Dict>(SCENES_DOC, () => ({}));
        expect((doc.scenes as Dict[]).map((scene) => scene.greeting)).toEqual([0, 1, 2]);
        expect((doc.active as Dict).greeting).toBe(0);
        const stores = env.journal.records.filter((record) =>
            record.changes.some((change) => (change.ref as Dict).step === 'sceneStore'),
        );
        expect(stores).toHaveLength(3);
        const status = await service.status();
        expect(status.scenes).toEqual({
            prepared: 3,
            active: 0,
            line: 'Подготовлено стартовых сцен: 3. Сейчас в чате: Сцена 1 (Солёный якорь).',
        });
        expect(status.lines).toContain('Нет портрета: Томас');
        expect(status.lines).not.toContain('Нет портрета: Мартин');
    });

    it('a swipe of message 0 switches the active scene quietly before the first user message', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply('all');
        const [first] = await startNotes();
        const notices = env.ui.notices.length;

        await swipe(1);
        await until(() => service.startScenes().active === 1);
        expect(service.startScenes()).toMatchObject({ shown: 1, active: 1 });
        expect(env.director.overrideType).toBe('exploration');
        // A Russian outfit goes to the wardrobe as a Russian statement its parser reads.
        expect(env.wardrobe.intakes).toEqual([
            {
                entityName: 'Вера',
                value: 'Вера носит: стёганая куртка портовой стражи',
                evidence: '',
                sourceMessage: 0,
            },
        ]);
        // The note of the start is rewritten in place, not doubled.
        let notes = await startNotes();
        expect(notes).toHaveLength(1);
        expect(notes[0]!.uid).toBe(first!.uid);
        expect(String(notes[0]!.entry.content)).toContain('Where: Silver Harbor');
        expect(env.ui.notices.slice(notices).map((notice) => notice.text)).toEqual([
            'Стартовая сцена: Серебряная Гавань, рассвет',
        ]);
        expect(env.ui.notices.at(-1)?.options?.importance).toBe('info');
        const jacket = env.journal.records.filter((record) => record.kind === 'wardrobe.outfit').at(-1)!;

        await swipe(2);
        await until(() => service.startScenes().active === 2);
        // The previous start's outfit is taken back through the wardrobe's own record.
        expect(jacket.undone).toBe(true);
        expect(env.director.overrideType).toBe('drama');
        notes = await startNotes();
        expect(notes).toHaveLength(1);
        expect(String(notes[0]!.entry.content)).toContain('Where: Архив гильдии картографов');
        expect(env.wardrobe.intakes.at(-1)).toMatchObject({ entityName: 'Мартин' });
        const status = await service.status();
        expect(status.scenes?.line).toBe(
            'Подготовлено стартовых сцен: 3. Сейчас в чате: Сцена 3 (Архив гильдии картографов).',
        );
        expect(status.lines).toContain('Нет портрета: Мартин');
        expect(status.lines).not.toContain('Нет портрета: Томас');

        await swipe(0);
        await until(() => service.startScenes().active === 0);
        expect(env.director.overrideType).toBe('dialogue');
        expect(env.director.calls).toEqual(['dialogue', 'exploration', 'drama', 'dialogue']);
        // Back on the first start its outfits come through the wardrobe (no passport is made now).
        expect(env.wardrobe.intakes.slice(-3).map((intake) => intake.entityName)).toEqual([
            'Элизабет',
            'Вера',
            'Томас',
        ]);
        expect(await startNotes()).toHaveLength(1);
    });

    it('a greeting without a prepared scene leaves no start active; another swipe brings one back', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply([{ id: 'scene:0' }, { id: 'scene:2' }]);
        expect(service.startScenes()).toMatchObject({ prepared: [0, 2], active: 0 });
        await swipe(1);
        await until(() => service.startScenes().active === null);
        expect(env.director.overrideType).toBeNull();
        expect(await startNotes()).toEqual([]);
        expect(env.ui.notices.at(-1)?.text).toBe('Это приветствие не подготовлено — прежняя стартовая сцена снята');
        expect((await service.status()).scenes?.line).toBe(
            'Подготовлено стартовых сцен: 2. Для приветствия, что сейчас в чате, подготовки нет.',
        );
        await swipe(2);
        await until(() => service.startScenes().active === 2);
        expect(env.director.overrideType).toBe('drama');
        expect(await startNotes()).toHaveLength(1);
    });

    it('the first user message locks the start: later swipes change nothing, the first scene type is released', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply('all');
        env.mock.chat.push({ ...greetingMessage({ name: 'Кай', data: { first_mes: 'Привет' } }), is_user: true });
        const notices = env.ui.notices.length;
        await swipe(1);
        await until(() => service.startScenes().locked);
        expect(service.startScenes()).toMatchObject({ active: 0, locked: true });
        expect(env.director.overrideType).toBe('dialogue');
        expect(env.ui.notices.length).toBe(notices);
        // The greeting is committed by the first message: the first reply still gets the first scene's type.
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await settle(20);
        expect(env.director.overrideType).toBe('dialogue');
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        await until(() => env.director.overrideType === null);
        expect(env.director.calls).toEqual(['dialogue', null]);
        // The outfits and the note stay: they are the story now.
        expect(await startNotes()).toHaveLength(1);
        expect((await service.status()).scenes?.line).toBe(
            'Подготовлено стартовых сцен: 3. Игра началась: Сцена 1 (Солёный якорь).',
        );
    });

    it('the first committed turn locks a new chat too', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply('all');
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await until(() => service.startScenes().locked);
        await swipe(2);
        await settle(20);
        expect(service.startScenes().active).toBe(0);
        // Locked, but the first reply has not been committed yet: the first scene's type is still on.
        expect(env.director.overrideType).toBe('dialogue');
    });

    it('undoing a scene takes it out; undoing the active one takes its parts back', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply('all');
        expect(await service.undoItem('scene:1')).toBe(true);
        expect(service.startScenes()).toMatchObject({ prepared: [0, 2], active: 0 });
        expect(env.director.overrideType).toBe('dialogue');
        expect(await service.undoItem('scene:0')).toBe(true);
        expect(service.startScenes()).toMatchObject({ prepared: [2], active: null });
        expect(env.director.overrideType).toBeNull();
        expect(await startNotes()).toEqual([]);
        // The direction's type is free again: applying it now sets it.
        const again = await service.apply([{ id: 'direction' }]);
        expect(again.done.map((row) => row.itemId)).toEqual(['direction']);
        expect(env.director.overrideType).toBe('dialogue');
    });

    it('a scene applied again replaces the kept one; its undo brings the earlier one back', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply([{ id: 'scene:0' }]);
        await service.apply([{ id: 'scene:0', data: { place: 'Таверна у пристани', firstScene: 'social' } }]);
        expect(env.director.overrideType).toBe('social');
        let notes = await startNotes();
        expect(notes).toHaveLength(1);
        expect(String(notes[0]!.entry.content)).toContain('Where: Таверна у пристани');
        expect(await service.undoItem('scene:0')).toBe(true);
        await until(() => service.startScenes().active === 0);
        expect(env.director.overrideType).toBe('dialogue');
        notes = await startNotes();
        expect(notes).toHaveLength(1);
        expect(String(notes[0]!.entry.content)).toContain('Where: Solenyy yakor');
    });

    it('for the character: every scene comes into the next new chat, the active one follows the greeting shown', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply(['scene:0', 'scene:1', 'scene:2'].map((id) => ({ id, scope: 'character' as const })));
        expect((await service.savedFor())?.items.map((item) => item.id)).toEqual(['scene:0', 'scene:1', 'scene:2']);
        // A new chat of the card that opened on the archive at night.
        env.mock.chat.splice(
            0,
            env.mock.chat.length,
            greetingMessage(env.mock.context.characters[0] as unknown as Dict),
        );
        show(2);
        await switchChat(env.mock, 'chat-2', {});
        await settle(10);
        const requests = env.llm.requests.length;
        const summary = await service.applySaved();
        expect(env.llm.requests.length).toBe(requests);
        expect(summary.done.map((row) => row.itemId)).toEqual(['scene:0', 'scene:1', 'scene:2']);
        expect(service.startScenes()).toMatchObject({ shown: 2, prepared: [0, 1, 2], active: 2 });
        expect(env.director.overrideType).toBe('drama');
        expect(env.journal.records.filter((record) => record.kind === 'prepare.import')).toHaveLength(3);
        expect(service.plan()?.openings?.[2]).toMatch(/^Ночь\. В архиве гильдии/);
        await swipe(0);
        await until(() => service.startScenes().active === 0);
        expect(env.director.overrideType).toBe('dialogue');
        // Undoing an imported scene does not touch the saved preparation of the card.
        expect(await service.undoItem('scene:1')).toBe(true);
        expect((await service.savedFor())?.items).toHaveLength(3);
    });

    it('undoing a scene saved for the character forgets it in the saved preparation', async () => {
        const { service } = started;
        await analyse(service);
        await service.apply([{ id: 'scene:1', scope: 'character' }]);
        expect((await service.savedFor())?.items.map((item) => item.id)).toEqual(['scene:1']);
        expect(await service.undoItem('scene:1')).toBe(true);
        expect(await service.savedFor()).toBeNull();
    });

    it('a plan of 1.15 with one scene keeps it as the scene of the greeting the chat opened with', async () => {
        await env.app.chat.put('prepare', {
            plan: {
                version: 1,
                createdAt: 5,
                card: { avatar: 'silver-harbor.png', name: 'Хроники Серебряной Гавани' },
                greeting: 1,
                items: [
                    {
                        id: 'scene',
                        kind: 'scene',
                        data: { place: 'Рынок', date: '', time: 'утро', present: [], situation: 'The market opens.' },
                        russian: 'Утро на рынке.',
                        sources: ['card.greeting'],
                        scope: 'chat',
                    },
                ],
                sources: [],
                skipped: [],
                fingerprint: 'f',
                chunks: 1,
                failedChunks: 0,
            },
            stage: 'ready',
            applied: [],
        });
        const { service } = started;
        const plan = (await service.load())!;
        expect(plan.items.map((item) => item.id)).toEqual(['scene:1']);
        expect(plan.items[0]!.data).toMatchObject({ greeting: 1, place: 'Рынок', outfits: [], firstScene: '' });
        await service.apply([{ id: 'scene:1' }]);
        expect(service.startScenes()).toMatchObject({ prepared: [1], active: null });
        await swipe(1);
        await until(() => service.startScenes().active === 1);
        const notes = await startNotes();
        expect(String(notes[0]!.entry.content)).toContain('Where: Рынок');
        expect(env.ui.notices.at(-1)?.text).toBe('Стартовая сцена: Рынок, утро');
    });
});
