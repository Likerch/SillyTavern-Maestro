import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRICS_DOC_KIND, METRIC_COUNTERS } from '../../../src/features/metrics';
import type { MetricsService } from '../../../src/features/metrics';
import type { MetricsDoc } from '../../../src/domain/metrics-doc';
import type { TurnLoreRecord } from '../../../src/features/loreJournal/api';
import type { InspectorRecord } from '../../../src/features/inspector/api';
import { settle } from '../../helpers/lore-app';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
import { SETTINGS_SAVE_URL, createMetricsStand, droppedEntry, qvinkOn } from './metrics-app';
import type { MetricsStand } from './metrics-app';

function doc(env: MetricsStand, chatId = 'chat-1'): MetricsDoc | undefined {
    return env.stand.chat.doc<MetricsDoc>(chatId, METRICS_DOC_KIND);
}

function loreRecord(messageIndex: number, at: number, patch: Partial<TurnLoreRecord> = {}): TurnLoreRecord {
    return {
        messageIndex,
        at,
        generationType: 'normal',
        activations: [
            {
                world: 'W',
                uid: 1,
                comment: 'a',
                chars: 300,
                tokens: 80,
                position: 4,
                depth: 2,
                role: 2,
                order: 1,
                loop: 1,
                recursionLevel: 0,
                tags: [],
            },
            {
                world: 'W',
                uid: 2,
                comment: 'b',
                chars: 200,
                tokens: 50,
                position: 0,
                order: 1,
                loop: 1,
                recursionLevel: 0,
                tags: [],
            },
            {
                world: 'W',
                uid: 3,
                comment: 'c',
                chars: 900,
                tokens: 200,
                position: 4,
                role: 2,
                order: 1,
                loop: 1,
                recursionLevel: 1,
                tags: [],
                cut: true,
            },
        ],
        totalChars: 500,
        totalTokens: 130,
        overflow: false,
        ...patch,
    };
}

