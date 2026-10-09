// «Язык истории» (M37): the resolver — an explicit choice wins; «Авто» reads the player's messages first, then Russian
// greetings or replies, then the interface language (a new chat with an English card under a Russian interface is a
// Russian story).
import { describe, expect, it } from 'vitest';
import { STORY_LANGUAGES, isStoryLanguage, resolveStoryLanguage, storyTexts } from '../../src/domain/story-language';

const ENGLISH_GREETING =
    'The rain drums on the shutters of the Salt Anchor Tavern. Thomas wipes the mugs and watches the door.';
const RUSSIAN_GREETING =
    'Дождь барабанит по ставням таверны «Солёный якорь». Томас протирает кружки и смотрит на дверь.';

function message(mes: string, extra: Record<string, unknown> = {}) {
    return { name: 'X', is_user: false, is_system: false, send_date: '', mes, ...extra };
}

describe('story language: the chat texts', () => {
    it("splits the player's messages from the others, newest first, without system messages and empty texts", () => {
        const texts = storyTexts([
            message(ENGLISH_GREETING),
            message('Я вхожу и сажусь у огня.', { is_user: true }),
            message('[system note]', { is_system: true }),
            message(''),
            message('Томас кивает.'),
        ]);
        expect(texts.player).toEqual(['Я вхожу и сажусь у огня.']);
        expect(texts.others).toEqual(['Томас кивает.', ENGLISH_GREETING]);
        expect(storyTexts([null, 'junk', 5])).toEqual({ player: [], others: [] });
    });

    it('reads a limited number of recent messages of each side', () => {
        const chat = Array.from({ length: 30 }, (_, index) => message(`Line ${index}`, { is_user: index % 2 === 1 }));
        const texts = storyTexts(chat, 3);
        expect(texts.player).toEqual(['Line 29', 'Line 27', 'Line 25']);
        expect(texts.others).toEqual(['Line 28', 'Line 26', 'Line 24']);
    });
});

describe('story language: the resolver', () => {
    it('an explicit setting wins over the chat and the interface', () => {
        const russianChat = storyTexts([message(RUSSIAN_GREETING), message('Я сажусь у огня.', { is_user: true })]);
        expect(resolveStoryLanguage('en', russianChat, 'ru')).toBe('en');
        const englishChat = storyTexts([message(ENGLISH_GREETING)]);
        expect(resolveStoryLanguage('ru', englishChat, 'en')).toBe('ru');
    });

    it('auto: an English greeting alone under a Russian interface is a Russian story', () => {
        const chat = storyTexts([message(ENGLISH_GREETING)]);
        expect(resolveStoryLanguage('auto', chat, 'ru')).toBe('ru');
        expect(resolveStoryLanguage(undefined, chat, 'ru')).toBe('ru');
        // …and an English one under an English interface (today's behaviour).
        expect(resolveStoryLanguage('auto', chat, 'en')).toBe('en');
    });

    it("auto: the player's own messages decide, whatever the card and the interface", () => {
        const russianPlayer = storyTexts([
            message(ENGLISH_GREETING),
            message('Я стряхиваю дождь с плаща и ищу свободный стол у огня.', { is_user: true }),
            message('Thomas nods and points at the corner table by the fire, the only one still free tonight.'),
        ]);
        expect(resolveStoryLanguage('auto', russianPlayer, 'en')).toBe('ru');
        const englishPlayer = storyTexts([
            message(RUSSIAN_GREETING),
            message('I shake the rain off my cloak and look for a free table near the fire.', { is_user: true }),
        ]);
        expect(resolveStoryLanguage('auto', englishPlayer, 'ru')).toBe('en');
    });

    it('auto: a Russian card is a Russian story under any interface; too little text falls back to the interface', () => {
        expect(resolveStoryLanguage('auto', storyTexts([message(RUSSIAN_GREETING)]), 'en')).toBe('ru');
        const short = storyTexts([message('Hi.'), message('Да.', { is_user: true })]);
        expect(resolveStoryLanguage('auto', short, 'en')).toBe('en');
        expect(resolveStoryLanguage('auto', short, 'ru')).toBe('ru');
        expect(resolveStoryLanguage('auto', { player: [], others: [] }, 'ru')).toBe('ru');
    });

    it('knows its choices', () => {
        expect(STORY_LANGUAGES).toEqual(['auto', 'ru', 'en']);
        expect(isStoryLanguage('ru')).toBe(true);
        expect(isStoryLanguage('auto')).toBe(false);
        expect(isStoryLanguage(null)).toBe(false);
    });
});
