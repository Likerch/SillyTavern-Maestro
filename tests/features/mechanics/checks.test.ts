// M25 checks part: the auto roll at MESSAGE_SENT (once, never on swipes), the actor and the difficulty, rolls by
// button and by /maestro-roll, pending/delivered, the per-chat log (load, merge, conflicts), edits and deletions,
// journal entries and message badges.
import { afterEach, describe, expect, it } from 'vitest';
import { stableHash } from '../../../src/domain/hash';
import {
    CHECKS_DOC,
    CHECK_KIND,
    MechanicChecks,
    describeCheck,
    parseDifficulty,
} from '../../../src/features/mechanics/checks';
import type { CheckResult, MechanicDef } from '../../../src/features/mechanics/api';
import { EVENT_TYPES } from '../../helpers/st-mock';
import {
    changeChat,
    createChecksEnv,
    dice,
    faces,
    magicDef,
    reply,
    send,
    socialDef,
    tick,
    userMessage,
} from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

let ctx: ChecksEnv;
let checks: MechanicChecks | null = null;

afterEach(() => {
    checks?.dispose();
    checks = null;
});

async function start(rng: () => number = faces(20, 14), defs?: MechanicDef[]): Promise<MechanicChecks> {
    ctx = createChecksEnv(defs ? { defs } : {});
    ctx.state.scene = { social: ['Kai', 'Elizabeth'], magic: ['Kai', 'Anna'] };
    checks = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng, saveMs: 0 });
    checks.install();
    await checks.ready();
    return checks;
}

function exposeWorld(): void {
    const people = [
        { name: 'Elizabeth', aliases: ['Liz'], forms: ['Элизабет', 'Элизабет'] },
        { name: 'Anna', aliases: [], forms: ['Анна'] },
    ];
    ctx.env.modules.expose('world', {
        resolve: (name: string) =>
            people.find((person) => [person.name, ...person.aliases, ...person.forms].includes(name)),
    });
}

function stored(): CheckResult[] {
    const doc = ctx.store.docs.get(`chat-1|${CHECKS_DOC}`) as { results: CheckResult[] } | undefined;
    return doc?.results ?? [];
}

