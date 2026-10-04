import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { livingCanonModule } from '../../../src/features/livingCanon';
import type { DisputedPayload, LivingCanonService } from '../../../src/features/livingCanon';
import { storedJson } from '../../helpers/core-host';
import {
    canonItem,
    commit,
    contradiction,
    createLivingTestApp,
    flush,
    proposalsOf,
    replyArrives,
    startModule,
    turn,
} from './helpers';
import type { LivingTestApp } from './helpers';

const FESTIVAL =
    'Вечером начинался Праздник Фонарей — каждый год жители запускают бумажные фонари над рекой. Элдрин улыбнулся.';

let env: LivingTestApp;
let living: LivingCanonService;
let stop: () => Promise<void>;

beforeEach(async () => {
    env = createLivingTestApp();
    env.world.add('Элдрин');
    const started = await startModule(env, livingCanonModule);
    living = started.living;
    stop = () => started.stop();
});

afterEach(async () => {
    await stop();
});

/** Canon changes are followed after a short pause. */
async function reconciled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush(living);
}

function docFile(): Record<string, unknown> | undefined {
    const name = [...env.mock.files.keys()].find((file) => file.includes('livingCanon'));
    const envelope = name ? storedJson<{ data: Record<string, unknown> }>(env.mock, name) : undefined;
    return envelope?.data;
}

describe('M26: drafts before the commit (P14)', () => {
    it('keeps the names of a reply as drafts and writes nothing to the canon', async () => {
        const index = await replyArrives(env, living, FESTIVAL);
        expect(living.drafts()).toEqual([
            expect.objectContaining({
                name: 'Праздник Фонарей',
                type: 'tradition',
                status: 'draft',
                sourceMessage: index,
            }),
        ]);
        expect(env.canon.calls).toEqual([]);
        expect(env.autonomy.proposals).toEqual([]);
        expect((docFile()?.drafts as unknown[]).length).toBe(1);
    });

    it('saves the committed reply as provisional canon with the Russian quote and keys', async () => {
        const index = await turn(env, living, FESTIVAL);
        expect(living.drafts()).toEqual([]);
        const [item] = env.canon.living();
        expect(item?.meta).toMatchObject({
            kind: 'addition',
            status: 'provisional',
            origin: 'living',
            type: 'tradition',
            sourceMessage: index,
            survivedTurns: 0,
        });
        expect(item?.entry.comment).toBe('Праздник Фонарей');
        expect(item?.entry.content).toBe(
            '[provisional] Tradition: Праздник Фонарей\n«Вечером начинался Праздник Фонарей — каждый год жители запускают бумажные фонари над рекой.»',
        );
        // No DES-RU: the canon's fallback (the name and its left-boundary key) and a key for every case form.
        expect(item?.entry.key).toEqual([
            'Праздник Фонарей',
            '/(?:^|[^\\p{L}\\p{N}_])Праздник\\s+Фонар[её]й/iu',
            '/(?:^|[^\\p{L}\\p{N}_])праздник\\p{L}{0,3}\\s+фонар\\p{L}{0,3}/iu',
        ]);
        expect(living.provisional()).toEqual([
            expect.objectContaining({
                uid: item?.uid,
                name: 'Праздник Фонарей',
                status: 'provisional',
                survivedTurns: 0,
            }),
        ]);
        const [proposal] = proposalsOf(env, 'living.fact');
        expect(proposal?.title).toBe('New provisional fact: Праздник Фонарей');
        expect(env.journal.records.map((record) => record.kind)).toEqual(['living.fact']);
    });

    it('takes the Russian keys from DES-RU when it is there', async () => {
        env.neighbours.desruApi = {
            nameForms: (name: string) =>
                name === 'Праздник Фонарей' ? [name, 'Праздника Фонарей', 'Празднике Фонарей'] : [],
        };
        await turn(env, living, FESTIVAL);
        expect(env.canon.living()[0]?.entry.key).toEqual([
            'Праздник Фонарей',
            'Праздника Фонарей',
            'Празднике Фонарей',
        ]);
    });

    it('uses DES-RU’s regex key when it has no plain forms', async () => {
        env.neighbours.desruApi = { nameForms: () => [], nameFormsKey: () => '/праздник\\s+фонар/iu' };
        await turn(env, living, FESTIVAL);
        expect(env.canon.living()[0]?.entry.key).toEqual(['Праздник Фонарей', '/праздник\\s+фонар/iu']);
    });

    it('drops the drafts of a swiped reply and saves nothing', async () => {
        const index = await replyArrives(env, living, FESTIVAL);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await flush(living);
        expect(living.drafts()).toEqual([]);
        // The swipe replaced the text: the commit reads the new reply.
        env.mock.chat[index] = { ...env.mock.chat[index]!, mes: 'Он молча кивнул.', swipe_id: 1 };
        await commit(env, living);
        expect(env.canon.living()).toEqual([]);
    });

    it('reads a reply at the commit when no draft was made for it (reload between reply and send)', async () => {
        env.mock.chat.push({ ...(await import('./helpers')).reply(FESTIVAL) });
        await commit(env, living);
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Праздник Фонарей']);
    });

    it('skips known names, insignificant ones and names of the card', async () => {
        env.canon.items.push(canonItem(0, 'Эльмира', 'Elmira is a town.'));
        env.mock.context.characters.push({
            name: 'Char',
            avatar: 'c.png',
            description: 'Каждую осень в городе Праздник Урожая.',
        });
        await turn(
            env,
            living,
            'Элдрин вспомнил Эльмиру. На Празднике Урожая пели песни. Мимо прошёл Гвидо. Начинался Праздник Фонарей.',
        );
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Праздник Фонарей']);
    });

    it('counts a name repeated across turns as significant', async () => {
        await turn(env, living, 'Мимо прошёл Гвидо и кивнул.');
        expect(env.canon.living()).toEqual([]);
        await turn(env, living, 'Потом снова появился Гвидо — хозяин таверны у моста.');
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Гвидо']);
        expect(env.canon.living()[0]?.meta.type).toBe('note');
    });

    it('does nothing in a group chat or without a chat', async () => {
        env.host.group = true;
        await turn(env, living, FESTIVAL);
        expect(living.drafts()).toEqual([]);
        expect(env.canon.calls).toEqual([]);
    });
});

