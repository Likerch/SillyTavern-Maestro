import { describe, expect, it } from 'vitest';
import {
    blockInstruction,
    describeForModel,
    hasBlockMarker,
    parseBlock,
    parseBlockLine,
    resolveBlock,
    stripBlock,
} from '../../src/domain/mechanics-block';
import type { BlockItem } from '../../src/domain/mechanics-block';
import type { AttributeDef, MechanicDef } from '../../src/domain/mechanics-defs';
import { resolveHolder } from '../../src/domain/mechanics-state';

const mana: AttributeDef = { id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100 };
const schools: AttributeDef = {
    id: 'schools',
    name: 'Школы',
    promptName: 'Schools',
    kind: 'list',
    options: ['fire', 'water'],
    multi: true,
};
const attitude: AttributeDef = {
    id: 'attitude',
    name: 'Отношение',
    promptName: 'Attitude',
    kind: 'scale',
    levels: ['hostile', 'cold', 'neutral', 'warm', 'loyal'],
};
const health: AttributeDef = {
    id: 'health',
    name: 'Здоровье',
    promptName: 'Health',
    kind: 'number',
    min: 0,
    max: 10,
    tracking: 'desStats',
};

function def(id: string, extra: Partial<MechanicDef>): MechanicDef {
    return {
        id,
        name: id,
        summary: id,
        rules: '',
        attributes: [],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

const MAGIC = def('magic', { attributes: [mana, schools, health] });
const BONDS = def('bonds', { attributes: [attitude], holders: { kind: 'named', names: ['Mira'] } });
const ALT = def('alt', { attributes: [{ ...mana, id: 'mana2' }], holders: { kind: 'named', names: ['Golem'] } });
const context = { persona: 'Алекс', canonical: (name: string) => ({ кай: 'Kai', мира: 'Mira' })[name.toLowerCase()] };
const resolve = (item: MechanicDef, raw: string) => resolveHolder(item, raw, context);

describe('parseBlockLine', () => {
    it('reads the documented forms', () => {
        expect(parseBlockLine('Kai.Mana: +3')).toEqual({
            holder: 'Kai',
            attribute: 'Mana',
            op: 'add',
            value: 3,
            line: 'Kai.Mana: +3',
        });
        expect(parseBlockLine('Kai.mana: -10')).toMatchObject({ op: 'add', value: -10 });
        expect(parseBlockLine('Kai.mana = 12')).toMatchObject({ op: 'set', value: 12 });
        expect(parseBlockLine('Mira.attitude = warm')).toMatchObject({ op: 'set', value: 'warm' });
        expect(parseBlockLine('Kai.schools += fire')).toMatchObject({ op: 'add', value: 'fire' });
        expect(parseBlockLine('Kai.schools -= fire')).toMatchObject({ op: 'sub', value: 'fire' });
        expect(parseBlockLine('Kai.mana -= 4')).toMatchObject({ op: 'add', value: -4 });
        expect(parseBlockLine('Kai.mana += 4')).toMatchObject({ op: 'add', value: 4 });
        expect(parseBlockLine('Kai.gold *= 2')).toMatchObject({ op: 'mul', value: 2 });
        expect(parseBlockLine('Kai.gold ×= x')).toBeNull();
    });

    it('repairs the usual deviations', () => {
        expect(parseBlockLine('- Кай.мана: −10 (заклинание)')).toMatchObject({
            holder: 'Кай',
            attribute: 'мана',
            op: 'add',
            value: -10,
            reason: 'заклинание',
        });
        expect(parseBlockLine('* **Kai . Mana** : – 5')).toMatchObject({ holder: 'Kai', attribute: 'Mana', value: -5 });
        expect(parseBlockLine("Kai's mana: 12 → 9")).toMatchObject({
            holder: 'Kai',
            attribute: 'mana',
            op: 'set',
            value: 9,
        });
        expect(parseBlockLine('Kai.mana: 45/100')).toMatchObject({ op: 'set', value: 45 });
        expect(parseBlockLine('Kai.gold: x2')).toMatchObject({ op: 'mul', value: 2 });
        expect(parseBlockLine('Kai.gold ×3')).toMatchObject({ op: 'mul', value: 3 });
        expect(parseBlockLine('Kai.mana -2 # drained')).toMatchObject({ op: 'add', value: -2, reason: 'drained' });
        expect(parseBlockLine('Kai mana: +1 — rest')).toMatchObject({
            holder: 'Kai mana',
            attribute: '',
            reason: 'rest',
        });
        expect(parseBlockLine('Mr. Smith.mana = "50"')).toMatchObject({
            holder: 'Mr.Smith',
            attribute: 'mana',
            value: 50,
        });
        expect(parseBlockLine('1) Kai.mana: +1')).toMatchObject({ holder: 'Kai' });
    });

    it('refuses what is not a line', () => {
        for (const line of ['', '<mechanics>', '```', 'Just prose.', 'Kai.mana:', 'Kai.mana: ()', '<b>.x: 1']) {
            expect(parseBlockLine(line)).toBeNull();
        }
    });
});

describe('parseBlock and stripBlock', () => {
    const story = 'Кай поднял руку, и пламя вспыхнуло.';

    it('finds a well-formed block at the end and strips it', () => {
        const text = `${story}\n\n<mechanics>\nKai.Mana: -10\nKai.Schools += fire\n</mechanics>`;
        const parsed = parseBlock(text);
        expect(parsed.found).toBe(true);
        expect(parsed.items.map((item) => item.line)).toEqual(['Kai.Mana: -10', 'Kai.Schools += fire']);
        expect(parsed.repaired).toEqual([]);
        expect(stripBlock(text)).toBe(story);
        expect(hasBlockMarker(story)).toBe(false);
        expect(stripBlock(story)).toBe(story);
        expect(parseBlock(story)).toEqual({
            found: false,
            items: [],
            repaired: [],
            dropped: [],
            rolls: [],
            combat: [],
        });
    });

    it('repairs a missing closing tag, a missing opening tag and fences', () => {
        const unclosed = parseBlock(`${story}\n<mechanics>\nKai.Mana: -10\n\nKai.Schools += fire`);
        expect(unclosed.items).toHaveLength(2);
        expect(unclosed.repaired).toContain('unclosed');
        expect(stripBlock(`${story}\n<mechanics>\nKai.Mana: -10`)).toBe(story);
        const unopened = parseBlock(`${story}\nKai.Mana: -10\n</mechanics>`);
        expect(unopened.items).toHaveLength(1);
        expect(unopened.repaired).toEqual(['unopened']);
        expect(stripBlock(`${story}\nKai.Mana: -10\n</mechanics>`)).toBe(story);
        const fenced = `${story}\n\n\`\`\`xml\n<mechanics>\nKai.Mana: -10\n</mechanics>\n\`\`\``;
        expect(parseBlock(fenced).repaired).toEqual(['fence']);
        expect(stripBlock(fenced)).toBe(story);
        const info = `${story}\n\`\`\`mechanics\nKai.Mana: -10\n\`\`\`\n`;
        expect(parseBlock(info).items).toHaveLength(1);
        expect(stripBlock(info)).toBe(story);
    });

    it('reads bracket and escaped tags, several blocks and stray tags', () => {
        const bracket = `${story}\n[mechanics]\nKai.Mana: -1\n[/mechanics]`;
        expect(parseBlock(bracket).repaired).toEqual(['bracket']);
        expect(stripBlock(bracket)).toBe(story);
        const escaped = `${story}\n&lt;mechanics&gt;\nKai.Mana: -1\n&lt;/mechanics&gt;`;
        expect(parseBlock(escaped).items).toHaveLength(1);
        expect(stripBlock(escaped)).toBe(story);
        const many = `<mechanics>\nKai.Mana: -1\n</mechanics>\n${story}\n<mechanics>\nKai.Mana: -2\n</mechanics>`;
        const parsed = parseBlock(many);
        expect(parsed.items.map((item) => item.value)).toEqual([-1, -2]);
        expect(parsed.repaired).toContain('many');
        expect(stripBlock(many)).toBe(story);
        expect(stripBlock(`${story}\n</mechanics>`)).toBe(story);
        expect(parseBlock(`${story}\n</mechanics>`).repaired).toEqual(['stray']);
        const middle = `Начало.\n\n<mechanics>\nKai.Mana: -1\n</mechanics>\n\nКонец.`;
        expect(stripBlock(middle)).toBe('Начало.\n\nКонец.');
        expect(stripBlock(`A\n<mechanics>Kai.Mana: -1</mechanics>\nB`)).toBe('A\nB');
    });

    it('keeps unreadable lines apart and stops an unclosed block at prose', () => {
        const parsed = parseBlock(`<mechanics>\nKai.Mana: -1\nthe mana drains away\n</mechanics>`);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.dropped).toEqual(['the mana drains away']);
        const prose = `${story}\n<mechanics>\nKai.Mana: -1\nОна ушла: навсегда.`;
        expect(stripBlock(prose)).toBe(`${story}\nОна ушла: навсегда.`);
        expect(parseBlock(`${story}\n<mechanics> просто текст`).items).toEqual([]);
    });

    it('cuts a streamed opening only in partial mode', () => {
        expect(stripBlock(`${story}\n<mecha`, { partial: true })).toBe(story);
        expect(stripBlock(`${story}\n<mechanics>\nKai.Ma`, { partial: true })).toBe(story);
        expect(stripBlock(`${story}\n<mecha`)).toBe(`${story}\n<mecha`);
        expect(stripBlock(`a <b>bold</b>`, { partial: true })).toBe('a <b>bold</b>');
        expect(stripBlock(undefined as unknown as string)).toBeUndefined();
    });
});

describe('resolveBlock', () => {
    const item = (line: string): BlockItem => parseBlockLine(line)!;

    it('maps lines to edits of the mechanics in the scene', () => {
        const { edits, rejected } = resolveBlock(
            [
                item('Кай.Mana: -10 (fireball)'),
                item('Kai.schools += fire'),
                item('Мира.Attitude = warm'),
                item("Kai's Mana: +2"),
                item('Kai Mana: +1'),
            ],
            [MAGIC, BONDS],
            { resolveHolder: resolve },
        );
        expect(rejected).toEqual([]);
        expect(edits).toEqual([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', op: 'add', value: -10, reason: 'fireball' },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'schools', op: 'add', value: 'fire' },
            { mechanicId: 'bonds', holder: 'Mira', attribute: 'attitude', op: 'set', value: 'warm' },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', op: 'add', value: 2 },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', op: 'add', value: 1 },
        ]);
    });

    it('lets the holder decide between attributes of the same name and reports what did not fit', () => {
        const { edits, rejected } = resolveBlock(
            [
                item('Golem.Mana: -1'),
                item('Kai.Luck: +1'),
                item('Kai.Attitude = warm'),
                item('Kai.Health: -1'),
                item('Somebody special: +1'),
            ],
            [MAGIC, ALT, BONDS],
            { resolveHolder: resolve },
        );
        expect(edits).toEqual([{ mechanicId: 'alt', holder: 'Golem', attribute: 'mana2', op: 'add', value: -1 }]);
        expect(rejected.map((entry) => entry.reason)).toEqual(['attribute', 'holder', 'mode', 'attribute']);
        const all = resolveBlock([item('Kai.Health: -1')], [MAGIC], { resolveHolder: resolve, allows: () => true });
        expect(all.edits).toHaveLength(1);
    });
});

