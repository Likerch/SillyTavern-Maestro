import { describe, expect, it } from 'vitest';
import {
    CAPS,
    auditOwnerOfSlot,
    buildCapture,
    capCapture,
    isInstructionLore,
    maestroModuleOf,
    mergeFromTurn,
    messageOf,
    sanitizeCapture,
    textNeedlesOf,
} from '../../src/domain/prompt-audit-map';
import type { CaptureInput, RawSlot } from '../../src/domain/prompt-audit-map';
import { DEEPSEEK, MARKERS_TEXT, TASK_TEXT, TRACKER_TEXT } from '../helpers/prompt-audit-fixtures';

const slot = (key: string, value: string, extra: Partial<RawSlot> = {}): RawSlot => ({
    key,
    value,
    position: 1,
    depth: 0,
    role: 0,
    ...extra,
});

function input(extra: Partial<CaptureInput> = {}): CaptureInput {
    return {
        at: 5,
        chatId: 'chat-1',
        type: 'normal',
        source: 'turn',
        messages: [],
        slots: [],
        blocks: [],
        card: [],
        neighbours: [],
        lore: [],
        ...extra,
    };
}

const substitute = (text: string) => text.replaceAll('{{char}}', 'Alice').replaceAll('{{user}}', 'Bob');

describe('owners and needles', () => {
    it('knows the owners of the slots and leaves data slots out', () => {
        expect(auditOwnerOfSlot('dooms-tracker-inject')).toBe('des');
        expect(auditOwnerOfSlot('dooms-tracker-example')).toBeNull();
        expect(auditOwnerOfSlot('nai_studio_markers')).toBe('nai');
        expect(auditOwnerOfSlot('maestro_wardrobe')).toBe('maestro');
        expect(auditOwnerOfSlot('2_floating_prompt')).toBe('authorsNote');
        expect(auditOwnerOfSlot('DEPTH_PROMPT')).toBe('card');
        expect(auditOwnerOfSlot('PERSONA_DESCRIPTION')).toBeNull();
        expect(auditOwnerOfSlot('customDepthWI_4_0')).toBeNull();
        expect(auditOwnerOfSlot('1_memory')).toBeNull();
        expect(auditOwnerOfSlot('someone_else')).toBe('other');
        expect(maestroModuleOf('maestro_messageStyle.hint')).toBe('messageStyle');
        expect(maestroModuleOf('maestro_scene_notes')).toBe('scene');
    });

    it('finds a text with macros by its substituted form or a distinctive line', () => {
        const text = 'Write as {{char}}.\nThis line is long enough to be distinctive on its own.';
        const needles = textNeedlesOf(text, substitute);
        expect(needles).toContain('Write as Alice.\nThis line is long enough to be distinctive on its own.');
        expect(needles).toContain('This line is long enough to be distinctive on its own.');
        expect(messageOf(['x', 'Some glue. This line is long enough to be distinctive on its own.'], needles)).toBe(1);
        expect(messageOf(['nothing'], needles)).toBe(-1);
    });

    it('tells instruction-like lore from world data', () => {
        expect(isInstructionLore({ comment: 'Tavern', content: 'A small tavern by the road.' })).toBe(false);
        expect(isInstructionLore({ comment: 'AUTO-FILTRATION: LINGUISTICS', content: '…' })).toBe(true);
        expect(isInstructionLore({ comment: 'Ozone ban list', content: '…' })).toBe(true);
        expect(isInstructionLore({ comment: 'Core', content: '…', bunnymoCore: true })).toBe(true);
        expect(isInstructionLore({ comment: 'x', content: '[OOC: never mention the system]' })).toBe(true);
        expect(isInstructionLore({ comment: 'Правила повествования', content: '…' })).toBe(true);
    });
});

