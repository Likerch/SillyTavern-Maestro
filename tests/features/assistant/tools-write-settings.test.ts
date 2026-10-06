// setting_set, module_toggle and autonomy_set (M33 part C): the core's allowlist, the module manager, autonomy levels;
// before/after in the user's language, journal records and undo.
import { describe, expect, it } from 'vitest';
import { fakeSettings } from './tools-helpers';
import { planError, writeFake } from './tools-write-fakes';

const MODULES = [
    { key: 'director', id: 'M13', stage: 8, titleKey: 'm13.title', enabled: true },
    { key: 'calendar', id: 'M17', stage: 9, titleKey: 'm17.title', enabled: false },
    { key: 'sheets', id: 'M31', stage: 12, titleKey: 'm31.title', enabled: false, missing: ['st.bunnymo'] },
    { key: 'assistant', id: 'M33', stage: 13, titleKey: 'm33.title', enabled: true },
];

/** Module titles come from the app's i18n (the app's language, the same as the conversation's in practice). */
function moduleFake(locale: 'en' | 'ru' = 'en') {
    return writeFake({
        locale,
        modules: MODULES.map((row) => ({ ...row })),
        strings: { en: { 'm13.title': 'Director', 'm17.title': 'Calendar' }, ru: { 'm13.title': 'Режиссёр' } },
    });
}

describe('setting_set', () => {
    it('hands the change to the core allowlist and returns its plan', async () => {
        const fake = writeFake();
        const access = fakeSettings(
            { director: { every: 4, profileId: 'secret' } },
            { allowed: { director: ['every'] } },
        );
        const tool = fake.tools.find((item) => item.name === 'setting_set')!;
        const plan = await tool.plan!({ module: 'director', path: 'every', value: 6 }, fake.ctx('en', access));
        expect(access.planned).toEqual([{ moduleKey: 'director', path: 'every', value: 6 }]);
        expect(plan.before).toBe(4);
        expect(plan.after).toBe(6);
        await plan.apply();
        expect(access.data.director!.every).toBe(6);
    });

    it('lets the core refuse what is not allowlisted', async () => {
        const fake = writeFake();
        const access = fakeSettings({ director: { profileId: 'x' } }, { allowed: { director: ['every'] } });
        const tool = fake.tools.find((item) => item.name === 'setting_set')!;
        await expect(
            tool.plan!({ module: 'director', path: 'profileId', value: 'y' }, fake.ctx('en', access)),
        ).rejects.toThrow(/Not allowed/);
        expect(access.planned).toEqual([]);
    });

    it('asks for the value in the user language', async () => {
        const fake = writeFake();
        const tool = fake.tools.find((item) => item.name === 'setting_set')!;
        const message = await planError(tool.plan!({ module: 'director', path: 'every' }, fake.ctx('ru')));
        expect(message).toBe('Не хватает параметра «value».');
        expect(await planError(tool.plan!({ path: 'every', value: 1 }, fake.ctx('en')))).toBe(
            'The parameter «module» is missing.',
        );
    });
});

describe('module_toggle', () => {
    it('plans a switch with before/after in the user language and applies it through the module manager', async () => {
        const fake = moduleFake('ru');
        const plan = await fake.plan('module_toggle', { module: 'M13', on: false }, 'ru');
        expect(plan.summary).toBe('Режиссёр (M13): выключить');
        expect(plan.target).toBe('Maestro · модули');
        expect(plan.before).toBe('вкл');
        expect(plan.after).toBe('выкл');
        expect(fake.modules.find((row) => row.key === 'director')!.enabled).toBe(true);
        const { result } = await plan.apply();
        expect(result).toEqual({ module: 'director', enabled: false, running: false });
        expect(fake.modules.find((row) => row.key === 'director')!.enabled).toBe(false);
        const record = fake.undoJournal.records[0]!;
        expect(record.module).toBe('M33');
        expect(record.kind).toBe('assistant.module');
        expect(record.summary).toBe('Выключил модуль «Режиссёр»');
        expect(record.changes[0]).toEqual({
            target: 'assistant-module',
            ref: { key: 'director' },
            before: true,
            after: false,
        });
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect(fake.modules.find((row) => row.key === 'director')!.enabled).toBe(true);
    });

    it('switches a module on by key', async () => {
        const fake = moduleFake();
        const plan = await fake.plan('module_toggle', { module: 'calendar', on: true });
        expect(plan.summary).toBe('Calendar (M17): switch on');
        await plan.apply();
        expect(fake.modules.find((row) => row.key === 'calendar')!.enabled).toBe(true);
    });

    it('never switches the assistant itself', async () => {
        const fake = moduleFake();
        expect(await planError(fake.plan('module_toggle', { module: 'assistant', on: false }, 'ru'))).toBe(
            'Свой модуль ассистент не переключает.',
        );
        expect(await planError(fake.plan('module_toggle', { module: 'm33', on: false }))).toMatch(/own module/);
    });

    it('refuses unknown modules, no-op switches and modules that cannot start', async () => {
        const fake = moduleFake();
        expect(await planError(fake.plan('module_toggle', { module: 'nope', on: true }))).toBe(
            'There is no module «nope». Modules: director, calendar, sheets, assistant.',
        );
        expect(await planError(fake.plan('module_toggle', { module: 'director', on: true }, 'ru'))).toBe(
            '«Director» и так включён.',
        );
        expect(await planError(fake.plan('module_toggle', { module: 'sheets', on: true }))).toBe(
            '«sheets» cannot start: this SillyTavern lacks st.bunnymo.',
        );
        expect(await planError(fake.plan('module_toggle', { module: 'director', on: 'maybe' }))).toBe(
            '«on» must be true or false.',
        );
    });

    it('does not undo a switch the user changed since', async () => {
        const fake = moduleFake();
        await (await fake.plan('module_toggle', { module: 'director', on: false })).apply();
        fake.modules.find((row) => row.key === 'director')!.enabled = true;
        expect(await fake.undoJournal.undoLast()).toBe(false);
    });
});

