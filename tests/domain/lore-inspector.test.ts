import { describe, expect, it } from 'vitest';
import {
    barGroups,
    charsByRole,
    compareSources,
    exportMessages,
    findRepeats,
    loreMeasures,
    messageRole,
    messageText,
    promptIdentifierOf,
    pushTurn,
    reconstructSources,
    scrubSecrets,
    slotOwner,
    splitSentences,
} from '../../src/domain/lore-inspector';
import type { InspectorSource } from '../../src/domain/lore-inspector';

function byId(sources: InspectorSource[]): Record<string, number> {
    return Object.fromEntries(sources.map((source) => [source.id, source.tokens]));
}

describe('slot owners', () => {
    it('maps known extension prompt keys to their owners', () => {
        const cases: [string, string][] = [
            ['dooms-tracker-inject', 'des'],
            ['dooms_workshop', 'des'],
            ['carrot_kernel_tags', 'ck'],
            ['script_inject_carrot-sheet-full', 'ck'],
            ['qvink_memory_long', 'qvink'],
            ['nai_studio_markers', 'nai'],
            ['desru_names', 'desru'],
            ['maestro_canon', 'maestro'],
            ['customWIOutlet_scene', 'wiOutlet'],
            ['customDepthWI_4_0', 'wiDepth'],
            ['1_memory', 'summary'],
            ['2_floating_prompt', 'authorsNote'],
            ['DEPTH_PROMPT', 'card'],
            ['DEPTH_PROMPT_1', 'card'],
            ['PERSONA_DESCRIPTION', 'card'],
            ['3_vectors', 'other'],
            ['something', 'other'],
        ];
        for (const [key, owner] of cases) expect(slotOwner(key), key).toBe(owner);
    });

    it('derives Prompt Manager identifiers like openai.js', () => {
        expect(promptIdentifierOf('1_memory')).toBe('summary');
        expect(promptIdentifierOf('2_floating_prompt')).toBe('authorsNote');
        expect(promptIdentifierOf('chromadb')).toBe('smartContext');
        expect(promptIdentifierOf('dooms-tracker inject')).toBe('dooms_tracker_inject');
    });
});

describe('messages', () => {
    it('reads text and roles of string and multimodal messages', () => {
        expect(messageText({ content: 'hi' })).toBe('hi');
        expect(
            messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, null, { text: 'b' }] }),
        ).toBe('ab');
        expect(messageText({ content: 3 })).toBe('');
        expect(messageText(null)).toBe('');
        expect(messageRole({ role: 'user' })).toBe('user');
        expect(messageRole({})).toBe('system');
        expect(messageRole('x')).toBe('system');
    });

    it('counts characters by role', () => {
        expect(
            charsByRole([
                { role: 'system', content: 'abc' },
                { role: 'user', content: 'de' },
                { role: 'assistant', content: 'f' },
                { role: 'tool', content: 'gh' },
                { role: 'developer', content: 'i' },
            ]),
        ).toEqual({ system: 4, user: 2, assistant: 1, tool: 2 });
    });
});

