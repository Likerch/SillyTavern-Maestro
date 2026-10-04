// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonBookName } from '../../../src/domain/canon-book';
import { canonModule } from '../../../src/features/canon';
import type { CanonApi } from '../../../src/features/canon/api';
import { createCanonTestApp, listsFrom, runScan, settle, startModule, wi } from './helpers';
import type { CanonTestApp } from './helpers';

let env: CanonTestApp;
let canon: Required<CanonApi>;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

function item(title: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('.maestro-m6-item')].find(
        (node) => node.querySelector('.maestro-m6-title')?.textContent === title,
    );
    if (!found) throw new Error(`no item ${title}`);
    return found;
}

beforeEach(async () => {
    env = createCanonTestApp();
    env.world.book('World', [wi(1, { key: ['dragon'], content: 'A red dragon.', comment: 'Dragon' })]);
    const started = await startModule(env, canonModule);
    stop = () => started.stop();
    canon = env.modules.api<Required<CanonApi>>('canon')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    await stop();
});

function render(): void {
    unmount = env.ui.tabs.find((tab) => tab.id === 'canon')!.render(container);
}

describe('canon tab', () => {
    it('shows an empty canon', async () => {
        render();
        await settle();
        expect(container.textContent).toContain('This chat has no canon yet.');
        expect(container.textContent).toContain('The canon of this chat is empty.');
        expect(container.textContent).toContain('No generation has used the canon yet.');
        expect(buttonByText('Export').disabled).toBe(true);
    });

    it('groups items by kind with status, origin and base, and acts on them', async () => {
        await canon.put({
            entry: { comment: 'Tavern', key: ['tavern'], content: 'A tavern.' },
            meta: { kind: 'addition', status: 'provisional', origin: 'living' },
        });
        await canon.put({
            entry: { content: 'The dragon is dead.' },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world: 'World', uid: 1, contentHash: '' },
            },
        });
        // Provisional living facts act only while the living canon (M26) runs.
        env.modules.expose('livingCanon', {});
        await runScan(env, listsFrom(env.world, { globalLore: ['World'] }), 'tavern dragon');
        render();
        await settle();
        expect(container.querySelector('.maestro-m6-book')?.textContent).toBe(canonBookName(env.mock.chatId!));
        expect(container.textContent).toContain('Overrides (1)');
        expect(container.textContent).toContain('Additions (1)');
        expect(container.textContent).toContain('Canon on the last turn: 28 of 8000 characters');
        const tavern = item('Tavern');
        expect(tavern.textContent).toContain('provisional');
        expect(tavern.textContent).toContain('living canon');
        const dragon = item('Override: Dragon');
        expect(dragon.textContent).toContain('Base: World, entry 1');
        expect(dragon.textContent).toContain('The dragon is dead.');

        buttonByText('Confirm', tavern).click();
        await settle();
        expect((await canon.list({ kind: 'addition' }))[0]?.meta.status).toBe('active');

        buttonByText('Archive', item('Tavern')).click();
        await settle();
        expect((await canon.list({ kind: 'addition' }))[0]?.meta.status).toBe('archived');
        expect(item('Tavern').classList.contains('maestro-m6-archived')).toBe(true);

        buttonByText('Remove', item('Tavern')).click();
        await settle();
        expect(await canon.list({ kind: 'addition' })).toEqual([]);

        buttonByText('Canon for all chats', item('Override: Dragon')).click();
        await settle();
        expect(env.world.entry('World', 1)?.content).toBe('The dragon is dead.');
    });

    it('shows base drift and exports', async () => {
        await canon.put({
            entry: { content: 'The dragon is dead.' },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world: 'World', uid: 1, contentHash: '' },
            },
        });
        await env.world.edit('World', 1, { content: 'A blue dragon.' });
        render();
        await settle();
        buttonByText('Check the bases').click();
        await settle();
        expect(container.textContent).toContain('Base entries changed');
        expect(container.textContent).toContain('the base entry in World has changed');
        buttonByText('Export').click();
        await settle();
        expect(env.world.books.has(`${env.mock.chatId} — канон`)).toBe(true);
        expect(env.ui.notices.at(-1)?.text).toContain('Canon exported');
    });
});
