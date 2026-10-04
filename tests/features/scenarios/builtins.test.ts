// @vitest-environment happy-dom
// M34 п. 7 / п. 9: per-scenario parameters and the built-in «impersonate» and «continue» scenarios on the real engine.
// Without a custom message set they keep ST's prompt and only set this request's parameters; `stream` never changes;
// only a generation of the matching type is touched; the sheet scenario works as before.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Scenario, ScenariosApi } from '../../../src/features/scenarios/api';
import { scenariosModule } from '../../../src/features/scenarios';
import type { ScenariosSettings } from '../../../src/features/scenarios';
import type { GenerationInfo } from '../../../src/shared/contracts';
import { createFixture, info } from './fixture';
import type { Fixture } from './fixture';

let fx: Fixture;
let api: ScenariosApi;
let settings: ScenariosSettings;

function stPrompt(): Record<string, unknown>[] {
    return [
        { role: 'system', content: 'Marinara main prompt' },
        { role: 'user', content: 'Привет' },
        { role: 'assistant', content: 'Char: Здравствуй, путник' },
        { role: 'system', content: '[Continue your last message without repeating its original content.]' },
    ];
}

/** ST's event sequence of one Chat Completion generation, up to the request. */
async function generate(generation: GenerationInfo, source = 'openrouter') {
    await fx.bus.emit('generation:before', generation);
    const prompt = stPrompt();
    const originals = [...prompt];
    const eventData = { chat: prompt, dryRun: false };
    await fx.emit('CHAT_COMPLETION_PROMPT_READY', eventData);
    const generateData: Record<string, unknown> = { prompt: eventData.chat };
    await fx.emit('GENERATE_AFTER_DATA', generateData, false);
    const request: Record<string, unknown> = {
        type: generation.type,
        messages: (generateData.prompt as object[]).filter(Boolean),
        stream: true,
        max_tokens: 1000,
        temperature: 1,
        stop: ['\nUser:'],
        chat_completion_source: source,
        reasoning_effort: 'medium',
        include_reasoning: true,
    };
    await fx.emit('CHAT_COMPLETION_SETTINGS_READY', request);
    return { prompt, originals, generateData, request };
}

beforeEach(async () => {
    fx = createFixture();
    const started = await fx.start(scenariosModule);
    settings = started.settings;
    api = fx.apis.get('scenarios') as ScenariosApi;
    fx.mock.chat.push(
        { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'Привет' },
        { name: 'Char', is_user: false, is_system: false, send_date: '', mes: 'Здравствуй, путник' },
    );
});

describe('scenario parameters', () => {
    it('lists the built-ins with their defaults, both off', () => {
        const list = api.list!();
        expect(list.map((item) => [item.id, item.types, item.defaults.enabled])).toEqual([
            ['impersonate', ['impersonate'], false],
            ['continue', ['continue'], false],
        ]);
        expect(list[0]!.titleKey).toBe('scn.impersonate.title');
        expect(fx.app.i18n.t('scn.impersonate.title')).toBe('Перевоплощение');
        expect(api.params!('impersonate')).toEqual({
            enabled: false,
            max_tokens: 300,
            stop: ['\n{{char}}:'],
            reasoning: 'off',
            messages: [],
            historyMessages: 20,
        });
        expect(api.params!('nope')).toBeNull();
        // The list is a copy.
        list[0]!.defaults.max_tokens = 1;
        expect(api.params!('impersonate')?.max_tokens).toBe(300);
    });

    it('keeps the user values in the settings slice, merged, and resets them', () => {
        api.setParams!('impersonate', { enabled: true, max_tokens: 200 });
        api.setParams!('impersonate', { temperature: 0.6, max_tokens: -3 });
        expect(settings.scenarioParams.impersonate).toEqual({ enabled: true, max_tokens: 200, temperature: 0.6 });
        expect(api.params!('impersonate')).toMatchObject({
            enabled: true,
            max_tokens: 200,
            temperature: 0.6,
            reasoning: 'off',
        });
        api.setParams!('unknown', { enabled: true });
        expect(settings.scenarioParams.unknown).toBeUndefined();
        api.setParams!('impersonate', null);
        expect(settings.scenarioParams.impersonate).toBeUndefined();
        expect(api.params!('impersonate')?.enabled).toBe(false);
        // A slice from an older settings.json without the key.
        (settings as unknown as { scenarioParams: unknown }).scenarioParams = undefined;
        expect(api.params!('continue')?.max_tokens).toBe(400);
    });

    it('lets other modules describe their scenarios', () => {
        const off = api.describe!({
            id: 'sheets',
            titleKey: 'm31.title',
            types: ['normal'],
            defaults: { max_tokens: 6000, temperature: 0.7 },
            fields: ['max_tokens', 'temperature'],
        });
        expect(api.list!().map((item) => item.id)).toEqual(['impersonate', 'continue', 'sheets']);
        api.setParams!('sheets', { max_tokens: 5000 });
        expect(api.params!('sheets')).toEqual({ max_tokens: 5000, temperature: 0.7 });
        off();
        expect(api.params!('sheets')).toBeNull();
    });
});