describe('reconstructSources with Prompt Manager counts', () => {
    const counts = {
        start_chat: 0,
        main: 300,
        'custom-uuid': 120,
        charDescription: 200,
        personaDescription: 50,
        dialogueExamples: 80,
        worldInfoBefore: 400,
        worldInfoAfter: 110,
        chatHistory: 2000,
        authorsNote: 90,
        dooms_tracker: 150,
        qvink_memory_long: 70,
        weird: Number.NaN,
    };

    it('splits blocks, slots, lore by book and the remaining history', () => {
        const result = reconstructSources({
            counts,
            presetNames: { main: 'Main Prompt', 'custom-uuid': 'Style' },
            slots: [
                { key: '2_floating_prompt', position: 0, tokens: 0 },
                { key: 'dooms_tracker', position: 0, tokens: 0 },
                { key: 'qvink_memory_long', position: 2, tokens: 0 },
                { key: 'qvink_memory_short', position: 1, tokens: 60 },
                { key: 'customDepthWI_4_0', position: 1, tokens: 140 },
                { key: 'DEPTH_PROMPT', position: 1, tokens: 30 },
                { key: 'maestro_flags', position: 1, tokens: 0 },
                { key: 'nai_studio_markers', position: 0, tokens: 25 },
            ],
            lore: [
                { book: 'World', position: 0, tokens: 300 },
                { book: 'World', position: 4, tokens: 140 },
                { book: 'Anna', position: 1, tokens: 100 },
                { book: 'Anna', position: 2, tokens: 40 },
                { book: 'Anna', position: 5, tokens: 30 },
                { book: 'Scene', position: 7, tokens: 10 },
                { book: 'Empty', position: 0, tokens: 0 },
            ],
            absolute: [
                { identifier: 'depthRule', name: 'Depth rule', tokens: 45 },
                { identifier: 'none', name: '', tokens: 0 },
            ],
        });
        expect(result.exact).toBe(true);
        expect(result.total).toBe(3570);
        expect(byId(result.sources)).toEqual({
            'preset:main': 300,
            'preset:custom-uuid': 120,
            'card:charDescription': 200,
            'card:personaDescription': 50,
            'card:dialogueExamples': 50,
            'ext:authorsNote': 50,
            'ext:des': 150,
            'ext:qvink': 130,
            'card:DEPTH_PROMPT': 30,
            'preset:depthRule': 45,
            'lore:World': 440,
            'lore:Anna': 170,
            'lore:Scene': 10,
            'preset:worldInfoFormat': 110,
            history: 2000 - 60 - 140 - 30 - 45,
        });
        expect(result.sources.find((source) => source.id === 'preset:main')?.name).toBe('Main Prompt');
        // A slot ST filtered out (not in the counts) is not counted.
        expect(result.sources.some((source) => source.id === 'ext:nai')).toBe(false);
    });

    it('keeps lore as one source without M1', () => {
        const result = reconstructSources({
            counts: { worldInfoBefore: 300, chatHistory: 1000 },
            slots: [{ key: 'customDepthWI_2_1', position: 1, tokens: 100 }],
            lore: null,
        });
        expect(byId(result.sources)).toEqual({ 'lore:': 400, history: 900 });
    });
});

describe('reconstructSources without counts (estimate)', () => {
    it('takes every measured part out of the total', () => {
        const result = reconstructSources({
            counts: null,
            messageTokens: 1000,
            slots: [
                { key: 'dooms_tracker', position: 0, tokens: 100 },
                { key: '2_floating_prompt', position: 1, tokens: 50 },
                { key: 'customWIOutlet_x', position: -1, tokens: 20 },
            ],
            lore: [
                { book: 'World', position: 1, tokens: 200 },
                { book: 'World', position: 3, tokens: 10 },
                { book: 'World', position: 6, tokens: 15 },
                { book: 'World', position: 7, tokens: 5 },
            ],
        });
        expect(result.exact).toBe(false);
        expect(result.total).toBe(1000);
        expect(byId(result.sources)).toEqual({
            'ext:des': 100,
            'ext:authorsNote': 40,
            'lore:World': 230,
            history: 1000 - 100 - 50 - 200 - 15 - 5,
        });
    });

    it('never reports negative history', () => {
        const result = reconstructSources({
            counts: null,
            messageTokens: undefined,
            slots: [{ key: 'maestro_x', position: 1, tokens: 10 }],
            lore: [{ book: 'W', position: 3, tokens: 5 }],
        });
        expect(result.total).toBe(0);
        expect(byId(result.sources)).toEqual({ 'ext:maestro': 10, 'lore:W': 5 });
    });
});

describe('lore measures and turn lists', () => {
    it('groups uncut activations by book and position', () => {
        expect(
            loreMeasures([
                { world: 'A', position: 0, tokens: 5 },
                { world: 'A', position: 0, tokens: 7 },
                { world: 'A', position: 4, tokens: 1 },
                { world: 'B', position: 0, tokens: 9, cut: true },
            ]),
        ).toEqual([
            { book: 'A', position: 0, tokens: 12 },
            { book: 'A', position: 4, tokens: 1 },
        ]);
    });

    it('replaces the same message and keeps the newest turns', () => {
        let list = pushTurn([], { messageIndex: 1, v: 'a' }, 2);
        list = pushTurn(list, { messageIndex: 3, v: 'b' }, 2);
        list = pushTurn(list, { messageIndex: 1, v: 'c' }, 2);
        expect(list).toEqual([
            { messageIndex: 3, v: 'b' },
            { messageIndex: 1, v: 'c' },
        ]);
        list = pushTurn(list, { messageIndex: 5, v: 'd' }, 2);
        expect(list.map((item) => item.v)).toEqual(['c', 'd']);
    });
});

