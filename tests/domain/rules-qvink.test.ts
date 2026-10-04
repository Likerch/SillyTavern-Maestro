import { describe, expect, it } from 'vitest';
import {
    contiguousRanges,
    hasQvinkMemory,
    liveIndexOf,
    promptChatIndexes,
    qvinkWouldSummarize,
    rangeArgument,
} from '../../src/domain/rules-qvink';

const tokens = (text: string) => Math.ceil(text.length / 4);
const msg = (fields: Record<string, unknown> = {}) => ({
    name: 'Lira',
    is_user: false,
    is_system: false,
    send_date: 'd1',
    mes: 'A long enough reply to be summarised by Qvink.',
    extra: {},
    ...fields,
});

describe('hasQvinkMemory', () => {
    it('needs a non-empty memory text', () => {
        expect(hasQvinkMemory(msg({ extra: { qvink_memory: { memory: 'Lira left.' } } }))).toBe(true);
        expect(hasQvinkMemory(msg({ extra: { qvink_memory: { memory: '  ' } } }))).toBe(false);
        expect(hasQvinkMemory(msg({ extra: { qvink_memory: { error: 'failed' } } }))).toBe(false);
        expect(hasQvinkMemory(msg({ extra: undefined }))).toBe(false);
        expect(hasQvinkMemory(null)).toBe(false);
    });
});

describe('qvinkWouldSummarize', () => {
    const options = { tokenCount: tokens };

    it('accepts ordinary character messages above the length threshold', () => {
        expect(qvinkWouldSummarize(msg(), {}, options)).toBe(true);
        expect(qvinkWouldSummarize(msg({ mes: 'short' }), {}, options)).toBe(false);
        expect(qvinkWouldSummarize(msg({ mes: 'short' }), { message_length_threshold: 1 }, options)).toBe(true);
        expect(qvinkWouldSummarize(msg({ mes: undefined }), { message_length_threshold: 1 }, options)).toBe(false);
    });

    it('follows remember and exclude marks first', () => {
        const remembered = msg({ is_user: true, mes: 'x', extra: { qvink_memory: { remember: true } } });
        expect(qvinkWouldSummarize(remembered, {}, options)).toBe(true);
        expect(qvinkWouldSummarize(msg({ extra: { qvink_memory: { exclude: true } } }), {}, options)).toBe(false);
        const system = msg({ extra: { qvink_memory: { is_qvink_system_memory: true, remember: true } } });
        expect(qvinkWouldSummarize(system, {}, options)).toBe(false);
    });

    it('respects the user, system, narrator and thought settings', () => {
        expect(qvinkWouldSummarize(msg({ is_user: true }), {}, options)).toBe(false);
        expect(qvinkWouldSummarize(msg({ is_user: true }), { include_user_messages: true }, options)).toBe(true);
        expect(qvinkWouldSummarize(msg({ is_system: true }), null, options)).toBe(false);
        expect(qvinkWouldSummarize(msg({ is_system: true }), { include_system_messages: true }, options)).toBe(true);
        const narrator = msg({ extra: { type: 'narrator' } });
        expect(qvinkWouldSummarize(narrator, {}, options)).toBe(false);
        expect(qvinkWouldSummarize(narrator, { include_narrator_messages: true }, options)).toBe(true);
        expect(qvinkWouldSummarize(msg({ is_thoughts: true }), {}, options)).toBe(false);
    });

    it('skips group members disabled for summaries', () => {
        const settings = { disabled_group_characters: { g1: ['lira.png'] } };
        const member = msg({ original_avatar: 'lira.png' });
        expect(qvinkWouldSummarize(member, settings, { ...options, groupId: 'g1' })).toBe(false);
        expect(qvinkWouldSummarize(member, settings, { ...options, groupId: 'g2' })).toBe(true);
        expect(qvinkWouldSummarize(member, settings, { ...options, groupId: null })).toBe(true);
    });

    it('rejects non-messages', () => {
        expect(qvinkWouldSummarize('text', {}, options)).toBe(false);
    });
});

describe('promptChatIndexes / liveIndexOf', () => {
    const chat = [
        msg({ send_date: 'a', name: 'Lira' }),
        msg({ send_date: 'b', is_system: true }),
        msg({ send_date: 'c', is_user: true, name: 'User' }),
        msg({ send_date: 'd', is_system: true, extra: { tool_invocations: [] } }),
        msg({ send_date: 'e' }),
        'broken',
    ];

    it('maps prompt positions to live indexes like ST builds coreChat', () => {
        expect(promptChatIndexes(chat, false)).toEqual([0, 2, 4]);
        expect(promptChatIndexes(chat, true)).toEqual([0, 2, 3, 4]);
    });

    it('finds the live message through the index and checks it is the same one', () => {
        const mapping = promptChatIndexes(chat, false);
        expect(liveIndexOf({ ...(chat[4] as object), index: 2 }, chat, mapping)).toBe(4);
        expect(liveIndexOf({ ...(chat[2] as object), index: 1 }, chat, mapping)).toBe(2);
    });

    it('falls back to the newest matching message when the index does not fit', () => {
        const mapping = promptChatIndexes(chat, false);
        expect(liveIndexOf({ ...(chat[0] as object), index: 2 }, chat, mapping)).toBe(0);
        expect(liveIndexOf({ ...(chat[0] as object) }, chat, mapping)).toBe(0);
        expect(liveIndexOf({ ...(chat[0] as object), index: 1.5 }, chat, mapping)).toBe(0);
    });

    it('gives -1 when nothing matches', () => {
        const mapping = promptChatIndexes(chat, false);
        expect(liveIndexOf({ name: 'X', send_date: 'zz', index: 0 }, chat, mapping)).toBe(-1);
        expect(liveIndexOf({ name: 'X', send_date: '', index: 9 }, chat, mapping)).toBe(-1);
        expect(liveIndexOf(null, chat, mapping)).toBe(-1);
    });
});

describe('contiguousRanges / rangeArgument', () => {
    it('groups sorted unique indexes into runs', () => {
        expect(contiguousRanges([9, 5, 6, 7, 7, -1, 1.5])).toEqual([
            [5, 7],
            [9, 9],
        ]);
        expect(contiguousRanges([])).toEqual([]);
    });

    it('formats STscript ranges', () => {
        expect(rangeArgument([5, 5])).toBe('5');
        expect(rangeArgument([5, 7])).toBe('5-7');
    });
});