describe('built-in impersonate', () => {
    it('does nothing while off', async () => {
        const { prompt, originals, request } = await generate(info({ type: 'impersonate' }));
        expect(api.active()).toBeNull();
        expect(prompt).toEqual(originals);
        expect(request).toMatchObject({ max_tokens: 1000, stop: ['\nUser:'], reasoning_effort: 'medium' });
    });

    it('keeps ST’s prompt and sets a short reply, its stop strings and no reasoning — never stream', async () => {
        api.setParams!('impersonate', { enabled: true });
        const { prompt, originals, generateData, request } = await generate(info({ type: 'impersonate' }));
        expect(prompt).toHaveLength(4);
        prompt.forEach((message, index) => expect(message).toBe(originals[index]));
        expect(generateData.prompt).toBe(prompt);
        expect(request).toMatchObject({
            max_tokens: 300,
            stop: ['\nChar:'],
            reasoning_effort: 'none',
            include_reasoning: false,
            temperature: 1,
            stream: true,
        });
    });

    it('turns reasoning off without an effort on other sources', async () => {
        api.setParams!('impersonate', { enabled: true });
        const { request } = await generate(info({ type: 'impersonate' }), 'deepseek');
        expect(request).toMatchObject({ reasoning_effort: 'medium', include_reasoning: false, stream: true });
    });

    it('applies its parameters only to a generation and a request of its own type', async () => {
        api.setParams!('impersonate', { enabled: true });
        const normal = await generate(info({ type: 'normal' }));
        expect(normal.request).toMatchObject({ max_tokens: 1000, include_reasoning: true });

        // Armed for impersonate, but the request carrying ST's messages says another type.
        await fx.bus.emit('generation:before', info({ type: 'impersonate' }));
        const eventData = { chat: stPrompt(), dryRun: false };
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', eventData);
        const foreign = { type: 'normal', messages: [...eventData.chat], max_tokens: 1000 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', foreign);
        expect(foreign.max_tokens).toBe(1000);
        // A quiet request in between is never ours.
        const quiet = { type: 'quiet', messages: [...eventData.chat], max_tokens: 50 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', quiet);
        expect(quiet.max_tokens).toBe(50);
        const own = { type: 'impersonate', messages: [...eventData.chat], max_tokens: 1000, stream: false };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', own);
        expect(own).toMatchObject({ max_tokens: 300, stream: false });
        // One-shot.
        const again = { type: 'impersonate', messages: [...eventData.chat], max_tokens: 1000 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', again);
        expect(again.max_tokens).toBe(1000);
    });

    it('replaces the prompt with a custom message set and the recent chat', async () => {
        api.setParams!('impersonate', {
            enabled: true,
            historyMessages: 1,
            messages: [
                { role: 'system', content: 'Write the next message of {{user}}.' },
                { role: 'system', content: '{{history}}' },
            ],
        });
        const { prompt, request } = await generate(info({ type: 'impersonate' }));
        expect(prompt).toEqual([
            { role: 'system', content: 'Write the next message of {{user}}.' },
            { role: 'assistant', content: 'Здравствуй, путник' },
        ]);
        expect(request).toMatchObject({ max_tokens: 300, stream: true });
    });

    it('falls back to its defaults when the stored values are partial', async () => {
        settings.scenarioParams.impersonate = { enabled: true };
        await fx.bus.emit('generation:before', info({ type: 'impersonate' }));
        expect(api.active()).toBe('impersonate');
        const { request } = await generate(info({ type: 'impersonate' }));
        expect(request.max_tokens).toBe(300);
    });
});

describe('built-in continue', () => {
    it('sets its own length, keeps reasoning by default and ST’s prompt', async () => {
        api.setParams!('continue', { enabled: true });
        const { prompt, originals, request } = await generate(info({ type: 'continue' }));
        prompt.forEach((message, index) => expect(message).toBe(originals[index]));
        expect(request).toMatchObject({
            max_tokens: 400,
            include_reasoning: true,
            reasoning_effort: 'medium',
            stream: true,
        });
    });

    it('sends the continued message once with a custom set, without the set’s own prefill', async () => {
        api.setParams!('continue', {
            enabled: true,
            messages: [
                { role: 'system', content: 'Continue the story.' },
                { role: 'system', content: '{{history}}' },
                { role: 'assistant', content: '<thinking>' },
            ],
        });
        const { prompt, request } = await generate(info({ type: 'continue' }));
        expect(prompt).toEqual([
            { role: 'system', content: 'Continue the story.' },
            { role: 'user', content: 'Привет' },
            { role: 'assistant', content: 'Char: Здравствуй, путник' },
            { role: 'system', content: '[Continue your last message without repeating its original content.]' },
        ]);
        expect(request).toMatchObject({ max_tokens: 400, stream: true });
    });

    it('keeps ST’s prompt when the continued message is not in it', async () => {
        api.setParams!('continue', { enabled: true, messages: [{ role: 'system', content: 'Continue.' }] });
        fx.mock.chat.at(-1)!.mes = 'Something else entirely';
        const { prompt, originals, request } = await generate(info({ type: 'continue' }));
        prompt.forEach((message, index) => expect(message).toBe(originals[index]));
        expect(request.max_tokens).toBe(400);
    });

    it('leaves the continue of a sheet to the sheets module', async () => {
        api.setParams!('continue', { enabled: true });
        fx.apis.set('sheets', { isSheetMessage: (index: number) => index === 1 });
        const { request } = await generate(info({ type: 'continue' }));
        expect(api.active()).toBeNull();
        expect(request.max_tokens).toBe(1000);
    });
});

describe('the sheet scenario with the built-ins on', () => {
    it('still takes its own generation with its plan and parameters', async () => {
        api.setParams!('impersonate', { enabled: true });
        api.setParams!('continue', { enabled: true });
        const sheet: Scenario = {
            id: 'sheets',
            match: (generation) => generation.sheetCommand === 'fullsheet',
            build: async () => ({
                messages: [{ role: 'user', content: '!fullsheet Вера' }],
                params: { max_tokens: 6000, temperature: 0.7 },
            }),
        };
        api.register(sheet);
        const { prompt, request } = await generate(info({ sheetCommand: 'fullsheet' }));
        expect(api.active()).toBe('sheets');
        expect(prompt).toEqual([{ role: 'user', content: '!fullsheet Вера' }]);
        expect(request).toMatchObject({ max_tokens: 6000, temperature: 0.7, stream: true, include_reasoning: true });
    });
});

describe('params-only plans in the engine', () => {
    it('ignores a kept prompt without parameters: ST’s request goes out as is', async () => {
        api.register({
            id: 'empty',
            match: (generation) => generation.type === 'swipe',
            build: async () => ({ messages: [], keepPrompt: true, params: {} }),
        });
        const { prompt, originals, request } = await generate(info({ type: 'swipe' }));
        expect(api.active()).toBeNull();
        prompt.forEach((message, index) => expect(message).toBe(originals[index]));
        expect(request.max_tokens).toBe(1000);
    });

    it('falls back to GENERATE_AFTER_DATA and follows message objects swapped by a later listener', async () => {
        api.setParams!('impersonate', { enabled: true });
        await fx.bus.emit('generation:before', info({ type: 'impersonate' }));
        // PROMPT_READY never reached the engine.
        const generateData: Record<string, unknown> = { prompt: stPrompt() };
        await fx.emit('GENERATE_AFTER_DATA', generateData, false);
        const first = { type: 'impersonate', messages: [...(generateData.prompt as object[])], max_tokens: 1 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', first);
        expect(first.max_tokens).toBe(300);

        await fx.bus.emit('generation:before', info({ type: 'impersonate' }));
        const eventData = { chat: stPrompt(), dryRun: false };
        await fx.emit('CHAT_COMPLETION_PROMPT_READY', eventData);
        const swapped = { prompt: stPrompt() };
        await fx.emit('GENERATE_AFTER_DATA', swapped, false);
        const second = { type: 'impersonate', messages: [...swapped.prompt], max_tokens: 1 };
        await fx.emit('CHAT_COMPLETION_SETTINGS_READY', second);
        expect(second.max_tokens).toBe(300);
    });

    it('does not touch the in-context marker for a kept prompt', async () => {
        api.setParams!('continue', { enabled: true });
        fx.mock.chatMetadata.lastInContextMessageId = 7;
        await generate(info({ type: 'continue' }));
        expect(fx.mock.chatMetadata.lastInContextMessageId).toBe(7);
    });
});
