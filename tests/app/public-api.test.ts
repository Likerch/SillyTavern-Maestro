// @vitest-environment happy-dom
// MAESTRO_API v1 (release 1.17) with fakes of Maestro's services: the LLM wrapper (leader, cap, interactive tasks,
// schema names, error words), task and kind labels, proposals through autonomy with appliers that survive a reload,
// the journal with neighbour undo handlers, notices, turn events, names, the cast, the speech digest, quiet claims,
// «Оформить» with tags, canon goals, and publishing the global.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAESTRO_API_GLOBAL, MAESTRO_API_READY_EVENT } from '../../src/adapters';
import type { ApiTurnEvent, MaestroApiV1 } from '../../src/adapters';
import { createBus } from '../../src/core/bus';
import { createI18n } from '../../src/core/i18n';
import { createLabels } from '../../src/core/labels';
import type { Labels } from '../../src/core/labels';
import { CORE_STRINGS } from '../../src/core/strings';
import {
    apiError,
    BEFORE_TIMEOUT_MS,
    createMaestroApi,
    installMaestroApi,
    isExternalId,
    isExternalTarget,
    schemaNameOf,
} from '../../src/app/public-api';
import type { MaestroApiHandle } from '../../src/app/public-api';
import type { CanonApi, CanonDraft, CanonItem } from '../../src/features/canon/api';
import type {
    App,
    AutonomyLevel,
    Decision,
    JournalAction,
    JournalChange,
    LlmRequest,
    LlmResult,
    Proposal,
    UndoHandler,
} from '../../src/shared/contracts';
import { createFakeUi, createTestHost } from '../helpers/core-host';
import type { FakeUi } from '../helpers/core-host';
import { installDramatis } from '../helpers/dramatis';
import type { InstalledDramatis } from '../helpers/dramatis';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { ARCHIVES, FakeWorld, tick, trackerReply, userMessage } from '../features/voices/helpers';

interface Env {
    app: App;
    mock: StMock;
    ui: FakeUi;
    labels: Labels;
    world: FakeWorld;
    llm: { requests: LlmRequest[]; result: LlmResult; available: boolean };
    cost: { cap: boolean };
    leader: { value: boolean; listeners: Set<(value: boolean) => void> };
    autonomy: { proposals: { proposal: Proposal; fallback: AutonomyLevel }[]; decision: Decision; apply: boolean };
    inbox: Map<
        string,
        { apply: (payload: unknown) => Promise<void>; stillValid?: (payload: unknown) => Promise<boolean> }
    >;
    journal: { records: JournalAction[]; undo: Map<string, UndoHandler> };
    profiles: { id: string; labelKey: string; removed: boolean }[];
    apis: Map<string, unknown>;
    dramatis: InstalledDramatis;
    handle: MaestroApiHandle;
    api: MaestroApiV1;
}

let env: Env;

