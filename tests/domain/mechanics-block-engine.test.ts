// M25 service block of plan-2 §6: statuses, items and equipment lines, roll requests, fight lines; resolving them to
// the mechanics that keep statuses and inventories; the check and actor of a roll request; the instruction with its
// new parts and the persona's own attributes; secret attributes stay out.
import { describe, expect, it } from 'vitest';
import {
    blockInstruction,
    parseBlock,
    parseBlockLine,
    parseCombatLine,
    parseItemText,
    parseRollLine,
    parseStatusText,
    resolveBlock,
    resolveRollHead,
    specialAttribute,
    stripBlock,
} from '../../src/domain/mechanics-block';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import { resolveHolder } from '../../src/domain/mechanics-state';

function def(id: string, extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id,
        name: id,
        summary: '',
        rules: '',
        attributes: [
            { id: 'hp', name: 'HP', promptName: 'HP', kind: 'number', min: 0, max: 20 },
            { id: 'secret', name: 'Secret', promptName: 'Secret', kind: 'number', visibility: { preset: 'secret' } },
            { id: 'max_hp', name: 'Max HP', promptName: 'Max HP', kind: 'number', formula: '20' },
            { id: 'stamina', name: 'Stamina', promptName: 'Stamina', kind: 'number', tracking: 'desStats' },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

const context = { persona: 'Алекс' };
const options = { resolveHolder: (target: MechanicDef, raw: string) => resolveHolder(target, raw, context) };

describe('lines of statuses, items and equipment', () => {
    it('keep the raw text (parentheses belong to the value) with a trailing note', () => {
        expect(parseBlockLine('Кай.состояние += Отравлен (3 хода)')).toEqual({
            holder: 'Кай',
            attribute: 'status',
            op: 'add',
            value: 'Отравлен (3 хода)',
            line: 'Кай.состояние += Отравлен (3 хода)',
        });
        expect(parseBlockLine('Kai.status -= Poisoned # cured by the herb')).toMatchObject({
            attribute: 'status',
            op: 'sub',
            value: 'Poisoned',
            reason: 'cured by the herb',
        });
        expect(parseBlockLine('Kai.items += "rope" x2')).toMatchObject({
            attribute: 'items',
            op: 'add',
            value: '"rope" x2',
        });
        expect(parseBlockLine('Kai.inventory: torch')).toMatchObject({ attribute: 'items', op: 'set', value: 'torch' });
        expect(parseBlockLine('Kai.equip += sword')).toMatchObject({ attribute: 'equip', op: 'add' });
        expect(parseBlockLine('Kai.wear += cloak')).toMatchObject({ attribute: 'wear' });
        expect(parseBlockLine('Kai.status =  ')).toBeNull();
        expect(specialAttribute('Инвентарь')).toBe('items');
        expect(specialAttribute('mana')).toBeNull();
    });

    it('item and status texts: quantities, slots, durations', () => {
        expect(parseItemText('"rope" x2')).toEqual({ name: 'rope', qty: 2 });
        expect(parseItemText('coin ×5')).toEqual({ name: 'coin', qty: 5 });
        expect(parseItemText('3 arrows')).toEqual({ name: 'arrows', qty: 3 });
        expect(parseItemText('potion (2)')).toEqual({ name: 'potion', qty: 2 });
        expect(parseItemText('sword (in hand)')).toEqual({ name: 'sword', qty: 1, slot: 'hand' });
        expect(parseItemText('плащ (надет)')).toEqual({ name: 'плащ', qty: 1, slot: 'worn' });
        expect(parseItemText('12')).toEqual({ name: '12', qty: 1 });
        expect(parseStatusText('Отравлен (3 хода)')).toEqual({
            name: 'Отравлен',
            duration: { turns: 3 },
            durationText: '3 хода',
        });
        expect(parseStatusText('Blessed (until sunset)')).toEqual({
            name: 'Blessed',
            duration: null,
            durationText: 'until sunset',
        });
        expect(parseStatusText('Poisoned 3 turns')).toEqual({
            name: 'Poisoned',
            duration: { turns: 3 },
            durationText: '3 turns',
        });
        expect(parseStatusText('Broken arm for 2 weeks')).toMatchObject({
            name: 'Broken arm',
            duration: { minutes: 20160 },
        });
        expect(parseStatusText('"Stunned"')).toEqual({ name: 'Stunned', duration: null });
        expect(parseStatusText('Level 3 wizard')).toEqual({ name: 'Level 3 wizard', duration: null });
    });
});

describe('roll requests', () => {
    it('read the check, the other side, advantage and difficulty', () => {
        expect(parseRollLine('roll: Stealth Kai vs Guard.Perception adv hard')).toEqual({
            head: 'Stealth Kai',
            vs: { holder: 'Guard', check: 'Perception' },
            mode: 'adv',
            level: 'hard',
            line: 'roll: Stealth Kai vs Guard.Perception adv hard',
        });
        expect(parseRollLine('- проверка: Скрытность Кая против Стражника с помехой')).toMatchObject({
            head: 'Скрытность Кая',
            vs: { holder: 'Стражника' },
            mode: 'dis',
        });
        expect(parseRollLine("check: Persuasion vs the guard's Insight DC 15")).toMatchObject({
            head: 'Persuasion',
            vs: { holder: 'the guard', check: 'Insight' },
            difficulty: 15,
        });
        expect(parseRollLine('бросок — Атлетика, очень трудно')).toMatchObject({ head: 'Атлетика', level: 'veryHard' });
        expect(parseRollLine('roll: Luck')).toEqual({ head: 'Luck', line: 'roll: Luck' });
        expect(parseRollLine('roll: adv')).toBeNull();
        expect(parseRollLine('Kai.Mana: -2')).toBeNull();
    });

    it('find their check at the start or the end of the head, the rest is the actor', () => {
        const checks = [
            { mechanicId: 'skills', checkId: 'stealth', names: ['skills.stealth', 'stealth', 'Скрытность', 'Stealth'] },
            { mechanicId: 'skills', checkId: 'lock', names: ['lock', 'Lock picking'] },
        ];
        expect(resolveRollHead('Stealth Kai', checks)).toEqual({ check: checks[0], actor: 'Kai' });
        expect(resolveRollHead("Kai's Stealth", checks)).toEqual({ check: checks[0], actor: 'Kai' });
        expect(resolveRollHead('Lock picking Mira', checks)).toEqual({ check: checks[1], actor: 'Mira' });
        expect(resolveRollHead('скрытность', checks)).toEqual({ check: checks[0], actor: '' });
        expect(resolveRollHead('Dance', checks)).toBeNull();
    });
});

describe('fight lines', () => {
    it('start, end, enemies with stats, out', () => {
        expect(parseCombatLine('combat: start Bandit, Wolf and Rat')).toEqual({
            action: 'start',
            names: ['Bandit', 'Wolf', 'Rat'],
            line: 'combat: start Bandit, Wolf and Rat',
        });
        expect(parseCombatLine('combat: start')).toEqual({ action: 'start', names: [], line: 'combat: start' });
        expect(parseCombatLine('бой: конец')).toMatchObject({ action: 'end', names: [] });
        expect(parseCombatLine('combat: enemy Bandit (hp=12, armor: 2)')).toEqual({
            action: 'enemy',
            names: ['Bandit'],
            stats: { hp: 12, armor: 2 },
            line: 'combat: enemy Bandit (hp=12, armor: 2)',
        });
        expect(parseCombatLine('fight: out "Wolf"')).toMatchObject({ action: 'out', names: ['Wolf'] });
        expect(parseCombatLine('combat: dance')).toBeNull();
        expect(parseCombatLine('Kai.hp: -2')).toBeNull();
    });

    it('a block collects rolls and fight lines apart from the changes', () => {
        const text = [
            'The guard turns.',
            '<mechanics>',
            'Kai.HP: -2',
            'roll: Stealth Kai',
            'combat: start Guard',
            '</mechanics>',
        ].join('\n');
        const parsed = parseBlock(text);
        expect(parsed.items.map((item) => item.line)).toEqual(['Kai.HP: -2']);
        expect(parsed.rolls.map((roll) => roll.head)).toEqual(['Stealth Kai']);
        expect(parsed.combat.map((line) => line.action)).toEqual(['start']);
        expect(stripBlock(text)).toBe('The guard turns.');
        // An unclosed block ends after its last readable line, rolls and fights included.
        const open = ['Story.', '<mechanics>', 'roll: Stealth Kai', 'combat: end', '', 'More story.'].join('\n');
        expect(parseBlock(open)).toMatchObject({ rolls: [{ head: 'Stealth Kai' }], combat: [{ action: 'end' }] });
        expect(stripBlock(open)).toBe('Story.\n\nMore story.');
    });
});

describe('resolveBlock: statuses and items', () => {
    const KEEPER = def('keeper', { statuses: [], inventory: {}, holders: { kind: 'named', names: ['Kai'] } });

    it('go to the mechanic that keeps them and has the holder', () => {
        const items = [
            'Кай.status += Отравлен (3 хода) # укус',
            'Kai.status -= Blessed',
            'Kai.items += rope x2',
            'Kai.items += sword (in hand)',
            'Kai.items -= coin x5',
            'Kai.equip += sword',
            'Kai.equip -= sword',
            'Kai.wear += cloak',
            'Mira.items += rope',
            'Kai.items +=  "" ',
        ]
            .map((line) => parseBlockLine(line))
            .filter((item) => item !== null);
        const resolved = resolveBlock(items, [def('plain'), KEEPER], {
            resolveHolder: (target, raw) =>
                resolveHolder(target, raw, {
                    persona: 'Алекс',
                    canonical: (name) => (name === 'Кай' ? 'Kai' : undefined),
                }),
        });
        expect(resolved.statuses).toEqual([
            {
                mechanicId: 'keeper',
                holder: 'Kai',
                op: 'add',
                name: 'Отравлен',
                duration: { turns: 3 },
                durationText: '3 хода',
                reason: 'укус',
            },
            { mechanicId: 'keeper', holder: 'Kai', op: 'remove', name: 'Blessed', duration: null },
        ]);
        expect(resolved.inventory).toEqual([
            { mechanicId: 'keeper', holder: 'Kai', name: 'rope', qty: 2, op: 'give' },
            { mechanicId: 'keeper', holder: 'Kai', name: 'sword', qty: 1, op: 'give', slot: 'hand' },
            { mechanicId: 'keeper', holder: 'Kai', name: 'coin', qty: 5, op: 'take' },
            { mechanicId: 'keeper', holder: 'Kai', name: 'sword', qty: 1, op: 'equip', slot: 'hand' },
            { mechanicId: 'keeper', holder: 'Kai', name: 'sword', qty: 1, op: 'equip', slot: null },
            { mechanicId: 'keeper', holder: 'Kai', name: 'cloak', qty: 1, op: 'equip', slot: 'worn' },
        ]);
        expect(resolved.rejected.map((item) => item.reason)).toEqual(['holder', 'attribute']);
    });

    it('without a mechanic that keeps them they are refused; a real attribute of that name wins', () => {
        const items = ['Kai.status += Poisoned', 'Kai.items += rope'].map((line) => parseBlockLine(line)!);
        expect(resolveBlock(items, [def('plain')], options).rejected.map((item) => item.reason)).toEqual([
            'mode',
            'mode',
        ]);
        const withStatus = def('mood', {
            attributes: [{ id: 'status', name: 'Status', promptName: 'Status', kind: 'text' }],
        });
        expect(resolveBlock(items.slice(0, 1), [withStatus], options).edits).toEqual([
            { mechanicId: 'mood', holder: 'Kai', attribute: 'status', op: 'add', value: 'Poisoned' },
        ]);
        expect(resolveBlock([parseBlockLine('Kai.status += ()')!], [KEEPER], options).rejected[0]?.reason).toBe(
            'attribute',
        );
    });

    it('secret and derived attributes are not the model’s to change; a custom rule may allow per holder', () => {
        const items = ['Kai.Secret: +1', 'Kai.Max HP: 5', 'Kai.HP: -1', 'Алекс.Stamina: -2', 'Kai.Stamina: -2'].map(
            (line) => parseBlockLine(line)!,
        );
        const plain = resolveBlock(items, [def('a')], options);
        expect(plain.edits.map((edit) => edit.attribute)).toEqual(['hp']);
        const persona = resolveBlock(items, [def('a')], {
            ...options,
            allows: (_def, attr, holder) => attr.id === 'stamina' && holder === 'Алекс',
        });
        expect(persona.edits.map((edit) => [edit.holder, edit.attribute])).toEqual([['Алекс', 'stamina']]);
    });
});

describe('blockInstruction: the new parts', () => {
    it('adds conditions, items, rolls and fights; leaves secret and derived attributes out', () => {
        const keeper = def('keeper', { statuses: [], inventory: {} });
        const text = blockInstruction([keeper], { keeper: ['Kai'] }, { checks: ['Stealth', ' '], combat: true });
        expect(text).toContain('Holders: Kai\n- HP: number 0-20');
        expect(text).not.toContain('Secret');
        expect(text).not.toContain('Max HP');
        expect(text).toContain('Conditions: Holder.status += Poisoned (3 turns)');
        expect(text).toContain('Items: Holder.items += rope x2');
        expect(text).toContain('Rolls: when the outcome of a risky action is uncertain');
        expect(text).toContain('Checks: Stealth.');
        expect(text).toContain('Fights: combat: start');
    });

    it('rolls or fights alone get a short instruction; statuses and items need block tracking', () => {
        const background = def('bg', { tracking: 'background', statuses: [], inventory: {}, attributes: [] });
        const rolls = blockInstruction([background], { bg: ['Kai'] }, { checks: ['Stealth'] });
        expect(rolls).toContain('[Mechanics block] When the story needs it, end your reply with a service block');
        expect(rolls).toContain('roll: Stealth Kai');
        expect(rolls).not.toContain('One change per line');
        expect(rolls).not.toContain('Conditions:');
        expect(blockInstruction([background], { bg: ['Kai'] }, { combat: true })).toContain(
            '<mechanics>\ncombat: start\n</mechanics>',
        );
        expect(blockInstruction([background], { bg: ['Kai'] })).toBe('');
        const statusOnly = def('s', { statuses: [], attributes: [] });
        expect(blockInstruction([statusOnly], { s: ['Kai'] })).toContain(
            '<mechanics>\nKai.status += Poisoned (3 turns)\n</mechanics>',
        );
        const itemsOnly = def('i', { inventory: {}, attributes: [] });
        expect(blockInstruction([itemsOnly], { i: ['Kai'] })).toContain(
            '<mechanics>\nKai.items += rope x2\n</mechanics>',
        );
    });

    it('lists the persona’s own attributes (the DES fallback) as a group of its own', () => {
        const health = def('health', {
            tracking: 'desStats',
            attributes: [def('x').attributes[3]!, def('x').attributes[0]!],
        });
        const text = blockInstruction(
            [health],
            { health: ['Kai', 'Алекс'] },
            {
                persona: {
                    name: 'Алекс',
                    attributes: (target) => target.attributes.filter((attr) => attr.id === 'stamina'),
                },
            },
        );
        expect(text).toContain('<mechanics>\nАлекс.Stamina: -2\n</mechanics>');
        expect(text).toContain('Holders: Алекс\n- Stamina: number');
        expect(
            blockInstruction([health], { health: ['Kai'] }, { persona: { name: 'Алекс', attributes: () => [] } }),
        ).toBe('');
    });
});
