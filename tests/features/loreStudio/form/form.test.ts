// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '../../../../src/domain/lore-form-fields';
import { renderEntryForm } from '../../../../src/features/loreStudio/form';
import type { WiEntry } from '../../../../src/features/loreStudio/store-api';
import {
    FakeCanon,
    FakeRoles,
    buttonByText,
    check,
    choose,
    click,
    createStand,
    entry,
    field,
    hasButton,
    mount,
    role,
    section,
    settle,
    type,
} from './harness';
import type { Mounted, Stand } from './harness';

const CONTENT = 'Anna lives in the Silver Tower.';

function root(mounted: Mounted): HTMLElement {
    const node = mounted.container.querySelector<HTMLElement>('.maestro-m23f');
    if (!node) throw new Error('no form');
    return node;
}

function form(mounted: Mounted) {
    const value = mounted.form();
    if (!value) throw new Error('no form instance');
    return value;
}

function text(mounted: Mounted): string {
    return mounted.container.textContent ?? '';
}

function key(node: HTMLElement, keyName: string, options: KeyboardEventInit = {}): void {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...options }));
}

describe('Lore Studio entry form', () => {
    let stand: Stand;
    let mounted: Mounted | null;

    beforeEach(() => {
        stand = createStand();
        stand.store.put('World', [
            entry(1),
            entry(2, {
                comment: 'Tower',
                key: ['tower'],
                group: 'places, towers',
                position: 7,
                outletName: 'scene',
                automationId: 'qr1',
            }),
        ]);
        mounted = null;
    });

    afterEach(() => {
        mounted?.dispose();
        mounted = null;
    });

    it('renders every section with the stored values, UID and token counter', async () => {
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        for (const id of [
            'keys',
            'content',
            'placement',
            'activation',
            'timers',
            'groups',
            'filters',
            'sources',
            'service',
        ]) {
            expect(section(node, id).hidden).toBe(false);
        }
        expect(section(node, 'passport').hidden).toBe(true);
        expect(node.querySelector('.maestro-m23f-title')?.textContent).toBe('Anna');
        expect(text(mounted)).toContain('UID 1');
        expect(field<HTMLTextAreaElement>(node, 'key').value).toBe('Anna');
        expect(field<HTMLTextAreaElement>(node, 'content').value).toBe(CONTENT);
        expect(field<HTMLSelectElement>(node, 'position').value).toBe('0');
        expect(field<HTMLSelectElement>(node, 'entryState').value).toBe('normal');
        expect(field<HTMLInputElement>(node, 'disable').checked).toBe(true);
        expect(stand.tokenCount).toHaveBeenCalledWith(CONTENT);
        expect(text(mounted)).toContain(`Tokens: ${Math.ceil(CONTENT.length / 4)}`);
        expect(text(mounted)).toContain(`Chars: ${CONTENT.length}`);
        expect(stand.styles.has('maestro-m23f')).toBe(true);
        expect(text(mounted)).toContain('Nothing: ST’s editor would keep this entry as it is.');
        // Suggestions from other entries of the book.
        expect([...node.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'))).toEqual(
            expect.arrayContaining(['scene', 'qr1']),
        );
        expect(text(mounted)).toContain('places');
    });

    it('makes no hidden changes on open and shows where ST would differ', async () => {
        stand.store.put('Old', [
            {
                uid: 3,
                key: ['a'],
                keysecondary: ['b'],
                content: 'c',
                comment: '',
                selective: false,
                useProbability: false,
                probability: 50,
            } as WiEntry,
        ]);
        mounted = await mount(stand, 'Old', 3);
        const instance = form(mounted);
        expect(instance.isDirty()).toBe(false);
        const page = text(mounted);
        expect(page).toContain(
            'Opening this entry in ST’s window would change how it fires: selective, useProbability, position',
        );
        expect(page).toContain('The secondary keys are ignored now');
        expect(page).toContain('The roll is off now, so 50% does not apply');
        expect(page).toContain('No position is stored');
        expect(await instance.save()).toBe(true);
        expect(stand.store.updates).toEqual([]);
        expect(text(mounted)).toContain('Nothing changed.');

        // The fix is an explicit edit, saved like any other — and nothing else is written.
        await click(root(mounted), 'Turn on «selective» and the roll');
        expect(instance.isDirty()).toBe(true);
        await instance.save();
        expect(stand.store.updates[0]?.patch).toEqual({ selective: true, useProbability: true });
        expect(stand.store.entry('Old', 3)).toEqual({
            uid: 3,
            key: ['a'],
            keysecondary: ['b'],
            content: 'c',
            comment: '',
            selective: true,
            useProbability: true,
            probability: 50,
        });
    });

    it('keeps missing fields missing when controls go back to their «empty» state', async () => {
        stand.store.put('Bare', [{ uid: 4, key: ['x'], keysecondary: [], content: 'y', comment: '' } as WiEntry]);
        mounted = await mount(stand, 'Bare', 4);
        const node = root(mounted);
        const instance = form(mounted);
        choose(field<HTMLSelectElement>(node, 'useGroupScoring'), 'false');
        choose(field<HTMLSelectElement>(node, 'useGroupScoring'), 'null');
        check(field(node, 'ignoreBudget'), true);
        check(field(node, 'ignoreBudget'), false);
        type(field(node, 'sticky'), '3');
        type(field(node, 'sticky'), '');
        type(field(node, 'order'), '5');
        type(field(node, 'order'), '');
        type(field(node, 'automationId'), 'a');
        type(field(node, 'automationId'), '');
        check(node.querySelector<HTMLInputElement>('[data-trigger="quiet"]')!, true);
        check(node.querySelector<HTMLInputElement>('[data-trigger="quiet"]')!, false);
        expect(instance.isDirty()).toBe(false);
        expect(instance.hasErrors()).toBe(false);
    });

    it('edits the tri-states with the global value shown', async () => {
        stand.store.globals = {
            world_info_case_sensitive: true,
            world_info_match_whole_words: false,
            world_info_depth: 3,
        };
        const item = entry(1, { matchWholeWords: false });
        delete (item as Record<string, unknown>).useGroupScoring;
        stand.store.put('World', [item]);
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        const caseSelect = field<HTMLSelectElement>(node, 'caseSensitive');
        expect(caseSelect.value).toBe('null');
        expect(caseSelect.options[0]?.textContent).toBe('Global (now: Yes)');
        expect(field<HTMLSelectElement>(node, 'matchWholeWords').value).toBe('false');
        expect(field<HTMLSelectElement>(node, 'useGroupScoring').value).toBe('null');
        expect(field(node, 'scanDepth').placeholder).toBe('Global (3)');
        choose(caseSelect, 'true');
        choose(field<HTMLSelectElement>(node, 'matchWholeWords'), 'null');
        key(node, 's', { ctrlKey: true });
        await settle();
        expect(stand.store.updates).toHaveLength(1);
        expect(stand.store.updates[0]).toMatchObject({
            book: 'World',
            uid: 1,
            patch: { caseSensitive: true, matchWholeWords: null },
            reason: { module: 'M23' },
        });
        expect(stand.store.updates[0]?.reason.summary).toContain('«Anna» in «World» — caseSensitive, matchWholeWords');
        expect(mounted.onSaved).toHaveBeenCalledTimes(1);
        expect(text(mounted)).toContain('Saved.');
    });

    it('splits keys like ST (commas inside regexes) and shows chips and warnings', async () => {
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        type(field<HTMLTextAreaElement>(node, 'key'), 'Anna, /An{1,2}a/i, /abc/x, Аня');
        expect(node.querySelectorAll('[data-section="keys"] .maestro-m23f-chip')).toHaveLength(4);
        expect(node.querySelectorAll('.maestro-m23f-chip-regex')).toHaveLength(1);
        expect(text(mounted)).toContain(
            'Looks like a regex, but ST cannot parse it, so it is matched as plain text: /abc/x',
        );
        expect(text(mounted)).not.toContain('«Whole words» does not know Cyrillic');
        choose(field<HTMLSelectElement>(node, 'matchWholeWords'), 'true');
        expect(text(mounted)).toContain(
            '«Whole words» does not know Cyrillic in ST (JS \\W): these keys also match inside other words — Аня',
        );
        type(field<HTMLTextAreaElement>(node, 'keysecondary'), 'forest');
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({
            key: ['Anna', '/An{1,2}a/i', '/abc/x', 'Аня'],
            keysecondary: ['forest'],
            matchWholeWords: true,
        });
        // After the reload the field shows the keys in ST's own format.
        expect(field<HTMLTextAreaElement>(root(mounted), 'key').value).toBe('Anna, /An{1,2}a/i, /abc/x, Аня');
        expect(field<HTMLInputElement>(root(mounted), 'comment').placeholder).toBe('Anna, /An{1,2}a/i, /abc/x, Аня');
    });

    it('handles position, role, depth and outlet with ST semantics', async () => {
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        const depthRow = field(node, 'depth').closest<HTMLElement>('.maestro-m23f-row')!;
        const outletRow = field(node, 'outletName').closest<HTMLElement>('.maestro-m23f-row')!;
        expect(depthRow.hidden).toBe(true);
        expect(outletRow.hidden).toBe(true);
        choose(field<HTMLSelectElement>(node, 'position'), '4:2');
        expect(depthRow.hidden).toBe(false);
        type(field(node, 'depth'), '2');
        key(field(node, 'depth'), 'Enter', { ctrlKey: true });
        await settle();
        expect(stand.store.updates[0]?.patch).toEqual({ position: 4, role: 2, depth: 2 });

        const again = root(mounted);
        choose(field<HTMLSelectElement>(again, 'position'), '7');
        expect(field(again, 'outletName').closest<HTMLElement>('.maestro-m23f-row')!.hidden).toBe(false);
        expect(text(mounted)).toContain('Outlet without a name: ST skips the entry.');
        type(field(again, 'outletName'), 'scene');
        expect(text(mounted)).not.toContain('Outlet without a name');
        await form(mounted).save();
        expect(stand.store.updates[1]?.patch).toEqual({ position: 7, role: null, outletName: 'scene' });
    });

    it('validates numbers and blocks saving until they are fixed', async () => {
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        const save = buttonByText(node, 'Save');
        expect(save.disabled).toBe(true);
        type(field(node, 'probability'), 'abc');
        expect(text(mounted)).toContain('Not a number.');
        expect(save.disabled).toBe(true);
        expect(await form(mounted).save()).toBe(false);
        expect(text(mounted)).toContain('Fix the marked fields first.');
        expect(text(mounted)).toContain('Fields with errors: probability');
        type(field(node, 'probability'), '50');
        expect(text(mounted)).not.toContain('Not a number.');
        type(field(node, 'scanDepth'), '2000', true);
        expect(field(node, 'scanDepth').value).toBe('1000');
        expect(text(mounted)).toContain('Lowered to 1000 (the maximum).');
        type(field(node, 'order'), '');
        expect(text(mounted)).toContain('Enter a number.');
        type(field(node, 'order'), '7');
        type(field(node, 'delayUntilRecursionLevel'), 'abc');
        expect(text(mounted)).toContain('A level is a number');
        type(field(node, 'delayUntilRecursionLevel'), '2');
        expect(save.disabled).toBe(false);
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({
            probability: 50,
            scanDepth: 1000,
            order: 7,
            delayUntilRecursion: 2,
        });
    });

    it('toggles delay-until-recursion like ST', async () => {
        stand.store.put('World', [entry(1, { delayUntilRecursion: 3 })]);
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        const toggle = field(node, 'delayUntilRecursion');
        const level = field(node, 'delayUntilRecursionLevel');
        expect(toggle.checked).toBe(true);
        expect(level.value).toBe('3');
        check(toggle, false);
        expect(level.value).toBe('');
        expect(level.closest<HTMLElement>('.maestro-m23f-row')!.hidden).toBe(true);
        check(toggle, true);
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({ delayUntilRecursion: true });
    });

    it('edits the character filter and triggers', async () => {
        stand.store.put('World', [entry(1, { characterFilter: { isExclude: false, names: ['Ghost'], tags: [] } })]);
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        expect(text(mounted)).toContain('not found');
        const anna = node.querySelector<HTMLInputElement>('[data-kind="character"][data-value="Anna"]')!;
        check(anna, true);
        check(node.querySelector<HTMLInputElement>('[data-kind="tag"][data-value="t1"]')!, true);
        expect(text(mounted)).toContain('[Tag] Elves');
        await click(node, 'Remove missing');
        check(field(node, 'characterFilterExclude'), true);
        check(node.querySelector<HTMLInputElement>('[data-trigger="quiet"]')!, true);
        check(node.querySelector<HTMLInputElement>('[data-trigger="normal"]')!, true);
        const search = node.querySelector<HTMLInputElement>('[data-section="filters"] input[type="search"]')!;
        type(search, 'brave');
        expect(node.querySelectorAll('.maestro-m23f-picker [data-kind]')).toHaveLength(1);
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({
            characterFilter: { isExclude: true, names: ['Anna'], tags: ['t1'] },
            triggers: ['normal', 'quiet'],
        });

        // Unselecting everything without exclude removes the field (ST).
        const next = root(mounted);
        check(field(next, 'characterFilterExclude'), false);
        check(next.querySelector<HTMLInputElement>('[data-kind="character"][data-value="Anna"]')!, false);
        check(next.querySelector<HTMLInputElement>('[data-kind="tag"][data-value="t1"]')!, false);
        await form(mounted).save();
        expect(stand.store.updates[1]?.patch).toEqual({ characterFilter: undefined });
        expect('characterFilter' in stand.store.entry('World', 1)!).toBe(false);
    });

    it('is read-only for BunnyMo books (P13) and still lets the tester run', async () => {
        const roles = new FakeRoles();
        roles.roles.set('Pack', role('Pack', 'bunnymo.pack'));
        stand.apis.set('bookRoles', roles);
        stand.apis.set('canon', new FakeCanon(stand.store));
        stand.store.put('Pack', [entry(5)]);
        mounted = await mount(stand, 'Pack', 5);
        const node = root(mounted);
        expect(text(mounted)).toContain('BunnyMo packs are never edited');
        const edit = node.querySelector<HTMLFieldSetElement>('fieldset.maestro-m23f-edit')!;
        expect(edit.disabled).toBe(true);
        const controls = [...edit.querySelectorAll<HTMLInputElement>('input, select, textarea, button')];
        expect(controls.length).toBeGreaterThan(30);
        expect(controls.every((control) => control.disabled)).toBe(true);
        expect(hasButton(node, 'Save')).toBe(false);
        expect(hasButton(node, 'Russian keys')).toBe(false);
        expect(node.querySelector('[data-section="canon"]')).toBeNull();
        type(field<HTMLTextAreaElement>(node, 'content'), 'hacked');
        key(node, 's', { ctrlKey: true });
        await settle();
        expect(stand.store.updates).toEqual([]);
        expect(form(mounted).isDirty()).toBe(false);

        const tester = section(node, 'tester');
        type(tester.querySelector('textarea')!, 'I met Anna');
        await click(tester, 'Check');
        expect(tester.textContent).toContain('Fires.');
        await click(node, 'Open «Rules»');
        expect(stand.openPult).toHaveBeenCalledWith('rules');
    });

    it('honours ctx.readOnly for any book', async () => {
        mounted = await mount(stand, 'World', 1, { readOnly: true });
        expect(text(mounted)).toContain('This book is open read-only.');
        expect(hasButton(root(mounted), 'Save')).toBe(false);
        expect(hasButton(root(mounted), 'Restore this version')).toBe(false);
    });

    it('composes the content of a typed entry in a Maestro book and stores the type in the entry', async () => {
        const roles = new FakeRoles();
        roles.roles.set('Mine', role('Mine', 'maestro'));
        stand.apis.set('bookRoles', roles);
        stand.store.put('Mine', [entry(1, { content: '', extensions: { other: { keep: true } } })]);
        mounted = await mount(stand, 'Mine', 1);
        const node = root(mounted);
        expect(text(mounted)).toContain('Stored in the entry (extensions.maestro)');
        choose(field<HTMLSelectElement>(node, 'entryType'), 'character');
        type(node.querySelector<HTMLInputElement>('[data-typed-field="name"]')!, 'Anna');
        type(node.querySelector<HTMLTextAreaElement>('[data-typed-field="appearance"]')!, 'tall');
        await click(node, 'Compose content from fields');
        expect(stand.confirm).not.toHaveBeenCalled();
        expect(field<HTMLTextAreaElement>(node, 'content').value).toBe('Character: Anna\nAppearance: tall');
        await form(mounted).save();
        const patch = stand.store.updates[0]?.patch;
        expect(patch?.content).toBe('Character: Anna\nAppearance: tall');
        expect(patch?.extensions).toEqual({
            other: { keep: true },
            maestro: {
                type: 'character',
                typeFields: expect.objectContaining({ name: 'Anna', appearance: 'tall', age: '' }),
            },
        });
        expect(roles.setEntryMeta).not.toHaveBeenCalled();
        // Reopened: the type and the fields are back.
        expect(field<HTMLSelectElement>(root(mounted), 'entryType').value).toBe('character');
    });

    it('never replaces existing content without asking', async () => {
        const roles = new FakeRoles();
        roles.roles.set('Mine', role('Mine', 'maestro'));
        stand.apis.set('bookRoles', roles);
        stand.store.put('Mine', [entry(1)]);
        mounted = await mount(stand, 'Mine', 1);
        const node = root(mounted);
        choose(field<HTMLSelectElement>(node, 'entryType'), 'note');
        type(node.querySelector<HTMLInputElement>('[data-typed-field="name"]')!, 'Memo');
        stand.confirm.mockResolvedValueOnce(false);
        await click(node, 'Compose content from fields');
        expect(stand.confirm).toHaveBeenCalledWith('Replace the content?', expect.any(HTMLElement));
        expect(field<HTMLTextAreaElement>(node, 'content').value).toBe(CONTENT);
        stand.confirm.mockResolvedValueOnce(true);
        await click(node, 'Compose content from fields');
        expect(field<HTMLTextAreaElement>(node, 'content').value).toBe('Note: Memo');
    });

    it('keeps the type of a base entry in the bookRoles sidecar (P2)', async () => {
        const roles = new FakeRoles();
        roles.roles.set('World', role('World', 'world'));
        roles.meta.set('World\u00001', { passport: { id: 'p1' } });
        roles.hashesKnown = false;
        stand.apis.set('bookRoles', roles);
        mounted = await mount(stand, 'World', 1);
        expect(roles.loadEntryMeta).toHaveBeenCalledWith('World', 1);
        const node = root(mounted);
        expect(text(mounted)).toContain('Stored in Maestro’s registry');
        choose(field<HTMLSelectElement>(node, 'entryType'), 'place');
        type(node.querySelector<HTMLInputElement>('[data-typed-field="name"]')!, 'Silver Tower');
        expect(form(mounted).isDirty()).toBe(true);
        await form(mounted).save();
        expect(stand.store.updates).toEqual([]);
        expect(roles.setEntryMeta).toHaveBeenCalledWith('World', 1, {
            passport: { id: 'p1' },
            type: 'place',
            typeFields: expect.objectContaining({ name: 'Silver Tower' }),
        });
        expect(form(mounted).isDirty()).toBe(false);
        expect(field<HTMLSelectElement>(root(mounted), 'entryType').value).toBe('place');

        // A content edit made here re-binds the typed meta to the new content hash (entry first, then sidecar).
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'The tower is silver.');
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({ content: 'The tower is silver.' });
        expect(roles.setEntryMeta).toHaveBeenCalledTimes(2);
        expect(roles.setEntryMeta.mock.calls[1]![2]).toMatchObject({ passport: { id: 'p1' }, type: 'place' });
    });

    it('creates a canon override of a base entry and opens it, then comes back', async () => {
        const canon = new FakeCanon(stand.store);
        stand.apis.set('canon', canon);
        mounted = await mount(stand, 'World', 1);
        const node = root(mounted);
        expect(text(mounted)).toContain('Chat canon · Maestro · канон · chat1');
        expect(text(mounted)).toContain('No override: this chat uses the base entry as it is.');
        await click(node, 'Override in canon');
        await settle();
        expect(canon.ensureBook).toHaveBeenCalled();
        expect(canon.put).toHaveBeenCalledTimes(1);
        const draft = canon.put.mock.calls[0]![0];
        expect(draft.meta).toEqual({
            kind: 'override',
            status: 'active',
            origin: 'user',
            base: { world: 'World', uid: 1, contentHash: contentHash(CONTENT), content: CONTENT },
        });
        expect(draft.entry).toMatchObject({ key: ['Anna'], content: CONTENT, comment: 'Anna' });
        expect('uid' in draft.entry).toBe(false);
        expect(stand.store.updates).toEqual([]);

        // The override is open in place of the base.
        expect(root(mounted).dataset.book).toBe(canon.book);
        expect(root(mounted).dataset.uid).toBe('7');
        expect(text(mounted)).toContain('Canon entry');
        expect(text(mounted)).toContain('override');
        expect(text(mounted)).toContain('Base: «World» #1');
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'Anna lives in Paris.');
        await form(mounted).save();
        expect(stand.store.updates[0]).toMatchObject({
            book: canon.book,
            uid: 7,
            patch: { content: 'Anna lives in Paris.' },
        });
        canon.items[0]!.entry.content = 'Anna lives in Paris.';

        await click(root(mounted), 'Back');
        await settle();
        expect(root(mounted).dataset.book).toBe('World');
        expect(text(mounted)).toContain('Canon override');
        expect(root(mounted).querySelector('[data-section="canon"] ins')?.textContent).toContain('Paris');
        expect(hasButton(root(mounted), 'Edit the override')).toBe(true);

        await click(root(mounted), 'Promote to the base');
        expect(canon.promote).toHaveBeenCalledWith(7);
        await click(root(mounted), 'Remove the override');
        expect(stand.confirm).toHaveBeenCalledWith('Remove the override?', expect.any(String));
        expect(canon.remove).toHaveBeenCalledWith(7);
        await settle();
        expect(text(mounted)).toContain('No override');
    });

    it('suppresses and pins a base entry in the chat canon', async () => {
        const canon = new FakeCanon(stand.store);
        stand.apis.set('canon', canon);
        mounted = await mount(stand, 'World', 1);
        await click(root(mounted), 'Suppress in this chat');
        expect(canon.put).toHaveBeenLastCalledWith({
            entry: {},
            meta: expect.objectContaining({
                kind: 'suppress',
                base: expect.objectContaining({ world: 'World', uid: 1 }),
            }),
        });
        await settle();
        expect(text(mounted)).toContain('Suppressed in this chat.');
        await click(root(mounted), 'Pin');
        expect(canon.put).toHaveBeenLastCalledWith({
            entry: {},
            meta: expect.objectContaining({ kind: 'pin', pinWhen: 'always' }),
        });
        await settle();
        await click(root(mounted), 'Stop suppressing');
        expect(canon.remove).toHaveBeenCalledWith(7);
        await settle();
        await click(root(mounted), 'Unpin');
        expect(canon.remove).toHaveBeenCalledWith(8);
    });

    it('hides the canon block without a chat and refuses to override with unsaved edits', async () => {
        const canon = new FakeCanon(stand.store);
        stand.apis.set('canon', canon);
        stand.chatId = null;
        mounted = await mount(stand, 'World', 1);
        expect(root(mounted).querySelector('[data-section="canon"]')).toBeNull();
        mounted.dispose();
        stand.chatId = 'chat1';
        mounted = await mount(stand, 'World', 1);
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'edited');
        await click(root(mounted), 'Override in canon');
        expect(canon.put).not.toHaveBeenCalled();
        expect(text(mounted)).toContain('Save or undo the edits of the base entry first.');
    });

    it('lists history and restores a version', async () => {
        mounted = await mount(stand, 'World', 1);
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'Second version.');
        await form(mounted).save();
        await settle();
        const history = section(root(mounted), 'history');
        expect(history.textContent).toContain('you (Lore Studio)');
        await click(history, 'Compare with now');
        const diff = history.querySelector<HTMLElement>('.maestro-m23f-hist-diff');
        expect(diff?.hidden).toBe(false);
        expect(diff?.textContent).toContain('Second');
        await click(history, 'Restore this version');
        await settle();
        expect(stand.store.updates[1]?.patch).toEqual({ content: CONTENT });
        expect(stand.store.updates[1]?.reason.summary).toContain('restored to the version of');
        expect(field<HTMLTextAreaElement>(root(mounted), 'content').value).toBe(CONTENT);
        expect(mounted.onSaved).toHaveBeenCalledTimes(2);
    });

    it('guards unsaved edits when closing', async () => {
        mounted = await mount(stand, 'World', 1);
        await click(root(mounted), 'Close');
        expect(stand.confirm).not.toHaveBeenCalled();
        expect(mounted.onClose).toHaveBeenCalledTimes(1);
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'changed');
        expect(root(mounted).classList.contains('maestro-m23f-is-dirty')).toBe(true);
        stand.confirm.mockResolvedValueOnce(false);
        await click(root(mounted), 'Close');
        expect(stand.confirm).toHaveBeenCalledWith('Unsaved edits', expect.any(String));
        expect(mounted.onClose).toHaveBeenCalledTimes(1);
        await click(root(mounted), 'Close');
        expect(mounted.onClose).toHaveBeenCalledTimes(2);
        await click(root(mounted), 'Undo edits');
        expect(field<HTMLTextAreaElement>(root(mounted), 'content').value).toBe(CONTENT);
        expect(form(mounted).isDirty()).toBe(false);
    });

    it('hands the shell a leave guard when the context offers setLeaveGuard', async () => {
        let guard: (() => Promise<boolean>) | null = null;
        const setLeaveGuard = vi.fn((next: (() => Promise<boolean>) | null) => {
            guard = next;
        });
        mounted = await mount(stand, 'World', 1, { setLeaveGuard } as never);
        expect(guard).not.toBeNull();
        expect(await guard!()).toBe(true);
        expect(stand.confirm).not.toHaveBeenCalled();
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'unsaved');
        stand.confirm.mockResolvedValueOnce(false);
        expect(await guard!()).toBe(false);
        mounted.dispose();
        mounted = null;
        expect(setLeaveGuard).toHaveBeenLastCalledWith(null);
    });

    it('follows outside changes: reloads a clean form, warns a dirty one, ignores its own echo', async () => {
        mounted = await mount(stand, 'World', 1);
        stand.store.entry('World', 1)!.content = 'Changed by CK.';
        stand.store.emit('World');
        await settle();
        expect(field<HTMLTextAreaElement>(root(mounted), 'content').value).toBe('Changed by CK.');
        expect(text(mounted)).toContain('The entry was changed outside the studio: the form shows the new version.');

        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'My edit');
        stand.store.entry('World', 1)!.comment = 'Renamed';
        stand.store.emit(null);
        await settle();
        expect(text(mounted)).toContain('The entry was changed outside the studio while you were editing it.');
        expect(field<HTMLTextAreaElement>(root(mounted), 'content').value).toBe('My edit');
        await click(root(mounted), 'Show the new version (drop my edits)');
        expect(field<HTMLTextAreaElement>(root(mounted), 'content').value).toBe('Changed by CK.');
        expect(root(mounted).querySelector('.maestro-m23f-title')?.textContent).toBe('Renamed');

        stand.store.emit('Other');
        await form(mounted).save();
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'Saved text');
        await form(mounted).save();
        await settle();
        expect(text(mounted)).not.toContain('while you were editing');
    });

    it('adds Russian keys through the canon module when the Localizer API is absent', async () => {
        const canon = new FakeCanon(stand.store);
        stand.apis.set('canon', canon);
        mounted = await mount(stand, 'World', 1);
        await click(root(mounted), 'Russian keys');
        expect(canon.russianKeys).toHaveBeenCalledWith('Anna');
        expect(field<HTMLTextAreaElement>(root(mounted), 'key').value).toBe('Anna, Анна, Анну');
        expect(text(mounted)).toContain('Added 2 keys — check them and save.');
        await form(mounted).save();
        expect(stand.store.updates[0]?.patch).toEqual({ key: ['Anna', 'Анна', 'Анну'] });
        await click(root(mounted), 'Russian keys');
        expect(text(mounted)).toContain('No new forms.');
    });

    it('localizes through the Localizer API and marks its keys', async () => {
        const localizeEntries = vi.fn(async (book: string, uids: number[]) => {
            const item = stand.store.entry(book, uids[0]!)!;
            item.key = [...item.key, '/Ан(на|ну)/iu'];
            item.extensions = {
                lorebook_localizer: { version: 1, languages: { ru: { added: { key: ['/Ан(на|ну)/iu'] } } } },
            };
            return { added: 1, entries: 1, failures: 0 };
        });
        stand.localizer.api = () => ({ version: 1, localizeEntries });
        mounted = await mount(stand, 'World', 1);
        type(field<HTMLTextAreaElement>(root(mounted), 'content'), 'dirty');
        await click(root(mounted), 'Russian keys');
        expect(localizeEntries).not.toHaveBeenCalled();
        expect(text(mounted)).toContain('Save or undo the edits first');
        await click(root(mounted), 'Undo edits');
        await click(root(mounted), 'Russian keys');
        expect(localizeEntries).toHaveBeenCalledWith('World', [1]);
        await settle();
        expect(field<HTMLTextAreaElement>(root(mounted), 'key').value).toBe('Anna, /Ан(на|ну)/iu');
        expect(root(mounted).querySelector('.maestro-m23f-chip-ll')?.textContent).toContain('LL');
        expect(text(mounted)).toContain('Localizer added 1 keys.');
    });

    it('shows activations from the lore journal and doctor findings with their rule', async () => {
        const now = Date.now();
        stand.apis.set('loreJournal', {
            turns: () => [
                { messageIndex: 1, at: now, activations: [{ world: 'World', uid: 1, chars: 30 }] },
                { messageIndex: 3, at: now, activations: [] },
            ],
            attributeKeys: async (record: { activations: { key?: string }[] }) => ({
                ...record,
                activations: record.activations.map((item) => ({ ...item, key: 'Anna' })),
            }),
        });
        stand.apis.set('doctor', {
            findings: () => [
                {
                    id: 'f1',
                    kind: 'keys.cyrillicWholeWord',
                    severity: 'warn',
                    messageKey: 'test.finding',
                    target: { book: 'World', uid: 1 },
                    fixRule: 'lore.cyrillic',
                },
                {
                    id: 'f2',
                    kind: 'keys.noRussian',
                    severity: 'info',
                    messageKey: 'other.finding',
                    target: { book: 'World', uid: 2 },
                },
            ],
        });
        stand.apis.set('rules', {
            list: () => [
                { id: 'lore.cyrillic', enabled: false, definition: { titleKey: 'test.rule' }, lastChanges: [] },
            ],
        });
        mounted = await mount(stand, 'World', 1);
        const insights = section(root(mounted), 'insights');
        expect(insights.textContent).toContain('1 of 2 turns (50%)');
        expect(insights.textContent).toContain('Recent activations');
        expect(insights.textContent).toContain('30 chars');
        expect(insights.textContent).toContain('message #1');
        expect(insights.textContent).toContain('30');
        expect(insights.textContent).toContain('test.finding');
        expect(insights.textContent).not.toContain('other.finding');
        expect(insights.textContent).toContain('Rule «test.rule» fixes it on the fly (off).');
        await click(insights, 'Find the key');
        expect(insights.textContent).toContain('Anna');
        await click(insights, 'Open «Rules»');
        expect(stand.openPult).toHaveBeenCalledWith('rules');
    });

    it('tests activation on a text with the edited keys and macros', async () => {
        stand.store.put('World', [entry(1, { key: ['{{char}}'], keysecondary: ['forest'], selectiveLogic: 3 })]);
        mounted = await mount(stand, 'World', 1);
        const tester = section(root(mounted), 'tester');
        const input = tester.querySelector('textarea')!;
        await click(tester, 'Check');
        expect(tester.textContent).toContain('Enter some text first.');
        type(input, 'Anna walks');
        await click(tester, 'Check');
        expect(tester.textContent).toContain('Does not fire.');
        expect(tester.textContent).toContain('do not satisfy «AND ALL»');
        type(input, 'Anna walks in the forest');
        key(input, 'Enter', { ctrlKey: true });
        expect(tester.textContent).toContain('Fires.');
        expect(tester.querySelectorAll('.maestro-m23f-chip-hit')).toHaveLength(2);
        // Editing the keys re-runs the shown result.
        type(field<HTMLTextAreaElement>(root(mounted), 'key'), 'Bob');
        expect(tester.textContent).toContain('No primary key matched.');
        expect(stand.store.updates).toEqual([]);
    });

    it('shows decorators, card books and unknown fields', async () => {
        stand.store.put(
            'Card',
            [entry(1, { content: '@@activate\n@@mystery\nText', extra_field: 1, extensions: { other: 1 } })],
            { originalData: { entries: [] } },
        );
        mounted = await mount(stand, 'Card', 1);
        expect(text(mounted)).toContain('@@activate: the entry fires without keys');
        expect(text(mounted)).toContain('Unknown decorators are cut from the prompt without a word: @@mystery');
        expect(text(mounted)).toContain('A book from a character card');
        expect(text(mounted)).toContain('Fields of other extensions: extra_field');
        const expand = root(mounted).querySelector<HTMLButtonElement>('button[title="Expand the editor"]')!;
        expand.click();
        expect(
            field<HTMLTextAreaElement>(root(mounted), 'content').classList.contains('maestro-m23f-content-big'),
        ).toBe(true);
        expect(expand.getAttribute('aria-pressed')).toBe('true');
    });

    it('reports a missing entry and closes', async () => {
        mounted = await mount(stand, 'World', 99);
        expect(text(mounted)).toContain('Entry #99 is not in «World»');
        await click(root(mounted), 'Close');
        expect(mounted.onClose).toHaveBeenCalled();
    });

    it('disposes everything it created', async () => {
        const canon = new FakeCanon(stand.store);
        stand.apis.set('canon', canon);
        const first = await mount(stand, 'World', 1);
        const second = await mount(stand, 'World', 2);
        expect(stand.store.listeners.size).toBe(2);
        expect(canon.listeners.size).toBe(2);
        first.dispose();
        expect(stand.styles.has('maestro-m23f')).toBe(true);
        expect(stand.store.listeners.size).toBe(1);
        second.dispose();
        expect(stand.styles.has('maestro-m23f')).toBe(false);
        expect(stand.store.listeners.size).toBe(0);
        expect(canon.listeners.size).toBe(0);
        expect(first.container.isConnected).toBe(false);

        // The public contract returns a plain disposer.
        const container = document.createElement('div');
        const dispose = renderEntryForm(container, { ...first.ctx });
        await settle();
        expect(container.querySelector('.maestro-m23f')).not.toBeNull();
        dispose();
        expect(container.childElementCount).toBe(0);
        expect(stand.styles.size).toBe(0);
    });
});
