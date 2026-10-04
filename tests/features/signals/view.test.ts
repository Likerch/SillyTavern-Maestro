// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNALS_STRINGS, describeSignal, signalsModule } from '../../../src/features/signals';
import { KIND_ORDER } from '../../../src/features/signals/view';
import type { Signal } from '../../../src/shared/contracts';
import { createSignalsTestApp, settle, startModule, turn } from './helpers';
import type { SignalsTestApp } from './helpers';

let env: SignalsTestApp;
let stop: (() => Promise<void>) | undefined;
let container: HTMLElement;
let unmount: (() => void) | void;

function render(): void {
    const tab = env.ui.tabs.find((item) => item.id === 'signals')!;
    unmount = tab.render(container);
}

function text(): string {
    return container.textContent ?? '';
}

beforeEach(async () => {
    env = createSignalsTestApp();
    container = document.createElement('div');
    document.body.appendChild(container);
    const started = await startModule(env, signalsModule);
    stop = () => started.stop();
    await settle();
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    container.remove();
    await stop?.();
});

describe('signals tab', () => {
    it('lists pending signals by kind with message links and the last turn', async () => {
        const jumps: string[] = [];
        (env.mock.context as unknown as Record<string, unknown>).executeSlashCommandsWithOptions = async (
            command: string,
        ) => {
            jumps.push(command);
        };
        let closed = 0;
        env.ui.closePult = () => {
            closed++;
        };
        const tab = env.ui.tabs.find((item) => item.id === 'signals')!;
        expect(tab).toMatchObject({ titleKey: 's4.tab', order: 48 });
        await turn(env, { location: 'Tavern', characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        await turn(env, { location: 'Forest', characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        const index = await turn(env, { location: 'Forest', characters: [{ name: 'Anna', relationship: 'Hostile' }] });
        render();
        expect(text()).toContain('Waiting for the revision: 4 · replies since the last revision: 3');
        const kinds = [...container.querySelectorAll<HTMLElement>('.maestro-s4-kind')].map((node) => node.dataset.kind);
        expect(kinds.slice(0, 4)).toEqual([
            'scene.ended',
            'location.changed',
            'relationship.changed',
            'character.appeared',
        ]);
        expect(text()).toContain('Tavern → Forest');
        expect(text()).toContain('Anna: Neutral → Hostile');
        expect(text()).toContain(`Last turn (message #${index})`);
        const link = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
            (node) => node.textContent === `#${index}`,
        )!;
        expect(link.title).toBe(`Go to message #${index}`);
        link.click();
        await settle();
        expect(closed).toBe(1);
        expect(jumps).toEqual([`/chat-jump ${index}`]);
    });

    it('shows empty, loading, other-tab and no-chat states', async () => {
        render();
        expect(text()).toContain('No new signals.');
        expect(text()).toContain('No turn has been compared yet.');
        if (typeof unmount === 'function') unmount();
        container.textContent = '';
        await turn(env, { location: 'Tavern' });
        env.leader.value = false;
        render();
        expect(text()).toContain('Another tab of this chat compares the turns');
        expect(text()).toContain('Nothing changed in this turn.');
        if (typeof unmount === 'function') unmount();
        container.textContent = '';
        env.mock.chatId = undefined;
        render();
        expect(text()).toContain('No chat is open.');
    });
});

describe('describeSignal', () => {
    const t = (key: string, params: Record<string, string | number> = {}) =>
        (SIGNALS_STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
    const describe1 = (kind: string, data: Record<string, unknown> = {}, entity?: string) =>
        describeSignal({ kind, chatId: 'c', at: 0, data, ...(entity ? { entity } : {}) } as Signal, t);

    it('describes every kind', () => {
        expect(describe1('relationship.changed', { name: 'Anna', to: 'Hostile' })).toBe('Anna: — → Hostile');
        expect(
            describe1('appearance.changed', {
                name: 'Anna',
                changes: [{ field: 'outfit', aspect: 'outfit' }, { field: 'look' }],
            }),
        ).toBe('Anna: outfit (outfit), look');
        expect(describe1('appearance.changed', { name: 'Anna' })).toBe('Anna: —');
        expect(describe1('location.changed', { from: null, to: 'Forest' })).toBe('— → Forest');
        expect(describe1('time.skipped', { fromDate: 'Day 1', toDate: 'Day 3', hours: 48 })).toBe(
            'Day 1 → Day 3 (≈ 48 h)',
        );
        expect(describe1('time.skipped', { fromTime: '08:00' })).toBe('08:00 → —');
        expect(describe1('scene.ended', { reasons: ['location', 'time'] })).toBe('because of a new place, a time skip');
        expect(describe1('scene.ended')).toBe('because of —');
        expect(describe1('quest.added', { title: 'Find it', main: true })).toBe('Find it (main)');
        expect(describe1('quest.removed', { title: 'Find it', main: false })).toBe('Find it');
        expect(describe1('character.appeared', { name: 'Bob', first: true })).toBe('Bob (first time)');
        expect(describe1('character.left', { name: 'Bob' })).toBe('Bob');
        expect(describe1('alias.added', { name: 'Anna', aliases: ['Аня', 'Анечка'] })).toBe('Anna: Аня, Анечка');
        expect(describe1('alias.added', { name: 'Anna' })).toBe('Anna: —');
        expect(describe1('memory.long', { items: [{ index: 3 }, { index: 5 }] })).toBe('messages #3, #5');
        expect(describe1('memory.added')).toBe('messages —');
        expect(describe1('name.new', { name: 'Якорь', quoted: true })).toBe('«Якорь»');
        expect(describe1('name.new', { name: 'Marcus' })).toBe('Marcus');
        expect(describe1('fact.new', { text: 'A feast' })).toBe('A feast');
        expect(describe1('other.kind', {}, 'x:y')).toBe('x:y');
        expect(describe1('other.kind')).toBe('—');
        expect(describe1('name.new', { name: 'Marcus', folded: 2 })).toBe('Marcus ×3');
    });

    it('has a title for every kind in both languages', () => {
        for (const kind of KIND_ORDER) {
            expect(SIGNALS_STRINGS.en).toHaveProperty(`s4.kind.${kind}`);
            expect(SIGNALS_STRINGS.ru).toHaveProperty(`s4.kind.${kind}`);
        }
        expect(Object.keys(SIGNALS_STRINGS.ru).sort()).toEqual(Object.keys(SIGNALS_STRINGS.en).sort());
        for (const [key, value] of Object.entries(SIGNALS_STRINGS.ru)) expect(value, key).not.toBe('');
        expect(Object.keys(SIGNALS_STRINGS.en).every((key) => key.startsWith('s4.'))).toBe(true);
    });
});
