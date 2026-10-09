// The model's part of «переодевание по сообщениям» (M27): when a message says that someone changes clothes but not into
// what («переодеваюсь», "she got dressed"), one background request after the reply reads what the people of those
// changes wear now — from the player's message and the reply — and answers with one short phrase each in the story's
// language, or an outfit of their library by its exact name. Strict JSON schema `{changes: [{name, wearing, outfit}]}`.
// It replaces the persona check every N turns while the triggers are on. Pure.
import type { LlmMessage } from '../shared/contracts';

export const CHANGE_SCHEMA_NAME = 'wardrobe_change';

export const CHANGE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['changes'],
    properties: {
        changes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'wearing', 'outfit'],
                properties: {
                    name: { type: 'string', description: 'Who changed clothes, as named in the list of people' },
                    wearing: {
                        type: ['string', 'null'],
                        description:
                            "What they wear right now, one short phrase in the story's language; null when the text does not say",
                    },
                    outfit: {
                        type: ['string', 'null'],
                        description: 'The exact name of one of their known outfits when it is that one, else null',
                    },
                },
            },
        },
    },
};

/** At most this much of the messages goes into the request (the newest part). */
export const CHANGE_EXCERPT_CHARS = 3500;

export interface ChangePerson {
    /** The name as the story has it. */
    name: string;
    /** The user's character. */
    persona?: boolean;
    /** Known outfits by name. */
    outfits: readonly string[];
    /** What they wore before ('' unknown). */
    current: string;
}

export interface ChangeRequest {
    people: readonly ChangePerson[];
    /** What the text said: «Алекс: переодеваюсь в домашнее». */
    said: readonly string[];
    /** The messages: «Name: text», oldest first. */
    excerpt: string;
}

export function changeMessages(request: ChangeRequest): LlmMessage[] {
    const system = [
        'You read an excerpt of a role-play where someone changed clothes and say what each listed person is wearing',
        'right now. Answer with JSON only: {"changes": [{"name": "<name>", "wearing": "<short phrase>" or null,',
        '"outfit": "<known outfit name>" or null}]}. The phrase lists garments, footwear and accessories as the story',
        'says them, in the language of the story (Russian stays Russian), or says that the person is naked, in a towel',
        'or in underwear. Only clothing: no hair, body or mood. When the clothes are one of the person’s known outfits,',
        'put its exact name in "outfit" as well. If the excerpt does not say or clearly imply what someone wears now,',
        'give null for them. Only the listed people.',
    ].join(' ');
    const people = request.people.map((person) => {
        const parts = [`- ${person.name}${person.persona ? " (the user's character)" : ''}`];
        if (person.current.trim()) parts.push(`wore before: ${person.current.trim()}`);
        if (person.outfits.length) parts.push(`known outfits: ${person.outfits.join(', ')}`);
        return parts.join('; ');
    });
    const user = [
        'People:',
        ...people,
        '',
        'What the text said:',
        ...request.said.map((line) => `- ${line}`),
        '',
        'Excerpt:',
        request.excerpt.slice(-CHANGE_EXCERPT_CHARS),
    ].join('\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

export interface ChangeAnswer {
    name: string;
    wearing: string | null;
    outfit: string | null;
}

const NOTHING_RE = /^(?:null|none|unknown|нет|неизвестно|n\/a)$/i;

function phrase(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text || text.length > max || NOTHING_RE.test(text)) return null;
    return text;
}

/** The answer's changes (junk dropped); [] for junk. */
export function parseChangeAnswer(data: unknown): ChangeAnswer[] {
    let value: unknown = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return [];
        }
    }
    if (typeof value !== 'object' || value === null) return [];
    const list = (value as Record<string, unknown>).changes;
    if (!Array.isArray(list)) return [];
    const out: ChangeAnswer[] = [];
    for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        const name = phrase(entry.name, 80);
        if (!name) continue;
        const wearing = phrase(entry.wearing, 300);
        const outfit = phrase(entry.outfit, 80);
        if (!wearing && !outfit) continue;
        out.push({ name, wearing, outfit });
    }
    return out;
}
