// The assistant's loop with packs, scopes and attached context (M33, plan-2 §1): a pack is one card with its changes,
// the user keeps some and picks a scope, the model learns what was applied and what was left out; limits of 5 cards
// and 20 changes per message; the preset mode (a block attached or preset tools in use) gives longer answers and the
// preset rules; «Обсудить с ассистентом» attaches a block and opens the assistant.
import { describe, expect, it, vi } from 'vitest';
import type {
    ApplyChoice,
    ToolCallRecord,
    ToolSpec,
    WriteOutcome,
    WritePlan,
} from '../../../src/features/assistant/api';
import { contextKey } from '../../../src/features/assistant/api';
import { MAX_CHANGES, contextNote } from '../../../src/features/assistant/service';
import type { AssistantService } from '../../../src/features/assistant/service';
import { ASSISTANT_DOC, normalizeAssistantDoc } from '../../../src/features/assistant/store';
import type { AssistantDoc } from '../../../src/features/assistant/store';
import type { LlmMessage } from '../../../src/shared/contracts';
import { answer, callOf, calls, createAssistantEnv, readTool, until, writeTool } from './env';

function records(service: AssistantService): ToolCallRecord[] {
    return service.conversation().flatMap((message) => message.toolCalls ?? []);
}

function toolMessages(messages: LlmMessage[]): LlmMessage[] {
    return messages.filter((message) => message.role === 'tool');
}

async function waitingCard(service: AssistantService): Promise<ToolCallRecord> {
    await until(() => records(service).some((record) => record.status === 'waiting' && service.awaiting(record.id)));
    return records(service).find((record) => record.status === 'waiting')!;
}

const SCOPES = [
    { value: 'global', label: 'Везде' },
    { value: 'chat', label: 'Этот чат' },
];

interface PackProbe {
    tool: ToolSpec;
    choices: (ApplyChoice | undefined)[];
}

/** A write tool whose plan is a pack of `size` changes; apply() reports per item (`fail`: ids that fail). */
function packTool(name = 'pack_thing', size = 3, fail: string[] = []): PackProbe {
    const probe: PackProbe = { choices: [], tool: undefined as unknown as ToolSpec };
    probe.tool = {
        name,
        kind: 'write',
        description: `Changes several things at once (${name}).`,
        parameters: { type: 'object', properties: {} },
        async plan(): Promise<WritePlan> {
            return {
                summary: `Pack of ${size}`,
                target: 'Preset «Marinara»',
                before: undefined,
                after: undefined,
                items: Array.from({ length: size }, (_, index) => ({
                    id: `c${index + 1}`,
                    summary: `Change ${index + 1}`,
                    before: { Текст: `old ${index + 1}` },
                    after: { Текст: `new ${index + 1}` },
                })),
                scope: 'global',
                scopes: SCOPES,
                full: true,
                async apply(choice): Promise<WriteOutcome> {
                    probe.choices.push(choice);
                    const selected = choice?.selected ?? [];
                    return {
                        result: { done: true },
                        items: Array.from({ length: size }, (_, index) => {
                            const id = `c${index + 1}`;
                            if (!selected.includes(id)) return { id, status: 'skipped' as const };
                            if (fail.includes(id)) return { id, status: 'error' as const, error: 'The block changed.' };
                            return { id, status: 'applied' as const };
                        }),
                    };
                },
            };
        },
    };
    return probe;
}

