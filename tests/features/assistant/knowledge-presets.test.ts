// What the assistant knows about presets (M33, plan-2 §1 п. 8): the preset rules in the system prompt while the
// conversation works on a preset (scopes, layers, binding, packs, dry run, the model pitfalls), the limits, and the
// guide found by its questions. Neutral: no server details.
import { describe, expect, it } from 'vitest';
import { searchDocs } from '../../../src/domain/assistant-docs';
import { PROMPT_PRESETS, buildSystemPrompt } from '../../../src/features/assistant/prompt';
import { knowledgeBase } from '../../../src/features/assistant/tools';

describe('the preset rules of the system prompt', () => {
    it('come in only while the conversation works on a preset', () => {
        const plain = buildSystemPrompt({ locale: 'ru', chatOpen: true });
        const presets = buildSystemPrompt({ locale: 'ru', chatOpen: true, presets: true });
        expect(plain).not.toContain('Preset work:');
        expect(presets).toContain(PROMPT_PRESETS);
        expect(plain).toContain('At most 10 tool rounds, 5 cards (a pack is one card) and 20 changes per user message');
        expect(plain).toContain('`preset_dry_run`');
    });

    it('name the scopes, the layer, packs, binding, the dry run and the model pitfalls', () => {
        for (const part of [
            '`global` (everywhere',
            '`character`',
            '`chat`',
            'survive an update of the base preset',
            '«Apply» on the card is the save',
            '`preset_pack`',
            '`preset_bind`',
            '`preset_dry_run`',
            'DeepSeek V4 through OpenRouter',
            'system messages in the middle of the history merge into the neighbouring turn',
            'an assistant-role message at the end (a prefill) breaks the reply',
            'DES tracker instructions to the system role broke the tracker JSON',
            'BunnyMo packs are never changed',
        ]) {
            expect(PROMPT_PRESETS, part).toContain(part);
        }
        expect(PROMPT_PRESETS).not.toMatch(/https?:|ssh|\b\d{1,3}(\.\d{1,3}){3}\b/);
    });
});

describe('the guide on presets', () => {
    const topics = knowledgeBase();
    const guide = topics.find((topic) => topic.id === 'guide.presets');

    it('is in both languages and covers scopes, packs, binding and the pitfalls', () => {
        expect(guide?.title).toEqual({
            en: 'How the assistant works with presets',
            ru: 'Как ассистент работает с пресетами',
        });
        for (const part of ['preset_dry_run', 'preset_pack', 'preset_bind', 'DeepSeek V4', 'BunnyMo']) {
            expect(guide?.body.en, part).toContain(part);
            expect(guide?.body.ru, part).toContain(part);
        }
        expect(guide?.body.ru).toContain('«этот чат»');
        expect(guide?.body.ru).toContain('префилл');
        expect(`${guide?.body.en} ${guide?.body.ru}`).not.toMatch(/https?:|ssh/);
    });

    it('is found by its questions', () => {
        const first = (query: string, locale: 'en' | 'ru') => searchDocs(topics, query, { locale })[0]?.id;
        expect(first('как ассистент работает с пресетами', 'ru')).toBe('guide.presets');
        expect(first('пробная сборка пресета', 'ru')).toBe('guide.presets');
        expect(first('how does the assistant work with presets', 'en')).toBe('guide.presets');
    });
});