describe('auto checks', () => {
    it('roll once when the user sends a message that calls for a check', async () => {
        const part = await start();
        const index = await send(ctx, 'Я пытаюсь убедить стражника пропустить нас.');
        expect(index).toBe(1);
        const [result] = part.checks();
        expect(result).toMatchObject({
            mechanicId: 'social',
            checkId: 'persuasion',
            holder: 'Kai',
            dice: '1d20+mod(@charisma)',
            rolls: [14],
            modifier: 0,
            total: 14,
            target: 15,
            outcome: 'failure',
            text: 'Persuasion check (Kai): rolled 14 vs 15 — failure.',
            messageIndex: 1,
            by: 'auto',
        });
        expect(part.pendingChecks().map((item) => item.id)).toEqual([result!.id]);

        await ctx.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 1);
        expect(part.checks()).toHaveLength(1);

        await tick();
        expect(stored().map((item) => item.id)).toEqual([result!.id]);
        const journal = ctx.env.journal.records.find((record) => record.kind === CHECK_KIND);
        expect(journal).toMatchObject({
            module: 'M25',
            summary: 'Roll: Убеждение (Kai): 14 vs 15 — failure',
            changes: [],
            sourceMessage: 1,
        });
        expect(ctx.badges).toEqual([
            {
                index: 1,
                id: `m25-check-${result!.id}`,
                text: 'Roll: Убеждение (Kai): 14 vs 15 — failure',
                removed: false,
            },
        ]);
    });

    it('roll nothing without a trigger, when switched off, in group chats, for sheets or unknown messages', async () => {
        const part = await start();
        await send(ctx, 'Я молча жду.');
        ctx.settings.autoChecks = false;
        await send(ctx, 'Я пытаюсь убедить его.');
        ctx.settings.autoChecks = true;
        ctx.env.autonomy.levels.set(CHECK_KIND, 'off');
        await send(ctx, 'Я пытаюсь убедить его.');
        ctx.env.autonomy.levels.delete(CHECK_KIND);
        ctx.env.host.group = true;
        await send(ctx, 'Я пытаюсь убедить его.');
        ctx.env.host.group = false;
        await send(ctx, '!fullsheet Elizabeth — пытаюсь убедить');
        ctx.defs.off.add('social');
        await send(ctx, 'Я пытаюсь убедить его.');
        ctx.defs.off.delete('social');
        await ctx.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 0);
        await ctx.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 'x');
        await ctx.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 99);
        expect(part.checks()).toEqual([]);
    });

    it('a persona without the values a formula needs is not rolled for automatically', async () => {
        const part = await start();
        ctx.state.scene = { social: ['Elizabeth'] };
        await send(ctx, 'Я пытаюсь убедить его.');
        expect(part.checks()).toEqual([]);
        // A plain formula needs nothing.
        const plain = socialDef();
        plain.checks[0]!.dice = '1d20+2';
        ctx.defs.defs = [plain];
        await send(ctx, 'Я пытаюсь убедить его.');
        expect(part.checks()[0]).toMatchObject({ holder: 'Kai', total: 16, outcome: 'success' });
    });

    it('a broken formula rolls nothing automatically', async () => {
        const broken = socialDef();
        broken.checks[0]!.dice = 'banana';
        const part = await start(faces(20, 14), [broken]);
        await send(ctx, 'Я пытаюсь убедить его.');
        expect(part.checks()).toEqual([]);
    });

    it('rolls for the holder named as the subject (with world names)', async () => {
        const part = await start(faces(20, 14));
        exposeWorld();
        ctx.state.set('social', 'Elizabeth', 'charisma', 16);
        await send(ctx, 'Элизабет пытается убедить стражника.');
        expect(part.checks()[0]).toMatchObject({
            holder: 'Elizabeth',
            modifier: 3,
            total: 17,
            outcome: 'success',
            text: 'Persuasion check (Elizabeth): rolled 14 + 3 = 17 vs 15 — success.',
        });
    });

    it('someone acting who does not hold the mechanic is not rolled for', async () => {
        const part = await start();
        exposeWorld();
        await send(ctx, 'Anna tries to persuade the guard.');
        expect(part.checks()).toEqual([]);
    });

    it('takes the difficulty from words or an explicit number', async () => {
        const part = await start(faces(20, 14, 14));
        await send(ctx, 'Пытаюсь убедить стражника, это трудно.');
        expect(part.checks()[0]?.target).toBe(20);
        await send(ctx, '(DC 12) I try to persuade him.');
        expect(part.checks()[0]).toMatchObject({ target: 12, outcome: 'success' });
    });

    it('roll-under checks scale the value by the difficulty', async () => {
        const part = await start(faces(100, 15));
        await send(ctx, 'Я тихо крадусь мимо, это трудно.');
        expect(part.checks()[0]).toMatchObject({
            checkId: 'stealth',
            target: 20,
            outcome: 'success',
            text: 'Stealth check (Kai): rolled 15, needed 20 or lower — success.',
        });
    });

    it('a roll made while the log loads is kept and saved', async () => {
        ctx = createChecksEnv();
        ctx.state.scene = { social: ['Kai'] };
        const part = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng: faces(20, 14), saveMs: 0 });
        checks = part;
        part.install();
        ctx.env.mock.chat.push(userMessage('Я пытаюсь убедить его.'));
        await ctx.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 1);
        await part.ready();
        await tick();
        expect(part.checks()).toHaveLength(1);
        expect(stored()).toHaveLength(1);
    });
});

