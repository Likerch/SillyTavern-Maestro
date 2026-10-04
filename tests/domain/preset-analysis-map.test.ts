import { describe, expect, it } from 'vitest';
import {
    assemblePrompt,
    extensionRole,
    normalizeGenerationType,
    promptTail,
    promptsById,
    resolveOrder,
    shouldTrigger,
} from '../../src/domain/preset-analysis-map';
import type { AssemblyOrderItem, ExtensionSlot } from '../../src/domain/preset-analysis-map';

type Prompt = Record<string, unknown>;

/** A small preset shaped like Marinara's Spaghetti Recipe: markers, depth blocks, a prefill and the usual traps. */
function marinara(): Prompt[] {
    return [
        {
            identifier: 'main',
            name: 'Main Prompt',
            role: 'system',
            system_prompt: true,
            content: '<instructions>Story.',
        },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
        { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
        { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
        {
            identifier: 'scenario',
            name: 'Scenario',
            system_prompt: true,
            marker: true,
            injection_trigger: ['continue'],
        },
        { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
        { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
        { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, content: '' },
        {
            identifier: 'jailbreak',
            name: 'Post-History Instructions',
            system_prompt: true,
            content: 'Stay in character.',
        },
        { identifier: 'rules', name: 'Rules', role: 'system', system_prompt: false, content: 'Write in third person.' },
        { identifier: 'legacy', name: 'Legacy', role: 'system', content: 'Old block without system_prompt.' },
        {
            identifier: 'reminder',
            name: 'Reminder',
            role: 'system',
            system_prompt: false,
            injection_position: 1,
            injection_depth: 2,
            injection_order: 100,
            content: 'Remember the plot.',
        },
        {
            identifier: 'style',
            name: 'Style',
            role: 'user',
            system_prompt: false,
            injection_position: 1,
            injection_depth: 0,
            injection_order: 99,
            content: 'Keep it short.',
        },
        {
            identifier: 'deepString',
            name: 'Depth as text',
            role: 'system',
            system_prompt: false,
            injection_position: 1,
            injection_depth: '4',
            content: 'never inserted',
        },
        {
            identifier: 'narrator',
            name: 'Narrator',
            role: 'narrator',
            system_prompt: false,
            injection_position: 1,
            injection_depth: 1,
            content: 'never inserted either',
        },
        {
            identifier: 'posString',
            name: 'Position as text',
            role: 'system',
            system_prompt: false,
            injection_position: '1',
            injection_depth: 3,
            content: 'sent as relative',
        },
        {
            identifier: 'onlyContinue',
            name: 'Only continue',
            system_prompt: false,
            injection_trigger: ['continue'],
            content: 'cont',
        },
        {
            identifier: 'badTrigger',
            name: 'Bad trigger',
            system_prompt: false,
            injection_trigger: ['Normal'],
            content: 'bt',
        },
        { identifier: 'prefill', name: 'Prefill', role: 'assistant', system_prompt: false, content: '<thinking>' },
    ];
}

const ORDER_IDS = [
    'main',
    'worldInfoBefore',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'rules',
    'legacy',
    'worldInfoAfter',
    'dialogueExamples',
    'chatHistory',
    'reminder',
    'style',
    'deepString',
    'narrator',
    'posString',
    'onlyContinue',
    'badTrigger',
    'jailbreak',
    'prefill',
    'ghost',
];

function order(overrides: Record<string, unknown> = {}, ids = ORDER_IDS): AssemblyOrderItem[] {
    return ids.map((identifier) => ({
        identifier,
        enabled: identifier in overrides ? overrides[identifier] : identifier !== 'dialogueExamples',
    }));
}

function extensionSlots(): ExtensionSlot[] {
    return [
        { key: 'dooms-tracker-inject', value: 'Tracker instructions', position: 1, depth: 0, role: 1 },
        { key: 'customDepthWI_2_0', value: 'Lore at depth two', position: 1, depth: 2, role: 0 },
        { key: 'carrotkernel_rag', value: 'RAG text', position: 2, depth: 0, role: 0 },
        { key: 'qvink_memory_long', value: 'Long memory', position: 0, depth: 0, role: 0 },
        { key: 'maestro_recap', value: '', position: 1, depth: 1, role: 0 },
        { key: 'customWIOutlet_x', value: 'outlet', position: -1, depth: 0, role: 0 },
        { key: 'PERSONA_DESCRIPTION', value: 'persona', position: 0, depth: 0, role: 0 },
    ];
}

function slot(assembly: ReturnType<typeof assemblePrompt>, id: string) {
    const found = assembly.slots.find((item) => item.identifier === id);
    if (!found) throw new Error(`no slot ${id}`);
    return found;
}

describe('assemblePrompt on a Marinara-like preset', () => {
    const assembly = assemblePrompt({ prompts: marinara(), order: order(), slots: extensionSlots() });

    it('keeps the relative order, puts the in-chat blocks inside the history and moved markers at the end', () => {
        expect(assembly.type).toBe('normal');
        expect(assembly.history).toBe(true);
        expect(assembly.slots.map((item) => item.identifier)).toEqual([
            'main',
            'worldInfoBefore',
            'charDescription',
            'charPersonality',
            'personaDescription',
            'rules',
            'legacy',
            'worldInfoAfter',
            'dialogueExamples',
            'chatHistory',
            // In-chat: deeper first; a depth that is not a number goes last.
            'reminder',
            'narrator',
            'style',
            'deepString',
            'posString',
            'onlyContinue',
            'badTrigger',
            'jailbreak',
            'prefill',
            'ghost',
            // P-118: the marker with a trigger that does not fit is sent after everything.
            'scenario',
        ]);
        expect(slot(assembly, 'reminder')).toMatchObject({ placement: 'depth', depth: 2, order: 100, role: 'system' });
        expect(slot(assembly, 'style')).toMatchObject({ placement: 'depth', depth: 0, order: 99, role: 'user' });
    });

    it('gives the strict-type reason for every enabled block that is not sent', () => {
        expect(slot(assembly, 'legacy')).toMatchObject({ sent: false, dropped: 'systemPrompt' });
        expect(slot(assembly, 'deepString')).toMatchObject({ sent: false, dropped: 'depthType' });
        expect(slot(assembly, 'narrator')).toMatchObject({ sent: false, dropped: 'role' });
        expect(slot(assembly, 'onlyContinue')).toMatchObject({
            sent: false,
            dropped: 'trigger',
            triggers: ['continue'],
        });
        expect(slot(assembly, 'badTrigger')).toMatchObject({ sent: false, dropped: 'triggerInvalid' });
        expect(slot(assembly, 'ghost')).toMatchObject({ sent: false, dropped: 'missing', name: 'ghost' });
        expect(slot(assembly, 'dialogueExamples')).toMatchObject({ enabled: false, sent: false });
        expect(slot(assembly, 'dialogueExamples').dropped).toBeUndefined();
        for (const id of ['main', 'rules', 'jailbreak', 'prefill', 'reminder', 'style', 'chatHistory']) {
            expect(slot(assembly, id).sent).toBe(true);
        }
    });

    it('notes a string position (sent as relative) and the marker moved to the end', () => {
        expect(slot(assembly, 'posString')).toMatchObject({ placement: 'relative', sent: true });
        expect(slot(assembly, 'posString').notes).toContain('positionString');
        expect(slot(assembly, 'posString').typeIssues).toContainEqual({ code: 'position', value: '"1"' });
        expect(slot(assembly, 'scenario')).toMatchObject({ sent: true, notes: ['movedToEnd'] });
        expect(slot(assembly, 'legacy').typeIssues).toContainEqual({ code: 'systemPrompt', value: 'undefined' });
        expect(slot(assembly, 'deepString').typeIssues).toContainEqual({ code: 'depth', value: '"4"' });
        expect(slot(assembly, 'narrator').typeIssues).toContainEqual({ code: 'role', value: '"narrator"' });
        expect(slot(assembly, 'badTrigger').typeIssues).toContainEqual({ code: 'triggerValues', value: '["Normal"]' });
    });

    it('places extension prompts by position, depth and role, with owners by key prefix', () => {
        const main = slot(assembly, 'main');
        expect(main.injections).toEqual([
            { key: 'carrotkernel_rag', owner: 'ck', text: 'RAG text', where: 'start' },
            { key: 'qvink_memory_long', owner: 'qvink', text: 'Long memory', where: 'end' },
        ]);
        // Same depth and role as an order-100 block: glued into its message (P-103).
        expect(slot(assembly, 'reminder').injections).toEqual([
            {
                key: 'customDepthWI_2_0',
                owner: 'wiDepth',
                text: 'Lore at depth two',
                where: 'chat',
                depth: 2,
                role: 'system',
            },
        ]);
        expect(slot(assembly, 'reminder').notes).toContain('merged');
        // No order-100 block at depth 0 with the user role (style has order 99): inside the history.
        expect(slot(assembly, 'chatHistory').injections).toEqual([
            {
                key: 'dooms-tracker-inject',
                owner: 'des',
                text: 'Tracker instructions',
                where: 'chat',
                depth: 0,
                role: 'user',
            },
        ]);
        expect(assembly.lost).toEqual([]);
    });

    it('assembles for another generation type through the triggers', () => {
        const forContinue = assemblePrompt({ prompts: marinara(), order: order(), type: 'Continue' });
        expect(forContinue.type).toBe('continue');
        expect(slot(forContinue, 'onlyContinue').sent).toBe(true);
        expect(slot(forContinue, 'scenario')).toMatchObject({ sent: true, notes: [] });
        expect(forContinue.slots.at(-1)?.identifier).toBe('ghost');
    });
});

describe('assemblePrompt edge cases', () => {
    it('drops the whole history with a disabled chatHistory: in-chat blocks and injections are lost', () => {
        const assembly = assemblePrompt({
            prompts: marinara(),
            order: order({ chatHistory: false }),
            slots: extensionSlots(),
        });
        expect(assembly.history).toBe(false);
        expect(slot(assembly, 'chatHistory')).toMatchObject({ enabled: false, sent: false });
        expect(slot(assembly, 'reminder')).toMatchObject({ sent: false, dropped: 'noHistory' });
        expect(slot(assembly, 'style')).toMatchObject({ sent: false, dropped: 'noHistory' });
        expect(assembly.lost.map((item) => item.key)).toEqual(['customDepthWI_2_0', 'dooms-tracker-inject']);
        // Before/after main still land: main is a relative block.
        expect(slot(assembly, 'main').injections).toHaveLength(2);
    });

    it('treats chatHistory with a wrong trigger like a disabled one', () => {
        const prompts = marinara().map((prompt) =>
            prompt.identifier === 'chatHistory' ? { ...prompt, injection_trigger: ['impersonate'] } : prompt,
        );
        const assembly = assemblePrompt({ prompts, order: order() });
        expect(assembly.history).toBe(false);
        expect(slot(assembly, 'chatHistory')).toMatchObject({ dropped: 'trigger' });
    });

    it('loses before/after-main injections when main is not in the list, keeps them for a disabled main', () => {
        const without = assemblePrompt({
            prompts: marinara(),
            order: order(
                {},
                ORDER_IDS.filter((id) => id !== 'main'),
            ),
            slots: extensionSlots(),
        });
        expect(without.lost.map((item) => item.key)).toEqual(['carrotkernel_rag', 'qvink_memory_long']);

        const disabled = assemblePrompt({
            prompts: marinara(),
            order: order({ main: false }),
            slots: extensionSlots(),
        });
        const main = slot(disabled, 'main');
        expect(main).toMatchObject({ enabled: false, sent: false, notes: ['mainAnchor'] });
        expect(main.injections).toHaveLength(2);
    });

    it('keeps main as an anchor when its trigger does not fit, and when it is empty', () => {
        const prompts = marinara().map((prompt) =>
            prompt.identifier === 'main' ? { ...prompt, injection_trigger: ['quiet'] } : prompt,
        );
        const anchored = assemblePrompt({ prompts, order: order(), slots: extensionSlots() });
        expect(slot(anchored, 'main')).toMatchObject({ dropped: 'trigger', notes: ['mainAnchor'] });
        expect(slot(anchored, 'main').injections).toHaveLength(2);

        const empty = marinara().map((prompt) => (prompt.identifier === 'main' ? { ...prompt, content: '' } : prompt));
        const emptied = assemblePrompt({ prompts: empty, order: order() });
        expect(slot(emptied, 'main')).toMatchObject({ dropped: 'empty', notes: ['mainAnchor'] });
    });

    it('moves before/after-main injections into the chat next to an in-chat main', () => {
        const prompts = marinara().map((prompt) =>
            prompt.identifier === 'main'
                ? { ...prompt, injection_position: 1, injection_depth: 3, injection_order: 50 }
                : prompt,
        );
        const assembly = assemblePrompt({ prompts, order: order(), slots: extensionSlots() });
        const main = slot(assembly, 'main');
        expect(main).toMatchObject({ placement: 'depth', depth: 3, order: 50, sent: true });
        expect(main.injections.map((item) => [item.key, item.where, item.depth, item.role])).toEqual([
            ['carrotkernel_rag', 'start', 3, 'system'],
            ['qvink_memory_long', 'end', 3, 'system'],
        ]);
        const noHistory = assemblePrompt({ prompts, order: order({ chatHistory: false }), slots: extensionSlots() });
        expect(noHistory.lost.map((item) => item.key)).toContain('carrotkernel_rag');
    });

    it('appends external markers that are not in the list but carry text, persona last', () => {
        const ids = ORDER_IDS.filter((id) => id !== 'charDescription' && id !== 'personaDescription');
        const assembly = assemblePrompt({
            prompts: marinara(),
            order: order({}, ids),
            markersWithText: new Set(['personaDescription', 'charDescription', 'chatHistory']),
        });
        expect(assembly.slots.slice(-3).map((item) => [item.identifier, item.notes])).toEqual([
            ['charDescription', ['notInList']],
            ['scenario', ['movedToEnd']],
            ['personaDescription', ['notInList']],
        ]);
    });

    it('handles markers placed in the chat, unknown markers, empty blocks and depth ranges', () => {
        const prompts: Prompt[] = [
            { identifier: 'chatHistory', marker: true, system_prompt: true },
            { identifier: 'charDescription', marker: true, injection_position: 1, injection_depth: 3 },
            { identifier: 'charPersonality', marker: true, injection_position: 1, injection_depth: 2, role: 'bot' },
            { identifier: 'custom', marker: true, system_prompt: false, content: '' },
            { identifier: 'blank', system_prompt: false, content: '' },
            {
                identifier: 'tooDeep',
                system_prompt: false,
                role: 'user',
                injection_position: 1,
                injection_depth: 20000,
                content: 'x',
            },
            {
                identifier: 'negative',
                system_prompt: false,
                role: 'user',
                injection_position: 1,
                injection_depth: -1,
                content: 'x',
            },
            {
                identifier: 'fraction',
                system_prompt: false,
                role: 'user',
                injection_position: 1,
                injection_depth: 1.5,
                content: 'x',
            },
            {
                identifier: 'spaces',
                system_prompt: false,
                role: 'user',
                injection_position: 1,
                injection_depth: 1,
                content: '  ',
            },
            { identifier: 'noRole', system_prompt: false, injection_position: 1, injection_depth: 1, content: 'x' },
            {
                identifier: 'weirdOrder',
                system_prompt: false,
                role: 'user',
                injection_position: 1,
                injection_depth: 1,
                injection_order: 'abc',
                content: 'x',
            },
        ];
        const ids = prompts.map((prompt) => String(prompt.identifier));
        const assembly = assemblePrompt({ prompts, order: ids.map((identifier) => ({ identifier, enabled: true })) });
        expect(slot(assembly, 'charDescription')).toMatchObject({
            placement: 'depth',
            depth: 3,
            sent: true,
            role: 'system',
        });
        expect(slot(assembly, 'charPersonality')).toMatchObject({ dropped: 'role' });
        expect(slot(assembly, 'custom')).toMatchObject({ dropped: 'unknownMarker' });
        expect(slot(assembly, 'blank')).toMatchObject({ dropped: 'empty' });
        expect(slot(assembly, 'tooDeep')).toMatchObject({ dropped: 'depthRange' });
        expect(slot(assembly, 'negative')).toMatchObject({ dropped: 'depthRange' });
        expect(slot(assembly, 'fraction')).toMatchObject({ dropped: 'depthType' });
        expect(slot(assembly, 'spaces')).toMatchObject({ dropped: 'empty' });
        expect(slot(assembly, 'noRole')).toMatchObject({ dropped: 'role' });
        expect(slot(assembly, 'noRole').typeIssues).toContainEqual({ code: 'role', value: 'undefined' });
        expect(slot(assembly, 'weirdOrder')).toMatchObject({ sent: true, order: 100 });
        expect(slot(assembly, 'weirdOrder').typeIssues).toContainEqual({ code: 'order', value: '"abc"' });
    });

    it('glues in-chat blocks of the same depth, order and role and reports the other members', () => {
        const prompts: Prompt[] = [
            { identifier: 'chatHistory', marker: true },
            {
                identifier: 'a',
                name: 'A',
                system_prompt: false,
                role: 'system',
                injection_position: 1,
                injection_depth: 1,
                content: 'a',
            },
            {
                identifier: 'b',
                name: 'B',
                system_prompt: false,
                role: 'system',
                injection_position: 1,
                injection_depth: 1,
                content: 'b',
            },
            {
                identifier: 'c',
                name: 'C',
                system_prompt: false,
                role: 'assistant',
                injection_position: 1,
                injection_depth: 1,
                content: 'c',
            },
            {
                identifier: 'off',
                system_prompt: false,
                role: 'system',
                injection_position: 1,
                injection_depth: 1,
                content: 'off',
            },
        ];
        const assembly = assemblePrompt({
            prompts,
            order: [
                ...['chatHistory', 'a', 'b', 'c'].map((identifier) => ({ identifier, enabled: true })),
                { identifier: 'off', enabled: false },
            ],
        });
        expect(slot(assembly, 'a').mergedWith).toEqual(['b']);
        expect(slot(assembly, 'b').mergedWith).toEqual(['a']);
        expect(slot(assembly, 'c').mergedWith).toBeUndefined();
        // At one depth and order: assistant before system.
        expect(assembly.slots.map((item) => item.identifier)).toEqual(['chatHistory', 'c', 'a', 'b', 'off']);
    });

    it('records type problems that ST tolerates and notes card overrides', () => {
        const prompts: Prompt[] = [
            { identifier: 'main', system_prompt: true, content: 'Main', injection_trigger: 'normal' },
            { identifier: 'jailbreak', system_prompt: true, content: 'PHI', forbid_overrides: true },
            { identifier: 'chatHistory', marker: true },
            { identifier: 'odd', system_prompt: false, role: 'narrator', content: 'x', injection_position: 2 },
        ];
        const assembly = assemblePrompt({
            prompts,
            order: [
                { identifier: 'main', enabled: 'true' },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true },
                { identifier: 'odd', enabled: 1 },
            ],
            overridden: new Set(['main', 'jailbreak']),
        });
        const main = slot(assembly, 'main');
        expect(main.sent).toBe(true);
        expect(main.notes).toEqual(['cardOverride']);
        expect(main.typeIssues).toEqual([
            { code: 'enabled', value: '"true"' },
            { code: 'trigger', value: '"normal"' },
        ]);
        expect(slot(assembly, 'jailbreak').notes).toEqual([]);
        const odd = slot(assembly, 'odd');
        expect(odd).toMatchObject({ sent: true, placement: 'relative', role: 'system' });
        expect(odd.typeIssues.map((issue) => issue.code)).toEqual(['enabled', 'position', 'role']);
    });

    it('skips a missing disabled entry and survives junk input', () => {
        const assembly = assemblePrompt({ prompts: 'junk', order: [{ identifier: 'gone', enabled: false }] });
        expect(assembly.slots).toEqual([]);
        expect(assembly.history).toBe(false);
    });
});

describe('order and helpers', () => {
    it('resolves the global order list, falls back to the first, keeps enabled as stored', () => {
        const lists = [
            { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
            { character_id: '100001', order: [{ identifier: 'b', enabled: 'yes' }, { identifier: 5 }, 'junk'] },
        ];
        expect(resolveOrder(lists)).toEqual([{ identifier: 'b', enabled: 'yes' }]);
        expect(resolveOrder([lists[0]])).toEqual([{ identifier: 'a', enabled: true }]);
        expect(resolveOrder([{ character_id: 1 }])).toEqual([]);
        expect(resolveOrder(null)).toEqual([]);
    });

    it('normalises the generation type and checks triggers like ST', () => {
        expect(normalizeGenerationType(undefined)).toBe('normal');
        expect(normalizeGenerationType(' Swipe ')).toBe('swipe');
        expect(shouldTrigger({}, 'normal')).toBe(true);
        expect(shouldTrigger({ injection_trigger: [] }, 'quiet')).toBe(true);
        expect(shouldTrigger({ injection_trigger: 'continue' }, 'normal')).toBe(true);
        expect(shouldTrigger({ injection_trigger: ['continue'] }, 'normal')).toBe(false);
    });

    it('maps extension roles and indexes prompts by the first identifier', () => {
        expect([extensionRole(0), extensionRole(1), extensionRole(2), extensionRole(undefined)]).toEqual([
            'system',
            'user',
            'assistant',
            'system',
        ]);
        const byId = promptsById([
            { identifier: 'a', content: 1 },
            { identifier: 'a', content: 2 },
            null,
            { name: 'x' },
        ]);
        expect(byId.size).toBe(1);
        expect(byId.get('a')?.content).toBe(1);
        expect(promptsById(undefined).size).toBe(0);
    });
});

describe('promptTail', () => {
    it('finds the assistant prefill after the history, or the moved marker when it carries text', () => {
        const assembly = assemblePrompt({ prompts: marinara(), order: order() });
        expect(promptTail(assembly)).toEqual({ role: 'assistant', identifier: 'prefill', via: 'block' });
        expect(promptTail(assembly, { markersWithText: new Set(['scenario']) })).toEqual({
            role: 'system',
            identifier: 'scenario',
            via: 'block',
        });
    });

    it('puts «Start reply with» after the blocks but before an appended persona; not for continue/impersonate', () => {
        const assembly = assemblePrompt({ prompts: marinara(), order: order({ prefill: false }) });
        expect(promptTail(assembly, { bias: 'Sure,' })).toEqual({ role: 'assistant', identifier: 'bias', via: 'bias' });
        const withPersona = assemblePrompt({
            prompts: marinara(),
            order: order(
                {},
                ORDER_IDS.filter((id) => id !== 'personaDescription'),
            ),
            markersWithText: new Set(['personaDescription']),
        });
        expect(promptTail(withPersona, { bias: 'Sure,', markersWithText: new Set(['personaDescription']) })).toEqual({
            role: 'system',
            identifier: 'personaDescription',
            via: 'block',
        });
        const impersonate = assemblePrompt({
            prompts: marinara(),
            order: order({ prefill: false }),
            type: 'impersonate',
        });
        expect(promptTail(impersonate, { bias: 'Sure,' })?.identifier).toBe('jailbreak');
    });

    it('reports continue with prefill', () => {
        const assembly = assemblePrompt({ prompts: marinara(), order: order(), type: 'continue' });
        expect(promptTail(assembly, { continuePrefill: true })).toEqual({
            role: 'assistant',
            identifier: 'continue',
            via: 'continue',
        });
    });

    it('falls back to the depth-0 messages when nothing follows the history', () => {
        const prompts: Prompt[] = [
            { identifier: 'chatHistory', marker: true },
            {
                identifier: 'late',
                system_prompt: false,
                role: 'assistant',
                injection_position: 1,
                injection_depth: 0,
                content: 'x',
            },
            {
                identifier: 'early',
                system_prompt: false,
                role: 'system',
                injection_position: 1,
                injection_depth: 0,
                injection_order: 50,
                content: 'y',
            },
            { identifier: 'after', system_prompt: false, content: '   ' },
        ];
        const ids = ['chatHistory', 'late', 'early', 'after'];
        const assembly = assemblePrompt({ prompts, order: ids.map((identifier) => ({ identifier, enabled: true })) });
        expect(promptTail(assembly)).toEqual({ role: 'assistant', identifier: 'late', via: 'block' });

        const slots: ExtensionSlot[] = [{ key: 'dooms-tracker-inject', value: 'T', position: 1, depth: 0, role: 1 }];
        const withInjection = assemblePrompt({
            prompts,
            order: ids.map((identifier) => ({ identifier, enabled: identifier !== 'late' })),
            slots,
        });
        expect(promptTail(withInjection)).toEqual({
            role: 'user',
            identifier: 'dooms-tracker-inject',
            via: 'injection',
        });

        const merged = assemblePrompt({
            prompts: [
                ...prompts,
                {
                    identifier: 'userBlock',
                    system_prompt: false,
                    role: 'user',
                    injection_position: 1,
                    injection_depth: 0,
                    content: 'u',
                },
            ],
            order: [...ids, 'userBlock'].map((identifier) => ({ identifier, enabled: identifier !== 'late' })),
            slots,
        });
        expect(promptTail(merged)?.via).toBe('injection');
        expect(
            promptTail(assemblePrompt({ prompts, order: [{ identifier: 'chatHistory', enabled: true }] })),
        ).toBeNull();
        expect(promptTail(assemblePrompt({ prompts: [], order: [] }))).toBeNull();
    });
});
