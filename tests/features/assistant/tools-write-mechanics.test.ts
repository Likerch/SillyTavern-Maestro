// mechanic_save and mechanic_toggle_chat (M33 part C over M25): templates with overrides, new definitions, changes
// merged by id, the constructor's validation in the user's language, the per-chat switch with journal and undo.
import { describe, expect, it } from 'vitest';
import { MECHANIC_TEMPLATES } from '../../../src/domain/mechanics-templates';
import { DEF_STRINGS } from '../../../src/features/mechanics/strings-defs';
import { fakeMechanics, healthDef, planError, writeFake } from './tools-write-fakes';

function setup(options: { locale?: 'en' | 'ru'; chatId?: string | null; card?: boolean } = {}) {
    const mechanics = fakeMechanics([healthDef()], [...MECHANIC_TEMPLATES]);
    const fake = writeFake({
        apis: { mechanics },
        locale: options.locale ?? 'en',
        strings: DEF_STRINGS,
        chatId: options.chatId === undefined ? 'chat-1' : options.chatId,
        ctx: options.card === false ? {} : { characters: [{ name: 'Kai', avatar: 'kai.png' }], characterId: 0 },
    });
    return { fake, mechanics };
}

describe('mechanic_save', () => {
    it('makes a mechanic from a template with overrides merged by id and saves it through the mechanics API', async () => {
        const { fake, mechanics } = setup({ locale: 'ru' });
        const plan = await fake.plan(
            'mechanic_save',
            {
                template: 'magic',
                overrides: {
                    attributes: [
                        { id: 'mana', max: 50, initial: 50 },
                        { id: 'schools', remove: true },
                    ],
                    rules: 'Mana is scarce.',
                },
            },
            'ru',
        );
        expect(plan.summary).toBe('Новая механика «Magic»: атрибутов — 1, проверок — 1, действует у этого персонажа');
        expect(plan.target).toBe('Механики · «Magic»');
        expect(plan.before).toBeNull();
        const after = plan.after as Record<string, unknown>;
        expect(after.attributes).toEqual([
            'Mana (mana): number 0–50, starts at 50; at <= 0: {holder} has no mana left and cannot cast.',
        ]);
        expect(after.rules).toBe('Mana is scarce.');
        expect(after.scope).toBe('card');
        expect(mechanics.saved).toEqual([]);
        const { result } = await plan.apply();
        expect(mechanics.saved).toHaveLength(1);
        expect(mechanics.saved[0]!.id).toBe('magic');
        expect(mechanics.saved[0]!.attributes.map((item) => item.id)).toEqual(['mana']);
        expect(mechanics.saved[0]!.scope).toEqual({ kind: 'card', avatar: 'kai.png' });
        expect(result).toEqual({ id: 'magic', name: 'Magic', book: 'Maestro Mechanics', uid: 7 });
    });

    it('creates a new definition with a readable id and this character as the scope', async () => {
        const { fake, mechanics } = setup();
        const plan = await fake.plan('mechanic_save', {
            definition: {
                name: 'Stamina Points',
                summary: 'How tired a character is.',
                attributes: [{ id: 'sp', name: 'SP', promptName: 'Stamina', kind: 'number', min: 0, max: 10 }],
            },
        });
        expect(plan.summary).toBe('New mechanic «Stamina Points»: 1 attributes, 0 checks, for this character');
        await plan.apply();
        expect(mechanics.saved[0]!.id).toBe('stamina_points');
        expect(mechanics.saved[0]!.scope).toEqual({ kind: 'card', avatar: 'kai.png' });
    });

    it('changes an existing mechanic in place: only the given fields, attributes merged by id', async () => {
        const { fake, mechanics } = setup();
        const plan = await fake.plan('mechanic_save', {
            definition: { id: 'health', rules: 'At 0 the holder dies.', attributes: [{ id: 'hp', max: 150 }] },
        });
        expect(plan.summary).toBe('Mechanic «Здоровье»: changes');
        expect((plan.before as Record<string, unknown>).rules).toBe('At 0 the holder falls unconscious.');
        expect((plan.after as Record<string, unknown>).rules).toBe('At 0 the holder dies.');
        await plan.apply();
        const saved = mechanics.saved[0]!;
        expect(saved.book).toBe('Maestro Mechanics');
        expect(saved.uid).toBe(3);
        expect(saved.attributes[0]).toMatchObject({ id: 'hp', min: 0, max: 150, initial: 100 });
        expect(saved.scope).toEqual({ kind: 'global' });
    });

    it('takes an explicit scope and refuses one that is impossible here', async () => {
        const { fake } = setup({ card: false });
        const plan = await fake.plan('mechanic_save', { template: 'money', scope: 'chat' });
        expect((plan.after as Record<string, unknown>).scope).toBe('chat');
        expect(await planError(fake.plan('mechanic_save', { template: 'money', scope: 'card' }))).toBe(
            'The scope «card» is not possible here (no single character or no chat).',
        );
    });

    it('validates with the constructor rules and reports errors in the user language', async () => {
        const { fake } = setup({ locale: 'ru' });
        const message = await planError(
            fake.plan(
                'mechanic_save',
                {
                    definition: {
                        name: 'Сломанная',
                        attributes: [{ id: 'hp', name: 'HP', promptName: 'HP', kind: 'number', min: 10, max: 1 }],
                    },
                },
                'ru',
            ),
        );
        expect(message).toBe('Механику нельзя сохранить: «HP»: минимум больше максимума.');
    });

    it('shows warnings of the definition in the card', async () => {
        const { fake } = setup();
        const plan = await fake.plan('mechanic_save', {
            definition: { name: 'Bare', attributes: [{ id: 'x', name: 'X', promptName: 'X', kind: 'text' }] },
        });
        expect((plan.after as Record<string, unknown>).warnings).toEqual([
            'no rules for the model: it will only see names and values.',
        ]);
    });

    it('refuses unknown templates, both sources at once, and non-definitions', async () => {
        const { fake } = setup();
        expect(await planError(fake.plan('mechanic_save', { template: 'nope' }))).toBe(
            'There is no template «nope». Templates: health, magic, reputation, money, skills, relationships.',
        );
        expect(await planError(fake.plan('mechanic_save', { template: 'magic', definition: {} }))).toBe(
            'Give either «definition» or «template», not both.',
        );
        expect(await planError(fake.plan('mechanic_save', {}))).toBe('Give «definition» or «template».');
        expect(await planError(fake.plan('mechanic_save', { definition: 'not json' }))).toBe(
            '«definition» must be a JSON object.',
        );
    });

    it('accepts a definition sent as a JSON string', async () => {
        const { fake } = setup();
        const plan = await fake.plan('mechanic_save', {
            definition: JSON.stringify({ name: 'Luck', rules: 'Luck changes fate.' }),
        });
        expect(plan.summary).toContain('«Luck»');
    });

    it('is offered only with the mechanics module', () => {
        const fake = writeFake();
        const tool = fake.tools.find((item) => item.name === 'mechanic_save')!;
        expect(tool.available?.(fake.app)).toBe(false);
        expect(
            setup()
                .fake.tools.find((item) => item.name === 'mechanic_save')!
                .available?.(setup().fake.app),
        ).toBe(true);
    });
});