describe('rolls by hand', () => {
    it('a pending roll made before sending belongs to that message and stops the auto roll', async () => {
        const part = await start();
        const manual = await part.roll('social', 'persuasion', 'Kai');
        expect(manual).toMatchObject({ by: 'user', messageIndex: -1, holder: 'Kai' });
        const index = await send(ctx, 'Я пытаюсь убедить его.');
        expect(part.checks()).toHaveLength(1);
        expect(part.checks()[0]).toMatchObject({ id: manual.id, messageIndex: index });
        expect(ctx.badges.at(-1)).toMatchObject({ index, removed: false });
    });

    it('take the difficulty given, the persona by default and attribute values as modifiers', async () => {
        const part = await start(faces(20, 4, 4, 4));
        expect(await part.roll('social', 'persuasion', 'Elizabeth', { difficulty: 5 })).toMatchObject({
            target: 5,
            outcome: 'failure',
        });
        expect(await part.roll('social', 'persuasion', '  ')).toMatchObject({ holder: 'Kai', target: 15 });
        expect(await part.roll('magic', 'focus', 'Kai')).toMatchObject({ modifier: 30, total: 34, outcome: 'success' });
        // A scale value counts as its level index.
        const scaled = magicDef();
        scaled.checks[0]!.dice = '1d20+@rank';
        ctx.defs.defs = [scaled];
        ctx.state.set('magic', 'Kai', 'rank', 'master');
        expect(await part.roll('magic', 'focus', 'Kai')).toMatchObject({ modifier: 2 });
    });

    it('refuse unknown checks, missing values, broken formulas and missing chats', async () => {
        const part = await start();
        await expect(part.roll('nope', 'x', 'Kai')).rejects.toThrow('Unknown mechanic: nope');
        await expect(part.roll('social', 'nope', 'Kai')).rejects.toThrow('has the check “nope”');
        await expect(part.roll('social', 'stealth', 'Stranger')).rejects.toThrow(
            'Nothing to roll against: no value of “Скрытность” for Stranger.',
        );
        const broken = socialDef();
        broken.checks[0]!.dice = 'banana';
        ctx.defs.defs = [broken];
        await expect(part.roll('social', 'persuasion', 'Kai')).rejects.toThrow('cannot be rolled: banana');
        ctx.defs.defs = [socialDef()];
        ctx.env.mock.context.name1 = '';
        ctx.state.scene = {};
        await expect(part.roll('social', 'persuasion', '')).rejects.toThrow('Who rolls?');
        await changeChat(ctx, undefined);
        await expect(part.roll('social', 'persuasion', 'Kai')).rejects.toThrow('Open a chat first.');
    });

    it('a holder kept in the state but not in the scene rolls with its values', async () => {
        const part = await start(faces(100, 50));
        ctx.state.set('social', 'Bob', 'stealth', 70);
        expect(await part.roll('social', 'stealth', 'Bob')).toMatchObject({ target: 70, outcome: 'success' });
    });
});

describe('/maestro-roll', () => {
    async function run(value: string, args: Record<string, unknown> = {}): Promise<string> {
        const spec = ctx.slashes.find((item) => item.name === 'maestro-roll');
        if (!spec) throw new Error('no command');
        return spec.callback(args, value);
    }

    it('is registered with its arguments', async () => {
        await start();
        const spec = ctx.slashes.find((item) => item.name === 'maestro-roll');
        expect(spec?.helpKey).toBe('m25.check.slash.help');
        expect(spec?.args?.map((arg) => arg.name)).toEqual(['value', 'holder', 'difficulty']);
    });

    it('rolls a check by name for a holder at a difficulty', async () => {
        const part = await start(faces(20, 14, 14, 14, 14, 14));
        exposeWorld();
        expect(await run('persuasion Elizabeth 12')).toBe('Persuasion check (Elizabeth): rolled 14 vs 12 — success.');
        expect(ctx.notices.at(-1)).toEqual({ text: 'Rolled: Убеждение (Elizabeth): 14 vs 12 — success', urgent: true });
        expect(await run('Убеждение трудно')).toBe('Persuasion check (Kai): rolled 14 vs 20 — failure.');
        expect(await run('social.persuasion очень трудно')).toContain('vs 25');
        expect(await run('persuasion', { holder: 'Liz', difficulty: 'easy' })).toBe(
            'Persuasion check (Elizabeth): rolled 14 vs 10 — success.',
        );
        expect(await run('PERSUASION Anna')).toContain('(Anna)');
        expect(part.checks().every((result) => result.by === 'user')).toBe(true);
    });

    it('answers with the problem otherwise', async () => {
        await start();
        expect(await run('  ')).toBe('Usage: /maestro-roll <check> [who] [difficulty]');
        expect(await run('fireball')).toBe('None of the mechanics on in this chat has the check “fireball”.');
        expect(await run('persuasion', { difficulty: 'banana' })).toBe(
            'Difficulty is a number or easy / hard / very hard: banana',
        );
        expect(ctx.notices.at(-1)).toMatchObject({ urgent: true });
    });

    it('parses typed difficulties', () => {
        expect(parseDifficulty('15')).toEqual({ explicit: 15, level: null });
        expect(parseDifficulty('очень трудно')).toEqual({ explicit: null, level: 'veryHard' });
        expect(parseDifficulty('Kai')).toBeNull();
    });
});

