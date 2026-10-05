import { describe, expect, it } from 'vitest';
import type { AttributeDef, MechanicDef } from '../../src/domain/mechanics-defs';
import {
    buildExtractMessages,
    EXTRACT_LIMITS,
    EXTRACT_SCHEMA_NAME,
    MECHANICS_EXTRACT_SCHEMA,
    parseExtractAnswer,
} from '../../src/domain/mechanics-extract';
import type { ExtractTarget } from '../../src/domain/mechanics-extract';

const gold: AttributeDef = { id: 'gold', name: 'Золото', promptName: 'Gold', kind: 'number', min: 0 };
const standing: AttributeDef = {
    id: 'standing',
    name: 'Репутация',
    promptName: 'Standing',
    kind: 'scale',
    levels: ['hated', 'neutral', 'liked'],
};
const perks: AttributeDef = {
    id: 'perks',
    name: 'Умения',
    promptName: 'Perks',
    kind: 'list',
    options: ['stealth', 'charm'],
    multi: true,
};
const mood: AttributeDef = { id: 'mood', name: 'Настроение', promptName: 'Mood', kind: 'text' };

function def(id: string, attributes: AttributeDef[], extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id,
        name: id,
        summary: `${id} summary`,
        rules: 'Rules text.',
        attributes,
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'background',
        scope: { kind: 'global' },
        ...extra,
    };
}

const MONEY = def('money', [gold, perks, mood]);
const REP = def('rep', [standing], { holders: { kind: 'factions', names: ['Guild'] }, summary: '' });
const targets: ExtractTarget[] = [
    { def: MONEY, attributes: [gold, perks, mood], holders: [{ name: 'Kai', values: { gold: 30, perks: ['charm'] } }] },
    { def: REP, attributes: [standing], holders: [{ name: 'Guild', values: { standing: 'neutral' } }] },
];

describe('schema', () => {
    it('is strict: every property required, no extras', () => {
        expect(EXTRACT_SCHEMA_NAME).toBe('maestro_mechanics_extract');
        const item = (MECHANICS_EXTRACT_SCHEMA.properties as { changes: { items: Record<string, unknown> } }).changes
            .items;
        expect(item.additionalProperties).toBe(false);
        expect([...(item.required as string[])].sort()).toEqual(Object.keys(item.properties as object).sort());
        expect(MECHANICS_EXTRACT_SCHEMA.required).toEqual(['changes']);
    });
});

describe('buildExtractMessages', () => {
    it('gives the rules, the current values and the reply', () => {
        const messages = buildExtractMessages({ targets, reply: 'Kai paid 10 gold to the Guild.' });
        expect(messages[0]?.role).toBe('system');
        expect(messages[0]?.content).toContain(`At most ${EXTRACT_LIMITS.changes} changes`);
        const user = messages[1]?.content ?? '';
        expect(user).toContain('## money summary\nRules text.\nAttributes:\n- Gold: number from 0');
        expect(user).toContain('## rep\nRules text.\nAttributes:\n- Standing: scale hated < neutral < liked');
        expect(user).toContain('Kai: Gold 30; Perks charm; Mood —');
        expect(user).toContain('Guild: Standing neutral');
        expect(user).toContain('<reply>\nKai paid 10 gold to the Guild.\n</reply>');
    });

    it('skips empty targets and clips a long reply', () => {
        const messages = buildExtractMessages({
            targets: [{ def: MONEY, attributes: [], holders: [] }],
            reply: 'x'.repeat(EXTRACT_LIMITS.reply + 100),
        });
        expect(messages[1]?.content).toContain('<mechanics>\n\n</mechanics>');
        expect(messages[1]?.content).toContain('…');
    });
});