describe('M26: limits and merging', () => {
    const MANY =
        'В таверне «Ржавый якорь» вспоминали Битву при Кровавом Броде. Там же чтили Орден Серебряной Луны — его основали века назад. Начинался Праздник Фонарей — каждый год его ждут.';

    it('adds at most K new facts per turn, the most significant first', async () => {
        await turn(env, living, MANY);
        const saved = env.canon.living().map((item) => item.entry.comment);
        expect(saved).toHaveLength(3);
        expect(saved).toEqual(expect.arrayContaining(['Орден Серебряной Луны', 'Праздник Фонарей']));
    });

    it('follows the K setting', async () => {
        env.settings.module<{ maxPerTurn: number }>('livingCanon').maxPerTurn = 1;
        await turn(env, living, MANY);
        expect(env.canon.living()).toHaveLength(1);
        env.settings.module<{ maxPerTurn: number }>('livingCanon').maxPerTurn = 0;
        await turn(env, living, 'Там стоял замок «Чёрный шпиль», где жили колдуны.');
        expect(env.canon.living()).toHaveLength(1);
    });

    it('extends a similar provisional fact instead of adding a new one', async () => {
        await turn(env, living, FESTIVAL);
        const [item] = env.canon.living();
        await turn(env, living, 'На Фестивале Фонарей всегда пели — так было испокон веков.');
        expect(env.canon.living()).toHaveLength(1);
        const merged = env.canon.item(item?.uid);
        expect(merged?.entry.key).toEqual(expect.arrayContaining(['Праздник Фонарей', 'Фестиваль Фонарей']));
        expect(String(merged?.entry.content)).toContain('«На Фестивале Фонарей всегда пели — так было испокон веков.»');
        expect(living.provisional()[0]?.keys).toEqual(expect.arrayContaining(['Фестиваль Фонарей']));
    });

    it('treats a plain repetition as a mention, not a new fact', async () => {
        await turn(env, living, FESTIVAL);
        const calls = env.canon.calls.length;
        await turn(env, living, 'Праздник Фонарей продолжался до утра, и Праздник Фонарей был прекрасен.');
        expect(env.canon.living()).toHaveLength(1);
        expect(env.canon.calls.slice(calls).filter((call) => call.startsWith('put'))).toEqual([]);
    });
});

