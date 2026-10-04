// Prompt snapshot normalisation and diff (tools/stand/snapshot-lib.mjs).
import { describe, expect, it } from 'vitest';
import {
    buildProbes,
    compareSnapshots,
    detectBlocks,
    diffMessages,
    normalizeMessages,
    normalizeParams,
    normalizeText,
    summarize,
} from '../../tools/stand/snapshot-lib.mjs';

describe('normalizeText', () => {
    it('evens out whitespace and line endings', () => {
        expect(normalizeText('  a  \r\nb\t\tc   \n\n\n\nd  ')).toBe('a\nb c\n\nd');
    });

    it('masks volatile values', () => {
        const text = [
            'sent 2026-10-04T12:34:56.789Z',
            'chat Хроники - 2026-1-5@18h00m00s123ms',
            'id 3b2f6c1e-7a54-4d0e-9c1a-5e8f00a1c320',
            'epoch 1791080911000',
            'today October 4, 2026 3:15pm',
            'now 12:30 PM',
        ].join('\n');
        expect(normalizeText(text)).toBe(
            [
                'sent <TS>',
                'chat Хроники - <CHATSTAMP>',
                'id <UUID>',
                'epoch <EPOCH_MS>',
                'today <DATE>',
                'now <TIME>',
            ].join('\n'),
        );
    });

    it('keeps story time and dates from trackers', () => {
        expect(normalizeText('"start": "18:00", "value": "Вторник, 4 Листопада, 1247"')).toBe(
            '"start": "18:00", "value": "Вторник, 4 Листопада, 1247"',
        );
    });
});

describe('normalizeMessages / normalizeParams', () => {
    it('flattens multimodal content and keeps names and tool calls', () => {
        const messages = normalizeMessages([
            {
                role: 'user',
                name: 'Кай',
                content: [
                    { type: 'text', text: 'смотри ' },
                    { type: 'image_url', image_url: { url: 'x' } },
                ],
            },
            { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search_lore' } }] },
        ]);
        expect(messages).toEqual([
            { role: 'user', name: 'Кай', content: 'смотри\n[image]' },
            { role: 'assistant', content: '', tool_calls: 'search_lore' },
        ]);
    });

    it('keeps sampling parameters and drops noise', () => {
        expect(
            normalizeParams({
                stream: true,
                max_tokens: 1200,
                temperature: 1,
                seed: 42,
                user: 'abc',
                logit_bias: {},
                response_format: { type: 'json_schema', json_schema: { name: 'maestro_revision' } },
                tools: [{ type: 'function', function: { name: 'search_lore' } }],
            }),
        ).toEqual({
            stream: true,
            max_tokens: 1200,
            temperature: 1,
            response_format: 'maestro_revision',
            tools: ['search_lore'],
        });
    });
});

describe('blocks and lorebooks', () => {
    it('detects tracker, BunnyMo and Qvink blocks', () => {
        const text = [
            '[Following is a list of recent events]:\n* Кай и Вера нашли улику.\n* Вера показала склад.',
            '',
            '```json\n{"infoBox": {"location": {"value": "Маяк"}}}\n```',
            '<BunnymoTags><Name:Вера>, <INTJ-H></BunnymoTags>',
        ].join('\n');
        const blocks = detectBlocks(text);
        expect(blocks['qvink-memory']?.count).toBe(1);
        expect(blocks['des-tracker']?.count).toBe(1);
        expect(blocks['bunnymo-tags']?.count).toBe(1);
        expect(blocks['think']).toBeUndefined();
    });

    it('recognises lorebook entries by their content', () => {
        const probes = buildProbes([
            {
                name: 'World',
                data: {
                    entries: {
                        '0': {
                            uid: 0,
                            content: 'The Lighthouse of Saint Ilza guards the northern approach of {{char}}.',
                        },
                        '1': { uid: 1, content: 'short' },
                        '2': {
                            uid: 2,
                            content: 'The Old Fort is a ruined coastal stronghold near the harbor.',
                            disable: true,
                        },
                    },
                },
            },
        ]);
        expect(probes.map((p) => p.uid)).toEqual([0]);
        const summary = summarize(
            normalizeMessages([
                { role: 'system', content: 'The   Lighthouse of Saint Ilza guards the northern approach of Narrator.' },
            ]),
            probes,
        );
        expect(summary.lorebooks).toEqual({ World: { entries: 1, uids: [0] } });
        expect(summary.roles).toEqual({ system: { count: 1, chars: 70 } });
    });
});

describe('diff', () => {
    const golden = {
        params: { stream: true },
        messages: normalizeMessages([
            { role: 'system', content: 'main prompt' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'line one\nline two' },
        ]),
    };

    it('reports equality', () => {
        expect(compareSnapshots(golden, golden).equal).toBe(true);
    });

    it('pairs changed messages and lists additions', () => {
        const current = {
            params: { stream: true },
            messages: normalizeMessages([
                { role: 'system', content: 'main prompt' },
                { role: 'system', content: 'maestro canon' },
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'line one\nline 2' },
            ]),
        };
        expect(diffMessages(golden.messages, current.messages).map((o) => o.op)).toEqual(['=', '+', '=', '~']);
        const { equal, lines } = compareSnapshots(golden, current);
        expect(equal).toBe(false);
        expect(lines.some((l) => l.startsWith('  + #1 system'))).toBe(true);
        expect(lines.some((l) => l.includes('line 2:'))).toBe(true);
    });

    it('treats a parameter change as a difference', () => {
        const { equal, lines } = compareSnapshots(golden, { ...golden, params: { stream: false } });
        expect(equal).toBe(false);
        expect(lines.some((l) => l.startsWith('params'))).toBe(true);
    });
});
