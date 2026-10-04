import { describe, expect, it } from 'vitest';
import {
    cleanEventText,
    looksDrastic,
    nameTable,
    offscreenComment,
    offscreenContent,
    offscreenKeys,
    parseOffscreenAnswer,
    readFlag,
    readOffscreenItem,
} from '../../src/domain/offscreen-parse';

const NAMES = ['Mira', 'Oleg'];

function item(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        character: 'Mira',
        text: 'Mira sold her herb shop and joined a caravan to the capital.',
        location: 'the capital road',
        rumour: 'They say the herbalist left town.',
        drastic: false,
        ...fields,
    };
}

describe('reading the answer', () => {
    it('reads {events: [...]} item by item, one event per character', () => {
        const result = parseOffscreenAnswer(
            {
                events: [
                    item(),
                    item({ character: 'oleg', text: 'Oleg won a duel.', location: 'none', rumour: '', drastic: 'yes' }),
                    item({ text: 'A second event for Mira.' }),
                    item({ character: 'Stranger' }),
                    item({ text: '   ' }),
                    'junk',
                ],
            },
            NAMES,
        );
        expect(result?.invalid).toBe(4);
        expect(result?.events).toEqual([
            {
                character: 'Mira',
                text: 'Mira sold her herb shop and joined a caravan to the capital.',
                location: 'the capital road',
                rumour: 'They say the herbalist left town.',
                drastic: false,
                drasticByRules: false,
            },
            { character: 'Oleg', text: 'Oleg won a duel.', drastic: true, drasticByRules: false },
        ]);
    });

    it('accepts a bare array, a JSON string, aliases and the `name`/`event`/`rumor` spellings', () => {
        const fromArray = parseOffscreenAnswer([item({ character: 'Мира' })], NAMES, { Mira: ['Мира'] });
        expect(fromArray?.events[0]?.character).toBe('Mira');
        const fromText = parseOffscreenAnswer(
            JSON.stringify({ events: [{ name: 'Oleg', event: 'Oleg slept.', rumor: 'Snoring was heard.' }] }),
            NAMES,
        );
        expect(fromText?.events[0]).toMatchObject({
            character: 'Oleg',
            text: 'Oleg slept.',
            rumour: 'Snoring was heard.',
        });
    });

    it('returns null for something that is not the answer', () => {
        expect(parseOffscreenAnswer('not json', NAMES)).toBeNull();
        expect(parseOffscreenAnswer({ changes: [] }, NAMES)).toBeNull();
        expect(parseOffscreenAnswer(42, NAMES)).toBeNull();
        expect(parseOffscreenAnswer({ events: [] }, NAMES)).toEqual({ events: [], invalid: 0 });
    });

    it('flags drastic events by the rules when the model did not', () => {
        const event = readOffscreenItem(
            item({ text: 'Mira was arrested by the city watch for smuggling.' }),
            nameTable(NAMES),
        );
        expect(event).toMatchObject({ drastic: true, drasticByRules: true });
        expect(readOffscreenItem(null, nameTable(NAMES))).toBeNull();
    });

    it('reads flags', () => {
        expect([true, 'true', 'Yes', '1', 1].map(readFlag)).toEqual([true, true, true, true, true]);
        expect([false, 'no', 0, null, undefined, {}].map(readFlag)).toEqual([false, false, false, false, false, false]);
    });

    it('keeps the first known name of a key in the table', () => {
        const table = nameTable(['Mira', 'mira'], { Mira: ['Мира', ''], mira: ['Мира'] });
        expect(table.get('mira')).toBe('Mira');
        expect(table.get('мира')).toBe('Mira');
        expect(table.has('')).toBe(false);
    });
});

describe('the event text', () => {
    it('keeps three sentences at most, drops wrapping quotes, clips long text', () => {
        expect(cleanEventText('"One. Two! Three? Four."')).toBe('One. Two! Three?');
        expect(cleanEventText('«Она ушла. Вернулась. Снова ушла. Навсегда.»')).toBe('Она ушла. Вернулась. Снова ушла.');
        expect(cleanEventText('  ')).toBe('');
        expect(cleanEventText('a'.repeat(700))).toHaveLength(600);
        expect(cleanEventText('One. Two.', 0)).toBe('One.');
    });

    it('drops empty-ish locations and rumours', () => {
        const event = readOffscreenItem(item({ location: 'unchanged', rumour: 'N/A' }), nameTable(NAMES));
        expect(event?.location).toBeUndefined();
        expect(event?.rumour).toBeUndefined();
    });
});

describe('drastic by the rules', () => {
    it.each([
        'Mira died of fever in the night.',
        'Oleg was brutally murdered in an alley.',
        'Mira was taken prisoner by raiders.',
        'Oleg is now in chains in the baron’s keep.',
        'Mira vanished without a trace.',
        'Oleg was exiled from the city.',
        'Mira was turned into a vampire.',
        'Oleg lost his left arm in the mine collapse.',
        'Mira betrayed her guild to the inquisition.',
        'Oleg left the kingdom forever.',
    ])('«%s» is drastic', (text) => {
        expect(looksDrastic(text)).toBe(true);
    });

    it.each(['Mira killed a wolf near the mill.', 'Oleg won a card game and bought a hat.', ''])(
        '«%s» is not',
        (text) => {
            expect(looksDrastic(text)).toBe(false);
        },
    );
});

describe('the canon entry', () => {
    it('reads «Offscreen (<story time>): <text>» with the new whereabouts', () => {
        expect(offscreenComment('Mira')).toBe('Offscreen: Mira');
        expect(offscreenContent('Mira left.', '3 марта', 'the capital')).toBe(
            'Offscreen (3 марта): Mira left. Whereabouts now: the capital.',
        );
        expect(offscreenContent('Mira went to the capital.', undefined, 'The Capital')).toBe(
            'Offscreen: Mira went to the capital.',
        );
        expect(offscreenContent('  Mira slept. ')).toBe('Offscreen: Mira slept.');
    });

    it('keys: the name, Russian forms and aliases; broken keys dropped', () => {
        expect(
            offscreenKeys('Mira', ['Мира', 'Миру', 'Mira', '', '/Мир(а|у/i', '/Мир[аеуы]/i', 'x'.repeat(301)]),
        ).toEqual(['Mira', 'Мира', 'Миру', '/Мир[аеуы]/i']);
        expect(offscreenKeys('Oleg')).toEqual(['Oleg']);
    });
});