describe('pending and delivered', () => {
    it('delivered results stop being pending and are saved so', async () => {
        const part = await start();
        await send(ctx, 'Я пытаюсь убедить его.');
        const pending = part.pendingChecks();
        let changes = 0;
        const off = part.onChange(() => changes++);
        part.markChecksDelivered(pending);
        part.markChecksDelivered(pending);
        off();
        expect(changes).toBe(1);
        expect(part.pendingChecks()).toEqual([]);
        await tick();
        expect(stored()[0]).toMatchObject({ delivered: true });
    });

    it('an undelivered roll of an earlier message expires when the next one is sent', async () => {
        const part = await start(faces(20, 14, 9));
        await send(ctx, 'Я пытаюсь убедить его.');
        ctx.env.mock.chat.push(reply());
        await send(ctx, 'Я снова пытаюсь убедить его.');
        expect(part.checks()).toHaveLength(2);
        expect(part.pendingChecks().map((result) => result.messageIndex)).toEqual([3]);
    });
});

describe('edits and deletions', () => {
    it('an edit keeps the roll while the same check is called for and replaces it otherwise', async () => {
        const part = await start(faces(20, 14, 11));
        const index = await send(ctx, 'Я пытаюсь убедить стражника.');
        const first = part.checks()[0]!;
        const edit = async (text: string) => {
            ctx.env.mock.chat[index]!.mes = text;
            await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        };
        await edit('Я пытаюсь убедить стражника, улыбаясь.');
        expect(part.checks().map((result) => result.id)).toEqual([first.id]);
        expect(ctx.badges.filter((badge) => !badge.removed)).toHaveLength(1);

        await edit('Я жду.');
        expect(part.checks()).toEqual([]);
        expect(ctx.badges.every((badge) => badge.removed)).toBe(true);

        ctx.state.set('social', 'Kai', 'stealth', 50);
        await edit('Я тихо крадусь мимо.');
        expect(part.checks()).toHaveLength(1);
        expect(part.checks()[0]).toMatchObject({ checkId: 'stealth', messageIndex: index });
    });

    it('edits of older messages, of replies and with auto checks off change nothing', async () => {
        const part = await start();
        const index = await send(ctx, 'Я пытаюсь убедить стражника.');
        const id = part.checks()[0]!.id;
        ctx.env.mock.chat.push(reply());
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index + 1, reason: 'edited' });
        ctx.env.mock.chat.push(userMessage('Дальше.'));
        ctx.env.mock.chat[index]!.mes = 'Я жду.';
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        expect(part.checks().map((result) => result.id)).toEqual([id]);
        ctx.env.mock.chat.splice(index + 1);
        ctx.settings.autoChecks = false;
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        expect(part.checks().map((result) => result.id)).toEqual([id]);
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: -1, reason: 'deleted' });
        expect(part.checks()).toHaveLength(1);
    });

    it('a deleted message takes its undelivered roll along; delivered ones stay as history', async () => {
        const part = await start(faces(20, 14, 14));
        const index = await send(ctx, 'Я пытаюсь убедить стражника.');
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        expect(part.checks()).toEqual([]);
        ctx.env.mock.chat.splice(index);
        const again = await send(ctx, 'Я пытаюсь убедить стражника.');
        part.markChecksDelivered(part.pendingChecks());
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: again, reason: 'deleted' });
        expect(part.checks()).toHaveLength(1);
    });
});