describe('M26: disputed facts', () => {
    beforeEach(() => {
        env.canon.items.push(canonItem(0, 'Эльмира', 'Elmira never had any festivals.'));
        env.contradictions.rule = (input) =>
            input.statement.includes('Эльмир') && input.against.some((item) => item.label === 'Эльмира')
                ? [contradiction('Эльмира', 'праздник в Эльмире', 'never had any festivals')]
                : [];
    });

    const DISPUTED = 'В Эльмире начинался Праздник Фонарей — каждый год жители запускают фонари.';

    it('sends a contradicting fact to the Inbox instead of the canon', async () => {
        const index = await turn(env, living, DISPUTED);
        expect(env.canon.living()).toEqual([]);
        const [card] = proposalsOf(env, 'living.disputed');
        expect(card?.title).toBe('Disputed invented fact: Праздник Фонарей');
        expect(card?.sourceMessage).toBe(index);
        expect(String(card?.description)).toContain('never had any festivals');
        expect(living.facts()).toEqual([expect.objectContaining({ name: 'Праздник Фонарей', status: 'disputed' })]);
        // The commit path asks the rules only (no model on the send path, P15).
        expect(env.contradictions.checkInputs).toEqual([]);
    });

    it('saves it as provisional when the card is accepted', async () => {
        await turn(env, living, DISPUTED);
        const [card] = proposalsOf(env, 'living.disputed');
        await card?.apply(card.payload);
        await flush(living);
        expect(env.canon.living().map((item) => item.meta.status)).toEqual(['provisional']);
        const fact = living.records().find((item) => item.name === 'Праздник Фонарей');
        expect(fact).toMatchObject({ status: 'provisional', dispute: 'kept' });
        expect(fact?.conflict).toContain('Эльмира');
    });

    it('applies a stored card after a reload through the registered applier', async () => {
        await turn(env, living, DISPUTED);
        const [card] = proposalsOf(env, 'living.disputed');
        const payload = JSON.parse(JSON.stringify(card?.payload)) as DisputedPayload;
        expect(await env.inbox.validators.get('living.disputed')?.(payload)).toBe(true);
        await env.inbox.appliers.get('living.disputed')?.(payload);
        await flush(living);
        expect(env.canon.living()).toHaveLength(1);
        expect(await env.inbox.validators.get('living.disputed')?.(payload)).toBe(false);
        await expect(env.inbox.appliers.get('living.disputed')?.({ junk: true })).rejects.toThrow();
    });

    it('drops it for good when the card is rejected', async () => {
        await turn(env, living, DISPUTED);
        const [card] = proposalsOf(env, 'living.disputed');
        await env.inbox.rejecters.get('living.disputed')?.(card?.payload);
        await flush(living);
        expect(living.records()[0]).toMatchObject({ status: 'dropped', droppedBy: 'user' });
        env.contradictions.rule = () => [];
        await turn(env, living, 'Снова Праздник Фонарей — его празднуют каждый год.');
        expect(env.canon.living()).toEqual([]);
    });

    it('uses the contradiction service with the relevant canon only', async () => {
        await turn(env, living, DISPUTED);
        const input = env.contradictions.quickInputs.find((item) => item.statement.includes('Праздник Фонарей'));
        expect(input?.against).toEqual([{ label: 'Эльмира', text: 'Elmira never had any festivals.' }]);
        expect(input?.entities).toEqual(['Праздник Фонарей']);
    });
});

