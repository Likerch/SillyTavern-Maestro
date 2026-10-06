import { describe, expect, it } from 'vitest';
import {
    parsePersonaAnswer,
    PERSONA_EXCERPT_CHARS,
    PERSONA_SCHEMA,
    personaMessages,
} from '../../src/domain/wardrobe-persona';

describe('persona clothing request', () => {
    it('asks for one phrase about the user’s character with a strict schema', () => {
        const messages = personaMessages({ name: 'Кай', current: '', excerpt: 'x'.repeat(PERSONA_EXCERPT_CHARS + 50) });
        expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
        expect(messages[0]!.content).toContain("the user's character");
        expect(messages[0]!.content).toContain('null');
        expect(messages[1]!.content).toContain('Character: Кай');
        expect(messages[1]!.content).toContain('Known so far: unknown');
        expect(messages[1]!.content.length).toBeLessThan(PERSONA_EXCERPT_CHARS + 100);
        expect(personaMessages({ name: 'Кай', current: 'плащ', excerpt: 'a' })[1]!.content).toContain(
            'Known so far: плащ',
        );
        expect(PERSONA_SCHEMA).toMatchObject({ required: ['wearing'], additionalProperties: false });
    });

    it('reads the answer, null for «does not say» and junk', () => {
        expect(parsePersonaAnswer({ wearing: ' серый   плащ ' })).toBe('серый плащ');
        expect(parsePersonaAnswer('{"wearing":"boots"}')).toBe('boots');
        expect(parsePersonaAnswer({ wearing: null })).toBeNull();
        expect(parsePersonaAnswer({ wearing: 'unknown' })).toBeNull();
        expect(parsePersonaAnswer({ wearing: 'x'.repeat(301) })).toBeNull();
        expect(parsePersonaAnswer({ wearing: 3 })).toBeNull();
        expect(parsePersonaAnswer('not json')).toBeNull();
        expect(parsePersonaAnswer(null)).toBeNull();
    });
});
