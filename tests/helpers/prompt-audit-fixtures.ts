// Fixtures of the prompt audit (M38). The «real case» is a neutral retelling of what happened on the user's own setup:
// the preset's task block asked for one line under 150 words while the DES tracker demanded a JSON block, the NAI
// Studio rules 1–3 picture markers and another block a world event every turn; and when the tracker instructions were
// switched to the system role, ST glued them with the preset's task and output format and the picture rules into one
// big trailing system message that DeepSeek V4 (no role token for system messages inside the history) stopped obeying.
import type { AuditCapture, AuditItem, AuditMessage } from '../../src/domain/prompt-audit-map';

export const TASK_TEXT =
    '<task>\nWrite the next reply of the story as {{char}}. Keep it short: one line, no more than 150 words.\n</task>';
export const TRACKER_TEXT =
    'At the start of every reply attach the tracker JSON in a ```json code block. Fill every field of the tracker. Then continue the story from the last message.';
export const MARKERS_TEXT = 'Place 1 to 3 picture markers in every reply, captions in English.';
export const WORLD_TEXT = 'Every turn something happens in the world: an event, a complication or a twist.';
export const FORMAT_TEXT =
    '<output_format>\nWrite prose in third person, past tense. Use *asterisks* for actions.\n</output_format>';

export function item(partial: Partial<AuditItem> & Pick<AuditItem, 'ref' | 'owner' | 'text'>): AuditItem {
    return {
        label: partial.ref,
        role: 'system',
        place: 'prompt',
        message: -1,
        chars: partial.text.length,
        ...partial,
    };
}

export const DEEPSEEK = {
    source: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    quirks: ['prefillEos', 'systemMerge', 'assistantDepth'],
};

/** The real case: the length cap against the tracker JSON, the picture markers and the world event. */
export function realCaseCapture(): AuditCapture {
    const items: AuditItem[] = [
        item({ ref: 'preset:task', owner: 'preset', label: 'Task', key: 'task', text: TASK_TEXT, message: 0 }),
        item({ ref: 'preset:world', owner: 'preset', label: 'World', key: 'world', text: WORLD_TEXT, message: 0 }),
        item({
            ref: 'preset:format',
            owner: 'preset',
            label: 'Output format',
            key: 'format',
            text: FORMAT_TEXT,
            message: 0,
        }),
        item({
            ref: 'slot:dooms-tracker-inject',
            owner: 'des',
            label: 'dooms-tracker-inject',
            key: 'dooms-tracker-inject',
            neighbours: ['des.tracker'],
            role: 'user',
            place: 'chat',
            depth: 0,
            text: TRACKER_TEXT,
            message: 4,
        }),
        item({
            ref: 'slot:nai_studio_markers',
            owner: 'nai',
            label: 'nai_studio_markers',
            key: 'nai_studio_markers',
            neighbours: ['nai.markers'],
            role: 'system',
            place: 'chat',
            depth: 0,
            text: MARKERS_TEXT,
            message: 5,
        }),
    ];
    const messages: AuditMessage[] = [
        { role: 'system', chars: 400, refs: ['preset:task', 'preset:world', 'preset:format'] },
        { role: 'assistant', chars: 900, refs: [] },
        { role: 'user', chars: 120, refs: [] },
        { role: 'assistant', chars: 1100, refs: [] },
        { role: 'user', chars: 300, refs: ['slot:dooms-tracker-inject'] },
        { role: 'system', chars: 80, refs: ['slot:nai_studio_markers'] },
    ];
    return {
        v: 1,
        at: 1000,
        chatId: 'chat-1',
        type: 'normal',
        source: 'turn',
        preset: 'Marinara',
        connection: { ...DEEPSEEK },
        items,
        messages,
    };
}

/** The second lesson: the tracker instructions in the system role, glued into one 17K trailing system message. */
export function mergedTrailingCapture(): AuditCapture {
    const capture = realCaseCapture();
    const tracker = capture.items.find((entry) => entry.ref === 'slot:dooms-tracker-inject')!;
    tracker.role = 'system';
    tracker.message = 4;
    tracker.chars = 15000;
    const markers = capture.items.find((entry) => entry.ref === 'slot:nai_studio_markers')!;
    markers.message = 4;
    capture.messages = [
        { role: 'system', chars: 400, refs: ['preset:task', 'preset:world', 'preset:format'] },
        { role: 'assistant', chars: 900, refs: [] },
        { role: 'user', chars: 120, refs: [] },
        { role: 'assistant', chars: 1100, refs: [] },
        { role: 'system', chars: 17000, refs: ['slot:dooms-tracker-inject', 'slot:nai_studio_markers'] },
    ];
    return capture;
}
