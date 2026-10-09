// «Язык истории» (core setting, M37): the language the story is told in — what the player reads and writes, so what
// Maestro's player-visible texts of the story (prepared names, DES seeds, secrets and promises, the recap, the format
// hint) are written in. An explicit choice wins. «Авто» reads the chat: the player's own messages first (the player
// writes in the story's language even when the card is English), then the other recent messages when they are Russian
// (a Russian card or Russian replies), else the interface language — so a new chat with only an English greeting under
// a Russian interface is a Russian story. Letters are counted by dominantLanguage (too few letters or a mix tell
// nothing). Pure.
import { dominantLanguage } from './director-flags';
import { cleanForAnalysis } from './text-clean';

export type StoryLanguage = 'ru' | 'en';
export type StoryLanguageChoice = 'auto' | StoryLanguage;

export const STORY_LANGUAGES: readonly StoryLanguageChoice[] = ['auto', 'ru', 'en'];

/** Recent messages read by «Авто» (the player's and the others' each). */
export const STORY_LANGUAGE_MESSAGES = 8;

export function isStoryLanguage(value: unknown): value is StoryLanguage {
    return value === 'ru' || value === 'en';
}

export interface StoryTexts {
    /** The player's own messages, newest first. */
    player: string[];
    /** The other non-system messages (greetings, replies), newest first. */
    others: string[];
}

/** Messages looked at per message read at most (a long chat without player messages is not walked to its start). */
const SCAN_FACTOR = 6;

/** Story texts of the recent messages of a chat (system messages and picture posts left out). */
export function storyTexts(chat: readonly unknown[], max = STORY_LANGUAGE_MESSAGES): StoryTexts {
    const out: StoryTexts = { player: [], others: [] };
    const stop = Math.max(0, chat.length - max * SCAN_FACTOR);
    for (let i = chat.length - 1; i >= stop; i--) {
        if (out.player.length >= max && out.others.length >= max) break;
        const message = chat[i];
        if (!message || typeof message !== 'object') continue;
        const record = message as { is_user?: unknown; is_system?: unknown };
        if (record.is_system === true) continue;
        const list = record.is_user === true ? out.player : out.others;
        if (list.length >= max) continue;
        const text = cleanForAnalysis(message);
        if (text) list.push(text);
    }
    return out;
}

/**
 * The story language: the explicit choice ('ru' / 'en'); for 'auto' (or anything else) the language of the player's
 * messages when they tell one, Russian when the other messages are Russian, else the interface language.
 */
export function resolveStoryLanguage(choice: unknown, texts: StoryTexts, ui: StoryLanguage): StoryLanguage {
    if (isStoryLanguage(choice)) return choice;
    const player = dominantLanguage(texts.player);
    if (player) return player;
    if (dominantLanguage(texts.others) === 'ru') return 'ru';
    return ui;
}
