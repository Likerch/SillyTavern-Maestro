import { describe, expect, it } from 'vitest';
import {
    chatLanguage,
    detectImportant,
    freeRecap,
    hasMaterial,
    lastMessageTime,
    parseSendDate,
    promptRecap,
    recapDue,
    recapPrompt,
    tidyRecap,
} from '../../src/domain/chronicle-recap';
import type { RecapMaterial } from '../../src/domain/chronicle-recap';

const HOUR = 3_600_000;
const labels = { chapters: 'Chronicle:', long: 'Remembered:', recent: 'Lately:' };

describe('send dates', () => {
    it('reads ISO, numeric and legacy send dates', () => {
        expect(parseSendDate('2026-10-04T15:45:12.345Z')).toBe(Date.UTC(2026, 9, 4, 15, 45, 12, 345));
        expect(parseSendDate(1_700_000_000_000)).toBe(1_700_000_000_000);
        expect(parseSendDate(' 1700000000000 ')).toBe(1_700_000_000_000);
        expect(parseSendDate('2026-10-04@15h45m12s')).toBe(new Date(2026, 9, 4, 15, 45, 12).getTime());
        expect(parseSendDate('2026-10-04 @15h 45m 12s 345ms')).toBe(new Date(2026, 9, 4, 15, 45, 12, 345).getTime());
        expect(parseSendDate('October 4, 2026 3:45pm')).toBe(new Date(2026, 9, 4, 15, 45).getTime());
        expect(parseSendDate('Oct 4, 2026 12:05am')).toBe(new Date(2026, 9, 4, 0, 5).getTime());
        expect(parseSendDate('October 4, 2026 15:45')).toBe(new Date(2026, 9, 4, 15, 45).getTime());
    });

    it('gives null for what it cannot read', () => {
        expect(parseSendDate('Foo 4, 2026 3:45pm')).toBeNull();
        expect(parseSendDate('not a date')).toBeNull();
        expect(parseSendDate('')).toBeNull();
        expect(parseSendDate(-5)).toBeNull();
        expect(parseSendDate(Number.NaN)).toBeNull();
        expect(parseSendDate(null)).toBeNull();
    });

    it('finds the newest readable message time', () => {
        const at = Date.UTC(2026, 0, 1);
        expect(
            lastMessageTime([{ send_date: new Date(at).toISOString() }, { send_date: 'junk' }, null, 'text', {}]),
        ).toBe(at);
        expect(lastMessageTime([{ send_date: '' }])).toBeNull();
        expect(lastMessageTime([])).toBeNull();
    });
});

describe('the absence rule', () => {
    it('is due after the threshold since the newest of the last message and the last recap', () => {
        const now = 100 * HOUR;
        expect(recapDue(now, now - 13 * HOUR, null, 12)).toBe(true);
        expect(recapDue(now, now - 11 * HOUR, undefined, 12)).toBe(false);
        // The recap was shown an hour ago: not again.
        expect(recapDue(now, now - 13 * HOUR, now - HOUR, 12)).toBe(false);
        // A new break after the last recap.
        expect(recapDue(now, now - 30 * HOUR, now - 13 * HOUR, 12)).toBe(true);
        expect(recapDue(now, null, null, 12)).toBe(false);
        expect(recapDue(now, now - 13 * HOUR, null, 0)).toBe(false);
    });
});

