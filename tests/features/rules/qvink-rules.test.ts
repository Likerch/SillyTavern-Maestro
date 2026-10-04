import { beforeEach, describe, expect, it } from 'vitest';
import {
    excludeImagePost,
    guardGaps,
    IGNORE_SYMBOL,
    QVINK_SUMMARIZE_TASK,
    registerQvinkHandlers,
    runQvinkSummaries,
} from '../../../src/features/rules/builtin/qvink';
import { RulesEngine } from '../../../src/features/rules/engine';
import type { RuleEnv } from '../../../src/features/rules/env';
import type { GenerationInfo } from '../../../src/shared/contracts';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import { EVENT_TYPES } from '../../helpers/st-mock';

const OTHER_SYMBOL = Symbol.for('maestro.test.other');
const LONG = 'Lira walks through the market and buys a long red scarf for the winter.';
const NORMAL: GenerationInfo = { type: 'normal', dryRun: false, quiet: false };

let env: RulesTestApp;
let ruleEnv: RuleEnv;

function chatMessage(index: number, fields: Partial<STChatMessage> = {}): STChatMessage {
    return {
        name: 'Lira',
        is_user: false,
        is_system: false,
        send_date: `date-${index}`,
        mes: `${LONG} (${index})`,
        extra: {},
        ...fields,
    };
}

/** ST's coreChat (shallow copies with `index`), then Qvink's interceptor: structuredClone + ignore flag. */
function promptOf(live: STChatMessage[], keepLast: number): STChatMessage[] {
    const core = live.filter((message) => !message.is_system).map((message, index) => ({ ...message, index }));
    return core.map((item, position) => {
        const clone = structuredClone(item) as STChatMessage;
        const extra = (clone.extra ?? {}) as Record<string | symbol, unknown>;
        extra[IGNORE_SYMBOL] = position < core.length - keepLast;
        // Another extension's symbol key that must survive Maestro's copy.
        extra[OTHER_SYMBOL] = `keep-${position}`;
        clone.extra = extra as STChatMessage['extra'];
        return clone;
    });
}

const flag = (message: STChatMessage | undefined) => (message?.extra as Record<symbol, unknown>)[IGNORE_SYMBOL];

beforeEach(() => {
    env = createRulesTestApp({ firstRunDone: true });
    // A bare engine (no rules registered, nothing started); the rules' own checks see them as enabled.
    ruleEnv = { ...new RulesEngine(env.app, env.log).env(), isActive: () => true };
});

