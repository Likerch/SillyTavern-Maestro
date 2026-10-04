// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, ScenarioContext, ScenariosApi } from '../../../src/features/scenarios/api';
import { scenariosModule } from '../../../src/features/scenarios';
import { createFixture, flush, info, ST_EVENTS } from './fixture';
import type { Fixture } from './fixture';

let fx: Fixture;
let api: ScenariosApi;
let dispose: () => Promise<void>;

const PLAN = [
    { role: 'system' as const, content: 'Only the sheet.' },
    { role: 'user' as const, content: '!fullsheet Вера' },
];

function stPrompt(): Record<string, unknown>[] {
    return [
        { role: 'system', content: 'Marinara main prompt' },
        { role: 'user', content: 'Привет' },
        { role: 'assistant', content: 'Здравствуй' },
        { role: 'user', content: '!fullsheet Вера' },
    ];
}

function scenario(overrides: Partial<Scenario> = {}): Scenario & { contexts: ScenarioContext[]; replies: number[] } {
    const contexts: ScenarioContext[] = [];
    const replies: number[] = [];
    return {
        id: 'test',
        match: (generation) => generation.sheetCommand === 'fullsheet',
        build: async (context) => {
            contexts.push(context);
            return { messages: PLAN, params: { max_tokens: 6000, temperature: 0.7 } };
        },
        onReply: (index) => {
            replies.push(index);
        },
        ...overrides,
        contexts,
        replies,
    };
}

/** ST's event sequence of one Chat Completion generation, up to the request. */
async function generate(generation = info({ sheetCommand: 'fullsheet' })) {
    await fx.bus.emit('generation:before', generation);
    const prompt = stPrompt();
    const eventData = { chat: prompt, dryRun: false };
    await fx.emit('CHAT_COMPLETION_PROMPT_READY', eventData);
    const generateData: Record<string, unknown> = { prompt: eventData.chat };
    await fx.emit('GENERATE_AFTER_DATA', generateData, false);
    // createGenerationParameters copies the array but keeps the message objects (OAI:2696).
    const request: Record<string, unknown> = {
        type: generation.type,
        messages: (generateData.prompt as object[]).filter(Boolean),
        stream: true,
        max_tokens: 300,
        temperature: 1,
        stop: ['\nКай:'],
    };
    await fx.emit('CHAT_COMPLETION_SETTINGS_READY', request);
    return { prompt, eventData, generateData, request };
}

beforeEach(async () => {
    fx = createFixture();
    const started = await fx.start(scenariosModule);
    dispose = started.dispose;
    api = fx.apis.get('scenarios') as ScenariosApi;
});