describe('M26: confirmation rules', () => {
    async function provisional(): Promise<{ index: number; uid: number }> {
        const index = await turn(env, living, FESTIVAL);
        const uid = env.canon.living()[0]?.uid;
        if (uid === undefined) throw new Error('not saved');
        return { index, uid };
    }

    it('confirms when the user mentions it in his own message', async () => {
        await replyArrives(env, living, FESTIVAL);
        await commit(env, living, 'Пойдём на Праздник Фонарей!');
        const [item] = env.canon.living();
        expect(item?.meta.status).toBe('active');
        expect(living.facts()[0]).toMatchObject({ status: 'active', confirmedBy: 'userMentioned' });
        expect(env.canon.calls).toContain(`status:${item?.uid}:active`);
    });

    it('confirms by an explicit acceptance when nothing contradicts it', async () => {
        const { uid } = await provisional();
        expect(await living.accept(uid)).toBe(true);
        await flush(living);
        expect(env.canon.item(uid)?.meta.status).toBe('active');
        expect(living.facts()[0]?.confirmedBy).toBe('userAccepted');
        expect(await living.accept(uid)).toBe(false);
        expect(await living.accept(999)).toBe(false);
    });

    it('refuses an acceptance the contradiction check does not pass', async () => {
        env.canon.items.push(canonItem(50, 'Фонари', 'Lanterns are forbidden here.'));
        const { uid } = await provisional();
        env.contradictions.rule = (input) =>
            input.against.length ? [contradiction('Фонари', 'запускают фонари', 'forbidden')] : [];
        expect(await living.accept(uid)).toBe(false);
        expect(env.contradictions.checkInputs).toHaveLength(1);
        expect(env.contradictions.checkOptions).toEqual([expect.objectContaining({ inline: false })]);
        expect(env.canon.item(uid)?.meta.status).toBe('provisional');
        expect(living.records()[0]?.conflict).toContain('forbidden');
        expect(env.ui.notices.at(-1)?.text).toContain('is not confirmed');
        // The model clears the rules' suspicion: confirmed.
        env.contradictions.verdict = () => ({ clean: true, askedAi: true, contradictions: [], costUsd: 0 });
        expect(await living.accept(uid)).toBe(true);
    });

    it('confirms when it comes up again in a reply whose prompt did not have it', async () => {
        const { uid } = await provisional();
        const next = await replyArrives(env, living, 'Старики вспоминали Праздник Фонарей.');
        env.lore.record(next, [{ world: 'Book', uid: 3 }]);
        await commit(env, living);
        expect(living.facts()[0]).toMatchObject({ status: 'active', confirmedBy: 'resurfaced' });
        expect(env.canon.item(uid)?.meta.status).toBe('active');
    });

    it('does not count a mention whose prompt held the entry, or a turn without lore data', async () => {
        const { uid } = await provisional();
        const next = await replyArrives(env, living, 'Старики вспоминали Праздник Фонарей.');
        env.lore.record(next, [{ world: env.canon.book, uid }]);
        await commit(env, living);
        expect(living.facts()[0]?.status).toBe('provisional');
        await turn(env, living, 'И снова Праздник Фонарей.');
        expect(living.facts()[0]?.status).toBe('provisional');
        const third = await replyArrives(env, living, 'Опять Праздник Фонарей.');
        env.lore.record(third, [{ world: env.canon.book, uid, cut: true }]);
        await commit(env, living);
        expect(living.facts()[0]?.confirmedBy).toBe('resurfaced');
    });

    it('confirms after N committed turns without contradictions or edits', async () => {
        env.settings.module<{ surviveTurns: number }>('livingCanon').surviveTurns = 2;
        const { uid } = await provisional();
        await turn(env, living, 'Тихий вечер.');
        expect(living.provisional()[0]?.survivedTurns).toBe(1);
        // An edit by the user starts the count again.
        env.canon.edit(uid, { content: 'Edited by hand.' });
        await turn(env, living, 'Тихая ночь.');
        expect(living.provisional()[0]?.survivedTurns).toBe(0);
        await turn(env, living, 'Тихое утро.');
        await turn(env, living, 'Тихий день.');
        expect(living.facts()[0]).toMatchObject({ status: 'active', confirmedBy: 'survived', survivedTurns: 2 });
    });

    it('sends a contradicting survivor to the Inbox once instead of confirming it', async () => {
        env.settings.module<{ surviveTurns: number }>('livingCanon').surviveTurns = 1;
        env.canon.items.push(canonItem(50, 'Фонари', 'Lanterns are forbidden here.'));
        const { uid } = await provisional();
        env.contradictions.rule = (input) =>
            input.against.some((item) => item.label === 'Фонари')
                ? [contradiction('Фонари', 'фонари', 'forbidden')]
                : [];
        await turn(env, living, 'Тихий вечер.');
        await turn(env, living, 'Тихая ночь.');
        expect(env.canon.item(uid)?.meta.status).toBe('provisional');
        const cards = proposalsOf(env, 'living.disputed');
        expect(cards).toHaveLength(1);
        expect((cards[0]?.payload as DisputedPayload).mode).toBe('existing');
        // Keeping it: no new card, still provisional.
        await cards[0]?.apply(cards[0].payload);
        await flush(living);
        expect(living.records()[0]?.dispute).toBe('kept');
        // Rejecting it removes it from the canon.
        await env.inbox.rejecters.get('living.disputed')?.(cards[0]?.payload);
        await flush(living);
        expect(env.canon.item(uid)).toBeUndefined();
    });

    it('never rewrites confirmed canon: a later contradiction becomes an Inbox card', async () => {
        await replyArrives(env, living, FESTIVAL);
        await commit(env, living, 'Праздник Фонарей — моя любимая традиция.');
        const [item] = env.canon.living();
        env.canon.edit(item!.uid, { content: 'Tradition: Lantern Festival\nHeld every spring.' });
        env.contradictions.rule = (input) =>
            input.statement.includes('осенью') ? [contradiction('Праздник Фонарей', 'осенью', 'every spring')] : [];
        const later = await turn(env, living, 'Праздник Фонарей отмечают осенью.');
        expect(env.canon.item(item!.uid)?.entry.content).toBe('Tradition: Lantern Festival\nHeld every spring.');
        const [card] = proposalsOf(env, 'living.disputed');
        expect(card?.title).toBe('The story contradicts confirmed canon: Праздник Фонарей');
        expect(card?.sourceMessage).toBe(later);
        // Accepting: the story wins, the entry becomes provisional with the new statement.
        await card?.apply(card.payload);
        await flush(living);
        expect(env.canon.item(item!.uid)?.meta.status).toBe('provisional');
        expect(String(env.canon.item(item!.uid)?.entry.content)).toContain('осенью');
    });

    it('accepts all provisional facts in one go', async () => {
        await turn(env, living, `${FESTIVAL} Там же чтили Орден Серебряной Луны — его основали века назад.`);
        expect(living.provisional()).toHaveLength(2);
        expect(await living.acceptAll()).toEqual({ confirmed: 2, blocked: 0 });
        expect(living.provisional()).toEqual([]);
    });
});