describe('gap guard', () => {
    it('returns unsummarised messages Qvink dropped as copies and keeps everything else shared', () => {
        env.mock.chat = [
            chatMessage(0, { extra: { qvink_memory: { memory: 'Lira arrived.' } } }),
            chatMessage(1, { is_user: true, name: 'User' }),
            chatMessage(2),
            chatMessage(3, { is_system: true }),
            chatMessage(4, { extra: { nai_studio: { model: 'nai' } } }),
            chatMessage(5),
            chatMessage(6, { mes: 'Hm.' }),
            chatMessage(7),
            chatMessage(8),
        ];
        const prompt = promptOf(env.mock.chat, 2);
        const before = [...prompt];
        const indexes = guardGaps(ruleEnv, prompt, NORMAL);

        expect(indexes).toEqual([2, 5]);
        // Positions in the prompt: live 2 → 2, live 5 → 4 (the system message is not in the prompt).
        for (const position of [2, 4]) {
            expect(prompt[position]).not.toBe(before[position]);
            expect(prompt[position]!.extra).not.toBe(before[position]!.extra);
            expect(flag(prompt[position])).toBe(false);
            expect((prompt[position]!.extra as Record<symbol, unknown>)[OTHER_SYMBOL]).toBe(`keep-${position}`);
            expect(flag(before[position])).toBe(true);
            expect(prompt[position]!.mes).toBe(before[position]!.mes);
        }
        for (const position of [0, 1, 3, 5, 6, 7]) expect(prompt[position]).toBe(before[position]);
        expect(Object.getOwnPropertySymbols(env.mock.chat[2]!.extra!)).toEqual([]);

        expect(env.tasks.queued).toEqual([
            {
                kind: QVINK_SUMMARIZE_TASK,
                dedupeKey: `${QVINK_SUMMARIZE_TASK}:chat-1`,
                chatId: 'chat-1',
                payload: { indexes: [2, 5], dates: ['date-2', 'date-5'] },
            },
        ]);
        // The same gaps on the next generation are not queued again.
        guardGaps(ruleEnv, promptOf(env.mock.chat, 2), NORMAL, new Map([['chat-1', '2,5']]));
        expect(env.tasks.queued).toHaveLength(1);
    });

    it('respects Qvink settings: user messages and the length threshold', () => {
        env.neighbours.qvink.settings = { include_user_messages: true, message_length_threshold: 1 };
        env.mock.chat = [chatMessage(0, { is_user: true }), chatMessage(1, { mes: 'Hm.' }), chatMessage(2)];
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), NORMAL)).toEqual([0, 1]);
    });

    it('returns at most the newest N messages', () => {
        env.settings.module<{ gapGuardLimit: number }>('rules').gapGuardLimit = 2;
        env.mock.chat = Array.from({ length: 6 }, (_, index) => chatMessage(index));
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), NORMAL)).toEqual([3, 4]);
        env.settings.module<{ gapGuardLimit: number }>('rules').gapGuardLimit = 0;
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), NORMAL)).toEqual([]);
    });

    it('does nothing for quiet runs or when Qvink keeps every message', () => {
        env.mock.chat = [chatMessage(0), chatMessage(1)];
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), { ...NORMAL, quiet: true })).toEqual([]);
        env.neighbours.qvink.removeMessages = false;
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), NORMAL)).toEqual([]);
        env.neighbours.qvink.removeMessages = true;
        env.neighbours.qvink.chat = false;
        expect(guardGaps(ruleEnv, promptOf(env.mock.chat, 1), NORMAL)).toEqual([]);
        expect(env.tasks.queued).toEqual([]);
    });

    it('finds the live message by send date when the prompt index does not match', () => {
        env.mock.chat = [chatMessage(0), chatMessage(1), chatMessage(2)];
        const prompt = promptOf(env.mock.chat, 1).map((item) => ({ ...item, index: 7 }));
        expect(guardGaps(ruleEnv, prompt, NORMAL)).toEqual([0, 1]);
        const strangers = promptOf(env.mock.chat, 1).map((item) => ({ ...item, send_date: 'unknown', index: 99 }));
        expect(guardGaps(ruleEnv, strangers, NORMAL)).toEqual([]);
    });

    it('runs as an intercept handler of the module', async () => {
        await startRules(env);
        env.mock.chat = [chatMessage(0), chatMessage(1)];
        const prompt = promptOf(env.mock.chat, 1);
        await env.turn.intercept(prompt);
        expect(flag(prompt[0])).toBe(false);
    });
});

describe('summarise task', () => {
    beforeEach(() => {
        env.mock.chat = [
            chatMessage(0),
            chatMessage(1, { is_user: true }),
            chatMessage(2),
            chatMessage(3),
            chatMessage(4),
        ];
    });

    it('summarises contiguous runs of messages that still need it', async () => {
        const done = await runQvinkSummaries(ruleEnv, { indexes: [0, 1, 2, 3, 4], dates: [] });
        expect(done).toEqual([0, 2, 3, 4]);
        expect(env.slash).toEqual(['/qm-summarize 0', '/qm-summarize 2-4']);
    });

    it('skips messages that changed or got a memory meanwhile', async () => {
        env.mock.chat[2]!.extra = { qvink_memory: { memory: 'Done.' } };
        await runQvinkSummaries(ruleEnv, {
            indexes: [0, 2, 3, 4, 9, 'x'],
            dates: ['date-0', 'date-2', 'moved', 'date-4'],
        });
        expect(env.slash).toEqual(['/qm-summarize 0', '/qm-summarize 4']);
    });

    it('does nothing when the rule is off, Qvink is gone or its command is missing', async () => {
        await runQvinkSummaries({ ...ruleEnv, isActive: () => false }, { indexes: [0] });
        env.neighbours.qvink.present = false;
        await runQvinkSummaries(ruleEnv, { indexes: [0] });
        env.neighbours.qvink.present = true;
        (env.mock.context.SlashCommandParser as { commands: Record<string, unknown> }).commands = {};
        await runQvinkSummaries(ruleEnv, { indexes: [0] });
        expect(env.slash).toEqual([]);
    });

    it('fails the task when Qvink reports an error', async () => {
        (env.mock.context as unknown as Record<string, unknown>).executeSlashCommandsWithOptions = async () => ({
            isError: true,
            errorMessage: 'no profile',
        });
        await expect(runQvinkSummaries(ruleEnv, { indexes: [0] })).rejects.toThrow('no profile');
    });

    it('is registered as the module task runner', async () => {
        await startRules(env);
        await env.tasks.enqueue({ kind: QVINK_SUMMARIZE_TASK, payload: { indexes: [3] } });
        await env.tasks.runLatest(QVINK_SUMMARIZE_TASK);
        expect(env.slash).toEqual(['/qm-summarize 3']);
    });
});

