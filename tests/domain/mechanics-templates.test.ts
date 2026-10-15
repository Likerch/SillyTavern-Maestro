import { describe, expect, it } from 'vitest';
import {
    desStatCandidates,
    desStatsAttributes,
    normalizeDef,
    parseDice,
    trackingOf,
    validateDef,
} from '../../src/domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../src/domain/mechanics-templates';
import { DEF_STRINGS } from '../../src/features/mechanics/strings-defs';

const LOCALES = ['en', 'ru'] as const;

describe('mechanic templates', () => {
    it('are the eleven of the plans, each with a title and a description in both languages', () => {
        expect(MECHANIC_TEMPLATES.map((item) => item.id)).toEqual([
            'health',
            'magic',
            'reputation',
            'money',
            'skills',
            'relationships',
            'survival',
            'sanity',
            'trade',
            'combat',
            'social',
        ]);
        for (const item of MECHANIC_TEMPLATES) {
            for (const locale of LOCALES) {
                expect(DEF_STRINGS[locale][item.titleKey], item.titleKey).toBeTruthy();
                expect(DEF_STRINGS[locale][item.descriptionKey], item.descriptionKey).toBeTruthy();
            }
        }
    });

    it('build definitions without errors (and normalised already) in both languages', () => {
        for (const item of MECHANIC_TEMPLATES) {
            for (const locale of LOCALES) {
                const value = defFromTemplate(item, locale, { kind: 'global' }, []);
                const issues = validateDef(value).filter((issue) => issue.level === 'error');
                expect(issues, `${item.id}/${locale}`).toEqual([]);
                expect(normalizeDef(value), `${item.id}/${locale}`).toEqual(value);
                expect(value.template).toBe(item.id);
                expect(value.rules).toMatch(/^[\x20-\x7E\n–→'’]+$/);
                for (const check of value.checks) expect(parseDice(check.dice), check.dice).not.toBeNull();
            }
        }
    });

    it('show names in the UI language and keep English for the model', () => {
        const en = templateById('health')!.build('en');
        const ru = templateById('health')!.build('ru');
        expect(en.name).toBe('Health and stamina');
        expect(ru.name).toBe('Здоровье и выносливость');
        expect(ru.attributes.map((item) => [item.name, item.promptName])).toEqual([
            ['Здоровье', 'Health'],
            ['Выносливость', 'Stamina'],
        ]);
        expect(ru.rules).toBe(en.rules);
        expect(templateById('skills')!.build('ru').checks[0]).toMatchObject({
            name: 'Убеждение',
            promptName: 'Persuasion',
            dice: '1d20+@persuasion',
            difficulty: 12,
        });
        expect(templateById('nope')).toBeNull();
    });

    it('follow the default tracking of the plan', () => {
        const tracking = (id: string) => {
            const value = defFromTemplate(templateById(id)!, 'en', { kind: 'global' }, []);
            return Object.fromEntries(value.attributes.map((item) => [item.id, trackingOf(value, item)]));
        };
        // 1.26: every template but combat is 'auto' (DES stats when DES keeps them, else the service block, the
        // background parse as the safety net); arcana lost its 'background' override (one parse per reply for a rare
        // change). Combat stays 'block' (its fight lines need the block).
        expect(tracking('health')).toEqual({ health: 'auto', stamina: 'auto' });
        expect(tracking('magic')).toEqual({ mana: 'auto', schools: 'auto', arcana: 'auto' });
        expect(tracking('reputation')).toEqual({ standing: 'auto' });
        expect(tracking('money')).toEqual({ coins: 'auto' });
        // Skills, experience and level move by Maestro alone (growth by use, experience per roll): 'manual'.
        expect(new Set(Object.values(tracking('skills')))).toEqual(new Set(['manual']));
        expect(tracking('relationships')).toEqual({ attitude: 'auto' });
        for (const id of ['survival', 'sanity', 'trade', 'social'])
            expect(new Set(Object.values(tracking(id)))).toEqual(new Set(['auto']));
        expect(new Set(Object.values(tracking('combat')))).toEqual(new Set(['block']));
    });

    it('carry the events and holders the plan asks for', () => {
        const health = defFromTemplate(templateById('health')!, 'en', { kind: 'global' }, []);
        expect(health.attributes.map((item) => item.events?.[0]?.when)).toEqual([
            { op: '<=', value: 0 },
            { op: '<=', value: 0 },
        ]);
        // 1.26: 'auto', no explicit DES stats; both numbers may still become DES stats (DES keeps them then).
        expect(desStatsAttributes(health)).toEqual([]);
        expect(desStatCandidates(health).map((item) => item.id)).toEqual(['health', 'stamina']);
        const reputation = defFromTemplate(templateById('reputation')!, 'en', { kind: 'global' }, []);
        expect(reputation.holders).toEqual({ kind: 'factions', names: [] });
        expect(reputation.attributes[0]?.levels?.[0]).toBe('hostile');
        expect(reputation.attributes[0]?.levels?.at(-1)).toBe('revered');
        expect(validateDef(reputation).map((issue) => issue.code)).toEqual(['holderNames']);
        const skills = defFromTemplate(templateById('skills')!, 'en', { kind: 'global' }, []);
        expect(skills.attributes.map((item) => item.id)).toEqual(
            expect.arrayContaining(['persuasion', 'stealth', 'athletics', 'perception']),
        );
        for (const check of skills.checks) {
            expect(
                check.triggers.some((stem) => /[а-я]/.test(stem)),
                check.id,
            ).toBe(true);
            expect(
                check.triggers.some((stem) => /^[a-z ]+$/.test(stem)),
                check.id,
            ).toBe(true);
        }
        const relationships = defFromTemplate(templateById('relationships')!, 'en', { kind: 'global' }, []);
        expect(relationships.holders).toEqual({ kind: 'characters' });
        expect(relationships.attributes[0]?.kind).toBe('scale');
    });

    it('create fresh copies with a unique id and the given scope', () => {
        const item = templateById('magic')!;
        const scope = { kind: 'card' as const, avatar: 'kai.png' };
        const first = defFromTemplate(item, 'ru', scope, ['magic']);
        expect(first.id).toBe('magic_2');
        expect(first.scope).toEqual(scope);
        expect(first.scope).not.toBe(scope);
        first.attributes[0]!.name = 'changed';
        expect(defFromTemplate(item, 'ru', scope, []).attributes[0]!.name).toBe('Мана');
        expect(defFromTemplate(item, 'ru', scope, []).id).toBe('magic');
    });
});

describe('templates of plan-2 §6', () => {
    const build = (id: string, locale: 'en' | 'ru' = 'en') =>
        defFromTemplate(templateById(id)!, locale, { kind: 'global' }, []);

    it('are «game» except the relationships and social scales («book», with words in the UI language)', () => {
        for (const item of MECHANIC_TEMPLATES) {
            const preset = build(item.id).visibility?.preset;
            expect(preset, item.id).toBe(['relationships', 'social'].includes(item.id) ? 'book' : 'game');
        }
        expect(build('relationships', 'ru').visibility?.words?.[3]).toEqual({
            level: 'warm',
            label: 'warm',
            display: 'тепло',
        });
        expect(build('relationships', 'en').visibility?.words?.[3]).toEqual({ level: 'warm', label: 'warm' });
        expect(build('social', 'ru').visibility?.words?.[0]).toEqual({ upTo: 15, label: 'none', display: 'нет' });
    });

    it('spellcasting is a check of the magic art that costs mana: 10 on success, 5 on failure', () => {
        const magic = build('magic');
        const check = magic.checks[0]!;
        expect(check).toMatchObject({ dice: '1d20+@arcana', difficulty: 12 });
        expect(check.effects?.map((effect) => [effect.on, effect.changes.map((change) => change.value)])).toEqual([
            ['success', [10]],
            ['failure', [5]],
            ['fumble', [5]],
            ['critical', []],
        ]);
        // Release 1.27: below its smallest cost there is nothing to cast with (no roll).
        expect(check.requires).toEqual([{ attr: 'mana', min: 5, note: 'a spell costs at least 5 mana' }]);
        expect(magic.attributes.find((attr) => attr.id === 'arcana')?.growth).toEqual({ perUse: 0.2, cap: 8 });
    });

    it('skills go 0–10 with d20 + skill against 12 and grow with use', () => {
        const skills = build('skills');
        const own = skills.attributes.filter((attr) => skills.checks.some((check) => check.id === attr.id));
        expect(own).toHaveLength(skills.checks.length);
        expect(own.every((attr) => attr.min === 0 && attr.max === 10 && attr.growth?.perUse === 0.2)).toBe(true);
        expect(skills.checks.every((check) => check.dice === `1d20+@${check.id}` && check.difficulty === 12)).toBe(
            true,
        );
    });

    it('skills: the social checks roll on spoken lines; every check gives experience toward five levels', () => {
        const skills = build('skills', 'ru');
        expect(skills.checks.filter((check) => check.speech).map((check) => check.id)).toEqual([
            'persuasion',
            'deception',
            'intimidation',
        ]);
        expect(skills.checks.find((check) => check.id === 'stealth')).not.toHaveProperty('speech');
        expect(skills.progression).toEqual({
            xp: 'xp',
            level: 'level',
            thresholds: [100, 250, 500, 1000],
            awards: { critical: 20, success: 10, failure: 3, fumble: 3 },
        });
        expect(skills.attributes.slice(-2)).toMatchObject([
            { id: 'xp', name: 'Опыт', promptName: 'Experience', min: 0, initial: 0 },
            { id: 'level', name: 'Уровень', promptName: 'Level', min: 1, max: 5, initial: 1 },
        ]);
        // No other template carries experience.
        for (const item of MECHANIC_TEMPLATES) {
            if (item.id !== 'skills') expect(build(item.id).progression, item.id).toBeUndefined();
        }
    });

    it('survival grows with story time and puts statuses on at the limits', () => {
        const survival = build('survival', 'ru');
        expect(survival.time).toEqual([
            { attr: 'hunger', amount: 4, per: 'hour' },
            { attr: 'thirst', amount: 6, per: 'hour' },
            { attr: 'fatigue', amount: 5, per: 'hour', when: 'awake' },
            { attr: 'fatigue', amount: -15, per: 'hour', when: 'rest' },
        ]);
        const starving = survival.attributes[0]!.events?.[0];
        expect(starving?.actions?.[0]).toMatchObject({
            attr: 'status',
            op: 'push',
            status: { name: 'Голодает', promptName: 'starving' },
        });
        expect(survival.statuses).toEqual([]);
    });

    it('sanity, trade, combat: checks, money, fights', () => {
        const sanity = build('sanity');
        expect(sanity.checks[0]).toMatchObject({ id: 'sanity_check', dice: '1d100<=@sanity' });
        expect(sanity.time).toEqual([{ attr: 'sanity', amount: 1, per: 'day', when: 'rest' }]);
        expect(build('trade').inventory).toEqual({ money: 'coins' });
        const combat = build('combat');
        expect(combat.combat).toEqual({ initiative: 'initiative', enemy: { hp: 12, armor: 1, attack: 2, agility: 2 } });
        expect(combat.attributes[0]?.events?.[0]?.actions).toEqual([
            { who: 'actor', attr: 'combat', op: 'pull', value: '' },
        ]);
        expect(combat.checks.find((check) => check.id === 'attack')?.effects?.[0]?.changes[0]).toMatchObject({
            who: 'target',
            attr: 'hp',
            value: 'max(1, 1d6 + @attack)',
        });
        expect(build('social').holders).toEqual({ kind: 'characters' });
    });

    it('reputation takes the factions of the lore when it is made (no repeats, at most 20)', () => {
        const item = templateById('reputation')!;
        const many = Array.from({ length: 25 }, (_, i) => `Faction ${i}`);
        expect(
            defFromTemplate(item, 'en', { kind: 'global' }, [], { factions: ['Guild', ' guild ', 'Crown', ' '] })
                .holders,
        ).toEqual({
            kind: 'factions',
            names: ['Guild', 'Crown'],
        });
        expect(
            (defFromTemplate(item, 'en', { kind: 'global' }, [], { factions: many }).holders as { names: string[] })
                .names,
        ).toHaveLength(20);
        expect(
            defFromTemplate(templateById('money')!, 'en', { kind: 'global' }, [], { factions: ['Guild'] }).holders,
        ).toEqual({
            kind: 'persona',
        });
    });
});
