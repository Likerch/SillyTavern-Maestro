// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placesModule } from '../../../src/features/places';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { FakeCanon, createPlacesTestApp, settle, startModule, turn } from './helpers';
import type { PlacesTestApp } from './helpers';

let env: PlacesTestApp;
let places: Required<PlacesApi>;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

/** Redraws are coalesced (50 ms). */
const redraw = () => settle(90);

function named(name: string): Place {
    const found = places.list().find((place) => place.name === name);
    if (!found) throw new Error(`no place ${name}`);
    return found;
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

function placeNode(name: string): HTMLDetailsElement {
    const found = [...container.querySelectorAll<HTMLDetailsElement>('.maestro-m24-place')].find(
        (node) => node.querySelector('.maestro-m24-name')?.textContent === name,
    );
    if (!found) throw new Error(`no place node ${name}`);
    return found;
}

function candidateNode(name: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('.maestro-m24-candidate')].find(
        (node) => node.querySelector('.maestro-m24-name')?.textContent === name,
    );
    if (!found) throw new Error(`no candidate ${name}`);
    return found;
}

function render(): void {
    unmount = env.ui.tabs.find((tab) => tab.id === 'places')!.render(container);
}

beforeEach(async () => {
    env = createPlacesTestApp();
    const started = await startModule(env, placesModule);
    stop = () => started.stop();
    places = env.modules.api<Required<PlacesApi>>('places')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
    await settle();
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    await stop();
});