describe('NAI picture posts in Qvink', () => {
    const post = (fields: Partial<STChatMessage> = {}) =>
        chatMessage(3, { mes: '1girl, elf, market', extra: { nai_studio: { model: 'nai-v4' }, media: [] }, ...fields });

    beforeEach(() => {
        env.mock.chat = [chatMessage(0), chatMessage(1), chatMessage(2), post()];
        registerQvinkHandlers(ruleEnv);
    });

    it('marks a picture post "exclude" with the right STscript syntax and journals it', async () => {
        expect(await excludeImagePost(ruleEnv, 3)).toBe(true);
        expect(env.slash).toEqual(['/qm-toggle-exclude exclude=true 3']);
        const record = env.journal.records.at(-1)!;
        expect(record).toMatchObject({ module: 'M22', kind: 'rules.qvinkExclude' });
        expect(record.changes[0]).toMatchObject({ target: 'm22.qvinkExclude', ref: { index: 3, sendDate: 'date-3' } });

        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.slash.at(-1)).toBe('/qm-toggle-exclude exclude=false 3');
    });

    it('does not undo on another message at the same index', async () => {
        await excludeImagePost(ruleEnv, 3);
        env.mock.chat[3] = chatMessage(3, { send_date: 'other' });
        expect(await env.journal.undo(env.journal.records.at(-1)!.id)).toBe(false);
    });

    it('leaves story messages, marked posts and remembered posts alone', async () => {
        expect(await excludeImagePost(ruleEnv, 0)).toBe(false);
        expect(await excludeImagePost(ruleEnv, 'x')).toBe(false);
        expect(await excludeImagePost(ruleEnv, 42)).toBe(false);
        env.mock.chat[3] = post({ extra: { nai_studio: {}, qvink_memory: { exclude: true } } });
        expect(await excludeImagePost(ruleEnv, 3)).toBe(false);
        env.mock.chat[3] = post({ extra: { nai_studio: {}, qvink_memory: { remember: true } } });
        expect(await excludeImagePost(ruleEnv, 3)).toBe(false);
        env.neighbours.qvink.present = false;
        env.mock.chat[3] = post();
        expect(await excludeImagePost(ruleEnv, 3)).toBe(false);
        expect(env.slash).toEqual([]);
    });

    it('follows the autonomy level and applies Inbox cards', async () => {
        await startRules(env);
        env.autonomy.levels.set('rules.qvinkExclude', 'inbox');
        expect(await excludeImagePost(ruleEnv, 3)).toBe(false);
        expect(env.slash).toEqual([]);
        await env.inbox.appliers.get('rules.qvinkExclude')!({ index: 3, sendDate: 'date-3' });
        expect(env.slash).toEqual(['/qm-toggle-exclude exclude=true 3']);
    });

    it('reacts to MESSAGE_RECEIVED of picture posts once the module runs', async () => {
        await startRules(env);
        await env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED!, 3, 'extension');
        await env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED!, 2, 'normal');
        expect(env.slash).toEqual(['/qm-toggle-exclude exclude=true 3']);
    });
});