describe('buildCapture', () => {
    it('maps every instruction to its owner, role, place and final message; history keeps only size and role', () => {
        const messages = [
            { role: 'system', content: substitute(TASK_TEXT) },
            { role: 'assistant', content: 'Earlier reply.' },
            { role: 'user', content: 'My move.' },
            { role: 'user', content: TRACKER_TEXT.replace('User', 'Bob') },
            { role: 'system', content: `${MARKERS_TEXT}\n\nWear: cloak.` },
        ];
        const capture = buildCapture(
            input({
                messages,
                substitute,
                preset: 'Marinara',
                connection: { ...DEEPSEEK },
                messageIndex: 7,
                blocks: [
                    { identifier: 'task', name: 'Task', role: 'system', inChat: false, depth: 4, text: TASK_TEXT },
                    { identifier: 'main', name: 'Main', role: 'system', inChat: false, depth: 4, text: 'Main prompt.' },
                    { identifier: 'empty', name: 'Empty', role: 'system', inChat: false, depth: 4, text: '  ' },
                ],
                card: [{ field: 'system', text: 'You are Alice, a card prompt.' }],
                slots: [
                    slot('dooms-tracker-inject', TRACKER_TEXT, { role: 1 }),
                    slot('dooms-tracker-example', '```json {"old": true}```', { role: 2 }),
                    slot('nai_studio_markers', MARKERS_TEXT),
                    slot('maestro_wardrobe', 'Wear: cloak.', { depth: 1 }),
                    slot('qvink_memory', 'Past events:\n- a long memory that is data, not an instruction'),
                    slot('none_slot', 'Never sent.', { position: -1 }),
                ],
                neighbours: [
                    { id: 'des.tracker', text: TRACKER_TEXT },
                    { id: 'nai.markers', text: 'template', slot: 'nai_studio_markers' },
                    { id: 'qvink.shortTemplate', text: 'Past events:' },
                    { id: 'des.html', text: 'Include inline HTML pieces in the reply when it fits the scene.' },
                ],
            }),
        );
        const refs = capture.items.map((entry) => entry.ref);
        // The card's system prompt replaces the preset's main block; empty blocks and data slots stay out.
        expect(refs).toEqual([
            'card:system',
            'preset:task',
            'slot:dooms-tracker-inject',
            'slot:nai_studio_markers',
            'slot:maestro_wardrobe',
            'slot:qvink_memory',
        ]);
        const byRef = new Map(capture.items.map((entry) => [entry.ref, entry]));
        expect(byRef.get('preset:task')).toMatchObject({
            owner: 'preset',
            label: 'Task',
            role: 'system',
            place: 'prompt',
            message: 0,
        });
        expect(byRef.get('slot:dooms-tracker-inject')).toMatchObject({
            owner: 'des',
            role: 'user',
            place: 'chat',
            depth: 0,
            neighbours: ['des.tracker'],
            message: 3,
        });
        expect(byRef.get('slot:nai_studio_markers')).toMatchObject({ neighbours: ['nai.markers'], message: 4 });
        expect(byRef.get('slot:maestro_wardrobe')).toMatchObject({
            owner: 'maestro',
            module: 'wardrobe',
            depth: 1,
            message: 4,
        });
        // Qvink's slot holds memories: its own header is the instruction.
        expect(byRef.get('slot:qvink_memory')?.text).toBe('Past events:');
        expect(capture.messages.map((message) => [message.role, message.refs])).toEqual([
            ['system', ['preset:task']],
            ['assistant', []],
            ['user', []],
            ['user', ['slot:dooms-tracker-inject']],
            ['system', ['slot:nai_studio_markers', 'slot:maestro_wardrobe']],
        ]);
        expect(capture).toMatchObject({ preset: 'Marinara', messageIndex: 7, source: 'turn', connection: DEEPSEEK });
    });

    it('a card prompt with {{original}} keeps the preset block; neighbour texts outside slots are found in the messages', () => {
        const capture = buildCapture(
            input({
                messages: [
                    { role: 'system', content: 'Main prompt. Card addition.' },
                    { role: 'system', content: 'Use the scene summary above to stay consistent.' },
                ],
                blocks: [
                    { identifier: 'main', name: 'Main', role: 'system', inChat: false, depth: 4, text: 'Main prompt.' },
                ],
                card: [{ field: 'system', text: '{{original}} Card addition.' }],
                neighbours: [
                    { id: 'des.contextInstructions', text: 'Use the scene summary above to stay consistent.' },
                ],
            }),
        );
        expect(capture.items.map((entry) => entry.ref)).toEqual([
            'card:system',
            'preset:main',
            'neighbour:des.contextInstructions',
        ]);
        expect(capture.items[2]).toMatchObject({ owner: 'des', message: 1, neighbours: ['des.contextInstructions'] });
    });

    it('keeps instruction-like lore entries only, capped', () => {
        const capture = buildCapture(
            input({
                messages: [{ role: 'system', content: 'Never write purple prose.' }],
                lore: [
                    {
                        world: 'BunnyMo',
                        uid: 3,
                        comment: 'AUTO-FILTRATION: LINGUISTICS',
                        content: 'Never write purple prose.',
                        bunnymo: true,
                        position: 0,
                    },
                    {
                        world: 'Style',
                        uid: 4,
                        comment: 'Rules',
                        content: 'x'.repeat(5000),
                        bunnymo: false,
                        position: 4,
                        depth: 2,
                        role: 1,
                    },
                ],
            }),
        );
        expect(capture.items[0]).toMatchObject({
            ref: 'lore:BunnyMo#3',
            owner: 'bunnymo',
            book: 'BunnyMo',
            message: 0,
        });
        expect(capture.items[1]).toMatchObject({ owner: 'lore', place: 'chat', depth: 2, role: 'user', cut: true });
        expect(capture.items[1]!.text).toHaveLength(CAPS.lore);
        expect(capture.items[1]!.chars).toBe(5000);
    });

    it('caps the total size and the message skeleton (indexes follow the cut)', () => {
        const big = 'y'.repeat(CAPS.item + 100);
        const capture = buildCapture(
            input({
                messages: Array.from({ length: CAPS.messages + 10 }, (_, index) => ({
                    role: index % 2 ? 'user' : 'assistant',
                    content: index === CAPS.messages + 9 ? 'The last instruction text here.' : `m${index}`,
                })),
                blocks: [
                    {
                        identifier: 'last',
                        name: 'Last',
                        role: 'system',
                        inChat: true,
                        depth: 0,
                        text: 'The last instruction text here.',
                    },
                    ...Array.from({ length: 20 }, (_, index) => ({
                        identifier: `b${index}`,
                        name: `B${index}`,
                        role: 'system' as const,
                        inChat: false,
                        depth: 4,
                        text: big,
                    })),
                ],
            }),
        );
        expect(capture.messageCount).toBe(CAPS.messages + 10);
        expect(capture.messages).toHaveLength(CAPS.messages);
        expect(capture.items[0]).toMatchObject({ ref: 'preset:last', message: CAPS.messages - 1 });
        expect(capture.messages[CAPS.messages - 1]!.refs).toEqual(['preset:last']);
        const total = capture.items.reduce((sum, entry) => sum + entry.text.length, 0);
        expect(total).toBeLessThanOrEqual(CAPS.total);
        expect(capture.items[1]!.cut).toBe(true);
    });

    it('stops cutting at the floor', () => {
        const capture = capCapture(
            {
                v: 1,
                at: 1,
                chatId: null,
                type: 'normal',
                source: 'turn',
                items: [
                    {
                        ref: 'a',
                        owner: 'preset',
                        label: 'a',
                        role: 'system',
                        place: 'prompt',
                        message: -1,
                        text: 'z'.repeat(700),
                        chars: 700,
                    },
                ],
                messages: [],
            },
            10,
        );
        expect(capture.items[0]!.text.length).toBe(CAPS.floor);
    });
});