function fakeLoreJournal(env: MetricsStand) {
    const listeners = new Set<(record: TurnLoreRecord) => void>();
    env.expose('loreJournal', {
        onTurn(listener: (record: TurnLoreRecord) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
    return { emit: (record: TurnLoreRecord) => listeners.forEach((listener) => listener(record)), listeners };
}

function fakeRules(env: MetricsStand, enabled: Record<string, boolean> = {}) {
    const compared: string[][] = [];
    env.expose('rules', {
        list: () => [
            { id: 'book.cap', enabled: true, definition: { kind: 'lore' }, lastChanges: [] },
            { id: 'pack.duplicates', enabled: true, definition: { kind: 'lore' }, waiting: true, lastChanges: [] },
            { id: 'qvink.gapGuard', enabled: true, definition: { kind: 'prompt' }, lastChanges: [] },
        ],
        isEnabled: (id: string) => enabled[id] === true,
        compare: async (ids: string[]) => {
            compared.push(ids);
            return {
                before: { totalChars: 10_000 },
                after: { totalChars: 4_000 },
                removed: [{}, {}, {}],
                added: [],
                charsDelta: -6000,
            };
        },
    });
    return compared;
}

describe('M21m service', () => {
    let env: MetricsStand;
    let service: MetricsService;
    let stop: () => void;

    beforeEach(() => {
        env = createMetricsStand();
        ({ service, stop } = env.makeService());
    });

    afterEach(() => {
        stop();
    });

    describe('send path', () => {
        it('measures generation:before → request, the ST window and Maestro’s own segment', async () => {
            await env.generate({ startToBefore: 7, beforeToIntercept: 3, interceptToRequest: 40 });
            await env.generate({ startToBefore: 1, beforeToIntercept: 1, interceptToRequest: 10 });
            const turns = service.current().turns;
            expect(turns).toHaveLength(2);
            expect(turns[0]).toMatchObject({
                type: 'normal',
                device: 'desktop',
                sendMs: 43,
                windowMs: 50,
                maestroMs: 3,
            });
            expect(turns[1]).toMatchObject({ sendMs: 11, windowMs: 12, maestroMs: 1 });
            const latency = service.latency();
            expect(latency.byDevice.desktop.send).toMatchObject({ n: 2, p50: 11, p95: 43 });
            expect(latency.byDevice.phone.send.n).toBe(0);
        });

        it('starts at the interceptor when the turn pipeline reports its timing', async () => {
            let timing: { type: string; startedAt: number; endedAt: number } | null = null;
            (env.app.turn as unknown as { lastIntercept: () => unknown }).lastIntercept = () => timing;
            await env.generate({
                startToBefore: 10,
                beforeToIntercept: 4,
                interceptToRequest: 20,
                during: () => {
                    // started 3 ms before generation:before (producers), ended at the intercept handlers
                    timing = { type: 'normal', startedAt: env.clock.value - 4 - 3, endedAt: env.clock.value };
                },
            });
            expect(service.current().turns[0]).toMatchObject({
                sendMs: 27,
                interceptMs: 7,
                maestroMs: 7,
                windowMs: 34,
            });
            // A timing of an older generation is ignored.
            await env.generate({ startToBefore: 1, beforeToIntercept: 1, interceptToRequest: 1 });
            expect(service.current().turns[1]).toMatchObject({ sendMs: 2, maestroMs: 1 });
            expect(service.current().turns[1]!.interceptMs).toBeUndefined();
            (env.app.turn as unknown as { lastIntercept: () => unknown }).lastIntercept = () => {
                throw new Error('no');
            };
            await env.generate();
            expect(service.current().turns[2]!.interceptMs).toBeUndefined();
        });

        it('classes this tab as a phone when the device says so', async () => {
            env.device.value = 'phone';
            await env.generate();
            expect(service.latency().byDevice.phone.send.n).toBe(1);
            expect(service.device()).toBe('phone');
        });

        it('skips quiet and dry generations, stray requests and generations that never sent', async () => {
            await env.generate({ quiet: true });
            await env.generate({ dryRun: true });
            await env.request();
            env.runDeferred();
            await env.generate({ skipRequest: true });
            await env.app.bus.emit('generation:ended', { type: 'normal', stopped: true });
            await env.request();
            env.runDeferred();
            expect(service.current().turns).toHaveLength(0);
            await env.generate();
            await env.request(); // a second request of the same generation is not the main one
            env.runDeferred();
            expect(service.current().turns).toHaveLength(1);
        });

        it('has no window without GENERATION_STARTED and no sample in a group chat', async () => {
            env.clock.value += 120_000;
            await env.app.bus.emit('generation:before', { type: 'swipe', dryRun: false, quiet: false });
            env.clock.value += 20;
            await env.request();
            env.runDeferred();
            const [turn] = service.current().turns;
            expect(turn).toMatchObject({ type: 'swipe', sendMs: 20, maestroMs: 0 });
            expect(turn!.windowMs).toBeUndefined();

            const host = env.app.host as unknown as { group: boolean };
            host.group = true;
            await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
            await env.generate();
            expect(service.current().turns).toHaveLength(1);
        });

        it('books module timings into the generation in flight, others as idle time', async () => {
            await env.generate({
                during: () => {
                    service.record('rules.scan', 4);
                    service.record('rules scan!', 1);
                    service.time('canon.inject', () => {
                        env.clock.value += 2;
                    });
                },
            });
            const [turn] = service.current().turns;
            expect(turn!.modules).toEqual({ 'rules.scan': 4, rules_scan_: 1, 'canon.inject': 2 });
            expect(turn!.maestroMs).toBe(2 + 7);
            expect(service.latency().modules['rules.scan']).toMatchObject({ n: 1, p95: 4 });

            service.record('places.capture', 12);
            service.record('bad', -1);
            service.record('bad', NaN);
            expect(() =>
                service.time('throws', () => {
                    env.clock.value += 1;
                    throw new Error('boom');
                }),
            ).toThrow('boom');
            const value = await service.time('async', async () => {
                env.clock.value += 5;
                return 42;
            });
            expect(value).toBe(42);
            await expect(service.time('asyncFail', () => Promise.reject(new Error('no')))).rejects.toThrow('no');
            service.record('', 1);
            const snapshot = await service.snapshot();
            expect(Object.keys(snapshot.idle)).toEqual(['async', 'asyncFail', 'places.capture', 'throws', 'unnamed']);
            expect(snapshot.idle['places.capture']).toMatchObject({ n: 1, p95: 12 });
        });

        it('adds well under 1 ms per generation (P15)', async () => {
            stop();
            const real = env.makeService({ clock: () => performance.now(), defer: (run) => env.deferred.push(run) });
            const chat = Array.from({ length: 650 }, (_, i) =>
                i % 3 === 0 ? droppedEntry(`message ${i} `.repeat(20)) : droppedEntry('kept'),
            );
            for (const entry of chat.slice(300)) delete (entry.extra as Record<symbol, unknown>)[Symbol.for('ignore')];
            qvinkOn(env);
            const startedHook = env.stand.mock.eventSource.events.get('generation_started')!.at(-1)!;
            const requestHook = env.before.find((hook) => hook.match.test('/api/backends/chat-completions/generate'))!;
            const intercept = [...env.intercepts].at(-1)!;
            const info = { type: 'normal', dryRun: false, quiet: false };
            const rounds = 300;
            let hot = 0;
            let after = 0;
            for (let i = 0; i < rounds; i++) {
                const t0 = performance.now();
                startedHook('normal', {}, false);
                await env.app.bus.emit('generation:before', info);
                await intercept(chat, info);
                await requestHook.fn('/api/backends/chat-completions/generate', {});
                hot += performance.now() - t0;
                const t1 = performance.now();
                env.runDeferred();
                after += performance.now() - t1;
            }
            const perGeneration = hot / rounds;
            // The send-path part (clock reads, references) and the deferred part (device, Qvink check, batch).
            expect(perGeneration).toBeLessThan(1);
            expect(after / rounds).toBeLessThan(5);
            expect(real.service.current().turns.length).toBeGreaterThan(0);
            expect(real.service.current().turns.at(-1)!.dropped).toBe(100);
            real.stop();
        });
    });

    describe('Qvink check (criterion 4)', () => {
        it('counts dropped entries without memory after every interceptor ran', async () => {
            qvinkOn(env);
            const chat = [
                droppedEntry('Вера поднялась на маяк и долго смотрела на море.'),
                droppedEntry('Мартин отпер ворота гавани и пропустил стражу.', 'Мартин открыл ворота.'),
                droppedEntry('Томас поклялся найти пропавший корабль до рассвета.'),
                droppedEntry('ok'),
            ];
            // A handler registered after M21m's (the gap guard re-enabled later) restores one entry.
            env.intercepts.add((entries) => {
                entries[2] = { ...entries[2]!, extra: { ...entries[2]!.extra, [Symbol.for('ignore')]: false } };
            });
            await env.generate({ chat });
            expect(service.current().turns[0]!.dropped).toBe(1);
        });

        it('skips the check when Qvink does not remove messages', async () => {
            await env.generate({ chat: [droppedEntry('Вера поднялась на маяк и долго смотрела на море.')] });
            expect(service.current().turns[0]!.dropped).toBeUndefined();
            expect((await service.criteria()).rows.find((row) => row.key === 'dropped')!.status).toBe('none');
        });
    });

    describe('lore and prompt of the turn', () => {
        it('attaches the lore journal record to the newest sample once', async () => {
            const lore = fakeLoreJournal(env);
            fakeRules(env);
            await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
            env.runDeferred();
            await env.generate();
            lore.emit(loreRecord(5, env.wall.value + 10, { simulated: true }));
            lore.emit(loreRecord(5, env.wall.value + 10, { generationType: 'quiet' }));
            lore.emit(loreRecord(-1, env.wall.value + 10));
            lore.emit(loreRecord(5, env.wall.value - 10_000)); // older than the sample
            expect(service.current().turns[0]!.loreChars).toBeUndefined();
            lore.emit(loreRecord(5, env.wall.value + 10));
            lore.emit(loreRecord(5, env.wall.value + 20, { totalChars: 1 })); // second record: no new sample
            expect(service.current().turns[0]).toMatchObject({
                messageIndex: 5,
                loreChars: 500,
                loreEntries: 2,
                assistantDepth: 1,
                loreRules: 1,
            });
            const assistant = (await service.criteria()).rows.find((row) => row.key === 'assistantDepth')!;
            expect(assistant).toMatchObject({ status: 'warn', values: { total: 1, turns: 1, turnsWith: 1, max: 1 } });
        });

        it('attaches prompt tokens and lore tokens from the inspector', async () => {
            const listeners = new Set<(record: InspectorRecord) => void>();
            env.expose('inspector', {
                onTurn(listener: (record: InspectorRecord) => void) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            });
            await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
            await env.generate();
            const record = {
                messageIndex: 7,
                at: env.wall.value + 5,
                generationType: 'normal',
                messages: 20,
                chars: { system: 1, user: 1, assistant: 1, tool: 0 },
                totalTokens: 9000,
                exact: true,
                sources: [
                    { id: 'lore:W', kind: 'lore', tokens: 1200 },
                    { id: 'lore:B', kind: 'lore', tokens: 300 },
                    { id: 'preset:main', kind: 'preset', tokens: 4000 },
                ],
                loreByBook: true,
            } as unknown as InspectorRecord;
            listeners.forEach((listener) => listener(record));
            expect(service.current().turns[0]).toMatchObject({ messageIndex: 7, promptTokens: 9000, loreTokens: 1500 });
        });
    });

    describe('costs (criterion 2)', () => {
        it('ingests today’s entries per chat once and computes the share over the turns', async () => {
            await env.generate();
            const at = env.wall.value;
            env.costRecent.push(
                { source: 'main', task: 'normal', usd: 0.01, at: at + 1, chatId: 'chat-1' },
                { source: 'maestro', task: 'revision', usd: 0.001, at: at + 2, chatId: 'chat-1' },
                { source: 'maestro', usd: 0.5, at: at + 2, chatId: 'chat-2' },
                { source: 'nai', usd: 0, anlas: 6, at: at + 3, chatId: 'chat-1' },
                { source: 'qvink', usd: 0.002, at: at + 4, chatId: null },
            );
            service.ingestCosts();
            service.ingestCosts();
            env.costRecent.push({ source: 'qvink', usd: 0.003, at: at + 4, chatId: 'chat-1' });
            service.ingestCosts();
            const share = service.costShare();
            expect(share).toMatchObject({ turns: 1, autoSwipes: 0 });
            expect(share.mainUsd).toBeCloseTo(0.01);
            expect(share.maestroUsd).toBeCloseTo(0.001);
            expect(share.qvinkUsd).toBeCloseTo(0.003);
            expect(share.share).toBeCloseTo(0.1);
            await service.flush();
            expect(doc(env, 'chat-2')!.costs).toHaveLength(1);
            expect(doc(env)!.costs).toHaveLength(3);
        });

        it('counts an automatic swipe as background spend', async () => {
            await env.generate();
            env.costRecent.push({ source: 'main', usd: 0.02, at: env.wall.value + 1, chatId: 'chat-1' });
            service.noteAutoSwipe();
            await env.generate({ type: 'swipe' });
            env.costRecent.push({ source: 'main', usd: 0.02, at: env.wall.value + 1, chatId: 'chat-1' });
            service.ingestCosts();
            const share = service.costShare();
            expect(share.autoSwipes).toBe(1);
            expect(share.autoSwipeUsd).toBeCloseTo(0.02);
            expect(share.share).toBeCloseTo(1);
            expect(service.current().counters[METRIC_COUNTERS.autoSwipes]).toBe(1);
            expect(service.current().turns.map((turn) => turn.auto === true)).toEqual([false, true]);
        });

        it('falls back to the growth of today’s totals without entry access', async () => {
            (env.app.cost as unknown as { today?: unknown }).today = undefined;
            env.bySource = { main: 1 };
            env.costChanged();
            await wait(600);
            await env.generate();
            env.bySource = { main: 1.5, maestro: 0.05 };
            service.ingestCosts();
            env.bySource = { main: 1.5, maestro: 0.05 };
            service.ingestCosts();
            const share = service.costShare();
            expect(share.mainUsd).toBeCloseTo(0.5);
            expect(share.maestroUsd).toBeCloseTo(0.05);
            (env.app.cost as unknown as { summary: () => never }).summary = () => {
                throw new Error('no meter');
            };
            expect(() => service.ingestCosts()).not.toThrow();
        });

        it('prefers the meter’s own recent() list', async () => {
            await env.generate();
            const cost = env.app.cost as unknown as { recent?: () => unknown[] };
            cost.recent = () => [{ source: 'main', usd: 0.04, at: env.wall.value + 1, chatId: 'chat-1' }, 'junk'];
            service.ingestCosts();
            expect(service.costShare().mainUsd).toBeCloseTo(0.04);
            cost.recent = () => {
                throw new Error('meter gone');
            };
            expect(() => service.ingestCosts()).not.toThrow();
        });

        it('ingests on a cost change after a short delay', async () => {
            await env.generate();
            env.costRecent.push({ source: 'main', usd: 0.03, at: env.wall.value + 1, chatId: 'chat-1' });
            env.costChanged();
            env.costChanged();
            await wait(600);
            expect(service.costShare().mainUsd).toBeCloseTo(0.03);
        });
    });

    describe('zero counters (criterion 6)', () => {
        it('counts data-loss lines of this session once, never its own', async () => {
            const at = env.wall.value + 1;
            env.logLines.push(
                { at: env.wall.value - 5, level: 'warn', scope: 'Maestro:M1', text: 'could not write lore-journal' },
                { at, level: 'warn', scope: 'Maestro:M6', text: 'canon change was not journaled' },
                { at, level: 'warn', scope: 'Maestro:metrics', text: 'could not write metrics' },
                { at, level: 'warn', scope: 'Maestro:M4', text: 'stale tab: an older settings save was refused' },
            );
            await env.generate();
            const first = await service.snapshot();
            await service.snapshot();
            expect(first.counters[METRIC_COUNTERS.dataLosses]).toBe(1);
            expect((await service.snapshot()).counters[METRIC_COUNTERS.dataLosses]).toBe(1);
            expect(first.losses).toEqual(['Maestro:M6: canon change was not journaled']);
            expect(first.report.rows.find((row) => row.key === 'tabs')!.status).toBe('warn');
        });

        it('counts saves that left a stale tab and stale episodes; shows blocked saves', async () => {
            let state = 'fresh';
            env.expose('guardian', {
                tabState: () => state,
                guardInfo: () => ({
                    held: { settings: 1, preset: 0 },
                    vetoed: { settings: 2, preset: 0, worldinfo: 0 },
                }),
            });
            env.respond(SETTINGS_SAVE_URL);
            state = 'stale';
            env.respond(SETTINGS_SAVE_URL);
            env.respond('/api/presets/save');
            await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
            env.runDeferred();
            await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
            env.runDeferred();
            const snapshot = await service.snapshot();
            expect(snapshot.counters[METRIC_COUNTERS.staleSaves]).toBe(2);
            expect(snapshot.counters[METRIC_COUNTERS.staleEpisodes]).toBe(1);
            expect(snapshot.input.tabs).toMatchObject({ staleSaves: 2, blocked: 3, staleEpisodes: 1 });
        });
    });

    describe('document', () => {
        it('writes batches to the chat they belong to and merges two tabs without double counting', async () => {
            await env.generate();
            const other = env.makeService({ tabId: 'tab-B' });
            service.count('custom', 2);
            other.service.count('custom', 3);
            await service.flush();
            env.stand.chat.conflicts = 1; // tab B's first write meets a newer version
            await other.service.flush();
            const stored = doc(env)!;
            expect(stored.counters.custom).toBe(5);
            expect(stored.turns).toHaveLength(1);
            expect(Object.keys(stored.applied).sort()).toEqual(['tab-A', 'tab-B']);
            await service.flush();
            await other.service.flush();
            expect(doc(env)!.counters.custom).toBe(5);
            other.stop();
        });

        it('keeps a chat’s samples in its own document across chat switches', async () => {
            await env.generate();
            env.stand.mock.chatId = 'chat-2';
            await env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
            await settle(10);
            expect(doc(env)!.turns).toHaveLength(1);
            expect(service.current().turns).toHaveLength(0);
            await env.generate();
            await service.flush();
            expect(doc(env, 'chat-2')!.turns).toHaveLength(1);
            env.stand.mock.chatId = 'chat-1';
            await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
            await settle(10);
            expect(service.current().turns).toHaveLength(1);
            service.count('ignored-without-chat', 0);
            env.stand.mock.chatId = undefined;
            await env.app.bus.emit('chat:changed', { chatId: null });
            service.count('no chat');
            expect(service.current().turns).toHaveLength(0);
        });

        it('saves on its timer and notifies listeners', async () => {
            stop();
            const timed = env.makeService({ saveDelayMs: 5 });
            let changes = 0;
            const off = timed.service.onChange(() => changes++);
            await env.generate();
            await wait(40);
            expect(doc(env)!.turns).toHaveLength(1);
            expect(changes).toBeGreaterThan(0);
            off();
            timed.stop();
        });

        it('freezes a baseline, restarts it and compares lore without the rules', async () => {
            env.settings.baselineTurns = 2;
            const lore = fakeLoreJournal(env);
            const compared = fakeRules(env);
            await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
            env.runDeferred();
            for (const chars of [1000, 800, 300, 200]) {
                await env.generate();
                lore.emit(loreRecord(1, env.wall.value + 1, { totalChars: chars }));
            }
            let state = service.lore();
            expect(state.baseline).toMatchObject({ avgChars: 900, turns: 2, rulesOff: false });
            expect(state.current).toEqual({ avg: 250, turns: 2 });
            expect(state.ratio).toEqual({ source: 'none', baselineWithRules: true });

            await service.resetBaseline();
            state = service.lore();
            expect(state.baseline).toBeUndefined();
            expect(doc(env)!.baselineFrom).toBe(env.wall.value);

            const whatIf = await service.compareLore();
            expect(compared).toEqual([['book.cap']]);
            expect(whatIf).toMatchObject({ before: 10_000, after: 4_000, removed: 3, ruleIds: ['book.cap'] });
            expect(service.lore().ratio).toEqual({ ratio: 0.4, source: 'whatIf' });
            await service.flush();
            expect(doc(env)!.whatIf).toMatchObject({ before: 10_000 });
        });

        it('cannot compare lore without the rules module', async () => {
            expect(await service.compareLore()).toBeNull();
        });
    });

    describe('pack files (criterion 10)', () => {
        beforeEach(() => {
            env.expose('bookRoles', {
                all: () => [
                    { book: 'BunnyMo Core', role: 'bunnymo.core' },
                    { book: 'Dere Pack', role: 'bunnymo.pack' },
                    { book: 'Velmar Reaches', role: 'world' },
                ],
            });
            env.books.set('BunnyMo Core', '{"entries":{"0":{"content":"core"}}}');
            env.books.set('Dere Pack', '{"entries":{"0":{"content":"dere"}}}');
        });

        it('fingerprints books once and compares them on demand', async () => {
            expect(await service.capturePacks()).toBe(2);
            expect(await service.capturePacks()).toBe(0);
            const name = env.app.files.fileName('metrics-packs');
            expect(Object.keys((env.files.get(name) as { books: object }).books)).toEqual([
                'BunnyMo Core',
                'Dere Pack',
            ]);

            expect(await service.checkPacks()).toMatchObject({ checked: 2, same: ['BunnyMo Core', 'Dere Pack'] });
            env.books.set('Dere Pack', '{"entries":{"0":{"content":"dere, edited by CK"}}}');
            env.books.delete('BunnyMo Core');
            const changed = await service.checkPacks();
            expect(changed).toMatchObject({ changed: ['Dere Pack'], missing: ['BunnyMo Core'] });
            const row = (await service.criteria()).rows.find((item) => item.key === 'packs')!;
            expect(row).toMatchObject({ status: 'warn', values: { checked: 2, changed: 1, missing: 1 } });

            env.books.set('BunnyMo Core', '{"entries":{"0":{"content":"core"}}}');
            await service.acceptPacks();
            expect(await service.checkPacks()).toMatchObject({ same: ['BunnyMo Core', 'Dere Pack'], changed: [] });
        });

        it('adds packs seen for the first time during a check', async () => {
            await service.capturePacks();
            (env.app.adapters as unknown as Record<string, unknown>).bunnymo = {
                books: () => ({ core: [], packs: ['MBTI Pack'], archives: [] }),
            };
            env.books.set('MBTI Pack', '{"entries":{}}');
            expect(await service.checkPacks()).toMatchObject({ added: ['MBTI Pack'], checked: 2 });
            expect(await service.checkPacks()).toMatchObject({ checked: 3, added: [] });
        });

        it('has nothing to check without BunnyMo books', async () => {
            env.expose('bookRoles', { all: () => [] });
            expect(await service.capturePacks()).toBe(0);
            expect(await service.checkPacks()).toBeNull();
        });

        it('takes the first fingerprints by itself after the start delay', async () => {
            stop();
            const auto = env.makeService({ packDelayMs: 5 });
            await wait(40);
            expect(env.files.get(env.app.files.fileName('metrics-packs'))).toBeTruthy();
            auto.stop();
        });
    });

    describe('other criteria', () => {
        it('reads sheets of the chat (criterion 9)', async () => {
            const tags = '<BunnymoTags><Name:Вера>, <GENRE:FANTASY></BunnymoTags>';
            const sheet = (
                index: number,
                committed: boolean,
                text = `## SECTION 1/14: Core\n**Name:** Вера\n\n${tags}`,
            ) => ({
                name: 'Char',
                is_user: false,
                is_system: false,
                send_date: String(index),
                mes: text,
                extra: { maestro: { sheet: { command: 'fullsheet', target: 'Вера', part: 'reply', committed } } },
            });
            env.stand.mock.chat = [
                {
                    name: 'User',
                    is_user: true,
                    is_system: false,
                    send_date: '',
                    mes: '!fullsheet Вера',
                    extra: { maestro: { sheet: { command: 'fullsheet', part: 'command' } } },
                },
                sheet(1, true),
                { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'дальше', extra: {} },
            ] as STChatMessage[];
            fakeRules(env, { 'display.bunnymoTags': true });
            let row = (await service.criteria()).rows.find((item) => item.key === 'sheets')!;
            expect(row).toMatchObject({ status: 'ok', values: { sheets: 1, defects: 0 } });
            env.stand.mock.chat.push(
                sheet(3, false, `## SECTION 1/14: Core\n**Name:** Вера\n\n${tags}\n\nВера улыбнулась и ушла в ночь.`),
            );
            env.stand.mock.chat.push({
                name: 'User',
                is_user: true,
                is_system: false,
                send_date: '',
                mes: 'ещё',
                extra: {},
            } as STChatMessage);
            row = (await service.criteria()).rows.find((item) => item.key === 'sheets')!;
            expect(row).toMatchObject({ status: 'warn', values: { sheets: 2, tail: 1, notCollapsed: 1 } });
        });

        it('reads revision and undo shares (criterion 7)', async () => {
            env.autonomy.push(
                { kind: 'canon.fact', accepted: 7, edited: 2, rejected: 1, undone: 0, streak: 0 },
                { kind: 'lore.save', accepted: 90, edited: 0, rejected: 0, undone: 5, streak: 0 },
            );
            env.journal.push(
                ...Array.from({ length: 40 }, (_, i) => ({
                    id: String(i),
                    at: i,
                    chatId: 'chat-1',
                    module: 'M8',
                    kind: 'k',
                    summary: '',
                    changes: [],
                    undone: i < 1,
                })),
            );
            let snapshot = await service.snapshot();
            expect(snapshot.input.revision).toMatchObject({ decisions: 10, acceptedAsIs: 7 });
            expect(snapshot.input.undo).toMatchObject({ actions: 40, undone: 1 });
            expect(snapshot.report.rows.find((row) => row.key === 'autonomy')!.status).toBe('ok');
            env.expose('revision', { stats: () => ({ decisions: 10, acceptedAsIs: 5, edited: 5, rejected: 0 }) });
            snapshot = await service.snapshot();
            expect(snapshot.input.revision.share).toBeCloseTo(0.5);
            expect(snapshot.report.rows.find((row) => row.key === 'autonomy')!.status).toBe('warn');
            env.expose('revision', { stats: () => ({ decisions: 0, acceptedAsIs: 0, edited: 0, rejected: 0 }) });
            expect((await service.snapshot()).input.revision.share).toBeUndefined();
        });

        it('reads the living canon from its stats or from counters (criterion 8)', async () => {
            expect((await service.snapshot()).input.living).toBeNull();
            service.count(METRIC_COUNTERS.livingProvisional, 10);
            service.count(METRIC_COUNTERS.livingDropped, 3);
            expect((await service.snapshot()).input.living).toEqual({
                provisional: 10,
                droppedByUser: 3,
                confirmed: 0,
                contradictedAfterConfirm: 0,
            });
            env.expose('livingCanon', {
                stats: () => ({ provisional: 20, droppedByUser: 1, contradictedAfterConfirm: 0 }),
            });
            const snapshot = await service.snapshot();
            expect(snapshot.input.living).toEqual({ provisional: 20, droppedByUser: 1, contradictedAfterConfirm: 0 });
            expect(snapshot.report.rows.find((row) => row.key === 'living')!.status).toBe('ok');
            env.expose('livingCanon', {
                stats: () => {
                    throw new Error('not ready');
                },
            });
            expect((await service.snapshot()).input.living).toMatchObject({ provisional: 10 });
        });
    });

    describe('export', () => {
        it('renders Markdown and JSON in the UI language', async () => {
            await env.generate();
            const markdown = await service.exportReport('markdown');
            expect(markdown).toContain('# Maestro: R3 criteria');
            expect(markdown).toContain('| № | Criterion | Target | Now | Status | How it is measured | Bench |');
            expect(markdown).toContain('Added latency before the request (p95)');
            expect(markdown).toContain('PC: p95 2 ms (p50 2 ms, samples: 1)');
            const json = JSON.parse(await service.exportReport('json')) as {
                format: string;
                criteria: unknown[];
                turns: number;
            };
            expect(json.format).toBe('maestro-r3-metrics');
            expect(json.criteria).toHaveLength(10);
            expect(json.turns).toBe(1);
        });
    });
});
