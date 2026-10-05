import { describe, expect, it } from 'vitest';
import { desStatsAttributes, normalizeDef, parseDice, trackingOf, validateDef } from '../../src/domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../src/domain/mechanics-templates';
import { DEF_STRINGS } from '../../src/features/mechanics/strings-defs';

const LOCALES = ['en', 'ru'] as const;

describe('mechanic templates', () => {
    it('are the six of the plan, each with a title and a description in both languages', () => {
        expect(MECHANIC_TEMPLATES.map((item) => item.id)).toEqual([
            'health',
            'magic',
            'reputation',
            'money',
            'skills',
            'relationships',
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
            dice: '1d20+mod(@persuasion)',
            difficulty: 12,
        });
        expect(templateById('nope')).toBeNull();
    });

    it('follow the default tracking of the plan', () => {
        const tracking = (id: string) => {
            const value = defFromTemplate(templateById(id)!, 'en', { kind: 'global' }, []);
            return Object.fromEntries(value.attributes.map((item) => [item.id, trackingOf(value, item)]));
        };
        expect(tracking('health')).toEqual({ health: 'desStats', stamina: 'desStats' });
        expect(tracking('magic')).toEqual({ mana: 'desStats', schools: 'background' });
        expect(tracking('reputation')).toEqual({ standing: 'background' });
        expect(tracking('money')).toEqual({ coins: 'background' });
        expect(new Set(Object.values(tracking('skills')))).toEqual(new Set(['background']));
        expect(tracking('relationships')).toEqual({ attitude: 'background' });
    });

    it('carry the events and holders the plan asks for', () => {
        const health = defFromTemplate(templateById('health')!, 'en', { kind: 'global' }, []);
        expect(health.attributes.map((item) => item.events?.[0]?.when)).toEqual([
            { op: '<=', value: 0 },
            { op: '<=', value: 0 },
        ]);
        expect(desStatsAttributes(health).map((item) => item.id)).toEqual(['health', 'stamina']);
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