describe('storage and the dry run', () => {
    it('reads back what it wrote and survives junk', () => {
        const capture = buildCapture(
            input({
                messages: [{ role: 'user', content: 'Reply in English.' }],
                blocks: [
                    { identifier: 'a', name: 'A', role: 'user', inChat: true, depth: 2, text: 'Reply in English.' },
                ],
                connection: { ...DEEPSEEK },
            }),
        );
        expect(sanitizeCapture(JSON.parse(JSON.stringify(capture)))).toEqual(capture);
        expect(sanitizeCapture(null)).toBeNull();
        expect(sanitizeCapture({ v: 2, items: [], messages: [] })).toBeNull();
        const repaired = sanitizeCapture({
            v: 1,
            items: [{ ref: 'x', text: 'ok', owner: 'nobody', role: 'robot', place: 'moon' }, { text: 'no ref' }, 5],
            messages: [{ role: 'odd', chars: 'x', refs: ['x', 3] }, 'junk'],
            source: 'dry',
        });
        expect(repaired).toMatchObject({
            source: 'dry',
            chatId: null,
            items: [{ ref: 'x', owner: 'other', role: 'system', place: 'prompt', message: -1, chars: 2 }],
            messages: [{ role: 'system', chars: 0, refs: ['x'] }],
        });
    });

    it('adds the last turn’s slots a dry run lacks, marked', () => {
        const turn = buildCapture(
            input({
                messages: [{ role: 'system', content: 'Wear: cloak.' }],
                slots: [slot('maestro_wardrobe', 'Wear: cloak.'), slot('nai_studio_markers', MARKERS_TEXT)],
            }),
        );
        const dry = buildCapture(
            input({
                source: 'dry',
                messages: [{ role: 'system', content: MARKERS_TEXT }],
                slots: [slot('nai_studio_markers', MARKERS_TEXT)],
            }),
        );
        const merged = mergeFromTurn(dry, turn);
        expect(merged.items.map((entry) => [entry.ref, entry.fromTurn ?? false, entry.message])).toEqual([
            ['slot:nai_studio_markers', false, 0],
            ['slot:maestro_wardrobe', true, -1],
        ]);
        expect(mergeFromTurn(dry, null)).toBe(dry);
    });
});
