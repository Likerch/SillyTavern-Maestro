// Prompt fixtures for M2 tests: a fake Prompt Manager (openai.js `promptManager`), extension prompt slots and a
// Chat Completion prompt as CHAT_COMPLETION_PROMPT_READY delivers it.
import type { LoreTestApp } from './lore-app';

export const FACT = 'Anna carries the silver key of the old tower and never lets anyone touch it.';
/** Qvink's memory slot: repeats FACT as its own sentence. */
export const QVINK_MEMORY = `Earlier.\n${FACT}`;

export interface PromptManagerFake {
    activeCharacter: { id: number };
    counts: Record<string, number>;
    tokenHandler: { getCounts(): Record<string, number> };
    getPromptOrderForCharacter(character: unknown): unknown;
    getPromptById(identifier: string): Record<string, unknown> | undefined;
}

export function installPromptManager(stand: LoreTestApp, counts: Record<string, number>): PromptManagerFake {
    const prompts: Record<string, Record<string, unknown>> = {
        main: { identifier: 'main', name: 'Main', content: 'Be a good narrator.', injection_position: 0 },
        depthRule: {
            identifier: 'depthRule',
            name: 'Depth rule',
            content: 'Stay in voice now.',
            injection_position: 1,
        },
        marker: { identifier: 'marker', name: 'Marker', marker: true, injection_position: 1, content: 'x' },
        off: { identifier: 'off', name: 'Off', content: 'Disabled.', injection_position: 1 },
        empty: { identifier: 'empty', name: 'Empty', content: '', injection_position: 1 },
    };
    const manager: PromptManagerFake = {
        activeCharacter: { id: 100000 },
        counts,
        tokenHandler: { getCounts: () => manager.counts },
        getPromptOrderForCharacter: () => [
            { identifier: 'main', enabled: true },
            { identifier: 'depthRule', enabled: true },
            { identifier: 'marker', enabled: true },
            { identifier: 'off', enabled: false },
            { identifier: 'empty', enabled: true },
            { identifier: 'missing', enabled: true },
            'junk',
        ],
        getPromptById: (identifier) => prompts[identifier],
    };
    stand.openai.promptManager = manager;
    stand.adapters.presetPrompts = [
        { identifier: 'main', name: 'Main', role: 'system', marker: false, content: 'Be a good narrator.' },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
    ];
    return manager;
}

export function installSlots(stand: LoreTestApp): void {
    stand.ctx.extensionPrompts = {
        dooms_tracker: { value: 'Tracker: Anna is present.', position: 0, depth: 0, scan: false, role: 0 },
        qvink_memory_short: { value: QVINK_MEMORY, position: 1, depth: 3, scan: false, role: 0 },
        customDepthWI_4_0: { value: 'The tower is tall.', position: 1, depth: 4, scan: false, role: 0 },
        customWIOutlet_scene: { value: 'Outlet text', position: -1, depth: 0, scan: false, role: 0 },
        blank: { value: '', position: 0, depth: 0, scan: false, role: 0 },
    };
}

export function promptMessages(): { role: string; content: string }[] {
    return [
        { role: 'system', content: 'Be a good narrator. Key sk-abcdefghijklmnopqrstuvwxyz' },
        { role: 'user', content: `Tell me. ${FACT}` },
        { role: 'assistant', content: 'Hello there.' },
    ];
}