function start(): Env {
    const mock = installStMock();
    mock.context.name1 = 'Kai';
    const host = createTestHost(mock);
    const ui = createFakeUi();
    const i18n = createI18n(() => 'ru');
    i18n.register(CORE_STRINGS);
    const bus = createBus({ debug() {}, info() {}, warn() {}, error() {}, scope: () => bus as never } as never);
    const apis = new Map<string, unknown>();
    const world = new FakeWorld([
        { name: 'Kai', kind: 'persona' },
        { name: 'Ilva', aliases: ['Ильва'], forms: ['Ильвы', 'Ильве'], archive: `${ARCHIVES}#1` },
        { name: 'Bram' },
    ]);
    apis.set('world', world);
    const llm: Env['llm'] = { requests: [], result: { ok: true, data: { done: true }, text: '{}' }, available: true };
    const cost = { cap: false };
    const leader: Env['leader'] = { value: true, listeners: new Set() };
    const autonomy: Env['autonomy'] = { proposals: [], decision: 'queued', apply: false };
    const inbox: Env['inbox'] = new Map();
    const journal: Env['journal'] = { records: [], undo: new Map() };
    const profiles: Env['profiles'] = [];
    const log = { debug() {}, info() {}, warn() {}, error() {}, scope: () => log };
    const app = {
        host,
        log,
        i18n,
        bus,
        ui,
        llm: {
            async request<T>(request: LlmRequest): Promise<LlmResult<T>> {
                llm.requests.push(request);
                return llm.result as LlmResult<T>;
            },
            available: () => llm.available,
        },
        cost: { backgroundCapReached: () => cost.cap },
        leader: {
            isLeader: () => leader.value,
            onChange(listener: (value: boolean) => void) {
                leader.listeners.add(listener);
                return () => leader.listeners.delete(listener);
            },
        },
        autonomy: {
            async decide(proposal: Proposal, fallback: AutonomyLevel) {
                autonomy.proposals.push({ proposal, fallback });
                if (autonomy.apply) await proposal.apply(proposal.payload);
                return autonomy.decision;
            },
        },
        inbox: {
            registerApplier(
                kind: string,
                apply: (payload: unknown) => Promise<void>,
                stillValid?: (payload: unknown) => Promise<boolean>,
            ) {
                const entry = stillValid ? { apply, stillValid } : { apply };
                inbox.set(kind, entry);
                return () => {
                    if (inbox.get(kind) === entry) inbox.delete(kind);
                };
            },
        },
        journal: {
            async record(action: JournalAction) {
                journal.records.push(action);
                return `j-${journal.records.length}`;
            },
            registerUndo(target: string, handler: UndoHandler) {
                journal.undo.set(target, handler);
            },
        },
        modules: {
            api: <T>(key: string) => apis.get(key) as T | undefined,
            expose: (key: string, api: unknown) => apis.set(key, api),
        },
        adapters: {
            desru: {
                api: () => ({
                    nameForms: (name: string) => (name === 'Stranger' ? ['Stranger', 'Strangera'] : [name]),
                }),
            },
            des: { removedCharacters: () => [] },
        },
    } as unknown as App;
    const dramatis = installDramatis(app);
    const labels = createLabels();
    const handle = createMaestroApi({
        app,
        labels,
        version: '1.17.0',
        registerProfileTask: (id, labelKey) => {
            const entry = { id, labelKey, removed: false };
            profiles.push(entry);
            return () => {
                entry.removed = true;
            };
        },
    });
    return {
        app,
        mock,
        ui,
        labels,
        world,
        llm,
        cost,
        leader,
        autonomy,
        inbox,
        journal,
        profiles,
        apis,
        dramatis,
        handle,
        api: handle.api,
    };
}

beforeEach(() => {
    env = start();
});

afterEach(() => {
    env.handle.dispose();
    env.dramatis.remove();
    vi.useRealTimers();
});

describe('ids', () => {
    it('lets a neighbour use `dramatis.` tasks and kinds, `dramatis.`/`dramatis-` targets', () => {
        expect(isExternalId('dramatis.turn')).toBe(true);
        expect(isExternalId('dramatis.scene_pass.v2')).toBe(true);
        expect(isExternalId('canon.fact')).toBe(false);
        expect(isExternalId('dramatis.')).toBe(false);
        expect(isExternalId(5)).toBe(false);
        expect(isExternalTarget('dramatis-stance')).toBe(true);
        expect(isExternalTarget('dramatis.intent')).toBe(true);
        expect(isExternalTarget('lore-entry')).toBe(false);
        expect(schemaNameOf('dramatis.turn')).toBe('dramatis_turn');
        expect(apiError('breaker-open')).toBe('breaker');
        expect(apiError('no-cm')).toBe('no-profile');
        expect(apiError('cap')).toBe('cap');
    });
});

