// Fixtures follow NAI Studio's records: picture posts (features/generation/output.ts postToChat), media attachments
// (toAttachments, appendToMessage) and inline images (domain/inline.ts InlineImage / InlineSwipe meta).
import { describe, expect, it } from 'vitest';
import { isReply, lastReply, naiRecords, newAnlas, turnOfMessage } from '../../src/domain/treasurer-anlas';
import type { AnlasContext, NaiRecord } from '../../src/domain/treasurer-anlas';

const media = (url: string, cost: number, correlationId?: string) => ({
    url,
    type: 'image',
    title: 'a forest road',
    source: 'generated',
    generation_type: 0,
    negative: '',
    nai_studio: {
        seed: 1,
        model: 'nai-diffusion-4-5-full',
        prompt: 'forest',
        transport: 'plugin',
        cost,
        correlationId,
    },
});

const post = (sendDate: string, cost: number, items: unknown[]) => ({
    name: 'Alice',
    is_user: false,
    is_system: false,
    send_date: sendDate,
    mes: 'a forest road',
    extra: {
        media: items,
        media_display: 'gallery',
        media_index: 0,
        inline_image: true,
        nai_studio: { model: 'nai-diffusion-4-5-full', seed: 1, mode: 0, transport: 'plugin', cost },
    },
});

const inlineSwipe = (cost: number, createdAt: string, seed: number) => ({
    blobKey: `blob-${seed}`,
    filePath: '',
    mime: 'image/png',
    meta: { scenePrompt: 'x', prompt: 'x', model: 'm', seed, cost, createdAt, transport: 'plugin' },
});

const reply = (text: string, extra: Record<string, unknown> = {}, swipeInfo?: unknown[]) => ({
    name: 'Alice',
    is_user: false,
    is_system: false,
    send_date: 'Oct 4, 2026 10:00am',
    mes: text,
    extra,
    ...(swipeInfo ? { swipe_info: swipeInfo } : {}),
});

const keys = (records: NaiRecord[]) => records.map((record) => `${record.key}=${record.anlas}`);

describe('naiRecords', () => {
    it('counts a picture post once and later batches appended to it separately', () => {
        const message = post('2026-10-04T10:00:00.000Z', 20, [
            media('/user/images/a1.png', 20, 'batch-1'),
            media('/user/images/a2.png', 20, 'batch-1'),
            media('/user/images/a3.png', 6, 'batch-2'),
        ]);
        expect(keys(naiRecords(message))).toEqual(['post|2026-10-04T10:00:00.000Z=20', 'media|c|batch-2=6']);
    });

    it('reads media batches by correlation id, else by url, and skips free or broken items', () => {
        const message = reply('text', {
            media: [
                media('/a.png', 4),
                media('/b.png', 4),
                media('/c.png', 0, 'free'),
                media('/d.png', 8, 'tool-run'),
                { url: '/e.png', nai_studio: { cost: 3 } },
                { nai_studio: { cost: 5 } },
                { url: '/f.png' },
                'junk',
            ],
        });
        expect(keys(naiRecords(message))).toEqual([
            'media|u|/a.png=4',
            'media|u|/b.png=4',
            'media|c|tool-run=8',
            'media|u|/e.png=3',
        ]);
    });

    it('reads inline images per generation batch, also from stored swipes', () => {
        const created = '2026-10-04T10:05:00.000Z';
        const entry = {
            id: 'img-123456',
            blobKey: 'blob-1',
            meta: {},
            swipes: [inlineSwipe(12, created, 1), inlineSwipe(12, created, 2), inlineSwipe(6, 'not a date', 3)],
            activeSwipe: 0,
            display: {},
            marker: { params: {}, status: 'done' },
        };
        const pending = { id: 'img-pending', swipes: [], marker: { params: {}, status: 'pending' } };
        const old = { id: 'img-old', swipes: [{ meta: { cost: 2 } }, { meta: 'x' }, 'junk'] };
        const message = reply('Text [nai:img:img-123456]', { nai_images: [entry, pending, { swipes: [] }] }, [
            { extra: { nai_images: [old] } },
            { extra: { nai_images: [entry] } },
            'junk',
            { extra: 5 },
        ]);
        const records = naiRecords(message);
        expect(keys(records)).toEqual([
            `inline|img-123456|${created}=12`,
            'inline|img-123456|not a date=6',
            'inline|img-old|#0=2',
        ]);
        expect(records[0]!.at).toBe(Date.parse(created));
        expect(records[1]!.at).toBeUndefined();
        expect(naiRecords(null)).toEqual([]);
        expect(naiRecords({ mes: 'x' })).toEqual([]);
    });
});

describe('newAnlas', () => {
    const context = (patch: Partial<AnlasContext> = {}): AnlasContext => ({
        trigger: 'swipe',
        isUser: false,
        counted: new Set(),
        baseline: new Set(),
        countFrom: 1000,
        ...patch,
    });
    const records: NaiRecord[] = [
        { key: 'post|d', kind: 'post', anlas: 20 },
        { key: 'media|c|b2', kind: 'media', anlas: 6 },
        { key: 'inline|new', kind: 'inline', anlas: 12, at: 2000 },
        { key: 'inline|old', kind: 'inline', anlas: 12, at: 500 },
        { key: 'inline|undated', kind: 'inline', anlas: 3 },
    ];
    const found = (patch: Partial<AnlasContext>) => newAnlas(records, context(patch)).map((record) => record.key);

    it('adds new inline pictures whatever the trigger', () => {
        for (const trigger of ['scan', 'sweep', 'reply', 'inline', 'marker'] as const) {
            expect(found({ trigger })).toEqual(['inline|new']);
        }
        expect(found({ trigger: 'scan', counted: new Set(['inline|new']) })).toEqual([]);
    });

    it('adds posts and media only when NAI Studio added them after the core looked', () => {
        expect(found({ trigger: 'swipe' })).toEqual(['post|d', 'media|c|b2', 'inline|new']);
        expect(found({ trigger: 'tool', baseline: new Set(['post|d']) })).toEqual(['media|c|b2', 'inline|new']);
        expect(found({ trigger: 'message' })).toEqual(['inline|new']);
        expect(found({ trigger: 'message', isUser: true })).toEqual(['post|d', 'media|c|b2', 'inline|new']);
        expect(found({ trigger: 'swipe', counted: new Set(['media|c|b2']) })).toEqual(['post|d', 'inline|new']);
    });
});

describe('turns of messages', () => {
    const chat = [
        reply('greeting'),
        { name: 'You', is_user: true, is_system: false, send_date: '', mes: 'hi' },
        reply('answer'),
        post('d1', 20, [media('/p.png', 20, 'b')]),
        { name: 'Note', is_user: false, is_system: true, send_date: '', mes: 'system' },
    ];

    it('finds the reply a message belongs to, skipping picture posts and notes', () => {
        expect(isReply(chat[0])).toBe(true);
        expect(isReply(chat[1])).toBe(false);
        expect(isReply(chat[3])).toBe(false);
        expect(isReply(chat[4])).toBe(false);
        expect(isReply('x')).toBe(false);
        expect(turnOfMessage(chat, 3)).toBe(2);
        expect(turnOfMessage(chat, 1)).toBe(0);
        expect(turnOfMessage(chat, 99)).toBe(2);
        expect(lastReply(chat)).toBe(2);
        expect(lastReply([])).toBe(-1);
        expect(turnOfMessage([chat[1]], 0)).toBe(-1);
    });
});