describe('M26: undoing a reply (§5 «Отмена»)', () => {
    it('removes the provisional facts of a swiped, edited or deleted reply and keeps confirmed ones', async () => {
        const first = await turn(env, living, FESTIVAL, 'Пойдём на Праздник Фонарей!');
        const second = await turn(env, living, 'Там чтили Орден Серебряной Луны — его основали века назад.');
        expect(env.canon.living().map((item) => item.meta.status)).toEqual(['active', 'provisional']);
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'edited' });
        await flush(living);
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Праздник Фонарей']);
        expect(living.records().find((fact) => fact.name === 'Орден Серебряной Луны')).toMatchObject({
            status: 'dropped',
            droppedBy: 'invalidated',
        });
        await env.app.bus.emit('message:invalidated', { messageIndex: first, reason: 'swiped' });
        await flush(living);
        expect(env.canon.living().map((item) => item.meta.status)).toEqual(['active']);
    });

    it('treats a deletion as the end of the chat: everything from that index on goes', async () => {
        await turn(env, living, FESTIVAL);
        const second = await turn(env, living, 'Там чтили Орден Серебряной Луны — его основали века назад.');
        env.mock.chat.splice(second);
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'deleted' });
        await flush(living);
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Праздник Фонарей']);
    });

    it('follows its messages when one in the middle is deleted', async () => {
        await turn(env, living, FESTIVAL);
        const second = await turn(env, living, 'Там чтили Орден Серебряной Луны — его основали века назад.');
        // The first reply (index 0) is deleted: everything moves up by one; ST reports the new length.
        env.mock.chat.splice(0, 1);
        await env.app.bus.emit('message:invalidated', { messageIndex: env.mock.chat.length, reason: 'deleted' });
        await flush(living);
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Орден Серебряной Луны']);
        const order = living.records().find((fact) => fact.name === 'Орден Серебряной Луны');
        expect(order).toMatchObject({ status: 'provisional', sourceMessage: second - 1 });
        expect(living.records().find((fact) => fact.name === 'Праздник Фонарей')?.droppedBy).toBe('invalidated');
    });

    it('undoes an addition from the journal', async () => {
        await turn(env, living, FESTIVAL);
        const record = env.journal.records.find((item) => item.kind === 'living.fact');
        expect(await env.journal.undo(record!.id)).toBe(true);
        await flush(living);
        expect(env.canon.living()).toEqual([]);
        expect(living.records()[0]).toMatchObject({ status: 'dropped', droppedBy: 'undone' });
    });

    it('follows the canon: a removed entry drops its fact, a returned one revives it', async () => {
        await turn(env, living, FESTIVAL);
        const [item] = env.canon.living();
        await env.canon.remove(item!.uid);
        await reconciled();
        expect(living.records()[0]).toMatchObject({ status: 'dropped', droppedBy: 'missing' });
        env.canon.items.push(item!);
        await env.canon.setStatus(item!.uid, 'active');
        await reconciled();
        expect(living.records()[0]).toMatchObject({ status: 'active', confirmedBy: 'userAccepted' });
    });

    it('adopts living entries it does not know', async () => {
        env.canon.items.push({
            ...canonItem(9, 'Старый маяк', '[provisional] Place: Старый маяк\n«Маяк погас.»', 'living'),
            meta: {
                kind: 'addition',
                status: 'provisional',
                origin: 'living',
                type: 'place',
                sourceMessage: 2,
                createdAt: 1,
                updatedAt: 1,
            },
        });
        env.canon.items.at(-1)!.meta.status = 'provisional';
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await flush(living);
        expect(living.provisional()).toEqual([
            expect.objectContaining({ uid: 9, name: 'Старый маяк', type: 'place', sourceMessage: 2 }),
        ]);
    });

    it('lets the user drop a provisional fact', async () => {
        await turn(env, living, FESTIVAL);
        const uid = living.provisional()[0]!.uid!;
        await living.drop(uid);
        expect(env.canon.living()).toEqual([]);
        expect(living.records()[0]?.droppedBy).toBe('user');
        await living.drop(uid);
    });
});