describe('scenario engine', () => {
    it('replaces the prompt in place with the plan and gives build a read-only copy', async () => {
        const test = scenario();
        api.register(test);
        const { prompt, eventData } = await generate();
        expect(eventData.chat).toBe(prompt);
        expect(prompt).toEqual(PLAN);
        const original = test.contexts[0]!.original;
        expect(original.map((m) => m.content)).toEqual([
            'Marinara main prompt',
            'Привет',
            'Здравствуй',
            '!fullsheet Вера',
        ]);
        expect(Object.isFrozen(original[0])).toBe(true);
        expect(test.contexts[0]!.info.sheetCommand).toBe('fullsheet');
        expect(test.contexts[0]!.chat).toBe(fx.mock.chat);
    });

    it('sets the request parameters once and never touches stream', async () => {
        api.register(scenario());
        const { request } = await generate();
        expect(request).toMatchObject({ max_tokens: 6000, temperature: 0.7, stream: true, stop: ['\nКай:'] });

        // A second request in the same generation (e.g. generateRaw) is not ours.
        const quiet = { type: 'quiet', messages: [{ role: 'user', content: 'x' }], max_tokens: 50, stream: false };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', quiet);
        expect(quiet.max_tokens).toBe(50);
        // Even our own messages are not reconfigured twice (one-shot).
        const again = { type: 'normal', messages: request.messages, max_tokens: 1 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', again);
        expect(again.max_tokens).toBe(1);
    });

    it('does not apply parameters to a request without our messages', async () => {
        api.register(scenario());
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', { chat: stPrompt(), dryRun: false });
        const foreign = { type: 'normal', messages: [{ role: 'user', content: 'other' }], max_tokens: 10 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', foreign);
        expect(foreign.max_tokens).toBe(10);
        const quietWithOurs = { type: 'quiet', messages: [], max_tokens: 10 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', quietWithOurs);
        expect(quietWithOurs.max_tokens).toBe(10);
    });

    it('ignores dry runs, quiet and non-matching generations', async () => {
        const test = scenario();
        api.register(test);
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        const dry = { chat: stPrompt(), dryRun: true };
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', dry);
        expect(dry.chat).toHaveLength(4);
        expect(api.active()).toBe('test');

        // A quiet generation in between does not cancel the armed scenario.
        await fx.bus.emit('generation:before', info({ type: 'quiet', quiet: true }));
        expect(api.active()).toBe('test');

        await fx.bus.emit('generation:before', info({ type: 'normal' }));
        expect(api.active()).toBeNull();
        const { prompt } = await generate(info());
        expect(prompt).toHaveLength(4);
        expect(test.contexts).toHaveLength(0);
    });

    it('stays out of Text Completion and group chats', async () => {
        api.register(scenario());
        const host = fx.app.host as unknown as { isChatCompletion: () => boolean; isGroupChat: () => boolean };
        host.isChatCompletion = () => false;
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        expect(api.active()).toBeNull();
        host.isChatCompletion = () => true;
        host.isGroupChat = () => true;
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        expect(api.active()).toBeNull();
    });

    it('keeps the prompt when build gives nothing or throws', async () => {
        const empty = scenario({ build: async () => null });
        const off = api.register(empty);
        expect((await generate()).prompt).toHaveLength(4);
        expect(api.active()).toBeNull();
        off();

        api.register(
            scenario({
                build: async () => {
                    throw new Error('boom');
                },
            }),
        );
        const { prompt, request } = await generate();
        expect(prompt).toHaveLength(4);
        expect(request.max_tokens).toBe(300);
        expect(fx.ui.notices.at(-1)?.text).toContain('test');

        const blank = scenario({ id: 'test', build: async () => ({ messages: [{ role: 'user', content: '  ' }] }) });
        api.register(blank);
        expect((await generate()).prompt).toHaveLength(4);
    });

    it('re-asserts listener order before each scenario generation, so the prompt listener is last', async () => {
        api.register(scenario());
        // Another extension subscribes after Maestro and would see (or change) the prompt after us.
        const late = vi.fn((data: { chat: unknown[] }) => {
            data.chat.push({ role: 'system', content: 'late injection' });
        });
        fx.mock.eventSource.on(ST_EVENTS.CHAT_COMPLETION_PROMPT_READY!, late as never);
        const before = fx.reasserts;
        const { prompt } = await generate();
        expect(fx.reasserts).toBe(before + 1);
        expect(late).toHaveBeenCalled();
        expect(prompt).toEqual(PLAN);
        const listeners = fx.mock.eventSource.events.get(ST_EVENTS.CHAT_COMPLETION_PROMPT_READY!)!;
        expect(listeners.at(-1)).not.toBe(late);
    });

    it('restores a prompt changed after it in GENERATE_AFTER_DATA, and the in-context marker', async () => {
        api.register(scenario());
        document.body.innerHTML =
            '<div id="chat"><div class="mes lastInContext" mesid="3"></div><div class="mes" mesid="7"></div></div>';
        fx.mock.chatMetadata.lastInContextMessageId = 3;
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        const eventData = { chat: stPrompt(), dryRun: false };
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', eventData);
        const ours = [...eventData.chat];
        // ST's setInContextMessages counted our short prompt.
        fx.mock.chatMetadata.lastInContextMessageId = 7;
        document.querySelector('[mesid="3"]')!.classList.remove('lastInContext');
        document.querySelector('[mesid="7"]')!.classList.add('lastInContext');
        // A listener after ours replaced a message.
        eventData.chat.splice(0, 1, { role: 'system', content: 'changed' });
        const generateData: Record<string, unknown> = { prompt: eventData.chat };
        await fx.emit('GENERATE_AFTER_DATA', generateData, false);
        expect(generateData.prompt).toEqual(ours);
        expect((generateData.prompt as unknown[])[0]).toBe(ours[0]);
        expect(fx.mock.chatMetadata.lastInContextMessageId).toBe(3);
        expect(document.querySelector('.lastInContext')?.getAttribute('mesid')).toBe('3');
    });

    it('builds in GENERATE_AFTER_DATA when PROMPT_READY never came', async () => {
        api.register(scenario());
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        delete fx.mock.chatMetadata.lastInContextMessageId;
        const generateData: Record<string, unknown> = { prompt: stPrompt() };
        await fx.emit('GENERATE_AFTER_DATA', generateData, true);
        expect(generateData.prompt).toHaveLength(4);
        await fx.emit('GENERATE_AFTER_DATA', generateData, false);
        expect(generateData.prompt).toEqual(PLAN);
        fx.mock.chatMetadata.lastInContextMessageId = 1;
        const request = { type: 'normal', messages: [...(generateData.prompt as object[])], max_tokens: 1 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', request);
        expect(request.max_tokens).toBe(6000);
    });

    it('filters WI entries in place without touching nested arrays', async () => {
        const keepEntry = vi.fn((entry: Record<string, unknown>) => entry.uid === 1);
        api.register(scenario({ keepEntry }));
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        const keys = ['!fullsheet'];
        const globalLore = [
            { uid: 1, key: keys },
            { uid: 2, key: ['x'] },
        ];
        const chatLore = [{ uid: 3, key: ['y'] }];
        const payload = { globalLore, characterLore: [], chatLore, personaLore: [] };
        await fx.emit('WORLDINFO_ENTRIES_LOADED', payload);
        expect(payload.globalLore).toBe(globalLore);
        expect(globalLore).toEqual([{ uid: 1, key: keys }]);
        expect(globalLore[0]!.key).toBe(keys);
        expect(chatLore).toEqual([]);

        // After the prompt is built, later scans (other extensions) are left alone.
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', { chat: stPrompt(), dryRun: false });
        const later = [{ uid: 9 }];
        await fx.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: later });
        expect(later).toHaveLength(1);
    });

    it('keeps an entry when keepEntry throws, and ignores scans outside a scenario', async () => {
        api.register(
            scenario({
                keepEntry: () => {
                    throw new Error('bad');
                },
            }),
        );
        const outside = [{ uid: 1 }];
        await fx.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: outside });
        expect(outside).toHaveLength(1);
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        const lore = [{ uid: 1 }, 'junk'];
        await fx.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: lore, chatLore: 'not a list' });
        expect(lore).toHaveLength(2);
    });

    it('calls onReply for the reply that arrives after GENERATION_ENDED (streaming order)', async () => {
        const test = scenario();
        api.register(test);
        fx.mock.chat.push(
            { name: 'Кай', is_user: true, is_system: false, send_date: '', mes: '!fullsheet Вера' },
            { name: 'Вера', is_user: false, is_system: false, send_date: '', mes: 'sheet' },
        );
        await generate();
        await fx.bus.emit('generation:ended', { type: 'normal', stopped: false });
        expect(api.active()).toBeNull();
        await fx.bus.emit('reply:ready', { messageIndex: 1, type: 'extension' });
        expect(test.replies).toEqual([]);
        await fx.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(test.replies).toEqual([]);
        await fx.bus.emit('reply:ready', { messageIndex: 1, type: 'normal' });
        await fx.bus.emit('reply:ready', { messageIndex: 1, type: 'normal' });
        expect(test.replies).toEqual([1]);
    });

    it('calls onReply when the reply comes before GENERATION_ENDED, and survives a failing onReply', async () => {
        const test = scenario({
            onReply: () => {
                throw new Error('reply failed');
            },
        });
        api.register(test);
        fx.mock.chat.push({ name: 'Вера', is_user: false, is_system: false, send_date: '', mes: 'sheet' });
        await generate();
        await fx.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        await fx.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await fx.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(api.active()).toBeNull();
    });

    it('forgets a scenario on chat change, on the next generation and when unregistered', async () => {
        const test = scenario();
        const off = api.register(test);
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        await fx.bus.emit('chat:changed', { chatId: 'other' });
        expect(api.active()).toBeNull();

        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        await fx.bus.emit('generation:ended', { type: 'normal', stopped: true });
        fx.mock.chat.push({ name: 'Вера', is_user: false, is_system: false, send_date: '', mes: 'x' });
        await fx.bus.emit('generation:before', info());
        await fx.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(test.replies).toEqual([]);

        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        off();
        expect(api.active()).toBeNull();
        off();
    });

    it('lets the first matching scenario win, replaces by id and survives a failing match', async () => {
        const broken = scenario({
            id: 'broken',
            match: () => {
                throw new Error('match');
            },
        });
        const first = scenario({ id: 'first' });
        const second = scenario({ id: 'second' });
        api.register(broken);
        api.register(first);
        api.register(second);
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        expect(api.active()).toBe('first');
        const replacement = scenario({ id: 'first', match: () => false });
        api.register(replacement);
        await fx.bus.emit('generation:before', info({ sheetCommand: 'fullsheet' }));
        expect(api.active()).toBe('second');
    });

    it('removes its listeners and API on dispose', async () => {
        const test = scenario();
        api.register(test);
        await dispose();
        expect(fx.apis.has('scenarios')).toBe(false);
        const { prompt } = await generate();
        expect(prompt).toHaveLength(4);
        await flush();
        for (const key of ['CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATE_AFTER_DATA']) {
            expect(fx.mock.eventSource.events.get(ST_EVENTS[key]!) ?? []).toHaveLength(0);
        }
    });
});