describe('llm', () => {
    const messages = [
        { role: 'system' as const, content: 'You are the engine.' },
        { role: 'user' as const, content: 'Who acts?' },
    ];

    it('runs a background task through Maestro’s client, named after the task, with the cost reported', async () => {
        env.llm.result = {
            ok: true,
            data: { who: 'Ilva' },
            text: '{"who":"Ilva"}',
            costUsd: 0.002,
            tokens: { prompt: 900, completion: 40 },
        };
        const result = await env.api.llm.request({
            task: 'dramatis.turn',
            messages,
            maxTokens: 800,
            temperature: 0.3,
            schema: { name: 'turn', schema: { type: 'object' } },
            background: true,
        });
        expect(result).toEqual({
            ok: true,
            data: { who: 'Ilva' },
            text: '{"who":"Ilva"}',
            costUsd: 0.002,
            tokens: { prompt: 900, completion: 40 },
        });
        expect(env.llm.requests[0]).toEqual({
            task: 'dramatis.turn',
            messages,
            maxTokens: 800,
            temperature: 0.3,
            schema: { name: 'dramatis_turn', schema: { type: 'object' } },
        });
    });

    it('refuses background work outside the leader tab and over the cap; a click is interactive', async () => {
        env.leader.value = false;
        expect(
            await env.api.llm.request({ task: 'dramatis.turn', messages, maxTokens: 100, background: true }),
        ).toEqual({
            ok: false,
            error: 'not-leader',
        });
        env.leader.value = true;
        env.cost.cap = true;
        expect(
            await env.api.llm.request({ task: 'dramatis.turn', messages, maxTokens: 100, background: true }),
        ).toEqual({
            ok: false,
            error: 'cap',
        });
        expect(env.llm.requests).toEqual([]);
        env.leader.value = false;
        const result = await env.api.llm.request({
            task: 'dramatis.read',
            messages,
            maxTokens: 100,
            background: false,
        });
        expect(result.ok).toBe(true);
        expect(env.llm.requests[0]?.interactive).toBe(true);
    });

    it('words Maestro’s errors as the contract does and checks the request', async () => {
        env.llm.result = { ok: false, error: 'breaker-open' };
        expect(
            (await env.api.llm.request({ task: 'dramatis.turn', messages, maxTokens: 10, background: true })).error,
        ).toBe('breaker');
        env.llm.result = { ok: false, refusal: true, error: 'refusal', text: 'I cannot' };
        expect(await env.api.llm.request({ task: 'dramatis.turn', messages, maxTokens: 10, background: true })).toEqual(
            {
                ok: false,
                refusal: true,
                error: 'refusal',
                text: 'I cannot',
            },
        );
        expect(await env.api.llm.request({ task: 'maestro.turn', messages, maxTokens: 10, background: true })).toEqual({
            ok: false,
            error: 'bad-task',
        });
        expect(
            await env.api.llm.request({ task: 'dramatis.turn', messages: [], maxTokens: 10, background: true }),
        ).toEqual({ ok: false, error: 'bad-request' });
        await env.api.llm.request({ task: 'dramatis.turn', messages, maxTokens: 10_000_000, background: true });
        expect(env.llm.requests.at(-1)?.maxTokens).toBe(32_000);
    });

    it('reports availability and shows a registered task in the profile list with its label', () => {
        expect(env.api.llm.available('dramatis.turn')).toBe(true);
        expect(env.api.llm.available('canon.fact')).toBe(false);
        env.llm.available = false;
        expect(env.api.llm.available('dramatis.turn')).toBe(false);

        const off = env.api.llm.registerTask('dramatis.turn', {
            ru: 'Dramatis: проход хода',
            en: 'Dramatis: turn pass',
        });
        expect(env.profiles).toEqual([
            { id: 'dramatis.turn', labelKey: 'core.dramatis.task.dramatis.turn', removed: false },
        ]);
        expect(env.app.i18n.t('core.dramatis.task.dramatis.turn')).toBe('Dramatis: проход хода');
        off();
        expect(env.profiles[0]?.removed).toBe(true);
        env.api.llm.registerTask('turn', { ru: 'x', en: 'x' });
        env.api.llm.registerTask('dramatis.x', { ru: '', en: '' });
        expect(env.profiles).toHaveLength(1);
    });
});

