// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { constructorSection } from '../../../src/features/mechanics/view-constructor';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { AVATAR, BOOK, createDefsEnv, FakeDefs, FakeTracking, mechanic } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;
let defs: FakeDefs;
let tracking: FakeTracking;
let container: HTMLElement;
let unmount: Unsubscribe | void;

beforeEach(() => {
    env = createDefsEnv();
    defs = new FakeDefs();
    tracking = new FakeTracking();
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(() => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
});

function render(): void {
    unmount = constructorSection(env.deps, defs, tracking)(container);
}

const text = () => container.textContent ?? '';
const notices = () => env.ui.notices.map((notice) => notice.text);

function buttonByText(label: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no button ${label}`);
    return found;
}

function one<T extends Element = HTMLElement>(selector: string, root: ParentNode = container): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
}

function type(node: HTMLInputElement | HTMLTextAreaElement, value: string, event = 'input'): void {
    node.value = value;
    node.dispatchEvent(new Event(event));
}

function choose(node: HTMLSelectElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('change'));
}

/** Lets button handlers and the coalesced redraw run (all in microtasks with the in-memory fakes). */
async function settle(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function click(node: HTMLElement): Promise<void> {
    node.click();
    await settle();
}

describe('list', () => {
    it('starts empty with the template picker', () => {
        render();
        expect(text()).toContain('Mechanics constructor');
        expect(text()).toContain('No mechanics yet — start from a template.');
        expect(buttonByText('From a template')).toBeDefined();
        expect(buttonByText('New mechanic')).toBeDefined();
    });

    it('shows each mechanic with its scope, the chat switch, edit and delete', async () => {
        defs.defs = [
            { ...mechanic(), book: BOOK, uid: 1 },
            { ...mechanic({ id: 'luck', name: 'Удача', scope: { kind: 'card', avatar: AVATAR } }), book: BOOK, uid: 2 },
        ];
        defs.off.add('luck');
        render();
        const cards = [...container.querySelectorAll<HTMLElement>('.maestro-m25-def')];
        expect(cards.map((node) => node.querySelector('.maestro-card-title')?.textContent)).toEqual(['Магия', 'Удача']);
        expect(cards[0]!.textContent).toContain('Every chat');
        expect(cards[1]!.textContent).toContain('This card');
        expect(cards[0]!.textContent).toContain('Attributes: 1 · checks: 1');
        const toggles = cards.map((node) => one<HTMLInputElement>('input[type="checkbox"]', node));
        expect(toggles.map((node) => node.checked)).toEqual([true, false]);
        toggles[1]!.checked = true;
        toggles[1]!.dispatchEvent(new Event('change'));
        await settle();
        expect(defs.switches).toEqual([['luck', true]]);

        env.ui.confirmAnswer = false;
        await click(buttonByText('Delete', container.querySelectorAll('.maestro-m25-def')[0]!));
        expect(defs.removed).toEqual([]);
        expect(env.ui.confirms[0]).toMatchObject({ title: 'Delete the mechanic?' });
        env.ui.confirmAnswer = true;
        await click(buttonByText('Delete', container.querySelectorAll('.maestro-m25-def')[0]!));
        expect(defs.removed).toEqual(['magic']);
        expect(notices()).toContain('Mechanic «Магия» deleted.');
        expect(container.querySelectorAll('.maestro-m25-def')).toHaveLength(1);
    });

    it('disables the chat switch without a chat', () => {
        defs.defs = [mechanic()];
        env.mock.chatId = undefined;
        render();
        expect(text()).toContain('No chat is open');
        expect(one<HTMLInputElement>('.maestro-m25-def input[type="checkbox"]').disabled).toBe(true);
    });
});

describe('templates', () => {
    it('creates a mechanic from a template for this card', async () => {
        defs.defs = [{ ...mechanic({ id: 'magic' }), book: BOOK, uid: 1 }];
        render();
        await click(buttonByText('From a template'));
        const titles = [...container.querySelectorAll('.maestro-m25-template .maestro-card-title')].map(
            (node) => node.textContent,
        );
        expect(titles).toEqual([
            'Health and stamina',
            'Magic',
            'Faction reputation',
            'Money',
            'Skills with checks',
            'Relationships',
            'Survival',
            'Sanity',
            'Inventory and trade',
            'Combat',
            'Social scales',
        ]);
        await click(buttonByText('Close'));
        expect(text()).toContain('Mechanics constructor');
        await click(buttonByText('From a template'));
        await click(buttonByText('Create', container.querySelectorAll('.maestro-m25-template')[1]!));
        expect(text()).toContain('New mechanic');
        expect(one<HTMLInputElement>('.maestro-m25-def-name').value).toBe('Magic');
        expect(one<HTMLInputElement>('.maestro-m25-def-id').value).toBe('magic_2');
        expect(container.querySelectorAll('.maestro-m25-attr')).toHaveLength(3);
        expect(one<HTMLInputElement>('.maestro-m25-dice').value).toBe('1d20+@arcana');
        expect(text()).toContain('Save the mechanic first.');
        await click(buttonByText('Save'));
        expect(defs.saved).toHaveLength(1);
        expect(defs.saved[0]).toMatchObject({
            id: 'magic_2',
            name: 'Magic',
            template: 'magic',
            scope: { kind: 'card', avatar: AVATAR },
            tracking: 'desStats',
        });
        expect(notices()).toContain('Mechanic «Magic» saved.');
        expect(container.querySelectorAll('.maestro-m25-def')).toHaveLength(2);
    });
});

describe('editor', () => {
    async function edit(def: MechanicDef = { ...mechanic(), book: BOOK, uid: 1 }): Promise<void> {
        defs.defs = [def];
        render();
        await click(buttonByText('Edit'));
    }

    it('edits the mechanic and its attributes', async () => {
        await edit();
        expect(text()).toContain('Editing «Магия»');
        expect(one<HTMLInputElement>('.maestro-m25-def-id').disabled).toBe(true);
        type(one<HTMLInputElement>('.maestro-m25-def-name'), 'Тёмная магия');
        type(one<HTMLTextAreaElement>('textarea[aria-label="Rules for the model"]'), 'Blood for power.');
        choose(one<HTMLSelectElement>('select[aria-label="Who has it"]'), 'factions');
        type(one<HTMLInputElement>('.maestro-m25-names'), 'Guild, Crown');
        choose(one<HTMLSelectElement>('select[aria-label="Where it works"]'), 'card');

        // A new attribute: its id follows its name for the model.
        await click(buttonByText('Add attribute'));
        let blocks = container.querySelectorAll<HTMLElement>('.maestro-m25-attr');
        expect(blocks).toHaveLength(2);
        const fresh = blocks[1]!;
        type(one<HTMLInputElement>('.maestro-m25-attr-name', fresh), 'Кровь');
        type(one<HTMLInputElement>('.maestro-m25-attr-prompt', fresh), 'Blood Points');
        expect(one<HTMLInputElement>('.maestro-m25-attr-id', fresh).value).toBe('blood_points');
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]', fresh), 'scale');
        blocks = container.querySelectorAll<HTMLElement>('.maestro-m25-attr');
        const scale = blocks[1]!;
        type(one<HTMLInputElement>('.maestro-m25-levels', scale), 'thin, normal, thick', 'change');
        const initial = one<HTMLSelectElement>(
            'select[aria-label="Start value"]',
            container.querySelectorAll('.maestro-m25-attr')[1]!,
        );
        expect([...initial.options].map((option) => option.value)).toEqual(['thin', 'normal', 'thick']);
        choose(initial, 'normal');

        // An event on the scale.
        await click(buttonByText('Add event', container.querySelectorAll('.maestro-m25-attr')[1]!));
        type(one<HTMLInputElement>('.maestro-m25-event-text'), '{holder} is pale.');

        // Reorder: the new attribute goes first; then the old one is removed.
        await click(one('.maestro-m25-up', container.querySelectorAll('.maestro-m25-attr')[1]!));
        expect(one<HTMLInputElement>('.maestro-m25-attr-name').value).toBe('Кровь');
        // The check uses @mana: removing mana makes the formula invalid — the save is refused.
        await click(one('.maestro-m25-attr-remove', container.querySelectorAll('.maestro-m25-attr')[1]!));
        expect(text()).toContain('the dice use @mana, but there is no such attribute');
        await click(buttonByText('Save'));
        expect(defs.saved).toEqual([]);
        expect(env.ui.notices.at(-1)).toMatchObject({ options: { level: 'warn' } });
        await click(one('.maestro-m25-check-remove'));

        await click(buttonByText('Save'));
        expect(defs.saved).toHaveLength(1);
        const saved = defs.saved[0]!;
        expect(saved).toMatchObject({
            id: 'magic',
            uid: 1,
            name: 'Тёмная магия',
            rules: 'Blood for power.',
            holders: { kind: 'factions', names: ['Guild', 'Crown'] },
            scope: { kind: 'card', avatar: AVATAR },
            checks: [],
        });
        expect(saved.attributes).toEqual([
            {
                id: 'blood_points',
                name: 'Кровь',
                promptName: 'Blood Points',
                kind: 'scale',
                levels: ['thin', 'normal', 'thick'],
                initial: 'normal',
                events: [{ id: 'event', when: { op: '=', value: 'thin' }, text: '{holder} is pale.' }],
            },
        ]);
        expect(text()).toContain('Mechanics constructor');
    });

    it('validates the dice live', async () => {
        await edit();
        const dice = one<HTMLInputElement>('.maestro-m25-dice');
        const verdict = () => one('.maestro-m25-dice-verdict');
        expect(verdict().textContent).toBe('Roll: 1d100<=@mana, success at or under the target');
        type(dice, '1d20 + mod(@mana)');
        expect(verdict().textContent).toBe('Roll: 1d20+mod(@mana), against the difficulty');
        expect(verdict().className).toContain('maestro-m25-dice-ok');
        type(dice, '1d20+@nope');
        expect(verdict().textContent).toContain('@nope, but there is no such attribute');
        expect(verdict().className).toContain('maestro-m25-dice-bad');
        type(dice, 'abc');
        expect(verdict().textContent).toContain('Unknown formula');
        expect(text()).toContain('unknown dice formula');
        type(dice, '2d6+3');
        expect(text()).not.toContain('unknown dice formula');

        type(one<HTMLInputElement>('input[aria-label="Difficulty"]'), '');
        type(one<HTMLInputElement>('.maestro-m25-triggers'), 'убед, persuad, убед');
        await click(buttonByText('Save'));
        expect(defs.saved[0]!.checks[0]).toMatchObject({
            dice: '2d6+3',
            difficulty: null,
            triggers: ['убед', 'persuad'],
        });
    });

    it('adds checks whose ids follow their names, with warnings shown', async () => {
        await edit();
        await click(buttonByText('Add check'));
        const fresh = container.querySelectorAll<HTMLElement>('.maestro-m25-check')[1]!;
        type(one<HTMLInputElement>('.maestro-m25-check-name', fresh), 'Ритуал');
        expect(one<HTMLInputElement>('.maestro-m25-check-id', fresh).value).toBe('ritual');
        expect(text()).toContain('«Ритуал»: no trigger words — it is rolled only by the button.');
        type(one<HTMLInputElement>('.maestro-m25-check-id', fresh), 'rite');
        type(one<HTMLInputElement>('.maestro-m25-check-name', fresh), 'Обряд');
        expect(one<HTMLInputElement>('.maestro-m25-check-id', fresh).value).toBe('rite');
        await click(buttonByText('Save'));
        expect(defs.saved[0]!.checks.map((check) => check.id)).toEqual(['spell', 'rite']);
    });

    it('makes DES stats of a saved mechanic', async () => {
        await edit();
        expect(text()).toContain('DES stats');
        expect(one('.maestro-m25-des-status').textContent).toContain('not in DES');
        await click(buttonByText('Make them DES stats'));
        expect(tracking.enabled.map((def) => def.id)).toEqual(['magic']);
        expect(notices()).toContain('The stats were added to DES.');
        expect(one('.maestro-m25-des-status').textContent).toContain('in DES');
        expect(one<HTMLButtonElement>('.maestro-m25-des').disabled).toBe(true);

        tracking.inDes.clear();
        tracking.result = false;
        await click(buttonByText('Cancel'));
        await click(buttonByText('Edit'));
        await click(buttonByText('Make them DES stats'));
        expect(env.ui.notices.at(-1)).toMatchObject({
            text: 'DES stats were not changed.',
            options: { level: 'warn' },
        });

        // No DES block when nothing is tracked as DES stats.
        choose(one<HTMLSelectElement>('select[aria-label="Tracking"]'), 'manual');
        expect(container.querySelector('.maestro-m25-des')).toBeNull();
    });

    it('starts a blank mechanic whose id follows its name and refuses an empty one', async () => {
        render();
        await click(buttonByText('New mechanic'));
        const id = one<HTMLInputElement>('.maestro-m25-def-id');
        expect(id.disabled).toBe(false);
        type(one<HTMLInputElement>('.maestro-m25-def-name'), 'Удача');
        expect(id.value).toBe('udacha');
        await click(buttonByText('Save'));
        expect(defs.saved).toEqual([]);
        expect(notices().at(-1)).toBe('The mechanic cannot be saved: add attributes, checks or at least rules.');
        type(one<HTMLTextAreaElement>('textarea[aria-label="Rules for the model"]'), 'Luck decides.');
        await click(buttonByText('Save'));
        expect(defs.saved[0]).toMatchObject({ id: 'udacha', name: 'Удача', rules: 'Luck decides.' });
    });

    it('reports save errors and keeps the editor; changes elsewhere do not redraw it', async () => {
        await edit();
        type(one<HTMLInputElement>('.maestro-m25-def-name'), 'Новое имя');
        defs.emit();
        await settle();
        expect(one<HTMLInputElement>('.maestro-m25-def-name').value).toBe('Новое имя');
        defs.failSave = new Error('disk is full');
        await click(buttonByText('Save'));
        expect(notices()).toContain('disk is full');
        expect(text()).toContain('Editing');
        await click(buttonByText('Cancel'));
        expect(text()).toContain('Mechanics constructor');
    });

    it('edits numbers, lists, texts and events of every kind', async () => {
        await edit({
            ...mechanic({ checks: [] }),
            book: BOOK,
            uid: 1,
        });
        const block = () => container.querySelectorAll<HTMLElement>('.maestro-m25-attr')[0]!;
        type(one<HTMLInputElement>('input[aria-label="Minimum"]', block()), '');
        type(one<HTMLInputElement>('input[aria-label="Maximum"]', block()), '50');
        type(one<HTMLInputElement>('input[aria-label="Start value"]', block()), '20');
        await click(buttonByText('Add event', block()));
        type(one<HTMLInputElement>('input[aria-label="Value"]', block()), '5');
        choose(one<HTMLSelectElement>('select[aria-label="When the value"]', block()), '>=');
        type(one<HTMLInputElement>('.maestro-m25-event-text', block()), 'Full.');
        const once = [...block().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
        once.checked = false;
        once.dispatchEvent(new Event('change'));
        const visible = one<HTMLInputElement>('input[type="checkbox"]', block());
        visible.checked = false;
        visible.dispatchEvent(new Event('change'));
        choose(one<HTMLSelectElement>('select[aria-label="Tracking"]', block()), 'block');

        await click(buttonByText('Add attribute'));
        const list = () => container.querySelectorAll<HTMLElement>('.maestro-m25-attr')[1]!;
        type(one<HTMLInputElement>('.maestro-m25-attr-name', list()), 'Школы');
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]', list()), 'list');
        type(one<HTMLInputElement>('.maestro-m25-options', list()), 'fire, water', 'change');
        const multi = one<HTMLInputElement>('input[type="checkbox"]', list());
        multi.checked = true;
        multi.dispatchEvent(new Event('change'));
        type(one<HTMLInputElement>('.maestro-m25-initial', list()), 'fire, water');
        await click(buttonByText('Add event', list()));
        choose(one<HTMLSelectElement>('select[aria-label="When the value"]', list()), '=');
        type(one<HTMLInputElement>('input[aria-label="Value"]', list()), 'water');
        type(one<HTMLInputElement>('.maestro-m25-event-text', list()), 'Wet.');

        await click(buttonByText('Add attribute'));
        const note = () => container.querySelectorAll<HTMLElement>('.maestro-m25-attr')[2]!;
        type(one<HTMLInputElement>('.maestro-m25-attr-name', note()), 'Заметка');
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]', note()), 'text');
        type(one<HTMLTextAreaElement>('textarea[aria-label="Start value"]', note()), 'Calm.');
        await click(buttonByText('Add event', note()));
        await click(one('.maestro-m25-event-remove', note()));
        await click(one('.maestro-m25-down', container.querySelectorAll('.maestro-m25-attr')[0]!));

        choose(one<HTMLSelectElement>('select[aria-label="Who has it"]'), 'characters');
        const persona = [...container.querySelectorAll<HTMLLabelElement>('label')].find((node) =>
            node.textContent?.includes('Your character too'),
        )!;
        const personaBox = one<HTMLInputElement>('input', persona);
        personaBox.checked = false;
        personaBox.dispatchEvent(new Event('change'));
        choose(one<HTMLSelectElement>('select[aria-label="Where it works"]'), 'chat');
        choose(one<HTMLSelectElement>('select[aria-label="Tracking"]'), 'background');

        await click(buttonByText('Save'));
        const saved = defs.saved[0]!;
        expect(saved.holders).toEqual({ kind: 'characters' });
        expect(saved.scope).toEqual({ kind: 'chat', chatId: env.mock.chatId });
        expect(saved.tracking).toBe('background');
        expect(saved.attributes).toEqual([
            {
                id: 'shkoly',
                name: 'Школы',
                promptName: 'Школы',
                kind: 'list',
                options: ['fire', 'water'],
                multi: true,
                initial: ['fire', 'water'],
                events: [{ id: 'event', when: { op: '=', value: 'water' }, text: 'Wet.' }],
            },
            {
                id: 'mana',
                name: 'Мана',
                promptName: 'Mana',
                kind: 'number',
                max: 50,
                initial: 20,
                tracking: 'block',
                visible: false,
                events: [{ id: 'event', when: { op: '>=', value: 5 }, text: 'Full.', once: false }],
            },
            { id: 'zametka', name: 'Заметка', promptName: 'Заметка', kind: 'text', initial: 'Calm.' },
        ]);
    });

    it('unmounts cleanly', async () => {
        render();
        expect(defs.listenerCount()).toBe(1);
        (unmount as Unsubscribe)();
        unmount = undefined;
        expect(defs.listenerCount()).toBe(0);
        expect(container.children).toHaveLength(0);
    });
});