describe('packs', () => {
    it('waits as one card with its changes and the scope switch; applies the kept ones in the chosen scope', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        const probe = packTool();
        service.registerTool(probe.tool);
        env.llm.script(calls(callOf('pack_thing', {}, 'p1')), answer('Done.'));
        const sending = service.send('tidy the preset');
        const card = await waitingCard(service);
        expect(card).toMatchObject({ status: 'waiting', summary: 'Pack of 3', scope: 'global', scopes: SCOPES });
        expect(card.items?.map((item) => item.id)).toEqual(['c1', 'c2', 'c3']);
        expect(card.items?.[1]).toEqual({
            id: 'c2',
            summary: 'Change 2',
            before: { Текст: 'old 2' },
            after: { Текст: 'new 2' },
        });
        await service.confirm('p1', true, { selected: ['c3', 'c1', 'zzz'], scope: 'chat' });
        await sending;
        expect(probe.choices).toEqual([{ selected: ['c1', 'c3'], scope: 'chat' }]);
        const applied = records(service)[0]!;
        expect(applied.status).toBe('applied');
        expect(applied.scope).toBe('chat');
        expect(applied.items?.map((item) => item.status)).toEqual(['applied', 'skipped', 'applied']);
        const told = toolMessages(env.llm.requests[1]!.messages)[0]!.content;
        expect(told).toContain('Applied 2 of 3 changes of the pack «Pack of 3»:\n- Change 1\n- Change 3');
        expect(told).toContain(
            'Left out by the user (not changed; do not propose them again unless asked):\n- Change 2',
        );
        expect(told).toContain('The user chose where it applies: Этот чат.');
        expect(told).toContain('Result: {"done":true}');
        expect(env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)?.writes).toHaveLength(2);
    });

    it('applies every change with «Применить всё» and reports the ones that failed', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        const probe = packTool('pack_thing', 3, ['c2']);
        service.registerTool(probe.tool);
        env.llm.script(calls(callOf('pack_thing', {}, 'p1')), answer('Done.'));
        const sending = service.send('go');
        await waitingCard(service);
        await service.confirm('p1', true);
        await sending;
        expect(probe.choices).toEqual([{ selected: ['c1', 'c2', 'c3'], scope: 'global' }]);
        const record = records(service)[0]!;
        expect(record.items?.map((item) => [item.status, item.error])).toEqual([
            ['applied', undefined],
            ['error', 'The block changed.'],
            ['applied', undefined],
        ]);
        expect(toolMessages(env.llm.requests[1]!.messages)[0]!.content).toContain(
            'Failed (not changed):\n- Change 2: The block changed.',
        );
        expect(env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)?.writes).toHaveLength(2);
    });

    it('turns a pack whose changes all failed into an error, and a pack with nothing kept into a decline', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        service.registerTool(packTool('all_fail', 2, ['c1', 'c2']).tool);
        const none = packTool('none_kept', 2);
        service.registerTool(none.tool);
        env.llm.script(calls(callOf('all_fail', {}, 'a'), callOf('none_kept', {}, 'b')), answer('Ok.'));
        const sending = service.send('go');
        await waitingCard(service);
        await service.confirm('a', true);
        await waitingCard(service);
        await service.confirm('b', true, { selected: [] });
        await sending;
        expect(records(service).map((record) => [record.status, record.error])).toEqual([
            ['error', 'The block changed.'],
            ['declined', undefined],
        ]);
        expect(none.choices).toEqual([]);
        const told = toolMessages(env.llm.requests[1]!.messages);
        expect(told[0]!.content).toContain('none of the changes of this pack was made');
        expect(told[1]!.content).toContain('The user declined this change');
        expect(env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)?.writes).toEqual([]);
    });

    it('passes the scope chosen on a single card, and only a scope the plan offers', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        const chosen: (ApplyChoice | undefined)[] = [];
        const probe = writeTool('scoped_thing', {
            async plan(args) {
                return {
                    summary: `Thing → ${String(args['value'])}`,
                    target: 'Preset',
                    before: 1,
                    after: args['value'],
                    scope: 'global',
                    scopes: SCOPES,
                    async apply(choice) {
                        chosen.push(choice);
                        return {};
                    },
                };
            },
        });
        service.registerTool(probe.tool);
        env.llm.script(
            calls(callOf('scoped_thing', { value: 2 }, 's1'), callOf('scoped_thing', { value: 3 }, 's2')),
            answer('Ok.'),
        );
        const sending = service.send('go');
        await waitingCard(service);
        await service.confirm('s1', true, { scope: 'chat' });
        await waitingCard(service);
        await service.confirm('s2', true, { scope: 'mars' });
        await sending;
        expect(chosen).toEqual([{ scope: 'chat' }, { scope: 'global' }]);
        expect(records(service).map((record) => record.scope)).toEqual(['chat', 'global']);
        expect(toolMessages(env.llm.requests[1]!.messages)[0]!.content).toBe(
            'Applied: Thing → 2\nThe user chose where it applies: Этот чат.',
        );
    });
});