describe('proposals and the Inbox', () => {
    it('needs an applier: it labels the kind and makes stored cards work after a reload', async () => {
        expect(
            await env.api.propose({ kind: 'dramatis.intent', title: 'x', changes: [], payload: {}, fallback: 'inbox' }),
        ).toBe('skipped');
        const applied: unknown[] = [];
        const off = env.api.registerApplier(
            'dramatis.intent',
            { ru: 'Намерение персонажа', en: 'A character’s intent' },
            async (payload) => {
                applied.push(payload);
            },
            async (payload) => (payload as { still?: boolean }).still === true,
        );
        expect(env.app.i18n.t('kind.dramatis.intent')).toBe('Намерение персонажа');
        const stored = env.inbox.get('dramatis.intent');
        expect(stored).toBeDefined();
        await stored!.apply({ from: 'reload' });
        expect(applied).toEqual([{ from: 'reload' }]);
        expect(await stored!.stillValid!({ still: true })).toBe(true);

        const payload = { intent: 'follow the courier', still: true };
        const decision = await env.api.propose({
            kind: 'dramatis.intent',
            title: '  Ильва решила проследить за курьером  ',
            description: 'Брам пойдёт за ним.',
            details: 'stance −2 → −3',
            changes: [{ target: 'dramatis.intent', ref: { who: 'Ilva' }, before: null, after: 'follow' }],
            payload,
            sourceMessage: 7,
            fallback: 'notify',
            ttlMs: 60_000,
            acceptLabel: 'Пусть',
            rejectLabel: 'Не надо',
        });
        expect(decision).toBe('queued');
        const { proposal, fallback } = env.autonomy.proposals[0]!;
        expect(fallback).toBe('notify');
        expect(proposal).toMatchObject({
            module: 'dramatis',
            kind: 'dramatis.intent',
            title: 'Ильва решила проследить за курьером',
            description: 'Брам пойдёт за ним.',
            details: 'stance −2 → −3',
            sourceMessage: 7,
            ttlMs: 60_000,
            acceptLabel: 'Пусть',
            rejectLabel: 'Не надо',
            changes: [{ target: 'dramatis.intent', ref: { who: 'Ilva' }, before: null, after: 'follow' }],
            payload,
        });
        expect(proposal.payload).not.toBe(payload);
        expect(await proposal.stillValid?.()).toBe(true);
        await proposal.apply(proposal.payload);
        expect(applied.at(-1)).toEqual(payload);

        await env.api.propose({
            kind: 'dramatis.intent',
            title: '',
            changes: [],
            payload: 1,
            fallback: 'bogus' as never,
        });
        expect(env.autonomy.proposals[1]?.fallback).toBe('inbox');
        expect(env.autonomy.proposals[1]?.proposal.title).toBe('Намерение персонажа');

        off();
        expect(env.inbox.has('dramatis.intent')).toBe(false);
        expect(
            await env.api.propose({ kind: 'dramatis.intent', title: 'x', changes: [], payload: {}, fallback: 'auto' }),
        ).toBe('skipped');
        expect(env.api.registerApplier('canon.fact', { ru: 'x', en: 'x' }, async () => {})).toBeTypeOf('function');
        expect(env.inbox.has('canon.fact')).toBe(false);
    });
});

describe('journal', () => {
    it('records under the module «dramatis» and refuses foreign kinds', async () => {
        const id = await env.api.journal.record({
            kind: 'dramatis.stance',
            summary: 'Ильва охладела к Каю',
            changes: [{ target: 'dramatis.stance', ref: { from: 'Ilva', to: 'Kai' }, before: -2, after: -3 }],
            sourceMessage: 4,
        });
        expect(id).toBe('j-1');
        expect(env.journal.records[0]).toEqual({
            module: 'dramatis',
            kind: 'dramatis.stance',
            summary: 'Ильва охладела к Каю',
            changes: [{ target: 'dramatis.stance', ref: { from: 'Ilva', to: 'Kai' }, before: -2, after: -3 }],
            sourceMessage: 4,
        });
        await expect(env.api.journal.record({ kind: 'canon.fact', summary: 'x', changes: [] })).rejects.toThrow(
            /dramatis\./,
        );
    });

    it('routes undo of its targets to the neighbour’s current handler, labelled as Dramatis', async () => {
        const seen: JournalChange[] = [];
        const off = env.api.journal.registerUndo('dramatis.stance', async (change) => {
            seen.push(change as JournalChange);
            return true;
        });
        const proxy = env.journal.undo.get('dramatis.stance')!;
        const change = { target: 'dramatis.stance', ref: {}, before: 1, after: 2 };
        expect(await proxy(change)).toBe(true);
        expect(seen).toEqual([change]);
        expect(env.labels.target('dramatis.stance')).toMatchObject({
            labelKey: 'core.dramatis.target',
            technical: true,
        });
        off();
        expect(await proxy(change)).toBe(false);
        // A new handler (Dramatis restarted) is used by the same proxy.
        env.api.journal.registerUndo('dramatis.stance', async () => true);
        expect(env.journal.undo.get('dramatis.stance')).toBe(proxy);
        expect(await proxy(change)).toBe(true);
        env.api.journal.registerUndo('lore-entry', async () => true);
        expect(env.journal.undo.has('lore-entry')).toBe(false);
    });
});