describe('comparison and bar groups', () => {
    const now: InspectorSource[] = [
        { id: 'history', kind: 'history', tokens: 600 },
        { id: 'lore:W', kind: 'lore', name: 'W', tokens: 300 },
        { id: 'ext:des', kind: 'extension', owner: 'des', tokens: 100 },
    ];
    const before: InspectorSource[] = [
        { id: 'history', kind: 'history', tokens: 500 },
        { id: 'lore:W', kind: 'lore', name: 'W', tokens: 400 },
    ];

    it('computes shares and deltas against the previous turn and the average', () => {
        const rows = compareSources(now, before, [before, now]);
        expect(rows.map((row) => [row.source.id, row.share, row.deltaPrevious, row.deltaAverage])).toEqual([
            ['history', 0.6, 100, 50],
            ['lore:W', 0.3, -100, -50],
            ['ext:des', 0.1, 100, 50],
        ]);
        const first = compareSources(now, undefined, []);
        expect(first[0]).not.toHaveProperty('deltaPrevious');
        expect(first[0]).not.toHaveProperty('deltaAverage');
        expect(compareSources([], undefined, [])).toEqual([]);
    });

    it('groups extension sources by owner', () => {
        expect(
            barGroups([
                ...now,
                { id: 'lore:X', kind: 'lore', tokens: 50 },
                { id: 'ext:?', kind: 'extension', tokens: 5 },
            ]),
        ).toEqual([
            { group: 'history', tokens: 600 },
            { group: 'lore', tokens: 350 },
            { group: 'des', tokens: 100 },
            { group: 'other', tokens: 5 },
        ]);
    });
});

describe('repeated facts', () => {
    const fact = 'Anna has a scar over her left eye from the battle at the Silver Tower.';

    it('splits sentences and strips list markers', () => {
        expect(splitSentences('- First one.  Second?\n2) Third!\n\n')).toEqual(['First one.', 'Second?', 'Third!']);
    });

    it('finds long identical sentences in different sources only', () => {
        const repeats = findRepeats([
            { source: 'Lore: Anna', text: `${fact} She is quiet.` },
            { source: 'DES', text: `* ${fact.toUpperCase()}` },
            { source: 'History', text: `Short. Short.\n${fact}` },
            { source: 'History', text: 'Another sentence that is long enough to count but appears only in one place.' },
            { source: 'Empty', text: '' },
        ]);
        expect(repeats).toEqual([{ sentence: fact, sources: ['Lore: Anna', 'DES', 'History'] }]);
        expect(
            findRepeats([
                { source: 'A', text: fact },
                { source: 'A', text: fact },
            ]),
        ).toEqual([]);
        expect(
            findRepeats([
                { source: 'A', text: 'short.' },
                { source: 'B', text: 'short.' },
            ]),
        ).toEqual([]);
    });
});

describe('export', () => {
    it('masks key-like strings', () => {
        const text = [
            'sk-abcdefghijklmnopqrstuvwx',
            'sk-ant-api03-abcdefghijklmnopqrstuv',
            'pst-abcdefghijklmnopqrstuvwxyz',
            'Bearer abcdefghijklmnopqrstuvwxyz0123',
            'AIzaSyA1234567890abcdefghijklmnopqrstu',
            'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            'xoxb-1234567890-abcdef',
            'skirt is fine',
        ].join(' ');
        const scrubbed = scrubSecrets(text);
        expect(scrubbed.match(/\[secret\]/g)).toHaveLength(7);
        expect(scrubbed).toContain('skirt is fine');
    });

    it('exports messages with chat text optionally hidden', () => {
        const messages = [
            { role: 'system', content: 'Rules. key sk-abcdefghijklmnopqrstuvwx' },
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        ];
        expect(exportMessages(messages, false)).toEqual([
            { role: 'system', chars: 38, content: 'Rules. key [secret]' },
            { role: 'user', chars: 11, content: 'Hello there' },
            { role: 'assistant', chars: 2, content: 'Hi' },
        ]);
        expect(exportMessages(messages, true)).toEqual([
            { role: 'system', chars: 38, content: 'Rules. key [secret]' },
            { role: 'user', chars: 11, redacted: true },
            { role: 'assistant', chars: 2, redacted: true },
        ]);
    });
});
