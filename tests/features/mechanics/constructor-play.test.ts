// @vitest-environment happy-dom
// M25 constructor of plan-2 §6 п.8 and §6.А: ids made from names and kept under «Подробнее», «Где видно» presets and
// places, the rules in the user's words with the English for the model (at once or by the background task, with a
// fake LLM), a file out and back in, a copy, resetting the state, «Описать словами», the live preview, editors of
// consequences, conditions and time rules, and a kind change that keeps the events (asking before dropping any).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceHash } from '../../../src/domain/mechanics-view';
import type { MechanicDef, MechanicsApi } from '../../../src/features/mechanics/api';
import { MECHANICS_STRINGS } from '../../../src/features/mechanics/strings';
import { MechanicTranslator, TRANSLATE_TASK, parseTranslation } from '../../../src/features/mechanics/translate';
import { constructorSection } from '../../../src/features/mechanics/view-constructor';
import type { ConstructorExtras } from '../../../src/features/mechanics/view-constructor';
import type { App, LlmRequest, Unsubscribe } from '../../../src/shared/contracts';
import { FakeTasks } from '../../helpers/rules-app';
import { BOOK, createDefsEnv, FakeDefs, FakeTracking, mechanic } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;
let defs: FakeDefs;
let container: HTMLElement;
let unmount: Unsubscribe | void;
let requests: LlmRequest[];
let fileText = '';

beforeEach(() => {
    env = createDefsEnv();
    env.app.i18n.register(MECHANICS_STRINGS);
    defs = new FakeDefs();
    requests = [];
    // The cheap model translates every item as «EN <text>».
    (env.app as { llm: App['llm'] }).llm = {
        available: () => true,
        request: async <T>(request: LlmRequest) => {
            requests.push(request);
            const asked = JSON.parse(request.messages[1]!.content) as { items: { key: string; text: string }[] };
            return {
                ok: true,
                data: { items: asked.items.map((item) => ({ key: item.key, text: `EN ${item.text}` })) } as T,
            };
        },
    };
    (env.app as { cost: App['cost'] }).cost = { backgroundCapReached: () => false } as unknown as App['cost'];
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(() => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    vi.unstubAllGlobals();
});

function render(extras: ConstructorExtras = {}): void {
    unmount = constructorSection(env.deps, defs, new FakeTracking(), extras, async () => fileText)(container);
}

async function settle(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function one<T extends Element = HTMLElement>(selector: string, root: ParentNode = container): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
}

function buttonByText(label: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label || node.title === label,
    );
    if (!found) throw new Error(`no button ${label}`);
    return found;
}

async function click(node: HTMLElement): Promise<void> {
    node.click();
    await settle();
}

function type(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('input'));
}

function choose(node: HTMLSelectElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('change'));
}

function check(node: HTMLInputElement, value: boolean): void {
    node.checked = value;
    node.dispatchEvent(new Event('change'));
}