describe('notices and leadership', () => {
    it('shows notices with importance and an action that cannot break Maestro', () => {
        const run = vi.fn(() => {
            throw new Error('boom');
        });
        env.api.notice('Ильва что-то задумала', { importance: 'important', action: { label: 'Показать', run } });
        env.api.notice('   ');
        expect(env.ui.notices).toHaveLength(1);
        expect(env.ui.notices[0]?.text).toBe('Ильва что-то задумала');
        expect(env.ui.notices[0]?.options?.importance).toBe('important');
        expect(() => env.ui.notices[0]?.options?.action?.run()).not.toThrow();
        expect(run).toHaveBeenCalled();
        env.api.notice('info');
        expect(env.ui.notices[1]?.options).toEqual({ importance: 'info' });
    });

    it('passes the leader state and its changes', () => {
        const seen: boolean[] = [];
        env.api.leader.onChange((value) => seen.push(value));
        for (const listener of env.leader.listeners) listener(false);
        expect(seen).toEqual([false]);
        expect(env.api.leader.isLeader()).toBe(true);
        env.handle.dispose();
        expect(env.leader.listeners.size).toBe(0);
    });
});

describe('turn events', () => {
    it('maps Maestro’s pipeline to the contract’s events', async () => {
        const events: ApiTurnEvent[] = [];
        const off = env.api.onTurn((event) => {
            events.push(event);
        });
        const { bus } = env.app;
        await bus.emit('chat:changed', { chatId: 'chat-2' });
        await bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        await bus.emit('reply:ready', { messageIndex: 5, type: 'normal' });
        await bus.emit('generation:ended', { type: 'normal', stopped: true });
        await bus.emit('turn:committed', { messageIndex: 5 });
        await bus.emit('message:invalidated', { messageIndex: 5, reason: 'swiped' });
        expect(events).toEqual([
            { type: 'chat:changed', chatId: 'chat-2' },
            { type: 'generation:before', generation: 'normal', dryRun: false, quiet: false },
            { type: 'reply:ready', messageIndex: 5 },
            { type: 'generation:ended', generation: 'normal', stopped: true },
            { type: 'turn:committed', messageIndex: 5 },
            { type: 'message:invalidated', messageIndex: 5, reason: 'swiped' },
        ]);
        off();
        await bus.emit('turn:committed', { messageIndex: 6 });
        expect(events).toHaveLength(6);
    });

    it('waits for a slow generation:before listener at most a moment; a failing listener breaks nothing', async () => {
        vi.useFakeTimers();
        env.api.onTurn(() => new Promise<void>(() => {}));
        env.api.onTurn(() => {
            throw new Error('boom');
        });
        let done = false;
        const emitted = env.app.bus
            .emit('generation:before', { type: 'normal', dryRun: false, quiet: false })
            .then(() => {
                done = true;
            });
        await vi.advanceTimersByTimeAsync(BEFORE_TIMEOUT_MS - 10);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(20);
        await emitted;
        expect(done).toBe(true);
    });
});

