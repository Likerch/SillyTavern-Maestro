import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus';
import { createEphemeral, injectionKey } from '../../src/core/ephemeral';
import { TurnPipeline } from '../../src/core/turn';
import type { EphemeralRunner } from '../../src/core/turn';
import type { GenerationInfo } from '../../src/shared/contracts';
import { createTestHost, createTestLogger, switchChat } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { EVENT_TYPES, installStMock, message } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

type PromptCall = [string, string, number, number, boolean | undefined, number | undefined];

let mock: StMock;
let host: TestHost;
let ephemeral: EphemeralRunner;
let prompts: PromptCall[];
let saveMetadata: ReturnType<typeof vi.fn>;

const info = (overrides: Partial<GenerationInfo> = {}): GenerationInfo => ({
    type: 'normal',
    dryRun: false,
    quiet: false,
    ...overrides,
});
const variables = () => mock.chatMetadata.variables as Record<string, unknown> | undefined;

beforeEach(() => {
    mock = installStMock();
    host = createTestHost(mock);
    prompts = [];
    mock.context.setExtensionPrompt = (key, value, position, depth, scan, role) => {
        prompts.push([key, value, position, depth, scan, role]);
    };
    saveMetadata = vi.fn(async () => {});
    mock.context.saveMetadata = saveMetadata as unknown as () => Promise<void>;
    ephemeral = createEphemeral({ host, log: createTestLogger() });
});

describe('flags', () => {
    it('writes chat-local variables as strings without saving the chat', () => {
        ephemeral.setFlag('maestro_scene', 'battle');
        ephemeral.setFlag('maestro_quiet', true);
        ephemeral.setFlag('maestro_count', 3);
        expect(variables()).toEqual({ maestro_scene: 'battle', maestro_quiet: 'true', maestro_count: '3' });
        expect(saveMetadata).not.toHaveBeenCalled();
    });

    it('keeps other variables and removes only its own flags', () => {
        mock.chatMetadata.variables = { user_var: 'keep' };
        ephemeral.setFlag('maestro_scene', 'battle');
        ephemeral.clearAll();
        expect(variables()).toEqual({ user_var: 'keep' });
    });

    it('cleans the metadata object it wrote to, even after a chat switch', async () => {
        ephemeral.setFlag('maestro_scene', 'battle');
        const oldVariables = variables()!;
        await switchChat(mock, 'chat-2', { variables: { maestro_scene: 'theirs' } });
        ephemeral.clearAll();
        expect(oldVariables).toEqual({});
        expect(variables()).toEqual({ maestro_scene: 'theirs' });
    });

    it('moves a flag set again after a chat switch', async () => {
        ephemeral.setFlag('maestro_scene', 'a');
        const oldVariables = variables()!;
        await switchChat(mock, 'chat-2');
        ephemeral.setFlag('maestro_scene', 'b');
        expect(oldVariables).toEqual({});
        expect(variables()).toEqual({ maestro_scene: 'b' });
    });
});

describe('injections', () => {
    it('sets extension prompts maestro_<key> with defaults for depth, scan and role', () => {
        ephemeral.setInjection('director', { text: 'Note', position: 1, depth: 2, role: 0 });
        ephemeral.setInjection('scan', { text: 'keys', position: -1, scan: true });
        expect(prompts).toEqual([
            ['maestro_director', 'Note', 1, 2, false, 0],
            ['maestro_scan', 'keys', -1, 0, true, 0],
        ]);
        expect(injectionKey('x')).toBe('maestro_x');
    });

    it('clears them to empty strings', () => {
        ephemeral.setInjection('director', { text: 'Note', position: 1, depth: 2, role: 2 });
        prompts = [];
        ephemeral.clearAll();
        expect(prompts).toEqual([['maestro_director', '', 1, 2, false, 2]]);
        prompts = [];
        ephemeral.clearAll();
        expect(prompts).toEqual([]);
    });
});

describe('run', () => {
    it('clears the last turn, then runs every producer in order', async () => {
        ephemeral.setFlag('maestro_old', 1);
        const order: string[] = [];
        ephemeral.addProducer('a', (gen) => {
            order.push(`a:${gen.type}`);
            ephemeral.setFlag('maestro_a', 1);
        });
        ephemeral.addProducer('b', async () => {
            await Promise.resolve();
            order.push('b');
        });
        await ephemeral.run(info());
        expect(order).toEqual(['a:normal', 'b']);
        expect(variables()).toEqual({ maestro_a: '1' });
    });

    it('isolates failing producers', async () => {
        const log = createTestLogger();
        const local = createEphemeral({ host, log });
        local.addProducer('bad', () => {
            throw new Error('boom');
        });
        local.addProducer('good', () => local.setFlag('maestro_ok', true));
        await local.run(info());
        expect(variables()).toEqual({ maestro_ok: 'true' });
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('skips producers on dry runs but still clears', async () => {
        ephemeral.setFlag('maestro_old', 1);
        const producer = vi.fn();
        ephemeral.addProducer('p', producer);
        await ephemeral.run(info({ dryRun: true }));
        expect(producer).not.toHaveBeenCalled();
        expect(variables()).toEqual({});
    });

    it('removes a producer on unsubscribe', async () => {
        const producer = vi.fn();
        const off = ephemeral.addProducer('p', producer);
        off();
        await ephemeral.run(info());
        expect(producer).not.toHaveBeenCalled();
    });

    it('works inside the turn pipeline: set in the interceptor, gone after the generation', async () => {
        const turn = new TurnPipeline(host, createBus(createTestLogger()), ephemeral, createTestLogger());
        turn.install();
        ephemeral.addProducer('scene', () => {
            ephemeral.setFlag('maestro_scene', 'calm');
            ephemeral.setInjection('director', { text: 'Slow down', position: 1, depth: 1 });
        });
        mock.chat.push(message('hi', { is_user: true }));
        await turn.intercept(mock.chat, 'normal');
        expect(variables()).toEqual({ maestro_scene: 'calm' });
        expect(prompts.at(-1)).toEqual(['maestro_director', 'Slow down', 1, 1, false, 0]);
        await mock.eventSource.emit(EVENT_TYPES.GENERATION_ENDED!);
        expect(variables()).toEqual({});
        expect(prompts.at(-1)).toEqual(['maestro_director', '', 1, 1, false, 0]);
        turn.dispose();
    });
});
