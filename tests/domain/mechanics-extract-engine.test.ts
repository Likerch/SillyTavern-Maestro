// M25 background parse of plan-2 §6: the schema grows statuses and items only when a mechanic in the scene keeps
// them; targets of one mechanic (the persona's DES-stat fallback) are shown as one; statuses and items of the answer
// are validated against the holders that may have them.
import { describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import {
    buildExtractMessages,
    EXTRACT_LIMITS,
    extractSchemaFor,
    MECHANICS_EXTRACT_SCHEMA,
    parseExtractAnswer,
} from '../../src/domain/mechanics-extract';
import type { ExtractTarget } from '../../src/domain/mechanics-extract';

const hp = { id: 'hp', name: 'HP', promptName: 'HP', kind: 'number' as const, min: 0, max: 20 };
const stamina = { id: 'stamina', name: 'Stamina', promptName: 'Stamina', kind: 'number' as const };

const DEF: MechanicDef = {
    id: 'health',
    name: 'Health',
    summary: 'Health.',
    rules: 'Wounds hurt.',
    attributes: [hp, stamina],
    holders: { kind: 'characters', includePersona: true },
    checks: [],
    tracking: 'background',
    scope: { kind: 'global' },
    statuses: [],
    inventory: {},
};

const targets: ExtractTarget[] = [
    {
        def: DEF,
        attributes: [stamina],
        holders: [{ name: 'Kai', values: { stamina: 5 }, statuses: ['poisoned'], items: 'rope x2' }],
        statuses: true,
        inventory: true,
    },
    {
        def: DEF,
        attributes: [hp, stamina],
        holders: [{ name: 'Алекс', values: { hp: 12, stamina: 3 }, statuses: [], items: '' }],
        statuses: true,
        inventory: true,
    },
];

describe('schema', () => {
    it('adds statuses and items only when asked; strict either way', () => {
        expect(extractSchemaFor({})).toBe(MECHANICS_EXTRACT_SCHEMA);
        const full = extractSchemaFor({ statuses: true, items: true }) as {
            required: string[];
            properties: Record<
                string,
                { items: { required: string[]; properties: object; additionalProperties: boolean } }
            >;
        };
        expect(full.required).toEqual(['changes', 'statuses', 'items']);
        for (const key of ['statuses', 'items']) {
            const item = full.properties[key]!.items;
            expect(item.additionalProperties).toBe(false);
            expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
        }
        expect((extractSchemaFor({ items: true }) as { required: string[] }).required).toEqual(['changes', 'items']);
    });
});

describe('buildExtractMessages', () => {
    it('shows one mechanic once, each holder with its own attributes, conditions and items', () => {
        const [system, user] = buildExtractMessages({ targets, reply: 'Кай пьёт зелье.' });
        expect(system?.content).toContain('"statuses": conditions that start or end');
        expect(system?.content).toContain('"items": things holders marked [items] gain');
        expect(user?.content.match(/## Health\./g)).toHaveLength(1);
        expect(user?.content).toContain('Attributes:\n- Stamina: number\n- HP: number 0-20');
        expect(user?.content).toContain('Kai: Stamina 5; [conditions] poisoned; [items] rope x2');
        expect(user?.content).toContain('Алекс: HP 12; Stamina 3; [conditions] none; [items] nothing');
    });

    it('a target with only statuses or items still appears; one without anything does not', () => {
        const only: ExtractTarget[] = [
            { def: { ...DEF, rules: '' }, attributes: [], holders: [{ name: 'Kai', values: {} }], statuses: true },
            { def: { ...DEF, id: 'x' }, attributes: [], holders: [{ name: 'Mira', values: {} }] },
        ];
        const user = buildExtractMessages({ targets: only, reply: 'x' })[1]?.content ?? '';
        expect(user).toContain('## Health.');
        expect(user).toContain('Kai: [conditions] none');
        expect(user).not.toContain('Mira');
        expect(user).not.toContain('Attributes:');
    });
});

describe('parseExtractAnswer: statuses and items', () => {
    it('keeps valid ones with durations and quotes, rejects the rest', () => {
        const parsed = parseExtractAnswer(
            {
                changes: [{ holder: 'Алекс', attribute: 'HP', value: '', delta: -3, reason: 'ранен' }],
                statuses: [
                    { holder: 'Kai', name: 'poisoned', add: false, duration: '', reason: 'зелье' },
                    { holder: 'Алекс', name: 'Bleeding', add: true, duration: '3 turns', reason: '' },
                    { holder: 'Алекс', name: 'Blessed', duration: 'until sunset' },
                    { holder: 'Nobody', name: 'x', add: true, duration: '' },
                    { holder: 'Kai', name: ' ' },
                    'junk',
                ],
                items: [
                    { holder: 'Kai', name: 'rope', qty: -1, reason: 'отдал' },
                    { holder: 'Алекс', name: 'potion', qty: '2' },
                    { holder: 'Kai', name: 'coin', qty: 0 },
                    { holder: 'Mira', name: 'coin', qty: 1 },
                    { name: 'x', qty: 1 },
                ],
            },
            targets,
        );
        expect(parsed?.edits).toEqual([
            { mechanicId: 'health', holder: 'Алекс', attribute: 'hp', op: 'add', value: -3, reason: 'ранен' },
        ]);
        expect(parsed?.statuses).toEqual([
            { mechanicId: 'health', holder: 'Kai', name: 'poisoned', add: false, duration: null, reason: 'зелье' },
            {
                mechanicId: 'health',
                holder: 'Алекс',
                name: 'Bleeding',
                add: true,
                duration: { turns: 3 },
                durationText: '3 turns',
            },
            {
                mechanicId: 'health',
                holder: 'Алекс',
                name: 'Blessed',
                add: true,
                duration: null,
                durationText: 'until sunset',
            },
        ]);
        expect(parsed?.items).toEqual([
            { mechanicId: 'health', holder: 'Kai', name: 'rope', qty: -1, reason: 'отдал' },
            { mechanicId: 'health', holder: 'Алекс', name: 'potion', qty: 2 },
        ]);
        expect(parsed?.rejected.map((item) => item.reason)).toEqual([
            'holder',
            'shape',
            'shape',
            'value',
            'holder',
            'shape',
        ]);
    });

    it('limits statuses and items; holders of a target without the part are not taken', () => {
        const many = Array.from({ length: EXTRACT_LIMITS.statuses + 2 }, (_, i) => ({
            holder: 'Kai',
            name: `s${i}`,
            add: true,
        }));
        const items = Array.from({ length: EXTRACT_LIMITS.items + 1 }, (_, i) => ({
            holder: 'Kai',
            name: `i${i}`,
            qty: 1,
        }));
        const parsed = parseExtractAnswer({ changes: [], statuses: many, items }, targets);
        expect(parsed?.statuses).toHaveLength(EXTRACT_LIMITS.statuses);
        expect(parsed?.items).toHaveLength(EXTRACT_LIMITS.items);
        expect(parsed?.rejected.filter((item) => item.reason === 'limit')).toHaveLength(3);
        const plain: ExtractTarget[] = [{ def: DEF, attributes: [hp], holders: [{ name: 'Kai', values: {} }] }];
        const none = parseExtractAnswer(
            { changes: [], statuses: [{ holder: 'Kai', name: 'x' }], items: [{ holder: 'Kai', name: 'y', qty: 1 }] },
            plain,
        );
        expect(none?.statuses).toEqual([]);
        expect(none?.items).toEqual([]);
        // Aliases go through the holder resolver.
        const aliased = parseExtractAnswer(
            { changes: [], statuses: [{ holder: 'Кай', name: 'x', add: true }] },
            targets,
            {
                resolveHolder: (_def, raw) => (raw === 'Кай' ? 'Kai' : null),
            },
        );
        expect(aliased?.statuses.map((status) => status.holder)).toEqual(['Kai']);
    });
});