describe('names, cast and speech', () => {
    it('resolves names through the world model with DES-RU forms', () => {
        expect(env.api.names.resolve('Ильвы')).toEqual({
            id: 'character:ilva',
            name: 'Ilva',
            aliases: ['Ильва'],
            forms: ['Ильвы', 'Ильве'],
        });
        // No forms in the world model: DES-RU's.
        expect(env.api.names.resolve('Bram')?.forms).toEqual(['Bram']);
        expect(env.api.names.resolve('Nobody')).toBeNull();
        expect(env.api.names.same('Ilva', 'ильве')).toBe(true);
        expect(env.api.names.same('Ilva', 'Bram')).toBe(false);
        expect(env.api.names.same('Stranger', 'Strangera')).toBe(true);
        expect(env.api.names.same('Ilva', 'Ильва')).toBe(true);
        expect(env.api.names.same('', 'x')).toBe(false);
    });

    it('gives the cast of the committed reply and the voice cards’ speech digest', async () => {
        const books: Record<string, unknown> = {
            [ARCHIVES]: {
                entries: {
                    '1': {
                        uid: 1,
                        content:
                            '<BunnymoTags><Name:Ilva>, <INTJ-U>, <LING:CURT></BunnymoTags>\n<Linguistics>Speaks in short, clipped sentences.</Linguistics>',
                    },
                },
            },
        };
        const loads: string[] = [];
        (env.mock.context as unknown as Record<string, unknown>).loadWorldInfo = async (name: string) => {
            loads.push(name);
            return books[name] ?? null;
        };
        env.mock.chat = [
            userMessage('Hello.'),
            trackerReply([{ name: 'Ильва' }, { name: 'Kai' }, { name: 'Bram', present: false }, { name: 'Stranger' }]),
            userMessage('Well?'),
        ];
        expect(env.api.present()).toEqual(['Ilva', 'Stranger']);
        expect(env.api.speech('Ilva')).toBeNull();
        await tick();
        expect(env.api.speech('Ильве')).toBe('Speech: curt; short, clipped sentences | MBTI: INTJ-U (unhealthy)');
        expect(env.api.speech('Bram')).toBeNull();
        expect(env.api.speech('Nobody')).toBeNull();
        expect(loads).toEqual([ARCHIVES]);

        // Warmed ahead of the next generation when the turn moves on.
        env.handle.speech.warm(['Ilva']);
        await env.app.bus.emit('turn:committed', { messageIndex: 1 });
        expect(loads).toEqual([ARCHIVES]);
        await env.mock.eventSource.emit('worldinfo_updated', ARCHIVES);
        await tick();
        expect(loads).toEqual([ARCHIVES, ARCHIVES]);
    });
});

describe('speech ahead of time', () => {
    it('reads the archives of the cast a moment after a turn, so speech() answers at the next generation', async () => {
        const loads: string[] = [];
        (env.mock.context as unknown as Record<string, unknown>).loadWorldInfo = async (name: string) => {
            loads.push(name);
            return { entries: { '1': { uid: 1, content: '<BunnymoTags><Name:Ilva>, <LING:CURT></BunnymoTags>' } } };
        };
        env.mock.chat = [userMessage('Hello.'), trackerReply([{ name: 'Ilva' }]), userMessage('Well?')];
        await env.app.bus.emit('turn:committed', { messageIndex: 1 });
        // Not on the send path: nothing is read during the event itself.
        expect(loads).toEqual([]);
        await tick();
        expect(loads).toEqual([ARCHIVES]);
        expect(env.api.speech('Ilva')).toBe('Speech: curt');
    });
});

describe('quiet modes', () => {
    it('records claims in the Dramatis adapter and gives them back when Maestro stops', () => {
        const off = env.api.quiet('voices', 'dramatis');
        env.api.quiet('ck.consistency', 'dramatis');
        expect(env.dramatis.adapter.claims().map((claim) => claim.fn)).toEqual(['voices', 'ck.consistency']);
        off();
        expect(env.dramatis.adapter.isClaimed('voices')).toBe(false);
        env.api.quiet('nope' as never, 'x');
        expect(env.dramatis.adapter.claims()).toHaveLength(1);
        env.handle.dispose();
        expect(env.dramatis.adapter.claims()).toEqual([]);
        expect(env.api.quiet('voices', 'dramatis')).toBeTypeOf('function');
        expect(env.dramatis.adapter.claims()).toEqual([]);
    });
});