function toggleByLabel(label: string, root: ParentNode = container): HTMLInputElement {
    const found = [...root.querySelectorAll<HTMLLabelElement>('label')].find(
        (node) => node.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no toggle ${label}`);
    return one<HTMLInputElement>('input', found);
}

async function edit(def: MechanicDef = { ...mechanic(), book: BOOK, uid: 1 }, extras: ConstructorExtras = {}) {
    defs.defs = [def];
    render(extras);
    await click(buttonByText('Edit'));
}

describe('ids and words', () => {
    it('makes ids from names and keeps them under «Подробнее»', async () => {
        render();
        await click(buttonByText('New mechanic'));
        const id = one<HTMLInputElement>('.maestro-m25-def-id');
        expect(id.closest('details')?.open).toBe(false);
        type(one<HTMLInputElement>('.maestro-m25-def-name'), 'Удача');
        expect(id.value).toBe('udacha');
        await click(buttonByText('Add attribute'));
        type(one<HTMLInputElement>('.maestro-m25-attr-name'), 'Кровь');
        const attrId = one<HTMLInputElement>('.maestro-m25-attr-id');
        expect(attrId.value).toBe('krov');
        expect(attrId.closest('details')?.open).toBe(false);
        // The main text never names an id.
        const visible = [...container.querySelectorAll('.maestro-section-body > .maestro-field .maestro-field-label')]
            .map((node) => node.textContent)
            .join(' ');
        expect(visible).not.toContain('Id');
    });
});

describe('where it is seen', () => {
    it('saves a preset of the mechanic, an attribute’s own set and places, and the narrator switch', async () => {
        await edit();
        const mechanicPresets = one('.maestro-m25-visibility[data-visibility="mechanic"]');
        await click(one('.maestro-m25-preset-book', mechanicPresets));
        const attribute = one('.maestro-m25-visibility[data-visibility="mana"]');
        await click(one('.maestro-m25-preset-hidden', attribute));
        check(toggleByLabel('Status block', one('.maestro-m25-visibility[data-visibility="mana"]')), true);
        check(toggleByLabel('The model reads the narrator messages of this mechanic too'), true);
        await click(buttonByText('Save'));
        const saved = defs.saved.at(-1)!;
        expect(saved.visibility).toEqual({ preset: 'book' });
        expect(saved.attributes[0]?.visibility).toEqual({ preset: 'hidden', places: { statusBlock: true } });
        expect(saved.narratorToModel).toBe(true);
    });

    it('goes back to the mechanic’s set and drops the old «visible» switch', async () => {
        await edit({
            ...mechanic({
                attributes: [{ id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', visible: false }],
            }),
            book: BOOK,
            uid: 1,
        });
        const attribute = one('.maestro-m25-visibility[data-visibility="mana"]');
        expect(one('.maestro-m25-preset-secret', attribute).className).toContain('maestro-btn-primary');
        await click(one('.maestro-m25-preset-inherit', attribute));
        await click(buttonByText('Save'));
        expect(defs.saved.at(-1)!.attributes[0]).not.toHaveProperty('visible');
        expect(defs.saved.at(-1)!.attributes[0]).not.toHaveProperty('visibility');
    });
});

describe('rules in his words', () => {
    it('translates at once, shows the English and saves it', async () => {
        const translator = new MechanicTranslator(env.deps, defs);
        await edit({ ...mechanic({ promptName: 'Magic' }), book: BOOK, uid: 1 }, { translator });
        // Older English rules became his words: nothing waits for a translation yet.
        expect(one<HTMLTextAreaElement>('.maestro-m25-rules-source').value).toBe('Casting costs mana.');
        expect(container.textContent).toContain('The English for the model is ready.');
        type(one<HTMLTextAreaElement>('.maestro-m25-rules-source'), 'Каждое заклинание стоит маны.');
        expect(one('.maestro-m25-translation').textContent).toContain('Waits for the English');
        await click(buttonByText('Translate now'));
        expect(requests[0]?.task).toBe(TRANSLATE_TASK);
        expect(one<HTMLTextAreaElement>('.maestro-m25-rules-en').value).toBe('EN Каждое заклинание стоит маны.');
        await click(buttonByText('Save'));
        const saved = defs.saved.at(-1)!;
        expect(saved.rules).toBe('EN Каждое заклинание стоит маны.');
        expect(saved.rulesSource).toBe('Каждое заклинание стоит маны.');
        expect(saved.translatedFrom?.rules).toBe(sourceHash('Каждое заклинание стоит маны.'));
        expect((env.app.tasks as FakeTasks).queued).toEqual([]);
    });

    it('saves his words for the model until the background task brings the English', async () => {
        const translator = new MechanicTranslator(env.deps, defs);
        translator.install();
        await edit({ ...mechanic({ promptName: 'Magic' }), book: BOOK, uid: 1 }, { translator });
        type(one<HTMLTextAreaElement>('.maestro-m25-rules-source'), 'Без маны заклинание срывается.');
        type(one<HTMLTextAreaElement>('.maestro-m25-summary-source'), 'Магия на мане.');
        await click(buttonByText('Save'));
        expect(defs.saved.at(-1)).toMatchObject({
            rules: 'Без маны заклинание срывается.',
            summary: 'Магия на мане.',
        });
        const tasks = env.app.tasks as FakeTasks;
        expect(tasks.queued.at(-1)).toMatchObject({ kind: TRANSLATE_TASK, payload: { mechanicId: 'magic' } });
        await tasks.runLatest(TRANSLATE_TASK);
        expect(defs.saved.at(-1)).toMatchObject({
            rules: 'EN Без маны заклинание срывается.',
            summary: 'EN Магия на мане.',
            rulesSource: 'Без маны заклинание срывается.',
        });
        // Done: nothing waits any more.
        expect(await translator.enqueue('magic')).toBe(false);
        translator.dispose();
    });

    it('reads tolerant answers', () => {
        expect(parseTranslation('noise {"items":[{"key":"rules","text":" X "}]} tail')).toEqual([
            { key: 'rules', text: 'X' },
        ]);
        expect(parseTranslation([{ key: 'a', text: 'b' }, { key: 1 }])).toEqual([{ key: 'a', text: 'b' }]);
        expect(parseTranslation('broken')).toBeNull();
        expect(parseTranslation(42)).toBeNull();
    });
});

describe('files, copies and resets', () => {
    it('saves a mechanic to a file and reads it back as a new one', async () => {
        let blob: Blob | null = null;
        const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((value: Blob | MediaSource) => {
            blob = value as Blob;
            return 'blob:x';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        defs.defs = [{ ...mechanic({ visibility: { preset: 'book' } }), book: BOOK, uid: 1 }];
        render();
        await click(buttonByText('To a file'));
        expect(blob).not.toBeNull();
        fileText = await blob!.text();
        expect(JSON.parse(fileText)).toMatchObject({ kind: 'maestro.mechanic', mechanic: { id: 'magic' } });

        const input = one<HTMLInputElement>('.maestro-m25-import-input');
        Object.defineProperty(input, 'files', { value: [new File([fileText], 'm.json')], configurable: true });
        input.dispatchEvent(new Event('change'));
        await settle();
        expect(env.ui.notices.at(-1)?.text).toContain('is read from the file');
        await click(buttonByText('Save'));
        const imported = defs.saved.at(-1)!;
        expect(imported.id).not.toBe('magic');
        expect(imported.attributes).toEqual(mechanic().attributes);
        expect(imported.visibility).toEqual({ preset: 'book' });

        fileText = '{"kind":"other"}';
        Object.defineProperty(input, 'files', { value: [new File([fileText], 'm.json')], configurable: true });
        one<HTMLInputElement>('.maestro-m25-import-input').dispatchEvent(new Event('change'));
        await settle();
        create.mockRestore();
        revoke.mockRestore();
    });

    it('refuses a file that is not a mechanic', async () => {
        render();
        fileText = 'not json';
        const input = one<HTMLInputElement>('.maestro-m25-import-input');
        Object.defineProperty(input, 'files', { value: [new File([fileText], 'm.json')], configurable: true });
        input.dispatchEvent(new Event('change'));
        await settle();
        expect(env.ui.notices.at(-1)).toMatchObject({ text: 'This file is not JSON.' });
    });

    it('copies a mechanic under a new name and resets its state after asking', async () => {
        const reset = vi.fn(async () => 3);
        defs.defs = [{ ...mechanic(), book: BOOK, uid: 1 }];
        render({ api: { reset } as unknown as MechanicsApi });
        await click(buttonByText('Copy'));
        expect(one<HTMLInputElement>('.maestro-m25-def-name').value).toBe('Магия (copy)');
        await click(buttonByText('Save'));
        expect(defs.saved.at(-1)).toMatchObject({ name: 'Магия (copy)', id: 'magiya_copy' });
        expect(defs.defs.map((def) => def.id)).toEqual(['magic', 'magiya_copy']);

        env.ui.confirmAnswer = false;
        await click(buttonByText('Reset', container.querySelectorAll('.maestro-m25-def')[0]!));
        expect(reset).not.toHaveBeenCalled();
        env.ui.confirmAnswer = true;
        await click(buttonByText('Reset', container.querySelectorAll('.maestro-m25-def')[0]!));
        expect(reset).toHaveBeenCalledWith({ mechanicId: 'magic' });
        expect(env.ui.notices.at(-1)?.text).toBe('Reset: 3 changes.');
    });
});

describe('the assistant and the preview', () => {
    it('asks the assistant to build a mechanic from words', async () => {
        const send = vi.fn(async () => {});
        env.modules.expose('assistant', { send });
        const open = vi.fn();
        env.ui.openWindow = open;
        render();
        await click(buttonByText('Describe in words'));
        type(one<HTMLTextAreaElement>('.maestro-m25-describe-text'), 'Мана, которая копится в отдыхе.');
        await click(buttonByText('Ask the assistant'));
        expect(open).toHaveBeenCalledWith('assistant');
        expect(send).toHaveBeenCalledWith(expect.stringContaining('Мана, которая копится в отдыхе.'));
        expect(container.textContent).toContain('Mechanics constructor');
    });

    it('shows what the model gets and follows the edits', async () => {
        await edit(undefined, {
            api: {
                persona: () => 'Алекс',
                previewPrompt: () => ({
                    text: '[Mechanics] whole',
                    tokens: 1,
                    budget: 0,
                    budgetSource: 'own',
                    cut: [],
                    mechanics: [],
                    flags: [],
                    facts: '',
                }),
            } as unknown as MechanicsApi,
        });
        const preview = one('.maestro-m25-preview-own');
        expect(preview.textContent).toContain('Casting costs mana.');
        expect(preview.textContent).toContain('Алекс');
        expect(one('.maestro-m25-preview-turn').textContent).toBe('[Mechanics] whole');
        type(one<HTMLTextAreaElement>('.maestro-m25-rules-en'), 'Mana is life.');
        expect(preview.textContent).toContain('Mana is life.');
    });
});

describe('engine fields', () => {
    it('edits consequences, conditions, time rules and checks a formula', async () => {
        await edit();
        const checkBlock = one('.maestro-m25-check');
        await click(buttonByText('Add a consequence', checkBlock));
        await click(buttonByText('Add a change', one('.maestro-m25-check')));
        type(one<HTMLInputElement>('.maestro-m25-check .maestro-m25-action-value'), '10');
        check(toggleByLabel('Its holders can have conditions'), true);
        await settle();
        await click(buttonByText('Add a condition'));
        type(one<HTMLInputElement>('.maestro-m25-status-name'), 'Отравлен');
        type(one<HTMLInputElement>('.maestro-m25-status-def input[aria-label="Turns"]'), '3');
        type(one<HTMLInputElement>('.maestro-m25-status-mods'), 'Мана -2, checks +1');
        await click(buttonByText('Add a rule'));
        type(one<HTMLInputElement>('.maestro-m25-time-amount'), '5');
        type(one<HTMLInputElement>('.maestro-m25-formula'), '@nope + 1');
        expect(one('.maestro-m25-number-extras .maestro-m25-verdict').textContent).toContain('@nope');
        type(one<HTMLInputElement>('.maestro-m25-formula'), '');
        await click(buttonByText('Save'));
        const saved = defs.saved.at(-1)!;
        expect(saved.checks[0]?.effects).toEqual([
            { on: 'failure', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 10 }] },
        ]);
        expect(saved.statuses).toEqual([
            { name: 'Отравлен', duration: { turns: 3 }, modifiers: { mana: -2, checks: 1 } },
        ]);
        expect(saved.time).toEqual([{ attr: 'mana', amount: 5, per: 'hour' }]);
    });

    it('keeps the events when the kind changes, asking before dropping the ones that no longer fit', async () => {
        const withEvent = (): MechanicDef => ({
            ...mechanic({
                checks: [],
                attributes: [
                    {
                        id: 'mana',
                        name: 'Мана',
                        promptName: 'Mana',
                        kind: 'number',
                        min: 0,
                        max: 100,
                        events: [
                            { id: 'empty', when: { op: '<=', value: 0 }, text: 'Empty.' },
                            { id: 'moved', when: { op: 'changed' }, text: 'Moved.' },
                        ],
                    },
                ],
            }),
            book: BOOK,
            uid: 1,
        });
        await edit(withEvent());
        env.ui.confirmAnswer = false;
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]'), 'list');
        await settle();
        expect(env.ui.confirms.at(-1)?.title).toBe('Drop the events that do not fit?');
        expect(container.querySelectorAll('.maestro-m25-event')).toHaveLength(2);

        choose(one<HTMLSelectElement>('select[aria-label="Kind"]'), 'number');
        await settle();
        env.ui.confirmAnswer = true;
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]'), 'text');
        await settle();
        expect(container.querySelectorAll('.maestro-m25-event')).toHaveLength(1);
        expect(one<HTMLInputElement>('.maestro-m25-event-text').value).toBe('Moved.');

        // A kind every event fits: no question.
        const asked = env.ui.confirms.length;
        choose(one<HTMLSelectElement>('select[aria-label="Kind"]'), 'scale');
        await settle();
        expect(env.ui.confirms).toHaveLength(asked);
        expect(container.querySelectorAll('.maestro-m25-event')).toHaveLength(1);
    });
});