describe('the log', () => {
    it('is loaded per chat, with badges on the messages that still match', async () => {
        const part = await start();
        const message = userMessage('Я пытаюсь убедить его.');
        const result = {
            id: 'old-1',
            mechanicId: 'social',
            checkId: 'persuasion',
            holder: 'Kai',
            dice: '1d20',
            rolls: [3],
            modifier: 0,
            total: 3,
            target: 15,
            outcome: 'failure',
            text: 'Persuasion check (Kai): rolled 3 vs 15 — failure.',
            messageIndex: 0,
            by: 'auto',
            at: 5,
            delivered: true,
            stamp: stableHash(message.mes),
        };
        const stale = { ...result, id: 'old-2', messageIndex: 0, stamp: 'other', delivered: false, rolls: 'x' };
        ctx.store.docs.set(`chat-2|${CHECKS_DOC}`, { results: [result, stale, {}, { id: 'x' }] });
        await changeChat(ctx, 'chat-2', [message]);
        await part.ready();
        expect(part.checks().map((item) => item.id)).toEqual(['old-2', 'old-1']);
        expect(part.checks()[0]?.rolls).toEqual([]);
        expect(part.pendingChecks().map((item) => item.id)).toEqual(['old-2']);
        expect(ctx.badges.filter((badge) => !badge.removed).map((badge) => badge.id)).toEqual(['m25-check-old-1']);
        expect(part.checks(1)).toHaveLength(1);
    });

    it('merges with a newer write of another tab', async () => {
        const part = await start(faces(20, 14));
        const theirs = {
            id: 'their-1',
            mechanicId: 'social',
            checkId: 'persuasion',
            holder: 'Elizabeth',
            dice: '1d20',
            rolls: [9],
            modifier: 0,
            total: 9,
            target: null,
            outcome: 'none',
            text: 'Persuasion check (Elizabeth): rolled 9.',
            messageIndex: -1,
            by: 'user',
            at: 1,
        };
        ctx.store.conflict = { results: [theirs] };
        await part.roll('social', 'persuasion', 'Kai');
        await tick();
        expect(part.checks().map((item) => item.holder)).toEqual(['Kai', 'Elizabeth']);
        expect(stored().map((item) => item.id)).toContain('their-1');
        expect(stored()).toHaveLength(2);
    });

    it('stops listening when disposed', async () => {
        const part = await start();
        part.dispose();
        await send(ctx, 'Я пытаюсь убедить его.');
        expect(part.checks()).toEqual([]);
        expect(ctx.slashes).toEqual([]);
        part.dispose();
    });
});

describe('describeCheck', () => {
    it('describes results in the UI language', async () => {
        await start();
        const i18n = ctx.env.app.i18n;
        const base = { holder: 'Kai', total: 16, target: 15, outcome: 'success' as const, dice: '1d20+2' };
        expect(describeCheck(base, i18n, 'Убеждение')).toBe('Убеждение (Kai): 16 vs 15 — success');
        expect(describeCheck({ ...base, dice: '1d100<=@stealth', target: 40 }, i18n, 'Скрытность')).toBe(
            'Скрытность (Kai): 16 (needs 40 or lower) — success',
        );
        expect(describeCheck({ ...base, target: null, outcome: 'none' }, i18n, 'Удача')).toBe('Удача (Kai): 16');
        expect(describeCheck({ ...base, target: null, outcome: 'critical' }, i18n, 'Удача')).toBe(
            'Удача (Kai): 16 — critical success',
        );
    });

    it('rolls dice of mixed sizes in order', async () => {
        const part = await start(dice([20, 7], [100, 30]));
        expect((await part.roll('social', 'persuasion', 'Kai')).rolls).toEqual([7]);
        expect((await part.roll('social', 'stealth', 'Kai')).rolls).toEqual([30]);
    });
});
