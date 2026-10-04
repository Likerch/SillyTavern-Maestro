import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { checkKey } from '../../../src/domain/contradictions-ai';
import {
    CHECK_TASK,
    CONTRADICTIONS_STRINGS,
    contradictionsModule,
    sanitizeInput,
} from '../../../src/features/contradictions';
import type { ContradictionInput, ContradictionsApi } from '../../../src/features/contradictions/api';
import { profileTasks, resetRegistries } from '../../../src/ui/views/registries';
import type { App, LlmRequest, LlmResult, TaskInfo, TaskSpec, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { TestHost } from '../../helpers/core-host';
import { FakeModules, FakeTasks } from '../../helpers/rules-app';
import { installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

interface Env {
    app: App;
    mock: StMock;
    host: TestHost;
    tasks: FakeTasks;
    modules: FakeModules;
    leader: { value: boolean };
    llm: { available: boolean; requests: LlmRequest[]; answer: (request: LlmRequest) => Promise<LlmResult> };
    cap: { reached: boolean };
}

function createEnv(): Env {
    const mock = installStMock();
    const host = createTestHost(mock);
    const log = createTestLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    const i18n = createI18n(() => 'en');
    const tasks = new FakeTasks();
    const modules = new FakeModules();
    const leader = { value: true };
    const cap = { reached: false };
    const llm: Env['llm'] = {
        available: true,
        requests: [],
        answer: async () => ({ ok: true, data: { contradictions: [] }, costUsd: 0.001 }),
    };
    const app = {
        host,
        log,
        i18n,
        settings,
        tasks,
        modules,
        leader: { isLeader: () => leader.value, onChange: (): Unsubscribe => () => {} },
        llm: {
            available: () => llm.available,
            request: async <T>(request: LlmRequest) => {
                llm.requests.push(request);
                return (await llm.answer(request)) as LlmResult<T>;
            },
        },
        cost: { backgroundCapReached: () => cap.reached } as unknown as App['cost'],
        bus: createBus(log),
        ui: createFakeUi(),
    } as unknown as App;
    return { app, mock, host, tasks, modules, leader, llm, cap };
}

let env: Env;
let api: ContradictionsApi;
let stop: () => Promise<void>;

async function start(): Promise<void> {
    const disposers: (() => void | Promise<void>)[] = [];
    await contradictionsModule.init({
        app: env.app,
        settings: {},
        log: env.app.log,
        own: (dispose) => disposers.push(dispose),
    });
    api = env.modules.api<ContradictionsApi>('contradictions')!;
    stop = async () => {
        for (const dispose of disposers.splice(0).reverse()) await dispose();
    };
}

/** Replaces what the fake queue reports as its tasks. */
function tasksList(target: Env, list: () => TaskInfo[]): void {
    (target.tasks as unknown as { list: () => TaskInfo[] }).list = list;
}

/** Lets the check reach the queue. */
async function queued(count = 1): Promise<TaskSpec[]> {
    for (let i = 0; i < 50 && env.tasks.queued.length < count; i++) await Promise.resolve();
    return env.tasks.queued;
}

const AGE: ContradictionInput = {
    statement: 'Anna is 25 years old.',
    entities: ['Anna'],
    against: [{ label: 'Anna (canon)', text: 'Anna is a healer. She is 30 years old.' }],
};

beforeEach(async () => {
    resetRegistries();
    env = createEnv();
    await start();
});

afterEach(async () => {
    await stop();
    vi.useRealTimers();
});

describe('quick', () => {
    it('runs the rules only, in English and Russian', () => {
        expect(api.quick(AGE)).toEqual([
            {
                label: 'Anna (canon)',
                statement: 'Anna is 25 years old.',
                conflicting: 'She is 30 years old.',
                kind: 'number',
                confidence: 0.65,
            },
        ]);
        expect(
            api
                .quick({
                    statement: 'Анна не умеет колдовать.',
                    entities: ['Анна'],
                    against: [{ label: 'Канон', text: 'Анна умеет колдовать с детства. Анна умеет колдовать.' }],
                })
                .map((item) => [item.kind, item.confidence]),
        ).toEqual([
            ['negation', 0.85],
            ['negation', 0.65],
        ]);
        expect(
            api.quick({
                statement: 'Anna loves Ivan.',
                entities: ['Anna'],
                against: [{ label: 'x', text: 'Anna is a healer.' }],
            }),
        ).toEqual([]);
        expect(api.quick(null as unknown as ContradictionInput)).toEqual([]);
        expect(env.tasks.queued).toEqual([]);
    });

    it('sanitizes junk input', () => {
        expect(
            sanitizeInput({
                statement: 3 as unknown as string,
                entities: ['A', 4 as unknown as string, ' '],
                against: [
                    { label: 5 as unknown as string, text: 'x' },
                    { label: 'y', text: '' },
                    null as unknown as { label: string; text: string },
                ],
            }),
        ).toEqual({ statement: '', entities: ['A'], against: [{ label: '', text: 'x' }] });
    });
});

describe('check', () => {
    it('answers from the rules when they are sure or find nothing suspicious', async () => {
        const sure = await api.check({
            statement: 'Anna was born in 1850.',
            entities: ['Anna'],
            against: [{ label: 'c', text: 'Anna was born in 1852.' }],
        });
        expect(sure).toMatchObject({ clean: false, askedAi: false, costUsd: 0 });
        expect(sure.contradictions.map((item) => item.kind)).toEqual(['date']);
        const calm = await api.check({
            statement: 'Anna loves Ivan.',
            entities: ['Anna'],
            against: [{ label: 'c', text: 'Anna is a healer.' }],
        });
        expect(calm).toEqual({ clean: true, askedAi: false, contradictions: [], costUsd: 0 });
        expect(env.tasks.queued).toEqual([]);
    });

    it('asks the model on suspicion through the background queue and merges its answer', async () => {
        env.llm.answer = async () => ({
            ok: true,
            data: {
                contradictions: [
                    {
                        against: 1,
                        statementQuote: '25 years old',
                        againstQuote: '30 years old',
                        kind: 'number',
                        confidence: 0.95,
                    },
                ],
            },
            costUsd: 0.002,
        });
        const pending = api.check(AGE);
        const [task] = await queued();
        expect(task).toMatchObject({ kind: CHECK_TASK, dedupeKey: checkKey(sanitizeInput(AGE)), priority: 1 });
        expect(task!.payload).toMatchObject({ statement: AGE.statement, entities: ['Anna'], against: AGE.against });
        await env.tasks.runLatest(CHECK_TASK);
        const result = await pending;
        expect(result).toEqual({
            clean: false,
            askedAi: true,
            costUsd: 0.002,
            contradictions: [
                {
                    label: 'Anna (canon)',
                    statement: 'Anna is 25 years old.',
                    conflicting: 'She is 30 years old.',
                    kind: 'number',
                    confidence: 0.95,
                },
            ],
        });
        const [request] = env.llm.requests;
        expect(request).toMatchObject({ task: CHECK_TASK, temperature: 0, schema: { name: 'contradictions_check' } });
        expect(request!.messages[0]!.content).toMatch(/untrusted data/);
        expect(request!.messages[1]!.content).toContain('Anna is a healer.');
    });

    it('drops weak rule hits the model refutes', async () => {
        const pending = api.check(AGE);
        await queued();
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toEqual({ clean: true, askedAi: true, contradictions: [], costUsd: 0.001 });
    });

    it('falls back to the rules on a malformed answer, a refusal or an error', async () => {
        env.llm.answer = async () => ({ ok: true, text: 'Sure! Here you go: {broken', costUsd: 0.003 });
        let pending = api.check(AGE);
        await queued(1);
        await env.tasks.runLatest(CHECK_TASK);
        const result = await pending;
        expect(result).toMatchObject({ clean: false, askedAi: false, error: 'parse', costUsd: 0.003 });
        expect(result.contradictions).toHaveLength(1);

        env.llm.answer = async () => ({ ok: false, refusal: true });
        pending = api.check(AGE);
        await queued(2);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toMatchObject({ askedAi: false, error: 'refusal', costUsd: 0 });

        env.llm.answer = async () => ({ ok: false, error: 'HTTP 500' });
        pending = api.check(AGE);
        await queued(3);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toMatchObject({ askedAi: false, error: 'HTTP 500' });

        env.llm.answer = async () => ({ ok: false });
        pending = api.check(AGE);
        await queued(4);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toMatchObject({ error: 'failed' });

        env.llm.answer = async () => {
            throw new Error('network');
        };
        pending = api.check(AGE);
        await queued(5);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toMatchObject({ askedAi: false, error: 'network' });
    });

    it('shares one request between identical checks', async () => {
        const first = api.check(AGE);
        const second = api.check({ ...AGE, statement: '  anna is 25 years old. ' });
        await queued();
        await Promise.resolve();
        expect(env.tasks.queued).toHaveLength(1);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await first).toEqual(await second);
        expect(env.llm.requests).toHaveLength(1);
    });

    it('does not ask without a profile, in another tab, over the cap, in a group or without a chat', async () => {
        env.llm.available = false;
        expect(await api.check(AGE)).toMatchObject({ askedAi: false, skipped: 'noProfile', clean: false });
        env.llm.available = true;
        env.cap.reached = true;
        expect(await api.check(AGE)).toMatchObject({ skipped: 'cap' });
        env.cap.reached = false;
        env.leader.value = false;
        expect(await api.check(AGE)).toMatchObject({ skipped: 'notLeader' });
        env.leader.value = true;
        env.host.group = true;
        expect(await api.check(AGE)).toMatchObject({ skipped: 'group' });
        env.host.group = false;
        env.mock.chatId = undefined;
        expect(await api.check(AGE)).toMatchObject({ skipped: 'noChat' });
        env.mock.chatId = 'chat-1';
        (env.app.llm as { available: unknown }).available = () => {
            throw new Error('broken');
        };
        expect(await api.check(AGE)).toMatchObject({ skipped: 'noProfile' });
        expect(env.tasks.queued).toEqual([]);
    });

    it('gives up waiting after a while, on a queue error and when disabled', async () => {
        vi.useFakeTimers();
        let pending = api.check(AGE);
        await queued(1);
        await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
        expect(await pending).toMatchObject({ askedAi: false, error: 'timeout' });

        env.tasks.enqueue = async () => {
            throw new Error('no chat');
        };
        expect(await api.check(AGE)).toMatchObject({ error: 'enqueue' });

        env.tasks.enqueue = async (task) => {
            env.tasks.queued.push(task);
            return 't';
        };
        pending = api.check(AGE);
        await queued(2);
        await stop();
        expect(await pending).toMatchObject({ error: 'disabled' });
        expect(await api.check(AGE)).toMatchObject({ skipped: 'noChat' });
    });

    it('ignores broken task payloads', async () => {
        const runner = env.tasks.runners.get(CHECK_TASK)!;
        const info = { id: 'x', kind: CHECK_TASK, payload: {}, state: 'running' as const, attempts: 1, createdAt: 0 };
        await runner({ key: 'k', statement: 's', against: 'x' }, info);
        await runner({ statement: 's' }, info);
        await runner({ key: 'k', statement: 's', against: [{ label: 1, text: 'x' }] }, info);
        expect(env.llm.requests).toEqual([]);
    });
});

describe('inline check (called from inside a background task)', () => {
    const running = (kind: string, chatId = 'chat-1') => ({
        id: 't1',
        kind,
        chatId,
        payload: {},
        state: 'running' as const,
        attempts: 1,
        createdAt: 0,
    });

    /** An answer that only comes when the request is aborted. */
    const hang = async (request: LlmRequest): Promise<LlmResult> =>
        new Promise((resolve) => {
            request.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' }));
        });

    it('asks the model directly when told to, without the queue', async () => {
        const result = await api.check(AGE, { inline: true });
        expect(result).toEqual({ clean: true, askedAi: true, contradictions: [], costUsd: 0.001 });
        expect(env.tasks.queued).toEqual([]);
        expect(env.llm.requests).toHaveLength(1);
        expect(env.llm.requests[0]!.signal).toBeInstanceOf(AbortSignal);
        expect(env.llm.requests[0]!.task).toBe(CHECK_TASK);
    });

    it('switches to inline by itself while a task of this chat runs', async () => {
        tasksList(env, () => [running('revision.run')]);
        expect(await api.check(AGE)).toMatchObject({ askedAi: true });
        expect(env.tasks.queued).toEqual([]);
        // A task of another chat or a queued check does not count.
        tasksList(env, () => [running('revision.run', 'chat-2'), running(CHECK_TASK)]);
        const pending = api.check(AGE);
        await queued();
        await env.tasks.runLatest(CHECK_TASK);
        expect(await pending).toMatchObject({ askedAi: true });
        tasksList(env, () => {
            throw new Error('broken');
        });
        const again = api.check(AGE);
        await queued(2);
        await env.tasks.runLatest(CHECK_TASK);
        expect(await again).toMatchObject({ askedAi: true });
    });

    it('is still leader-only and under the cap', async () => {
        env.leader.value = false;
        expect(await api.check(AGE, { inline: true })).toMatchObject({ skipped: 'notLeader', askedAi: false });
        env.leader.value = true;
        env.cap.reached = true;
        expect(await api.check(AGE, { inline: true })).toMatchObject({ skipped: 'cap' });
        expect(env.llm.requests).toEqual([]);
    });

    it('is bounded in time and can be aborted', async () => {
        env.llm.answer = hang;
        expect(await api.check(AGE, { inline: true, timeoutMs: 20 })).toMatchObject({
            askedAi: false,
            error: 'timeout',
            clean: false,
        });
        const controller = new AbortController();
        const pending = api.check(AGE, { inline: true, signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        expect(await pending).toMatchObject({ error: 'aborted' });
        const aborted = new AbortController();
        aborted.abort();
        expect(await api.check(AGE, { inline: true, signal: aborted.signal })).toMatchObject({ error: 'aborted' });
        env.llm.answer = async (request) => {
            await new Promise((resolve) => request.signal?.addEventListener('abort', resolve));
            throw new Error('fetch aborted');
        };
        expect(await api.check(AGE, { inline: true, timeoutMs: 10 })).toMatchObject({ error: 'timeout' });
    });

    it('shares one request between identical inline checks', async () => {
        const [first, second] = await Promise.all([
            api.check(AGE, { inline: true }),
            api.check({ ...AGE, statement: 'anna is 25 years old.' }, { inline: true }),
        ]);
        expect(first).toEqual(second);
        expect(env.llm.requests).toHaveLength(1);
    });
});

describe('module', () => {
    it('registers its background profile task and strings', async () => {
        expect(profileTasks()).toEqual([{ id: CHECK_TASK, labelKey: 'm26c.profileTask' }]);
        await stop();
        expect(profileTasks()).toEqual([]);
        expect(env.tasks.runners.has(CHECK_TASK)).toBe(false);
        expect(Object.keys(CONTRADICTIONS_STRINGS.ru).sort()).toEqual(Object.keys(CONTRADICTIONS_STRINGS.en).sort());
        expect(Object.keys(CONTRADICTIONS_STRINGS.en).every((key) => key.startsWith('m26c.'))).toBe(true);
        expect(contradictionsModule).toMatchObject({ id: 'M26c', key: 'contradictions', stage: 4 });
        expect(contradictionsModule.defaults()).toEqual({});
    });
});