describe('recap text', () => {
    const material: RecapMaterial = {
        chapters: [
            { title: 'Old', events: ['Long ago.'] },
            { title: 'Alice — Tavern', events: ['Alice met Bob.', 'Bob sang.', 'Third.'] },
            { title: 'Bare', events: [] },
            { title: 'Newest', events: ['It rained.'] },
        ],
        long: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'Shared'],
        recent: ['R0', 'R1', 'R2', 'Shared'],
    };

    it('knows when there is material', () => {
        expect(hasMaterial({ chapters: [], long: [], recent: [] })).toBe(false);
        expect(hasMaterial({ chapters: [], long: ['x'], recent: [] })).toBe(true);
        expect(hasMaterial({ chapters: [{ title: 't', events: [] }], long: [], recent: [] })).toBe(true);
        expect(hasMaterial({ chapters: [], long: [], recent: ['x'] })).toBe(true);
    });

    it('builds the free recap in sections', () => {
        expect(freeRecap(material, labels)).toBe(
            [
                'Chronicle:',
                '• Alice — Tavern: Alice met Bob. Bob sang.',
                '• Bare',
                '• Newest: It rained.',
                '',
                'Remembered:',
                '• L2',
                '• L3',
                '• L4',
                '• L5',
                '• L6',
                '• L7',
                '',
                'Lately:',
                '• R1',
                '• R2',
                '• Shared',
            ].join('\n'),
        );
        expect(freeRecap({ chapters: [], long: [], recent: [] }, labels)).toBe('');
    });

    it('drops older long-term memories first to fit, then cuts', () => {
        const long = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
        const text = freeRecap({ chapters: [], long, recent: [] }, labels, 230);
        expect(text).toBe(`Remembered:\n• ${'b'.repeat(100)}\n• ${'c'.repeat(100)}`);
        const cut = freeRecap({ chapters: [], long: [], recent: ['x'.repeat(200)] }, labels, 50);
        expect(cut.length).toBe(50);
        expect(cut.endsWith('…')).toBe(true);
        const line = freeRecap({ chapters: [], long: ['y'.repeat(400)], recent: [] }, labels);
        expect(line.split('\n')[1]?.length).toBe(2 + 220);
    });

    it('asks the model for a short recap in the chat language', () => {
        const ru = recapPrompt(material, 'ru', 100);
        expect(ru.system).toContain('At most 100 words');
        expect(ru.system).toContain('Russian');
        expect(ru.user).toContain(
            'Chronicle chapters (oldest first):\n- Alice — Tavern: Alice met Bob. Bob sang. Third.',
        );
        expect(ru.user).toContain('- Bare\n');
        expect(ru.user).toContain('Long-term memories (oldest first):\n- L1');
        expect(ru.user).toContain('Latest events (oldest first):\n- R0');
        const en = recapPrompt({ chapters: [], long: [], recent: ['Only.'] }, 'en');
        expect(en.system).toContain('Write in English.');
        expect(en.system).toContain('At most 120 words');
        expect(en.user).toBe('Latest events (oldest first):\n- Only.');
    });

    it('tidies the model answer', () => {
        expect(tidyRecap('<think>plan</think>\n«Alice met Bob.»')).toBe('Alice met Bob.');
        expect(tidyRecap('```text\nA  B\n\n\n\nC\n```')).toBe('A B\n\nC');
        expect(tidyRecap(5)).toBe('');
        const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
        const tidy = tidyRecap(long, 100);
        expect(tidy.split(' ')).toHaveLength(100);
        expect(tidy.endsWith('…')).toBe(true);
        // A little over the limit is kept.
        expect(tidyRecap(Array.from({ length: 110 }, () => 'w').join(' '), 100).split(' ')).toHaveLength(110);
    });

    it('wraps the recap for the prompt', () => {
        expect(promptRecap('  ')).toBe('');
        expect(promptRecap('Alice met Bob.')).toBe(
            '[Previously in the story — the user returns after a break:\nAlice met Bob.]',
        );
    });

    it('tells the chat language', () => {
        expect(chatLanguage(['Привет, как дела?', 'ok'])).toBe('ru');
        expect(chatLanguage(['Hello there', 'да'])).toBe('en');
        expect(chatLanguage([])).toBe('en');
    });
});

describe('important moments', () => {
    it('finds oaths in Russian and English', () => {
        expect(detectImportant('— Клянусь, я найду его, — сказал он.')).toEqual(['oath']);
        expect(detectImportant('Она дала мне честное слово вернуться.')).toEqual(['oath']);
        expect(detectImportant('Я даю тебе слово, что вернусь.')).toEqual(['oath']);
        expect(detectImportant('Он принёс клятву верности.')).toEqual(['oath']);
        expect(detectImportant('Монах дал обет молчания.')).toEqual(['oath']);
        expect(detectImportant('Земля обетованная ждала.')).toEqual([]);
        expect(detectImportant('"I swear I will protect you," she said.')).toEqual(['oath']);
        expect(detectImportant('He swore revenge.')).toEqual(['oath']);
        expect(detectImportant('They took a blood oath.')).toEqual(['oath']);
    });

    it('finds revealed secrets without catching secretaries', () => {
        expect(detectImportant('Наконец она раскрыла ему свою тайну.')).toEqual(['secret']);
        expect(detectImportant('Его секрет раскрыт.')).toEqual(['secret']);
        expect(detectImportant('Он рассказал секретарю о встрече.')).toEqual([]);
        expect(detectImportant('В тайнике лежало письмо.')).toEqual([]);
        expect(detectImportant('She finally revealed her secret to him.')).toEqual(['secret']);
        expect(detectImportant('The secret is out now.')).toEqual(['secret']);
        expect(detectImportant('The truth is, I am your father.')).toEqual(['secret']);
    });

    it('finds new quests', () => {
        expect(detectImportant('Старейшина дал им новое задание.')).toEqual(['quest']);
        expect(detectImportant('Алекс взял задание гильдии.')).toEqual(['quest']);
        expect(detectImportant('A new quest begins.')).toEqual(['quest']);
        expect(detectImportant('Quest accepted: find the ring.')).toEqual(['quest']);
        expect(detectImportant('She accepted the mission.')).toEqual(['quest']);
    });

    it('reports several kinds in a fixed order and nothing for plain text', () => {
        expect(detectImportant('I swear the truth is out. A new quest!')).toEqual(['oath', 'secret', 'quest']);
        expect(detectImportant('Он молча пил чай.')).toEqual([]);
        expect(detectImportant('')).toEqual([]);
        expect(detectImportant(5 as unknown as string)).toEqual([]);
    });
});