describe('stage 3', () => {
    it('styles up through the dossier and says false without it', async () => {
        expect(await env.api.styleUp?.('Bram', ['<SPECIES:HUMAN>'])).toBe(false);
        const calls: [string, readonly string[]][] = [];
        env.apis.set('dossier', {
            styleUpArchive: async (name: string, tags: readonly string[]) => {
                calls.push([name, tags]);
                return true;
            },
        });
        expect(await env.api.styleUp?.('  Bram ', ['<SPECIES:HUMAN>', 5 as never])).toBe(true);
        expect(calls).toEqual([['Bram', ['<SPECIES:HUMAN>']]]);
        expect(await env.api.styleUp?.('Bram', [])).toBe(false);
    });

    it('writes goals into the character’s chat canon entry, or makes one', async () => {
        const items: CanonItem[] = [
            {
                uid: 3,
                meta: {
                    kind: 'addition',
                    status: 'active',
                    origin: 'entity',
                    type: 'character',
                    createdAt: 1,
                    updatedAt: 2,
                    typeFields: { name: 'Ilva', role: 'innkeeper' },
                } as CanonItem['meta'],
                entry: { comment: 'Ilva', key: ['Ilva'], content: 'Character: Ilva\nRole: innkeeper' },
            },
        ];
        const puts: { draft: CanonDraft; options?: { uid?: number } }[] = [];
        const canon: Partial<CanonApi> = {
            list: async () => items,
            put: async (draft, options) => {
                puts.push(options ? { draft, options } : { draft });
                return options?.uid ?? 9;
            },
            russianKeys: async (term) => (term === 'Bram' ? ['Брам', 'Брама'] : [term]),
        };
        expect(await env.api.setCanonGoals?.('Ilva', ['raise the tax'])).toBe(false);
        env.apis.set('canon', canon);

        expect(await env.api.setCanonGoals?.('Ильва', ['raise the tax', 'raise the tax', ' avenge her husband '])).toBe(
            true,
        );
        expect(puts[0]?.options).toEqual({ uid: 3 });
        expect(puts[0]?.draft.entry.content).toBe(
            'Character: Ilva\nRole: innkeeper\nGoals:\nraise the tax\navenge her husband',
        );
        expect(puts[0]?.draft.meta).toMatchObject({
            kind: 'addition',
            type: 'character',
            typeFields: { name: 'Ilva', role: 'innkeeper', goals: 'raise the tax\navenge her husband' },
        });
        expect(puts[0]?.draft.meta).not.toHaveProperty('createdAt');

        expect(await env.api.setCanonGoals?.('Bram', ['keep the inn safe'])).toBe(true);
        expect(puts[1]?.options).toBeUndefined();
        expect(puts[1]?.draft).toEqual({
            entry: {
                comment: 'Bram',
                key: ['Bram', 'Брам', 'Брама'],
                keysecondary: [],
                content: 'Character: Bram\nGoals: keep the inn safe',
            },
            meta: {
                kind: 'addition',
                status: 'active',
                origin: 'entity',
                type: 'character',
                typeFields: { name: 'Bram', goals: 'keep the inn safe' },
            },
        });
        // Nothing to write for a character without an entry.
        expect(await env.api.setCanonGoals?.('Nobody', [])).toBe(true);
        expect(puts).toHaveLength(2);
        env.mock.chatId = undefined;
        expect(await env.api.setCanonGoals?.('Bram', ['x'])).toBe(false);
    });
});

describe('the global', () => {
    it('is published with maestro-api-ready and removed when Maestro stops', () => {
        const seen: unknown[] = [];
        const listener = (event: Event) => seen.push((event as CustomEvent).detail);
        window.addEventListener(MAESTRO_API_READY_EVENT, listener);
        const installed = installMaestroApi({ app: env.app, version: '1.17.0', registerProfileTask: () => () => {} });
        const root = globalThis as Record<string, unknown>;
        expect(root[MAESTRO_API_GLOBAL]).toBe(installed.handle.api);
        expect(installed.handle.api).toMatchObject({ version: 1, maestroVersion: '1.17.0' });
        expect(seen).toEqual([{ version: 1 }]);
        installed.remove();
        expect(root[MAESTRO_API_GLOBAL]).toBeUndefined();
        window.removeEventListener(MAESTRO_API_READY_EVENT, listener);
    });

    it('answers safely after Maestro stopped', async () => {
        env.handle.dispose();
        expect(
            await env.api.llm.request({ task: 'dramatis.turn', messages: [], maxTokens: 1, background: true }),
        ).toEqual({
            ok: false,
            error: 'maestro-stopped',
        });
        expect(env.api.present()).toEqual([]);
        expect(env.api.speech('Ilva')).toBeNull();
        expect(
            await env.api.propose({ kind: 'dramatis.x', title: 'x', changes: [], payload: 0, fallback: 'auto' }),
        ).toBe('skipped');
        await expect(env.api.journal.record({ kind: 'dramatis.x', summary: 'x', changes: [] })).rejects.toThrow();
    });
});