describe('limits per message', () => {
    it('allows 20 changes in all: a pack that does not fit is refused, the next single change too', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        service.registerTool(packTool('pack_ten', 10).tool);
        service.registerTool(packTool('pack_fifteen', 15).tool);
        const single = writeTool();
        service.registerTool(single.tool);
        env.llm.script(
            calls(
                callOf('pack_ten', {}, 'a'),
                callOf('pack_fifteen', {}, 'b'),
                callOf('pack_ten', {}, 'c'),
                callOf('set_thing', { value: 1 }, 'd'),
            ),
            answer('Twenty is enough.'),
        );
        const sending = service.send('change everything');
        await waitingCard(service);
        await service.confirm('a', true);
        await waitingCard(service);
        await service.confirm('c', true);
        await sending;
        expect(MAX_CHANGES).toBe(20);
        const [a, b, c, d] = records(service);
        expect(a?.status).toBe('applied');
        expect(b).toMatchObject({ status: 'error', error: 'Not proposed: at most 20 changes per message' });
        expect(c?.status).toBe('applied');
        expect(d).toMatchObject({ status: 'error', error: 'Not proposed: at most 20 changes per message' });
        const told = toolMessages(env.llm.requests[1]!.messages);
        expect(told[1]!.content).toContain('this pack has 15 changes, only 10 more fit into this message');
        expect(told[3]!.content).toContain('the limit of 20 proposed changes per user message is reached');
        expect(single.applied).toEqual([]);
    });

    it('counts the hourly limit by applied changes', async () => {
        const env = createAssistantEnv();
        env.settings.module<{ writesPerHour: number }>('assistant').writesPerHour = 2;
        const service = env.service();
        service.registerTool(packTool('pack_thing', 3).tool);
        env.llm.script(calls(callOf('pack_thing', {}, 'p')), answer('Too many.'));
        const sending = service.send('go');
        await waitingCard(service);
        await service.confirm('p', true);
        await sending;
        expect(records(service)[0]).toMatchObject({
            status: 'error',
            error: 'Not proposed: 2 changes were already applied in this chat this hour',
        });
    });
});

describe('the preset mode and attached context', () => {
    it('sends an attached block with the message, longer answers and the preset rules', async () => {
        const env = createAssistantEnv({ locale: 'ru' });
        const service = env.service();
        service.attach({ kind: 'presetBlock', preset: 'Marinara', identifier: 'main', label: 'Main Prompt' });
        service.attach({ kind: 'presetBlock', preset: 'Marinara', identifier: 'main', label: 'Main Prompt' });
        service.attach({ kind: 'preset', preset: 'Marinara', label: 'Marinara' });
        expect(service.attachments().map(contextKey)).toEqual(['block:Marinara:main', 'preset:Marinara']);
        service.detach('preset:Marinara');
        expect(service.attachments()).toHaveLength(1);
        env.llm.script(answer('Посмотрю.'));
        await service.send('Сделай его короче');
        const request = env.llm.requests[0]!;
        expect(request.maxTokens).toBe(4000);
        expect(request.messages[0]!.content).toContain('Preset work:');
        expect(request.messages.at(-1)!.content).toBe(
            `${contextNote([{ kind: 'presetBlock', preset: 'Marinara', identifier: 'main', label: 'Main Prompt' }])}\n\nСделай его короче`,
        );
        expect(request.messages.at(-1)!.content).toContain('the block with identifier "main" of the preset "Marinara"');
        expect(service.attachments()).toEqual([]);
        expect(service.conversation()[0]).toMatchObject({
            role: 'user',
            text: 'Сделай его короче',
            context: [{ kind: 'presetBlock', preset: 'Marinara', identifier: 'main', label: 'Main Prompt' }],
        });
        // The next message goes on with the preset: the history carries the note, the mode stays.
        env.llm.script(answer('Ок.'));
        await service.send('А теперь?');
        expect(env.llm.requests[1]!.maxTokens).toBe(4000);
        expect(env.llm.requests[1]!.messages[1]!.content).toContain('[Attached by the user from the Preset Studio');
    });

    it('enters the preset mode when the model calls a preset tool; otherwise the setting holds', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        service.registerTool(readTool('preset_list', async () => ({ data: { current: 'Marinara' } })));
        env.llm.script(answer('Hi.'));
        await service.send('hello');
        expect(env.llm.requests[0]!.maxTokens).toBe(2000);
        expect(env.llm.requests[0]!.messages[0]!.content).not.toContain('Preset work:');
        env.llm.script(calls(callOf('preset_list', {}, 'r')), answer('Marinara.'));
        await service.send('which preset?');
        expect(env.llm.requests[1]!.maxTokens).toBe(2000);
        expect(env.llm.requests[2]!.maxTokens).toBe(4000);
        env.llm.script(answer('Sure.'));
        await service.send('and now?');
        expect(env.llm.requests[3]!.maxTokens).toBe(4000);
        expect(env.llm.requests[3]!.messages[0]!.content).toContain('Preset work:');
    });

    it('«Обсудить с ассистентом» attaches the item and opens the assistant window, else the pult tab', () => {
        const env = createAssistantEnv();
        const service = env.service();
        const openPult = vi.fn();
        env.ui.openPult = openPult;
        // Without windows (an older shell) the pult tab opens.
        delete (env.ui as { openWindow?: unknown }).openWindow;
        service.discuss({ kind: 'preset', preset: 'Marinara', label: 'Marinara' });
        expect(openPult).toHaveBeenCalledWith('assistant');
        const openWindow = vi.fn();
        env.ui.openWindow = openWindow;
        service.discuss({ kind: 'presetBlock', preset: 'Marinara', identifier: 'style', label: 'Style' });
        expect(openWindow).toHaveBeenCalledWith('assistant', { tab: 'assistant' });
        expect(service.attachments().map(contextKey)).toEqual(['preset:Marinara', 'block:Marinara:style']);
        // Malformed items are refused.
        service.attach({ kind: 'presetBlock', preset: 'Marinara', label: 'x' } as never);
        service.attach({ kind: 'lore', preset: 'x', label: 'x' } as never);
        expect(service.attachments()).toHaveLength(2);
    });
});