describe('autonomy_set', () => {
    it('sets a level through setLevel, journals it and undoes it back to the module default', async () => {
        const fake = writeFake({
            modules: MODULES.map((row) => ({ ...row })),
            locale: 'ru',
            strings: { ru: { 'kind.canon.fact': 'Факты канона' } },
        });
        fake.autonomy.stats.push('canon.fact');
        const plan = await fake.plan('autonomy_set', { kind: 'canon.fact', level: 'auto' }, 'ru');
        expect(plan.summary).toBe('Автономия «canon.fact»: Как задано в модуле → Само');
        expect(plan.target).toBe('Maestro · автономия');
        expect(plan.before).toBe('Как задано в модуле');
        expect(plan.after).toBe('Само');
        await plan.apply();
        expect(fake.autonomy.setLevelCalls).toEqual([{ kind: 'canon.fact', level: 'auto' }]);
        expect(fake.core.autonomy['canon.fact']).toBe('auto');
        // The journal names the kind by its label; the raw kind stays in ref.
        expect(fake.undoJournal.records[0]!.summary).toBe('Поставил «Само» для «Факты канона»');
        expect(fake.undoJournal.records[0]!.changes[0]).toEqual({
            target: 'assistant-autonomy',
            ref: { kind: 'canon.fact' },
            before: null,
            after: 'auto',
        });
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect('canon.fact' in fake.core.autonomy).toBe(false);
        expect(fake.saves).toBeGreaterThan(0);
    });

    it('puts a level back to the module default and undo restores the stored one', async () => {
        const fake = writeFake();
        fake.core.autonomy['doctor.regexFix'] = 'ask';
        const plan = await fake.plan('autonomy_set', { kind: 'doctor.regexFix', level: 'default' });
        expect(plan.before).toBe('Ask');
        expect(plan.after).toBe('Module default');
        await plan.apply();
        expect(fake.undoJournal.records[0]!.summary).toBe('Set «Module default» for one kind of actions');
        expect('doctor.regexFix' in fake.core.autonomy).toBe(false);
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect(fake.core.autonomy['doctor.regexFix']).toBe('ask');
    });

    it('refuses auto for never-auto kinds, unknown kinds and no-op changes', async () => {
        const fake = writeFake({ modules: MODULES.map((row) => ({ ...row })) });
        fake.autonomy.stats.push('doctor.presetRegexFix');
        fake.autonomy.neverAuto.add('doctor.presetRegexFix');
        expect(await planError(fake.plan('autonomy_set', { kind: 'doctor.presetRegexFix', level: 'auto' }, 'ru'))).toBe(
            '«doctor.presetRegexFix» никогда не делается само.',
        );
        expect(await planError(fake.plan('autonomy_set', { kind: 'made.up', level: 'ask' }))).toBe(
            'Unknown kind of actions «made.up». Known kinds: doctor.presetRegexFix.',
        );
        fake.core.autonomy['doctor.presetRegexFix'] = 'ask';
        expect(await planError(fake.plan('autonomy_set', { kind: 'doctor.presetRegexFix', level: 'ask' }))).toBe(
            '«doctor.presetRegexFix» already has «Ask».',
        );
        expect(await planError(fake.plan('autonomy_set', { kind: 'canon.fact', level: 'sometimes' }))).toMatch(
            /must be one of: auto, notify, inbox, ask, off, default/,
        );
    });

    it('accepts a kind of a known module that has not come up yet, and says so', async () => {
        const fake = writeFake({ modules: MODULES.map((row) => ({ ...row })) });
        const plan = await fake.plan('autonomy_set', { kind: 'director.twist', level: 'inbox' });
        expect(plan.after).toBe('Inbox (This kind of actions has not come up yet.)');
    });

    it('does not undo a level changed since', async () => {
        const fake = writeFake();
        fake.autonomy.stats.push('canon.fact');
        await (await fake.plan('autonomy_set', { kind: 'canon.fact', level: 'notify' })).apply();
        fake.core.autonomy['canon.fact'] = 'off';
        expect(await fake.undoJournal.undoLast()).toBe(false);
        expect(fake.core.autonomy['canon.fact']).toBe('off');
    });
});