describe('M26: statistics for the R3 metrics', () => {
    it('counts created, dropped by the user, confirmed and contradicted-after-confirmation facts', async () => {
        expect(living.stats()).toEqual({ provisional: 0, droppedByUser: 0, confirmed: 0, contradictedAfterConfirm: 0 });
        await replyArrives(env, living, FESTIVAL);
        await commit(env, living, 'Пойдём на Праздник Фонарей!');
        const second = await turn(env, living, 'Там чтили Орден Серебряной Луны — его основали века назад.');
        await turn(env, living, 'В таверне «Ржавый якорь» пахло элем, как всегда.');
        // A swipe removes a provisional fact by itself: not counted as the user's drop.
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'swiped' });
        await flush(living);
        const tavern = living.provisional().find((fact) => fact.name === 'Ржавый якорь');
        await living.drop(tavern!.uid!);
        const [festival] = env.canon.living();
        env.canon.edit(festival!.uid, { content: 'Tradition: Lantern Festival\nHeld every spring.' });
        env.contradictions.rule = (input) =>
            input.statement.includes('осенью') ? [contradiction('Праздник Фонарей', 'осенью', 'spring')] : [];
        await turn(env, living, 'Праздник Фонарей отмечают осенью.');
        expect(living.stats()).toEqual({ provisional: 3, droppedByUser: 1, confirmed: 1, contradictedAfterConfirm: 1 });
        const file = docFile();
        expect(file?.stats).toEqual(living.stats());
    });
});