describe('stored packs and context', () => {
    it('keeps the items, the scope and the attached context through a reload', () => {
        const doc = normalizeAssistantDoc({
            messages: [
                {
                    id: 'u',
                    role: 'user',
                    text: 'x',
                    at: 1,
                    context: [
                        { kind: 'presetBlock', preset: 'M', identifier: 'main', label: 'Main' },
                        { kind: 'presetBlock', preset: 'M', label: 'no id' },
                        { kind: 'other', preset: 'M', label: 'x' },
                    ],
                },
                {
                    id: 'a',
                    role: 'assistant',
                    text: '',
                    at: 2,
                    toolCalls: [
                        {
                            id: 'p',
                            name: 'preset_pack',
                            args: {},
                            status: 'applied',
                            scope: 'chat',
                            scopes: [{ value: 'chat', label: 'Этот чат' }, { value: 1 }],
                            items: [
                                { id: 'c1', summary: 'A', before: 'a', after: 'b', status: 'applied' },
                                { id: 'c2', summary: 'B', status: 'weird' },
                                { summary: 'no id' },
                            ],
                        },
                    ],
                },
            ],
            writes: [],
        });
        expect(doc.messages[0]!.context).toEqual([
            { kind: 'presetBlock', preset: 'M', identifier: 'main', label: 'Main' },
        ]);
        const call = doc.messages[1]!.toolCalls![0]!;
        expect(call.scope).toBe('chat');
        expect(call.scopes).toEqual([{ value: 'chat', label: 'Этот чат' }]);
        expect(call.items).toEqual([
            { id: 'c1', summary: 'A', before: 'a', after: 'b', status: 'applied' },
            { id: 'c2', summary: 'B' },
        ]);
    });

    it('stores block texts of a whole card in full, other values cut', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        const long = 'word '.repeat(3000);
        const whole = writeTool('whole_thing', {
            async plan() {
                return {
                    summary: 'Long',
                    target: 't',
                    before: long,
                    after: `${long}!`,
                    full: true,
                    apply: async () => ({}),
                };
            },
        });
        const cut = writeTool('cut_thing', {
            async plan() {
                return { summary: 'Long', target: 't', before: long, after: `${long}!`, apply: async () => ({}) };
            },
        });
        service.registerTool(whole.tool);
        service.registerTool(cut.tool);
        env.llm.script(
            calls(callOf('whole_thing', { value: 1 }, 'w'), callOf('cut_thing', { value: 1 }, 'c')),
            answer('ok'),
        );
        const sending = service.send('go');
        await waitingCard(service);
        await service.confirm('w', false);
        await waitingCard(service);
        await service.confirm('c', false);
        await sending;
        const [first, second] = records(service);
        expect(first!.before).toBe(long);
        expect(String(second!.before).length).toBeLessThan(long.length);
    });
});