describe('mechanic_toggle_chat', () => {
    it('switches a mechanic off in this chat, journals it and undoes it', async () => {
        const { fake, mechanics } = setup({ locale: 'ru' });
        const plan = await fake.plan('mechanic_toggle_chat', { id: 'Здоровье', on: false }, 'ru');
        expect(plan.summary).toBe('Механика «Здоровье» в этом чате: выключить');
        expect(plan.target).toBe('Механики · этот чат');
        expect(plan.before).toBe('вкл');
        expect(plan.after).toBe('выкл');
        await plan.apply();
        expect(mechanics.chatCalls).toEqual([{ id: 'health', on: false }]);
        expect(fake.undoJournal.records[0]!.changes[0]).toEqual({
            target: 'assistant-mechanic-chat',
            ref: { chatId: 'chat-1', id: 'health' },
            before: true,
            after: false,
        });
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect(mechanics.chatCalls).toEqual([
            { id: 'health', on: false },
            { id: 'health', on: true },
        ]);
    });

    it('refuses without a chat, for unknown ids and when nothing changes', async () => {
        expect(
            await planError(setup({ chatId: null }).fake.plan('mechanic_toggle_chat', { id: 'health', on: false })),
        ).toBe('Open a chat first.');
        const { fake } = setup({ locale: 'ru' });
        expect(await planError(fake.plan('mechanic_toggle_chat', { id: 'mana', on: true }, 'ru'))).toBe(
            'Здесь нет механики «mana». Есть: health.',
        );
        expect(await planError(fake.plan('mechanic_toggle_chat', { id: 'health', on: true }, 'ru'))).toBe(
            '«Здоровье» и так включена в этом чате.',
        );
    });

    it('does not undo when the switch changed since', async () => {
        const { fake, mechanics } = setup();
        await (await fake.plan('mechanic_toggle_chat', { id: 'health', on: false })).apply();
        mechanics.off.delete('health');
        expect(await fake.undoJournal.undoLast()).toBe(false);
    });
});
