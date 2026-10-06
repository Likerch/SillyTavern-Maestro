// What the user's character wears (plan-2 §4 п. 6, decision В9): DES never tracks {{user}}, so a cheap background
// request reads it from the recent chat — the user's messages and the narration — and answers with one short phrase
// in the story's language, or null when the excerpt does not say. Strict JSON schema; the request is made only when
// the excerpt mentions clothes at all (wardrobe-wear.ts mentionsClothing) and not more often than every N turns. Pure.
import type { LlmMessage } from '../shared/contracts';

export const PERSONA_SCHEMA_NAME = 'wardrobe_persona';

export const PERSONA_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['wearing'],
    properties: {
        wearing: {
            type: ['string', 'null'],
            description:
                "What the user's character wears right now, one short phrase in the story's language; null when the excerpt does not say",
        },
    },
};

/** At most this much of the chat goes into the request (the newest part). */
export const PERSONA_EXCERPT_CHARS = 3000;

export interface PersonaRequest {
    /** The user's character (persona name). */
    name: string;
    /** What is known so far ('' unknown). */
    current: string;
    /** Recent messages: «Name: text», oldest first. */
    excerpt: string;
}

export function personaMessages(request: PersonaRequest): LlmMessage[] {
    const system = [
        "You read an excerpt of a role-play and say what one character is wearing right now: the user's character.",
        'Answer with JSON only: {"wearing": "<short phrase>"} or {"wearing": null}.',
        'The phrase lists garments, footwear and accessories as the story says them, in the language of the story',
        '(Russian stays Russian), or says that the character is naked, in a towel or in underwear.',
        'Only clothing: no hair, eyes, body, mood. Do not describe anyone else.',
        'If the excerpt does not say or clearly imply what this character wears now, answer null.',
    ].join(' ');
    const user = [
        `Character: ${request.name}`,
        `Known so far: ${request.current.trim() || 'unknown'}`,
        '',
        'Excerpt:',
        request.excerpt.slice(-PERSONA_EXCERPT_CHARS),
    ].join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

/** The answer's phrase; null for «does not say», junk or an over-long text. */
export function parsePersonaAnswer(data: unknown): string | null {
    let value: unknown = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }
    if (typeof value !== 'object' || value === null) return null;
    const wearing = (value as Record<string, unknown>).wearing;
    if (typeof wearing !== 'string') return null;
    const text = wearing.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300 || /^(?:null|none|unknown|нет|неизвестно)$/i.test(text)) return null;
    return text;
}
