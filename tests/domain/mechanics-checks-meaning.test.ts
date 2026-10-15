// M25 checks of release 1.27, the pure parts: what an outcome means for the scene (the author's texts, else a line by
// outcome, «barely» within two points), the fact of an attempt without the means (no dice), what a check requires
// (stored, validated, described), the templates' outcome texts and requirements, and the roll line of the block
// instruction when the same reply continues with the result.
import { describe, expect, it } from 'vitest';
import { blockInstruction } from '../../src/domain/mechanics-block';
import { describeCheck, normalizeDef, normalizeRequires, validateDef } from '../../src/domain/mechanics-defs';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import { blockedFact, factWithMeaning, isBarely, outcomeMeaning } from '../../src/domain/mechanics-dice';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../src/domain/mechanics-templates';

function def(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'magic',
        name: 'Magic',
        summary: 'Spells.',
        rules: 'Mana fuels spells.',
        attributes: [
            { id: 'mana', name: 'Mana', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 },
            { id: 'rank', name: 'Rank', promptName: 'Rank', kind: 'scale', levels: ['novice', 'adept'] },
            { id: 'oath', name: 'Oath', promptName: 'Oath', kind: 'text' },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Spell',
                promptName: 'Spellcasting',
                dice: '1d20',
                difficulty: 12,
                triggers: ['spell'],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

describe('isBarely', () => {
    it('a success by 0–1 over the target or a failure by 1–2 under it, never a critical or without a target', () => {
        expect(isBarely('success', 0, { target: true })).toBe(true);
        expect(isBarely('success', 1, { target: true })).toBe(true);
        expect(isBarely('success', 2, { target: true })).toBe(false);
        expect(isBarely('failure', -1, { target: true })).toBe(true);
        expect(isBarely('failure', -2, { target: true })).toBe(true);
        expect(isBarely('failure', -3, { target: true })).toBe(false);
        expect(isBarely('critical', 0, { target: true })).toBe(false);
        expect(isBarely('fumble', -1, { target: true })).toBe(false);
        expect(isBarely('none', 0, { target: true })).toBe(false);
        expect(isBarely('success', 0, { target: false })).toBe(false);
        expect(isBarely('success', Number.NaN, { target: true })).toBe(false);
    });

    it('opposed: a win by 1–2, a tie or a loss by 1', () => {
        expect(isBarely('success', 1, { target: true, opposed: true })).toBe(true);
        expect(isBarely('success', 2, { target: true, opposed: true })).toBe(true);
        expect(isBarely('success', 3, { target: true, opposed: true })).toBe(false);
        expect(isBarely('failure', 0, { target: true, opposed: true })).toBe(true);
        expect(isBarely('failure', -1, { target: true, opposed: true })).toBe(true);
        expect(isBarely('failure', -2, { target: true, opposed: true })).toBe(false);
    });
});

describe('outcomeMeaning', () => {
    it('a line by outcome when the author wrote nothing, «barely» for a close one', () => {
        expect(outcomeMeaning('critical')).toBe('it works brilliantly, with an extra benefit');
        expect(outcomeMeaning('success')).toBe('it works as intended');
        expect(outcomeMeaning('failure')).toBe('it does not work — show what goes wrong and what it costs');
        expect(outcomeMeaning('fumble')).toBe('it goes badly wrong, with a complication');
        expect(outcomeMeaning('success', {}, true)).toBe('it barely works — only just, with nothing to spare');
        expect(outcomeMeaning('failure', {}, true)).toBe(
            'it barely fails — it nearly works; show what goes wrong and what it costs',
        );
        expect(outcomeMeaning('none')).toBe('');
    });

    it('the outcome’s own texts; a critical with success texts only gets them «and brilliantly»; any-texts follow', () => {
        expect(outcomeMeaning('success', { own: ['the spell takes shape.'] })).toBe('the spell takes shape');
        expect(outcomeMeaning('success', { own: ['the spell takes shape'] }, true)).toBe(
            'barely — the spell takes shape',
        );
        expect(outcomeMeaning('critical', { wider: ['the door opens'] })).toBe(
            'the door opens, and brilliantly, with an extra benefit',
        );
        expect(outcomeMeaning('fumble', { wider: ['the lock holds'] })).toBe(
            'the lock holds, and badly, with a complication',
        );
        expect(outcomeMeaning('critical', { own: ['a perfect cast'], wider: ['it works'] })).toBe('a perfect cast');
        expect(outcomeMeaning('failure', { any: ['the noise carries'] })).toBe(
            'it does not work — show what goes wrong and what it costs; the noise carries',
        );
        expect(outcomeMeaning('none', { any: ['the dice clatter'] })).toBe('the dice clatter');
        expect(outcomeMeaning('success', { own: ['  ', ''] })).toBe('it works as intended');
    });

    it('closes the fact: the changes, then what it means', () => {
        expect(
            factWithMeaning('Spellcasting check (Kai): rolled 15 vs 12 — success.', ['Kai: Mana -10'], 'it works'),
        ).toBe(
            'Spellcasting check (Kai): rolled 15 vs 12 — success. Consequences: Kai: Mana -10. In the scene: it works.',
        );
        expect(factWithMeaning('Luck check (Kai): rolled 9.', [], '')).toBe('Luck check (Kai): rolled 9.');
    });
});

describe('blockedFact', () => {
    it('says the attempt fails without dice, as much as the model may know', () => {
        expect(blockedFact('Spellcasting', 'Kai', { attribute: 'Mana', have: 3, need: 5 })).toBe(
            'Spellcasting (Kai): not possible — mana 3, needs 5. The attempt fails; narrate it, there is no roll.',
        );
        expect(
            blockedFact(
                'Attack',
                'Kai',
                { attribute: 'HP', have: 0, need: 1, note: 'a fighter who is down cannot attack.' },
                'Bandit',
            ),
        ).toBe(
            'Attack (Kai) against Bandit: not possible — HP 0, needs 1 (a fighter who is down cannot attack). The attempt fails; narrate it, there is no roll.',
        );
        expect(blockedFact('Spellcasting', 'Kai', { attribute: 'Mana', have: 2.456, need: 5, mode: 'words' })).toBe(
            'Spellcasting (Kai): not possible — not enough mana. The attempt fails; narrate it, there is no roll.',
        );
        expect(
            blockedFact('Spellcasting', 'Kai', {
                attribute: 'Mana',
                have: 3,
                need: 5,
                note: 'costs mana',
                mode: 'none',
            }),
        ).toBe('Spellcasting (Kai): not possible now. The attempt fails; narrate it, there is no roll.');
        expect(blockedFact(' ', ' ', { attribute: '', have: 1.234, need: 2 })).toBe(
            'Skill: not possible — value 1.23, needs 2. The attempt fails; narrate it, there is no roll.',
        );
    });
});

describe('what a check requires', () => {
    it('is stored cleanly: attribute ids in lower case, a finite minimum, a note; at most four', () => {
        expect(normalizeRequires('mana')).toBeUndefined();
        expect(normalizeRequires([])).toBeUndefined();
        expect(
            normalizeRequires([
                { attr: ' Mana ', min: '5', note: '  a spell costs mana ' },
                { attr: '', min: 1 },
                { attr: 'rank', min: 'many' },
                'mana',
                { attr: 'rank', min: 1 },
                { attr: 'a', min: 1 },
                { attr: 'b', min: 1 },
                { attr: 'c', min: 1 },
            ]),
        ).toEqual([
            { attr: 'mana', min: 5, note: 'a spell costs mana' },
            { attr: 'rank', min: 1 },
            { attr: 'a', min: 1 },
            { attr: 'b', min: 1 },
        ]);
        const value = normalizeDef({
            ...def(),
            checks: [{ ...def().checks[0], requires: [{ attr: 'mana', min: 5 }] }],
        });
        expect(value?.checks[0]?.requires).toEqual([{ attr: 'mana', min: 5 }]);
        expect(normalizeDef(def())?.checks[0]).not.toHaveProperty('requires');
    });

    it('warns of an unknown attribute or one without a number (the roll then goes ahead)', () => {
        const check = def().checks[0]!;
        const value = def({
            checks: [
                {
                    ...check,
                    requires: [
                        { attr: 'mana', min: 5 },
                        { attr: 'rank', min: 1 },
                        { attr: 'stamina', min: 1 },
                        { attr: 'oath', min: 1 },
                    ],
                },
            ],
        });
        const issues = validateDef(value).filter((issue) => issue.code.startsWith('require'));
        expect(issues).toEqual([
            {
                level: 'warn',
                code: 'requireAttr',
                path: 'checks.0.requires.2.attr',
                params: { check: 'Spell', attribute: 'stamina' },
            },
            {
                level: 'warn',
                code: 'requireKind',
                path: 'checks.0.requires.3.attr',
                params: { check: 'Spell', attribute: 'oath' },
            },
        ]);
    });

    it('is described for the entry’s «Costs and limits»', () => {
        const check = { ...def().checks[0]!, requires: [{ attr: 'mana', min: 5 }] };
        expect(describeCheck(check)).toBe('Spellcasting (spell): 1d20 vs 12; needs mana >= 5');
    });
});

describe('templates of release 1.27', () => {
    const build = (id: string) => defFromTemplate(templateById(id)!, 'ru', { kind: 'global' }, []);

    it('every check with a target says in English what each outcome means for the scene', () => {
        for (const item of MECHANIC_TEMPLATES) {
            for (const check of build(item.id).checks) {
                if (check.difficulty === null && !check.dice.includes('<=')) continue;
                for (const on of ['critical', 'success', 'failure', 'fumble'] as const) {
                    const text = check.effects?.find((effect) => effect.on === on)?.text ?? '';
                    expect(text, `${item.id}.${check.id} ${on}`).toMatch(/^[\x20-\x7E]{6,}$/);
                }
            }
        }
        const spell = build('magic').checks[0]!;
        expect(spell.effects?.find((effect) => effect.on === 'success')?.text).toContain('the spell takes shape');
        expect(spell.effects?.find((effect) => effect.on === 'failure')?.text).toContain('fizzles');
        const attack = build('combat').checks.find((check) => check.id === 'attack')!;
        expect(attack.effects?.map((effect) => [effect.on, effect.text])).toEqual([
            ['success', 'the attack hits'],
            ['critical', 'a telling blow: it lands hard where it hurts most'],
            ['fumble', 'the attack goes wide and leaves an opening for the enemy'],
            ['failure', 'the attack misses'],
        ]);
        expect(build('skills').checks.find((check) => check.id === 'persuasion')?.effects?.[0]).toEqual({
            on: 'success',
            changes: [],
            text: 'they are persuaded and agree',
        });
    });

    it('a spell needs its smallest cost in mana, an attack a fighter who is not down', () => {
        expect(build('magic').checks[0]?.requires).toEqual([
            { attr: 'mana', min: 5, note: 'a spell costs at least 5 mana' },
        ]);
        expect(build('combat').checks.find((check) => check.id === 'attack')?.requires).toEqual([
            { attr: 'hp', min: 1, note: 'a fighter who is down cannot attack' },
        ]);
        expect(build('magic').rules).toContain('below 5 mana no spell can be cast at all');
        for (const item of MECHANIC_TEMPLATES) {
            expect(
                validateDef(build(item.id)).filter((issue) => issue.code.startsWith('require')),
                item.id,
            ).toEqual([]);
        }
    });
});

describe('the roll line of the block instruction', () => {
    const scene = def({ tracking: 'background', attributes: [] });

    it('with the roll in the middle of a reply: stop right at the attempt, the same reply continues', () => {
        const text = blockInstruction([scene], { magic: ['Kai'] }, { checks: ['Spellcasting'], rollContinue: true });
        expect(text).toContain(
            'Rolls: when the outcome of a risky action is uncertain, do not decide it — stop the story right at the attempt and end the reply there with the service block holding roll: <check> <who> (optionally vs <other>.<check>, adv or dis, easy or hard); Maestro rolls at once and this same reply then continues with the result. Checks: Spellcasting.',
        );
        expect(text).not.toContain('next turn');
    });

    it('without it: the result next turn, as before', () => {
        const text = blockInstruction([scene], { magic: ['Kai'] }, { checks: ['Spellcasting'] });
        expect(text).toContain('stop before the outcome; Maestro rolls and gives you the result next turn.');
        expect(text).not.toContain('this same reply');
    });
});
