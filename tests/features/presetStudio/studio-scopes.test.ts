// @vitest-environment happy-dom
// The Preset Studio's side of release 1.13: where new edits go (the scope switch of the block editor and the «Слой»
// tab), the layer's ops grouped by scope and moved between scopes, the preset bound to the card or the chat in the
// header, and the «Промпты соседей» tab over the neighbour prompts API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PmInfo } from '../../../src/features/presetStudio/launcher';
import type { LayerOp, LayerScope, PresetBindings, ScopedLayerOp } from '../../../src/features/presetStudio/layer-api';
import { SCOPE_STRINGS } from '../../../src/features/presetStudio/scope-strings';
import { PresetStudio, baseHashOf, servicesOf } from '../../../src/features/presetStudio/studio';
import type { StudioTab } from '../../../src/features/presetStudio/studio';
import type { NeighbourPrompt, NeighbourPromptsApi } from '../../../src/features/neighbourPrompts/api';
import { click, createStand, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let studio: PresetStudio;
let scoped: ScopedLayerOp[];
let bound: { chat: string | null; character: string | null };
const recorded: { base: string; op: LayerOp; scope?: LayerScope }[] = [];
const moved: { index: number; scope: LayerScope }[] = [];
const binds: { scope: string; preset: string | null }[] = [];

const context = { character: { avatar: 'alice.png', name: 'Alice' }, chat: { id: 'chat-1' } };
const row = (id: string) => qa('.maestro-m34-block').find((node) => node.dataset.id === id) as HTMLElement;
const tab = async (id: StudioTab) => {
    click(qa('.maestro-tab').find((node) => node.dataset.tab === id));
    await wait();
};
const change = (node: HTMLSelectElement | HTMLTextAreaElement | null, value: string, event = 'change') => {
    (node as HTMLSelectElement).value = value;
    node?.dispatchEvent(new Event(event, { bubbles: true }));
};

beforeEach(() => {
    s = createStand();
    s.app.i18n.register(SCOPE_STRINGS);
    s.expose();
    recorded.length = 0;
    moved.length = 0;
    binds.length = 0;
    scoped = [];
    bound = { chat: null, character: null };
    const layer = s.layer as unknown as Record<string, unknown>;
    layer.get = (base: string) => {
        const global = (s.layer.layers.get(base) ?? []).map((op) => ({ ...op, scope: 'global' as const }));
        const ops = [...global, ...scoped];
        return ops.length ? { base, ops, updatedAt: 1 } : null;
    };
    layer.record = async (base: string, op: LayerOp, scope?: LayerScope) => {
        recorded.push({ base, op, scope });
    };
    layer.context = () => context;
    layer.whenContext = async () => context;
    layer.below = (base: string, scope: LayerScope) => {
        const body = structuredClone(s.store.saved(base));
        if (body && scope !== 'global')
            body.prompts!.find((item) => item.identifier === 'style')!.content = 'Global style';
        return body;
    };
    layer.moveOp = async (_base: string, index: number, scope: LayerScope) => {
        moved.push({ index, scope });
    };
    layer.bindings = (): PresetBindings => ({
        ...bound,
        active: bound.chat
            ? { scope: 'chat', preset: bound.chat }
            : bound.character
              ? { scope: 'character', preset: bound.character }
              : null,
        context,
    });
    layer.bind = async (scope: string, preset: string | null) => {
        binds.push({ scope, preset });
        if (scope === 'chat') bound.chat = preset;
        else bound.character = preset;
    };
    studio = new PresetStudio({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        settings: s.settings,
        saveSettings: vi.fn(),
        pm: new PmInfo(s.app, s.app.log),
        showClassic: () => {},
    });
});

afterEach(() => {
    studio.close();
});

describe('where edits go', () => {
    it('the editor’s switch sends the edit to the chat, made on the base below that scope', async () => {
        studio.open();
        await wait();
        click(row('style').querySelector('.maestro-m34-block-name'));
        await wait();
        const scope = q<HTMLSelectElement>('select.maestro-m34-editor-scope');
        expect([...(scope?.options ?? [])].map((option) => option.text)).toEqual([
            'Everywhere',
            'This character (Alice)',
            'This chat',
        ]);
        expect(scope?.value).toBe('global');
        change(scope, 'chat');
        await wait();
        expect(q('.maestro-m34-scope-badge')?.textContent).toBe('Edits → This chat');
        change(q<HTMLTextAreaElement>('.maestro-m34-f-content'), 'Chat style', 'input');
        click(q('.maestro-m34-editor-save'));
        await wait();
        expect(recorded.at(-1)).toEqual({
            base: 'Marinara',
            op: {
                op: 'edit',
                identifier: 'style',
                patch: { content: 'Chat style' },
                baseHash: baseHashOf('Global style'),
                baseText: 'Global style',
            },
            scope: 'chat',
        });
        expect(s.store.called('updatePrompt')).toEqual([['style', { content: 'Chat style' }]]);
        // Toggles go to the same scope; «везде» is the default of a new window session.
        click(row('extra').querySelector('.maestro-m34-toggle'));
        await wait();
        expect(recorded.at(-1)?.scope).toBe('chat');
    });

    it('an edit of the chat’s own block stays in the chat whatever the switch says', async () => {
        scoped = [
            {
                op: 'add',
                prompt: { identifier: 'extra', name: 'Extra', content: 'x' },
                anchor: { kind: 'start' },
                enabled: true,
                scope: 'chat',
                owner: 'chat-1',
            },
        ];
        studio.open();
        await wait();
        click(row('extra').querySelector('.maestro-m34-toggle'));
        await wait();
        expect(recorded.at(-1)?.scope).toBe('chat');
    });
});

describe('the «Слой» tab', () => {
    it('groups the ops by scope and moves one into another scope', async () => {
        s.layer.layers.set('Marinara', [{ op: 'toggle', identifier: 'main', enabled: false }]);
        scoped = [
            { op: 'key', key: 'temperature', value: 0.3, scope: 'character', owner: 'alice.png' },
            { op: 'toggle', identifier: 'style', enabled: false, scope: 'chat', owner: 'chat-1' },
        ];
        studio.open();
        await wait();
        await tab('layer');
        expect(qa('.maestro-m34-op-scope').map((node) => node.textContent)).toEqual([
            'Everywhere: 1',
            'This character (Alice): 1',
            'This chat: 1',
        ]);
        const chatOp = qa('.maestro-m34-op').find((node) => node.dataset.scope === 'chat') as HTMLElement;
        expect(chatOp.dataset.index).toBe('2');
        const select = chatOp.querySelector<HTMLSelectElement>('.maestro-m34-op-move');
        expect([...(select?.options ?? [])].map((option) => option.value)).toEqual(['global', 'character', 'chat']);
        change(select, 'global');
        await wait();
        expect(moved).toEqual([{ index: 2, scope: 'global' }]);
        change(q<HTMLSelectElement>('select.maestro-m34-layer-scope'), 'character');
        await wait();
        expect(studio.router.scope()).toBe('character');
    });
});

describe('the preset of this character or chat', () => {
    it('shows the binding in the header and binds the current preset to the chat', async () => {
        studio.open();
        await wait();
        expect(q('.maestro-m34-binding')).toBeNull();
        click(q('.maestro-m34-bind'));
        await wait();
        expect(s.popupTexts.at(-1)).toContain('Bind «Marinara»?');
        expect(binds).toEqual([{ scope: 'chat', preset: 'Marinara' }]);
        expect(q('.maestro-m34-binding')?.textContent).toBe('Preset of this chat: Marinara');
        // Now the chat has it: «To Alice» first, then «Unbind from the chat».
        s.answer(100);
        click(q('.maestro-m34-bind'));
        await wait();
        expect(binds.at(-1)).toEqual({ scope: 'chat', preset: null });
    });
});

describe('the «Промпты соседей» tab', () => {
    function entry(fields: Partial<NeighbourPrompt>): NeighbourPrompt {
        return {
            id: 'des.html',
            owner: 'des',
            label: 'DES immersive HTML',
            description: 'HTML pieces.',
            present: true,
            text: 'Built-in HTML',
            globalText: 'Built-in HTML',
            setting: '',
            scoped: {},
            editable: true,
            scopable: true,
            usedIn: 'prompt',
            ...fields,
        };
    }

    it('lists the neighbours’ texts and saves a copy for this chat', async () => {
        const entries = [
            entry({}),
            entry({
                id: 'desru.languageLock',
                owner: 'desru',
                label: 'DES-RU language rule',
                editable: false,
                setting: undefined,
                scoped: { chat: 'English here.' },
                text: 'English here.',
            }),
            entry({ id: 'maestro.director', owner: 'maestro', label: 'Director', editable: false, scopable: false }),
            entry({ id: 'qvink.prompt', owner: 'qvink', present: false, label: 'Qvink' }),
        ];
        const api = {
            list: () => entries,
            get: (id: string) => entries.find((item) => item.id === id) ?? null,
            setGlobal: vi.fn(async () => {}),
            setScoped: vi.fn(async () => {}),
            effective: () => '',
            lastReport: () => ({ at: 1, replaced: ['desru.languageLock'], notFound: [] }),
            ready: async () => {},
            onChange: () => () => {},
        } satisfies NeighbourPromptsApi;
        s.app.modules.expose('neighbourPrompts', api);
        studio.open();
        await wait();
        await tab('neighbours');
        expect(qa('.maestro-m34-neighbour-group').map((node) => node.dataset.owner)).toEqual([
            'des',
            'desru',
            'maestro',
        ]);
        expect(q('.maestro-m34-neighbours')?.textContent).toContain('own copies used — DES-RU language rule');
        const lock = qa('.maestro-m34-neighbour').find(
            (node) => node.dataset.id === 'desru.languageLock',
        ) as HTMLElement;
        expect(lock.textContent).toContain('own in this chat');
        expect(lock.querySelector('.maestro-m34-neighbour-reset-chat')).not.toBeNull();
        const director = qa('.maestro-m34-neighbour').find(
            (node) => node.dataset.id === 'maestro.director',
        ) as HTMLElement;
        expect(director.querySelector('.maestro-m34-neighbour-edit')).toBeNull();
        click(q('.maestro-m34-neighbour[data-id="des.html"] .maestro-m34-neighbour-edit'));
        await wait();
        const select = q<HTMLSelectElement>('.maestro-m34-neighbour-scope');
        expect([...(select?.options ?? [])].map((option) => option.value)).toEqual(['global', 'character', 'chat']);
        change(select, 'chat');
        change(q<HTMLTextAreaElement>('.maestro-m34-neighbour-area'), 'No HTML here.', 'input');
        click(q('.maestro-m34-neighbour-save'));
        await wait();
        expect(api.setScoped).toHaveBeenCalledWith('des.html', 'chat', 'No HTML here.');
        expect(s.notices.at(-1)?.text).toBe('This chat now has an own «DES immersive HTML».');
        click(
            lock.isConnected
                ? lock.querySelector('.maestro-m34-neighbour-reset-chat')
                : q('.maestro-m34-neighbour-reset-chat'),
        );
        await wait();
        expect(api.setScoped).toHaveBeenLastCalledWith('desru.languageLock', 'chat', null);
    });

    it('says when the module is off', async () => {
        studio.open();
        await wait();
        await tab('neighbours');
        expect(q('.maestro-m34-neighbours')?.textContent).toContain('The neighbour prompts module is off.');
    });
});