describe('M26: autonomy, other modules and tabs', () => {
    it('queues new facts to the Inbox at level «inbox» and applies a stored card later', async () => {
        env.autonomy.levels.set('living.fact', 'inbox');
        await turn(env, living, FESTIVAL);
        expect(env.canon.living()).toEqual([]);
        const [proposal] = proposalsOf(env, 'living.fact');
        const payload = JSON.parse(JSON.stringify(proposal?.payload));
        expect(await env.inbox.validators.get('living.fact')?.(payload)).toBe(true);
        await env.inbox.appliers.get('living.fact')?.(payload);
        await flush(living);
        expect(env.canon.living()).toHaveLength(1);
        expect(await env.inbox.validators.get('living.fact')?.(payload)).toBe(false);
        await expect(env.inbox.appliers.get('living.fact')?.({})).rejects.toThrow();
    });

    it('refuses a stored card whose message changed', async () => {
        env.autonomy.levels.set('living.fact', 'inbox');
        const index = await turn(env, living, FESTIVAL);
        const [proposal] = proposalsOf(env, 'living.fact');
        env.mock.chat[index] = { ...env.mock.chat[index]!, mes: 'Другой текст.' };
        expect(await proposal?.stillValid?.()).toBe(false);
        await expect(proposal?.apply(proposal.payload)).rejects.toThrow('changed');
    });

    it('takes new facts from the revision (signal fact.new and propose)', async () => {
        const index = await turn(env, living, 'Старый маяк погас много лет назад.');
        await env.app.bus.emit('signal', {
            kind: 'fact.new',
            chatId: 'chat-1',
            at: 0,
            data: {
                name: 'Старый маяк',
                quote: 'Старый маяк погас много лет назад.',
                sourceMessage: index,
                type: 'place',
                text: 'The old lighthouse went dark many years ago.',
            },
        });
        await flush(living);
        const [item] = env.canon.living();
        expect(item?.entry.content).toBe('Place: Старый маяк\nThe old lighthouse went dark many years ago.');
        expect(living.records()[0]).toMatchObject({ origin: 'revision', type: 'place' });
        expect(await living.propose({ name: 'Старый маяк', quote: 'x', sourceMessage: index })).toBe(false);
        expect(await living.propose({ name: 'Элдрин', quote: 'x', sourceMessage: index })).toBe(false);
        expect(await living.propose({ name: 'Новое', quote: 'x', sourceMessage: 99 })).toBe(false);
        expect(await living.propose({ name: '', quote: 'x', sourceMessage: index })).toBe(false);
        expect(
            await living.propose({
                name: 'Белая башня',
                quote: 'Белая башня',
                sourceMessage: index,
                type: 'nope',
                text: 'Русский текст, не канон.',
            }),
        ).toBe(true);
        const tower = env.canon.living().find((item) => item.entry.comment === 'Белая башня');
        expect(String(tower?.entry.content)).toContain('[provisional]');
    });

    it('leaves the writing to the leader tab', async () => {
        env.leader.value = false;
        const index = await replyArrives(env, living, FESTIVAL);
        expect(living.drafts().map((draft) => draft.name)).toEqual(['Праздник Фонарей']);
        await commit(env, living);
        expect(env.canon.calls).toEqual([]);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await flush(living);
        expect(living.drafts()).toEqual([]);
    });

    it('registers its tab, style, task and appliers and stops on disable', async () => {
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['living', 'm26.tab', 50]]);
        expect(env.ui.styles.has('m26-living')).toBe(true);
        expect(env.tasks.runners.has('living.extract')).toBe(true);
        expect([...env.inbox.appliers.keys()]).toEqual(['living.fact', 'living.disputed']);
        await stop();
        stop = async () => {};
        expect(env.ui.tabs).toEqual([]);
        expect(env.tasks.runners.has('living.extract')).toBe(false);
        env.mock.chat.push((await import('./helpers')).reply(FESTIVAL));
        await env.app.bus.emit('reply:ready', { messageIndex: env.mock.chat.length - 1, type: 'normal' });
        await flush(living);
        expect(living.drafts()).toEqual([]);
    });

    it('works without the contradiction service, the world model and the lore journal', async () => {
        env.modules.apis.delete('contradictions');
        env.modules.apis.delete('world');
        env.modules.apis.delete('loreJournal');
        await turn(env, living, FESTIVAL);
        expect(env.canon.living()).toHaveLength(1);
    });

    it('saves nothing (and keeps no drafts) when the canon is off', async () => {
        env.modules.apis.delete('canon');
        await turn(env, living, FESTIVAL);
        expect(env.canon.calls).toEqual([]);
        expect(living.drafts()).toEqual([]);
    });
});