describe('parseExtractAnswer', () => {
    it('turns valid items into edits', () => {
        const result = parseExtractAnswer(
            {
                changes: [
                    { holder: 'kai', attribute: 'Gold', value: '', delta: -10, reason: '  Kai paid   10 gold ' },
                    { holder: 'Kai', attribute: 'perks', value: '+stealth', delta: null, reason: '' },
                    { holder: 'Kai', attribute: 'perks', value: '-charm', delta: null, reason: '' },
                    { holder: 'Guild', attribute: 'Standing', value: 'liked', delta: null, reason: 'cheers' },
                    { holder: 'Guild', attribute: 'standing', value: '', delta: -1, reason: '' },
                    { holder: 'Kai', attribute: 'gold', value: '25', delta: null, reason: '' },
                    { holder: 'Kai', attribute: 'gold', value: '+5', delta: null, reason: '' },
                    { holder: 'Kai', attribute: 'mood', value: 'cheerful', delta: null, reason: '' },
                    { holder: 'Guild', attribute: 'standing', value: 2, delta: null, reason: '' },
                ],
            },
            targets,
        );
        expect(result?.rejected).toEqual([]);
        expect(result?.edits).toEqual([
            {
                mechanicId: 'money',
                holder: 'Kai',
                attribute: 'gold',
                op: 'add',
                value: -10,
                reason: 'Kai paid 10 gold',
            },
            { mechanicId: 'money', holder: 'Kai', attribute: 'perks', op: 'add', value: 'stealth' },
            { mechanicId: 'money', holder: 'Kai', attribute: 'perks', op: 'sub', value: 'charm' },
            { mechanicId: 'rep', holder: 'Guild', attribute: 'standing', op: 'set', value: 'liked', reason: 'cheers' },
            { mechanicId: 'rep', holder: 'Guild', attribute: 'standing', op: 'add', value: -1 },
            { mechanicId: 'money', holder: 'Kai', attribute: 'gold', op: 'set', value: 25 },
            { mechanicId: 'money', holder: 'Kai', attribute: 'gold', op: 'add', value: 5 },
            { mechanicId: 'money', holder: 'Kai', attribute: 'mood', op: 'set', value: 'cheerful' },
            { mechanicId: 'rep', holder: 'Guild', attribute: 'standing', op: 'set', value: 2 },
        ]);
    });

    it('reads JSON strings (fenced) and refuses other shapes', () => {
        const text = '```json\n{"changes":[{"holder":"Kai","attribute":"gold","value":"","delta":3,"reason":""}]}\n```';
        expect(parseExtractAnswer(text, targets)?.edits).toHaveLength(1);
        expect(parseExtractAnswer('Sure! {"changes": []} hope it helps', targets)?.edits).toEqual([]);
        expect(parseExtractAnswer('{"changes": [', targets)).toBeNull();
        expect(parseExtractAnswer('no json', targets)).toBeNull();
        expect(parseExtractAnswer('[1, 2]', targets)).toBeNull();
        expect(parseExtractAnswer({ items: [] }, targets)).toBeNull();
        expect(parseExtractAnswer(42, targets)).toBeNull();
    });

    it('rejects broken items, unknown holders and attributes, empty values and the overflow', () => {
        const result = parseExtractAnswer(
            {
                changes: [
                    'junk',
                    { holder: 'Kai' },
                    { holder: 'Mira', attribute: 'gold', value: '', delta: 1, reason: '' },
                    { holder: 'Kai', attribute: 'luck', value: '', delta: 1, reason: '' },
                    { holder: 'Kai', attribute: 'gold', value: '', delta: 0, reason: '' },
                    { holder: 'Kai', attribute: 'gold', value: 'a lot', delta: null, reason: '' },
                    { holder: 'Kai', attribute: 'mood', value: '', delta: 2, reason: '' },
                ],
            },
            targets,
        );
        expect(result?.edits).toEqual([]);
        expect(result?.rejected.map((item) => item.reason)).toEqual([
            'shape',
            'shape',
            'holder',
            'attribute',
            'empty',
            'value',
            'empty',
        ]);
        const many = Array.from({ length: EXTRACT_LIMITS.changes + 2 }, () => ({
            holder: 'Kai',
            attribute: 'gold',
            value: '',
            delta: 1,
            reason: '',
        }));
        const capped = parseExtractAnswer({ changes: many }, targets);
        expect(capped?.edits).toHaveLength(EXTRACT_LIMITS.changes);
        expect(capped?.rejected.map((item) => item.reason)).toEqual(['limit', 'limit']);
    });

    it('resolves aliases through the caller', () => {
        const result = parseExtractAnswer(
            { changes: [{ holder: 'Кай', attribute: 'gold', value: '', delta: 1, reason: '' }] },
            targets,
            { resolveHolder: (_def, raw) => (raw === 'Кай' ? 'kai' : null) },
        );
        expect(result?.edits[0]?.holder).toBe('Kai');
        const missing = parseExtractAnswer(
            { changes: [{ holder: 'Кай', attribute: 'gold', value: '', delta: 1, reason: '' }] },
            targets,
            { resolveHolder: () => 'Nobody' },
        );
        expect(missing?.rejected[0]?.reason).toBe('holder');
    });
});