describe('blockInstruction', () => {
    it('is empty without block attributes or holders', () => {
        expect(blockInstruction([MAGIC], {})).toBe('');
        expect(blockInstruction([def('x', { attributes: [health] })], { x: ['Kai'] })).toBe('');
    });

    it('lists the holders and attributes with an example', () => {
        const text = blockInstruction([MAGIC, BONDS], { magic: ['Kai', 'Алекс'], bonds: ['Mira'] });
        expect(text).toContain('<mechanics>\nKai.Mana: -2\n</mechanics>');
        expect(text).toContain(
            'Holders: Kai, Алекс\n- Mana: number 0-100\n- Schools: list (fire, water), several at once',
        );
        expect(text).toContain('Holders: Mira\n- Attitude: scale hostile < cold < neutral < warm < loyal');
        expect(text).not.toContain('Health');
        const scaleFirst = blockInstruction([BONDS], { bonds: ['Mira'] });
        expect(scaleFirst).toContain('Mira.Attitude = neutral');
    });

    it('describes every kind for the model', () => {
        expect(describeForModel({ ...mana, min: undefined })).toBe('Mana: number up to 100');
        expect(describeForModel({ ...mana, max: undefined })).toBe('Mana: number from 0');
        expect(describeForModel({ ...mana, min: undefined, max: undefined })).toBe('Mana: number');
        expect(describeForModel({ ...schools, multi: false, options: [] })).toBe('Schools: list, one at a time');
        expect(describeForModel({ id: 'note', name: 'N', promptName: '', kind: 'text' })).toBe('note: short text');
        const examples = blockInstruction(
            [
                def('a', { attributes: [{ ...schools, multi: false }] }),
                def('b', { attributes: [{ id: 'note', name: 'N', promptName: 'Note', kind: 'text' }] }),
                def('c', { attributes: [schools] }),
            ],
            { a: ['Kai'], b: ['Kai'], c: ['Kai'] },
        );
        expect(examples).toContain('Kai.Schools = fire');
    });
});
