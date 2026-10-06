// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relationsModule } from '../../../src/features/relations';
import { worldModule } from '../../../src/features/world';
import type { WorldModelApi } from '../../../src/features/world/api';
import type { Dict, WorldEnv } from './helpers';
import { addCard, createWorldEnv, FakeDesRu, startModule, trackerMessage, userMessage } from './helpers';

let env: WorldEnv;
let world: WorldModelApi;
let stops: (() => Promise<void>)[];
let container: HTMLElement;
let unmount: (() => void) | void;

async function tick(ms = 200): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

function names(): string[] {
    return [...container.querySelectorAll('.maestro-m7w-entity .maestro-m7w-name')].map(
        (node) => node.textContent ?? '',
    );
}

function render(id: string): void {
    const tab = env.ui.tabs.find((item) => item.id === id)!;
    unmount = tab.render(container);
}

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWorldEnv();
    const desru = new FakeDesRu();
    desru.forms = { Лиза: ['Лиза', 'Лизой'] };
    env.neighbours.desru = desru;
    addCard(env, 'Elizabeth');
    (env.mock.context as unknown as Dict).name1 = 'Алекс';
    env.neighbours.desKnown = ['Лиза', 'Анна'];
    env.neighbours.desAliases = { Elizabeth: ['Лиза'] };
    env.mock.chat.push(
        trackerMessage('Привет', [
            { name: 'Лиза', relationship: { status: 'Friendly' } },
            { name: 'Анна', present: false },
        ]),
        userMessage('Привет!'),
    );
    addCard(env, 'Анна Петрова');
    (env.mock.context as unknown as Dict).groupId = 'g1';
    (env.mock.context as unknown as Dict).groups = [
        { id: 'g1', name: 'Group', members: ['Elizabeth.png', 'Анна Петрова.png'] },
    ];
    stops = [];
    for (const module of [worldModule, relationsModule]) {
        const started = await startModule(env, module as typeof worldModule);
        stops.push(() => started.stop());
    }
    world = env.modules.api<WorldModelApi>('world')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    for (const stop of stops.reverse()) await stop();
    vi.useRealTimers();
});

describe('M7 world tab', () => {
    it('lists entities by kind with presence and sources, and filters by search', async () => {
        render('world');
        await tick();
        expect(names()).toEqual(['Алекс', 'Анна', 'Анна Петрова', 'Elizabeth']);
        const sections = [...container.querySelectorAll('.maestro-section-title')].map((node) => node.textContent);
        expect(sections).toEqual(
            expect.arrayContaining(['Persona (1)', 'Characters (3)', 'Maybe the same (1)', 'Nicknames in this chat']),
        );
        const elizabeth = container.querySelector<HTMLElement>('[data-id="character:elizabeth"]')!;
        expect(elizabeth.textContent).toContain('in the scene');
        expect(elizabeth.textContent).toContain('Known from: 3');
        expect(elizabeth.textContent).toContain('Forms: Лизой');
        const search = container.querySelector<HTMLInputElement>('.maestro-m7w-search')!;
        search.value = 'лизой';
        search.dispatchEvent(new Event('input'));
        expect(names()).toEqual(['Elizabeth']);
        search.value = 'zzz';
        search.dispatchEvent(new Event('input'));
        expect(container.textContent).toContain('Nothing matches the search.');
        expect(env.ui.tabs.find((tab) => tab.id === 'world')?.badge?.()).toBe(1);
    });

    it('merges a candidate from the tab, journaled with undo', async () => {
        render('world');
        await tick();
        buttonByText('Merge').click();
        await tick();
        expect(world.resolve('Анна')?.name).toBe('Анна Петрова');
        expect(env.ui.notices.at(-1)?.text).toContain('in this chat «Анна» means the same now');
        const record = env.journal.records.find((item) => item.kind === 'world.merge')!;
        expect(record.changes[0]?.target).toBe('world-merge');
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(world.resolve('Анна')?.name).toBe('Анна');
    });

    it('marks a candidate as different, journaled with undo', async () => {
        render('world');
        await tick();
        buttonByText('Different').click();
        await tick();
        expect(world.mergeCandidates()).toEqual([]);
        expect(container.textContent).toContain('No doubtful matches.');
        const record = env.journal.records.find((item) => item.kind === 'world.separate')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(world.mergeCandidates()).toHaveLength(1);
    });

    it('adds and removes chat aliases, journaled with undo', async () => {
        render('world');
        await tick();
        const form = container.querySelector('.maestro-m7w-alias-form')!;
        const input = form.querySelector<HTMLInputElement>('input')!;
        const picker = form.querySelector<HTMLSelectElement>('select')!;
        input.value = 'Рыжая';
        input.dispatchEvent(new Event('input'));
        picker.value = 'character:elizabeth';
        picker.dispatchEvent(new Event('change'));
        buttonByText('Add', form).click();
        await tick();
        expect(world.chatAliases()).toEqual({ Рыжая: 'character:elizabeth' });
        const added = env.journal.records.at(-1)!;
        expect(added.kind).toBe('world.alias');
        const row = container.querySelector('.maestro-m7w-alias')!;
        expect(row.textContent).toContain('Рыжая');
        row.querySelector<HTMLButtonElement>('button')!.click();
        await tick();
        expect(world.chatAliases()).toEqual({});
        expect(await env.journal.undo(env.journal.records.at(-1)!.id)).toBe(true);
        expect(world.chatAliases()).toEqual({ Рыжая: 'character:elizabeth' });
        expect(await env.journal.undo(added.id)).toBe(true);
        expect(world.chatAliases()).toEqual({});
        buttonByText('Add', container.querySelector('.maestro-m7w-alias-form')!).click();
        await tick();
        expect(env.ui.notices.at(-1)).toMatchObject({ text: 'Enter a nickname.', options: { level: 'error' } });
    });

    it('shows a placeholder without a chat', async () => {
        env.mock.chatId = undefined;
        render('world');
        expect(container.textContent).toContain('No chat is open.');
    });
});

describe('M19 relations tab', () => {
    it('shows each pair with its current status and timeline', async () => {
        render('relations');
        await tick();
        expect(container.textContent).toContain('No relationships yet');
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await tick(2000);
        env.mock.chat.push(trackerMessage('Ответ', [{ name: 'Лиза', relationship: { status: 'Romantic' } }]));
        env.mock.chat.push(userMessage('…'));
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        await tick(2000);
        const rows = container.querySelectorAll('tbody tr');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.textContent).toContain('Elizabeth → Алекс');
        expect(container.querySelector('.maestro-badge-pill')?.textContent).toBe('Romantic');
        const points = [...container.querySelectorAll('.maestro-m19-point')];
        expect(points.map((node) => node.firstChild?.textContent)).toEqual(['Friendly', 'Romantic']);
        expect(points[1]?.getAttribute('title')).toBe('Message #2, 3 марта, 14:00');
        expect(points[1]?.classList.contains('maestro-m19-last')).toBe(true);
        buttonByText('Read the tracker again').click();
        await tick(1000);
        expect(env.ui.notices.at(-1)?.text).toBe('The relationship history was read again.');
    });

    it('shows a placeholder without a chat', async () => {
        env.mock.chatId = undefined;
        render('relations');
        expect(container.textContent).toContain('No chat is open.');
    });
});