describe('places tab', () => {
    it('registers the tab and its styles', () => {
        const tab = env.ui.tabs.find((item) => item.id === 'places')!;
        expect(tab).toMatchObject({ titleKey: 'm24.tab', order: 47 });
        expect(env.ui.styles.get('m24-places')).toContain('.maestro-m24-place');
    });

    it('shows an empty registry and adds a place', async () => {
        render();
        expect(container.textContent).toContain('The current place is unknown.');
        expect(container.textContent).toContain('No places yet');
        const input = container.querySelector<HTMLInputElement>('input[aria-label="New place"]')!;
        input.value = 'Old Mill';
        buttonByText('Add').click();
        await redraw();
        expect(placeNode('Old Mill').open).toBe(true);
        expect(placeNode('Old Mill').textContent).toContain('not visited yet');
    });

    it('shows the tree, the current place, visits and candidates', async () => {
        await turn(env, 'Main Hall, Rusty Anchor Tavern', { characters: [{ name: 'Ann' }] });
        await turn(env, 'Main Hall, Rusty Anchor Tavern', {
            characters: [{ name: 'Ann' }, { name: 'Bob' }],
            date: 'Day 2',
            events: ['A fight broke out'],
        });
        await turn(env, 'Cellar, Rusty Anchor Tavern');
        await turn(env, 'Main Hall, Rusty Anchor Tavern');
        render();
        expect(container.querySelector('.maestro-m24-now')?.textContent).toBe('Now: Rusty Anchor Tavern › Main Hall');
        const names = [...container.querySelectorAll('.maestro-m24-place .maestro-m24-name')].map((n) => n.textContent);
        expect(names).toEqual(['Rusty Anchor Tavern', 'Main Hall']);
        const hall = placeNode('Main Hall');
        expect(hall.classList.contains('maestro-m24-current')).toBe(true);
        expect(hall.getAttribute('style')).toContain('--maestro-m24-depth: 1');
        expect(hall.querySelector('summary')?.textContent).toContain('here');
        const visits = [...hall.querySelectorAll('.maestro-m24-visit')].map((node) => node.textContent);
        expect(visits[0]).toContain('Since message #6, now');
        expect(visits[1]).toContain('Messages #0–#2');
        expect(visits[1]).toContain('Day 2');
        expect(visits[1]).toContain('There: Ann, Bob');
        expect(visits[1]).toContain('A fight broke out');
        expect(placeNode('Rusty Anchor Tavern').textContent).toContain('Inside: Main Hall');
        const cellar = candidateNode('Cellar');
        expect(cellar.textContent).toContain('DES: Cellar, Rusty Anchor Tavern');
        expect(cellar.textContent).toContain('Inside: Rusty Anchor Tavern');
        expect(cellar.textContent).toContain('seen 1×');
    });

    it('edits names, aliases, parent and merges or removes places', async () => {
        const city = await places.create('Port Royal');
        await places.create('Inn');
        await places.create('Tavern');
        render();
        let inn = placeNode('Inn');
        inn.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value = 'Rusty Inn';
        buttonByText('Rename', inn).click();
        await redraw();
        inn = placeNode('Rusty Inn');
        expect(named('Rusty Inn').aliases).toEqual(['Inn']);

        inn.querySelector<HTMLInputElement>('input[aria-label="Add a name"]')!.value = 'Anchor';
        buttonByText('Add a name', inn).click();
        await redraw();
        expect(named('Rusty Inn').aliases).toEqual(['Inn', 'Anchor']);
        placeNode('Rusty Inn').querySelector<HTMLButtonElement>('button[title="Remove «Inn»"]')!.click();
        await redraw();
        expect(named('Rusty Inn').aliases).toEqual(['Anchor']);

        const parent = placeNode('Rusty Inn').querySelector<HTMLSelectElement>('select[aria-label="Part of"]')!;
        parent.value = city.id;
        parent.dispatchEvent(new Event('change'));
        await redraw();
        expect(named('Rusty Inn').parent).toBe(city.id);

        const merge = placeNode('Tavern').querySelector<HTMLSelectElement>(
            'select[aria-label="Merge into another place"]',
        )!;
        merge.value = named('Rusty Inn').id;
        buttonByText('Merge', placeNode('Tavern')).click();
        await redraw();
        expect(env.ui.confirms.at(-1)?.title).toBe('Merge the places?');
        expect(places.list().some((place) => place.name === 'Tavern')).toBe(false);
        expect(named('Rusty Inn').aliases).toEqual(['Anchor', 'Tavern']);

        env.ui.confirmAnswer = false;
        buttonByText('Remove', placeNode('Rusty Inn')).click();
        await redraw();
        expect(places.list()).toHaveLength(2);
        env.ui.confirmAnswer = true;
        buttonByText('Remove', placeNode('Rusty Inn')).click();
        await redraw();
        expect(places.list().map((place) => place.name)).toEqual(['Port Royal']);

        // A bad edit shows its message.
        placeNode('Port Royal').querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value = ' ';
        buttonByText('Rename', placeNode('Port Royal')).click();
        await redraw();
        expect(env.ui.notices.at(-1)).toMatchObject({ text: 'A place needs a name.', options: { level: 'error' } });
    });

    it('opens the description entry through /maestro-lore', async () => {
        const canon = new FakeCanon();
        env.modules.expose('canon', canon);
        const commands: string[] = [];
        (env.mock.context as unknown as Record<string, unknown>).executeSlashCommandsWithOptions = async (
            command: string,
        ) => {
            commands.push(command);
            return {};
        };
        await places.create('Inn');
        render();
        buttonByText('Description', placeNode('Inn')).click();
        await redraw();
        expect(commands).toEqual([`/maestro-lore ${canon.book}`]);
        expect(env.ui.closed).toBe(1);
        expect(named('Inn').entry).toEqual({ world: canon.book, uid: 0 });
        expect(placeNode('Inn').textContent).toContain('described');

        // The Lore Studio's own API wins when it exposes one.
        const opened: unknown[] = [];
        env.modules.expose('loreStudio', { open: (book: string, uid: number) => opened.push([book, uid]) });
        buttonByText('Description', placeNode('Inn')).click();
        await redraw();
        expect(opened).toEqual([[canon.book, 0]]);

        // Without either, a notice says where the entry is.
        env.modules.apis.delete('loreStudio');
        delete (env.mock.context as unknown as Record<string, unknown>).executeSlashCommandsWithOptions;
        buttonByText('Description', placeNode('Inn')).click();
        await redraw();
        expect(env.ui.notices.at(-1)?.text).toBe(`The description is entry #0 of the lorebook «${canon.book}».`);
    });

    it('acts on candidates', async () => {
        const city = await places.create('Port Royal');
        await turn(env, 'Docks, Port Royal');
        await turn(env, 'Smithy, Port Royal');
        await turn(env, 'Harbour');
        render();
        expect(container.textContent).toContain('New names (3)');
        buttonByText('Create a place', candidateNode('Smithy')).click();
        await redraw();
        expect(named('Smithy').parent).toBe(city.id);

        const docks = candidateNode('Docks');
        docks.querySelector<HTMLSelectElement>('select[aria-label="Known place"]')!.value = city.id;
        buttonByText('It is this place', docks).click();
        await redraw();
        expect(named('Port Royal').aliases).toEqual(['Docks']);

        buttonByText('Not a place', candidateNode('Harbour')).click();
        await redraw();
        expect(places.candidates()).toEqual([]);
        expect(container.querySelector('.maestro-m24-candidate')).toBeNull();
    });

    it('marks candidates sent to the Inbox and shows the look-alike', async () => {
        await places.create('Rusty Anchor Tavern');
        await turn(env, 'Rusty Anchor');
        await turn(env, 'Rusty Anchor');
        render();
        const candidate = candidateNode('Rusty Anchor');
        expect(candidate.textContent).toContain('in the Inbox');
        expect(candidate.textContent).toContain('Looks like: Rusty Anchor Tavern');
    });

    it('says when no chat is open and stops redrawing after unmount', async () => {
        env.mock.chatId = undefined;
        render();
        expect(container.textContent).toContain('No chat is open.');
        (unmount as () => void)();
        unmount = undefined;
        env.mock.chatId = 'chat-1';
        await places.create('Inn');
        await redraw();
        expect(container.textContent).toContain('No chat is open.');
    });
});
