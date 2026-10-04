// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PmInfo } from '../../../src/features/presetStudio/launcher';
import type { ScenariosApi } from '../../../src/features/scenarios/api';
import { PresetStudio, baseHashOf, servicesOf } from '../../../src/features/presetStudio/studio';
import type { StudioTab } from '../../../src/features/presetStudio/studio';
import { POPUP_RESULT } from '../../helpers/ui-env';
import { CUSTOM, click, createStand, presetBody, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let studio: PresetStudio;
let classic: number;

const rowIds = () => qa('.maestro-m34-block').map((node) => node.dataset.id);
const row = (id: string) => qa('.maestro-m34-block').find((node) => node.dataset.id === id) as HTMLElement;
const tab = async (id: StudioTab) => {
    click(qa('.maestro-tab').find((node) => node.dataset.tab === id));
    await wait();
};
const input = (
    node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
    value: string,
    event = 'change',
) => {
    (node as HTMLInputElement).value = value;
    node?.dispatchEvent(new Event(event, { bubbles: true }));
};

async function open(identifier?: string): Promise<void> {
    studio.open(identifier);
    await wait();
}

function withLayer(ops = true): void {
    if (ops) s.layer.layers.set('Marinara', [{ op: 'toggle', identifier: 'main', enabled: true }]);
}

beforeEach(() => {
    s = createStand();
    s.expose();
    s.lore.openai.promptManager = {
        tokenUsage: 100,
        error: null,
        overriddenPrompts: ['main'],
        tokenHandler: { getCounts: () => ({ main: 12, style: 8 }) },
    };
    s.analysis.slots = [
        {
            identifier: 'main',
            name: 'Main Prompt',
            role: 'system',
            placement: 'relative',
            tokens: 40,
            enabled: true,
            marker: false,
            injections: [{ owner: 'DES', key: 'des_scene', tokens: 30, where: 'end' }],
        },
        {
            identifier: 'style',
            name: 'Style',
            role: 'system',
            placement: 'relative',
            tokens: 9,
            enabled: true,
            marker: false,
            injections: [],
            tokensFrom: 'count',
            note: 'glued with lore',
            triggers: ['normal'],
        },
        {
            identifier: 'extra',
            name: 'Extra',
            role: 'user',
            placement: 'depth',
            depth: 2,
            order: 99,
            tokens: 3,
            enabled: false,
            marker: false,
            injections: [],
            dropped: 'switched off',
        },
    ];
    s.analysis.list = [
        {
            kind: 'contradiction',
            severity: 'warn',
            identifier: 'style',
            otherIdentifier: 'extra',
            text: 'Short vs long',
        },
        { kind: 'heavyBlock', severity: 'info', identifier: 'main', text: 'Main is heavy' },
    ];
    s.analysis.hintList = [{ model: 'deepseek/deepseek-v4', text: 'Prefill closes with EOS' }];
    classic = 0;
    studio = new PresetStudio({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        settings: s.settings,
        saveSettings: vi.fn(),
        pm: new PmInfo(s.app, s.app.log),
        showClassic: () => classic++,
    });
});

afterEach(() => {
    studio.close();
});

describe('window and tabs', () => {
    it('opens a large dialog on the block list in PM order', async () => {
        await open();
        expect(q('.popup.maestro-m34-dialog')).not.toBeNull();
        expect(rowIds()).toEqual(['main', 'charDescription', 'style', 'extra', 'chatHistory']);
        expect(row('extra').classList.contains('maestro-m34-off')).toBe(true);
        expect(q('.maestro-m34-count')?.textContent).toBe('On: 4 of 5');
        // Tokens come from the analysis map, the card override from PM.
        expect(row('main').querySelector('.maestro-m34-tokens')?.textContent).toBe('40');
        expect(row('main').textContent).toContain('card');
        expect(q<HTMLSelectElement>('.maestro-m34-preset')?.value).toBe('Marinara');
        expect(q('.maestro-m34-mode')?.textContent).toBe('Edits → preset');
        expect(q('.maestro-m34-unsaved')).toBeNull();
        // Markers are not deletable, user blocks are (P-025, P-029).
        expect(row('charDescription').querySelector('.maestro-m34-delete')).toBeNull();
        expect(row('style').querySelector('.maestro-m34-delete')).not.toBeNull();
        expect(q<HTMLSelectElement>('.maestro-m34-insert-select')?.options.length).toBe(2);
    });

    it('renders every tab', async () => {
        await open();
        await tab('map');
        expect(qa('.maestro-m34-slot').map((node) => node.dataset.id)).toEqual(['main', 'style', 'extra']);
        expect(q('.maestro-m34-injections')?.textContent).toContain('DES: des_scene');
        expect(q('.maestro-m34-slot-note')?.textContent).toBe('glued with lore');
        expect(qa('.maestro-m34-estimated')).toHaveLength(1);
        expect(q('.maestro-m34-dropped')?.textContent).toContain('switched off');
        input(q<HTMLSelectElement>('.maestro-m34-map-type'), 'continue');
        await wait();
        expect(s.analysis.options.at(-1)).toEqual({ type: 'continue' });

        await tab('analysis');
        expect(qa('.maestro-m34-finding')).toHaveLength(2);
        expect(q('.maestro-m34-finding-kind')?.textContent).toBe('Contradiction');
        expect(qa('.maestro-m34-finding')[0]!.querySelectorAll('.maestro-m34-finding-open')).toHaveLength(2);
        expect(q('.maestro-m34-hints')?.textContent).toContain('deepseek/deepseek-v4');
        click(qa('.maestro-m34-finding-open')[1]);
        await wait();
        expect(studio.editorOpen()).toBe('extra');

        await tab('layer');
        expect(q('.maestro-m34-layer')).not.toBeNull();
        expect(q('.maestro-m34-layer-start')).not.toBeNull();

        await tab('versions');
        expect(q('.maestro-m34-versions')?.textContent).toContain('No versions yet');

        await tab('params');
        expect(q<HTMLInputElement>('[data-key="temperature"]')?.value).toBe('1');
        expect(q<HTMLInputElement>('[data-key="stream_openai"]')?.checked).toBe(true);
        expect(q('.maestro-m34-scenarios')?.textContent).toContain('not running');
        expect(studio.currentTab()).toBe('params');
        expect(s.settings.tab).toBe('params');
    });

    it('shows Prompt Manager’s assembly error in the header (P-010)', async () => {
        (s.lore.openai.promptManager as { error: string | null }).error = 'Not enough tokens for mandatory prompts';
        await open();
        await wait();
        expect(q('.maestro-m34-pm-error')?.getAttribute('title')).toBe('Not enough tokens for mandatory prompts');
    });

    it('refuses Text Completion and a missing store', async () => {
        s.lore.app.host.isChatCompletion = () => false;
        studio.open();
        expect(q('.maestro-m34-dialog')).toBeNull();
        expect(s.notices.at(-1)?.text).toContain('Chat Completion');
        s.lore.app.host.isChatCompletion = () => true;
        s.app.modules.expose('presetStore', undefined);
        studio.open();
        expect(q('.maestro-m34-dialog')).toBeNull();
    });

    it('opens on a block by identifier or name and goes to the classic editor', async () => {
        await open('Extra');
        expect(studio.editorOpen()).toBe('extra');
        expect(q<HTMLInputElement>('.maestro-m34-f-name')?.value).toBe('Extra');
        click(q('.maestro-m34-classic'));
        await wait();
        expect(classic).toBe(1);
        expect(studio.isOpen()).toBe(false);
    });
});

describe('preset switch', () => {
    async function switchTo(name: string): Promise<void> {
        input(q<HTMLSelectElement>('.maestro-m34-preset'), name);
        await wait();
    }

    it('warns about the draft: cancel keeps the preset', async () => {
        await s.store.setKeys({ temperature: 1.5 });
        await open();
        expect(q('.maestro-m34-unsaved')).not.toBeNull();
        s.answer(null);
        await switchTo('Yablochny');
        expect(s.popupTexts.at(-1)).toContain('unsaved changes');
        expect(s.store.called('select')).toEqual([]);
        expect(q<HTMLSelectElement>('.maestro-m34-preset')?.value).toBe('Marinara');
    });

    it('warns about the draft: drop switches, save saves first', async () => {
        await s.store.setKeys({ temperature: 1.5 });
        await open();
        s.answer(CUSTOM);
        await switchTo('Yablochny');
        expect(s.store.called('save')).toEqual([]);
        expect(s.store.called('select')).toEqual([['Yablochny']]);
        await s.store.setKeys({ temperature: 0.2 });
        s.answer(POPUP_RESULT.AFFIRMATIVE);
        await switchTo('Marinara');
        expect(s.store.called('save')).toEqual([['Yablochny', 'Saved in the Preset Studio']]);
        expect(s.store.called('select').at(-1)).toEqual(['Marinara']);
    });

    it('switches without asking when nothing is unsaved', async () => {
        await open();
        await switchTo('Yablochny');
        expect(s.callGenericPopup).not.toHaveBeenCalled();
        expect(s.store.called('select')).toEqual([['Yablochny']]);
        expect(q<HTMLSelectElement>('.maestro-m34-preset')?.value).toBe('Yablochny');
    });

    it('in layer mode offers «into the layer» with a preview', async () => {
        withLayer();
        await s.store.setKeys({ temperature: 1.5 });
        await open();
        s.answer(POPUP_RESULT.AFFIRMATIVE, POPUP_RESULT.AFFIRMATIVE);
        await switchTo('Yablochny');
        expect(s.popupTexts[0]).toContain('outside your layer');
        expect(s.popupTexts[1]).toContain('Block operations: 1');
        expect(s.layer.migrations).toHaveLength(1);
        expect(s.store.called('save')).toEqual([]);
        expect(s.store.called('select')).toEqual([['Yablochny']]);
    });
});

describe('edits', () => {
    it('go to the layer when the base has one (recorded, then applied)', async () => {
        withLayer();
        await open();
        expect(q('.maestro-m34-mode')?.textContent).toBe('Edits → your layer');
        click(row('extra').querySelector('.maestro-m34-toggle'));
        await wait();
        expect(s.layer.recorded.at(-1)).toEqual({
            base: 'Marinara',
            op: { op: 'toggle', identifier: 'extra', enabled: true },
        });
        expect(s.store.called('setEnabled')).toEqual([[['extra'], true]]);
        click(row('style').querySelector('.maestro-m34-block-name'));
        await wait();
        input(q<HTMLTextAreaElement>('.maestro-m34-f-content'), 'Use short sentences.', 'input');
        click(q('.maestro-m34-editor-save'));
        await wait();
        const base = 'Use {{if .maestro_scene_combat}}short{{/if}} sentences.';
        expect(s.layer.recorded.at(-1)).toEqual({
            base: 'Marinara',
            op: {
                op: 'edit',
                identifier: 'style',
                patch: { content: 'Use short sentences.' },
                baseHash: baseHashOf(base),
                baseText: base,
            },
        });
        expect(s.store.called('updatePrompt')).toEqual([['style', { content: 'Use short sentences.' }]]);
        expect(studio.editorOpen()).toBeNull();
    });

    it('go to the store only without the layer API or with «edits to my layer» off', async () => {
        s.app.modules.expose('presetLayer', undefined);
        await open();
        click(row('extra').querySelector('.maestro-m34-toggle'));
        await wait();
        expect(s.store.called('setEnabled')).toEqual([[['extra'], true]]);
        expect(s.layer.recorded).toEqual([]);
        s.app.modules.expose('presetLayer', s.layer);
        withLayer();
        s.settings.editsToLayer = false;
        await tab('params');
        input(q<HTMLInputElement>('[data-key="temperature"]'), '0.8');
        await wait();
        expect(s.store.called('setKeys')).toEqual([[{ temperature: 0.8 }]]);
        expect(s.layer.recorded).toEqual([]);
    });

    it('a block made outside the studio is applied to the working copy only', async () => {
        withLayer();
        await s.store.addPrompt({ identifier: 'outside', name: 'Outside', content: 'x' }, 'main');
        s.store.calls.length = 0;
        await open();
        click(row('outside').querySelector('.maestro-m34-toggle'));
        await wait();
        expect(s.layer.recorded).toEqual([]);
        expect(s.store.called('setEnabled')).toEqual([[['outside'], false]]);
    });

    it('adds a new block (switched on, at the start) and duplicates one', async () => {
        await open();
        click(q('.maestro-m34-new'));
        await wait();
        input(q<HTMLInputElement>('.maestro-m34-f-name'), 'Tone', 'input');
        input(q<HTMLTextAreaElement>('.maestro-m34-f-content'), 'Dark tone.', 'input');
        click(q('.maestro-m34-editor-save'));
        await wait();
        const [added] = s.store.called('addPrompt');
        expect(added![0]).toMatchObject({
            name: 'Tone',
            content: 'Dark tone.',
            system_prompt: false,
            marker: false,
            enabled: true,
        });
        expect(added![1] ?? undefined).toBeUndefined();
        expect(rowIds()[0]).toBe((added![0] as { identifier: string }).identifier);
        click(row('style').querySelector('.maestro-m34-duplicate'));
        await wait();
        const copy = s.store.called('addPrompt')[1]!;
        expect(copy[0]).toMatchObject({ name: 'Style (copy)', enabled: false });
        expect(copy[1]).toBe('style');
    });

    it('deletes: a base block is switched off in the layer, a layer block loses its operations', async () => {
        withLayer();
        await s.layer.record('Marinara', {
            op: 'add',
            prompt: { identifier: 'mine', name: 'Mine' },
            anchor: { kind: 'end' },
            enabled: true,
        });
        s.store.work.prompts!.push({
            identifier: 'mine',
            name: 'Mine',
            content: '',
            system_prompt: false,
            marker: false,
        });
        await s.store.setEnabled(['mine'], true);
        s.store.calls.length = 0;
        await open();
        click(row('style').querySelector('.maestro-m34-delete'));
        await wait();
        expect(s.store.called('removePrompt')).toEqual([]);
        expect(s.store.called('setEnabled')).toEqual([[['style'], false]]);
        expect(s.notices.at(-1)?.text).toContain('switched off in your layer');
        click(row('mine').querySelector('.maestro-m34-delete'));
        await wait();
        expect(s.layer.removed).toEqual([{ base: 'Marinara', index: 1 }]);
        expect(s.store.called('removePrompt')).toEqual([['mine']]);
    });

    it('previews a block with macros substituted, asking first about side effects', async () => {
        (s.lore.ctx as { substituteParams: (text: string) => string }).substituteParams = (text) => text.toUpperCase();
        s.store.work.prompts!.find((item) => item.identifier === 'extra')!.content = '{{setvar::x::1}}Hi';
        await open();
        click(row('style').querySelector('.maestro-m34-expand'));
        await wait();
        expect(qa('.maestro-m34-hl-flag')).toHaveLength(1);
        click(row('style').querySelector('.maestro-m34-substitute'));
        await wait();
        expect(row('style').querySelector('.maestro-m34-substituted')?.textContent).toContain('USE {{IF');
        click(row('extra').querySelector('.maestro-m34-expand'));
        await wait();
        s.answer(null);
        click(row('extra').querySelector('.maestro-m34-substitute'));
        await wait();
        expect(s.popupTexts.at(-1)).toContain('setvar');
        expect(row('extra').querySelector('.maestro-m34-substituted')).toBeNull();
    });
});

describe('block editor guard', () => {
    it('asks before leaving unsaved edits: cancel stays, drop leaves', async () => {
        await open();
        click(row('style').querySelector('.maestro-m34-block-name'));
        await wait();
        input(q<HTMLInputElement>('.maestro-m34-f-name'), 'Style 2', 'input');
        s.answer(null);
        click(row('extra').querySelector('.maestro-m34-block-name'));
        await wait();
        expect(studio.editorOpen()).toBe('style');
        expect(s.popupTexts.at(-1)).toContain('unsaved edits');
        s.answer(CUSTOM);
        click(row('extra').querySelector('.maestro-m34-block-name'));
        await wait();
        expect(studio.editorOpen()).toBe('extra');
        expect(s.store.called('updatePrompt')).toEqual([]);
    });

    it('saves on «Save» from the guard and keeps the window open on cancel', async () => {
        await open();
        click(row('style').querySelector('.maestro-m34-block-name'));
        await wait();
        input(q<HTMLInputElement>('.maestro-m34-f-name'), 'Style 2', 'input');
        s.answer(null);
        click(q('.maestro-m34-close'));
        await wait();
        expect(studio.isOpen()).toBe(true);
        s.answer(POPUP_RESULT.AFFIRMATIVE);
        click(q('.maestro-m34-close'));
        await wait();
        expect(s.store.called('updatePrompt')).toEqual([['style', { name: 'Style 2' }]]);
        expect(studio.isOpen()).toBe(false);
    });

    it('asks before overwriting a block changed outside the studio (P-018)', async () => {
        await open();
        click(row('style').querySelector('.maestro-m34-block-name'));
        await wait();
        s.store.work.prompts!.find((item) => item.identifier === 'style')!.content = 'Changed by /setpromptentry';
        input(q<HTMLInputElement>('.maestro-m34-f-name'), 'Style 2', 'input');
        s.answer(null);
        click(q('.maestro-m34-editor-save'));
        await wait();
        expect(s.popupTexts.at(-1)).toContain('changed outside the studio');
        expect(s.store.called('updatePrompt')).toEqual([]);
    });

    it('only writes the fields the user changed, with strict types', async () => {
        s.store.work.prompts!.find((item) => item.identifier === 'extra')!.injection_depth = '3' as unknown as number;
        await open();
        click(row('extra').querySelector('.maestro-m34-block-name'));
        await wait();
        input(q<HTMLSelectElement>('.maestro-m34-f-position'), '1');
        click(q('.maestro-m34-editor-save'));
        await wait();
        expect(s.store.called('updatePrompt')).toEqual([['extra', { injection_position: 1, injection_depth: 3 }]]);
    });
});

describe('order', () => {
    it('moves with ↑/↓ and records anchored moves in layer mode', async () => {
        withLayer();
        await open();
        click(row('style').querySelector('.maestro-m34-down'));
        await wait();
        expect(s.store.called('reorder')).toEqual([[['main', 'charDescription', 'extra', 'style', 'chatHistory']]]);
        expect(s.layer.recorded.at(-1)?.op).toEqual({
            op: 'move',
            identifier: 'style',
            anchor: { kind: 'after', identifier: 'extra' },
        });
        expect(rowIds()).toEqual(['main', 'charDescription', 'extra', 'style', 'chatHistory']);
        expect(row('main').querySelector<HTMLButtonElement>('.maestro-m34-up')?.disabled).toBe(true);
    });

    it('moves by drag and with Alt+arrows', async () => {
        await open();
        const drag = (node: HTMLElement, type: string) =>
            node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        drag(row('chatHistory'), 'dragstart');
        drag(row('main'), 'dragover');
        drag(row('main'), 'drop');
        await wait();
        expect(s.store.called('reorder')).toEqual([[['chatHistory', 'main', 'charDescription', 'style', 'extra']]]);
        row('extra').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
        await wait();
        expect(s.store.called('reorder').at(-1)).toEqual([
            ['chatHistory', 'main', 'charDescription', 'extra', 'style'],
        ]);
    });

    it('turns selected blocks on and off together', async () => {
        await open();
        for (const id of ['style', 'extra']) {
            const box = row(id).querySelector<HTMLInputElement>('input[type=checkbox]')!;
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            await wait();
        }
        expect(q('.maestro-m34-bulk-count')?.textContent).toBe('Selected: 2');
        click(q('.maestro-m34-bulk-off'));
        await wait();
        expect(s.store.called('setEnabled')).toEqual([[['style', 'extra'], false]]);
    });

    it('searches and inserts a block from outside the list', async () => {
        await open();
        input(q<HTMLInputElement>('.maestro-m34-search'), 'extra', 'input');
        await wait(300);
        expect(rowIds()).toEqual(['extra']);
        expect(q('.maestro-m34-down')).toBeNull();
        input(q<HTMLInputElement>('.maestro-m34-search'), '', 'input');
        await wait(300);
        input(q<HTMLSelectElement>('.maestro-m34-insert-select'), 'loose');
        click(q('.maestro-m34-insert-btn'));
        await wait();
        expect(s.store.called('setEnabled')).toEqual([[['loose'], false]]);
        expect(rowIds()[0]).toBe('loose');
    });

    it('imports a prompt list in PM’s format', async () => {
        await open();
        const file = new File(
            [
                JSON.stringify({
                    version: 1,
                    type: 'full',
                    data: {
                        prompts: [
                            {
                                identifier: 'style',
                                name: 'Style',
                                content: 'Imported style',
                                system_prompt: false,
                                marker: false,
                            },
                            { identifier: 'fresh', name: 'Fresh', content: 'New', injection_depth: '2' },
                        ],
                        prompt_order: [
                            { identifier: 'fresh', enabled: true },
                            { identifier: 'main', enabled: true },
                        ],
                    },
                }),
            ],
            'st-prompts.json',
        );
        click(q('.maestro-m34-import-list'));
        await wait();
        const picker = q<HTMLInputElement>('.maestro-m34-hidden-file')!;
        Object.defineProperty(picker, 'files', { value: [file] });
        picker.dispatchEvent(new Event('change'));
        await wait(100);
        expect(s.store.called('updatePrompt')).toEqual([['style', { content: 'Imported style' }]]);
        expect(s.store.called('addPrompt')[0]![0]).toMatchObject({
            identifier: 'fresh',
            injection_depth: 2,
            system_prompt: false,
        });
        expect(rowIds().slice(0, 2)).toEqual(['fresh', 'main']);
        expect(row('fresh').classList.contains('maestro-m34-off')).toBe(false);
        expect(s.notices.at(-1)?.text).toContain('1 updated, 1 added');
    });
});

describe('versions and saving', () => {
    it('shows what a rollback changes and restores the version', async () => {
        s.store.versionList = [
            {
                id: 'v1',
                at: 1_700_000_000_000,
                by: 'user',
                summary: 'Before tuning',
                body: presetBody({ temperature: 0.3 }),
            },
        ];
        await open();
        await tab('versions');
        click(q('.maestro-m34-version-pick'));
        await wait();
        expect(q('.maestro-m34-version-detail')?.textContent).toContain('temperature');
        click(q('.maestro-m34-version-restore'));
        await wait();
        expect(s.store.called('restoreVersion')).toEqual([['Marinara', 'v1']]);
        expect(s.store.work.temperature).toBe(0.3);
    });

    it('«Save» writes the preset without a layer; «Save base» writes the base in layer mode', async () => {
        await open();
        click(q('.maestro-m34-save'));
        await wait();
        expect(s.store.called('save')).toEqual([['Marinara', 'Saved in the Preset Studio']]);
        expect(q('.maestro-m34-save-base')).toBeNull();
        withLayer();
        await s.store.setKeys({ temperature: 1.2 });
        await wait();
        click(q('.maestro-m34-save-base'));
        await wait();
        expect(s.store.called('save')).toHaveLength(2);
        expect(s.popupTexts.at(-1)).toContain('without your layer');
    });

    it('«Save» in layer mode: nothing to do, or the rest goes into the base or the layer', async () => {
        withLayer();
        await open();
        click(q('.maestro-m34-save'));
        await wait();
        expect(s.notices.at(-1)?.text).toContain('already in the layer');
        await s.store.setKeys({ temperature: 1.2 });
        s.answer(CUSTOM);
        click(q('.maestro-m34-save'));
        await wait();
        expect(s.store.called('save')).toHaveLength(1);
        expect(s.layer.migrations).toHaveLength(0);
    });

    it('runs the preset actions through the store', async () => {
        await open();
        s.answer('Copy');
        click(q('.maestro-m34-save-as'));
        await wait();
        expect(s.store.called('saveAs')).toEqual([['Copy']]);
        s.answer('Renamed');
        click(q('.maestro-m34-rename'));
        await wait();
        expect(s.store.called('rename')).toEqual([['Copy', 'Renamed']]);
        s.answer(CUSTOM);
        click(q('.maestro-m34-export'));
        await wait();
        expect(s.store.called('exportPreset')).toEqual([['Renamed', { withConnection: true, withSensitive: false }]]);
        click(q('.maestro-m34-delete-preset'));
        await wait();
        expect(s.store.called('remove')).toEqual([['Renamed']]);
    });
});

describe('layer tab', () => {
    it('resolves conflicts in three versions', async () => {
        withLayer();
        s.layer.report = {
            applied: 0,
            conflicts: [{ identifier: 'style', oldBase: 'old text', newBase: 'new text', mine: 'my text' }],
            orphaned: [],
        };
        await open();
        expect(row('style').querySelector('.maestro-m34-badge-conflict')).not.toBeNull();
        await tab('layer');
        const cols = qa('.maestro-m34-conflict-col');
        expect(cols.map((col) => col.firstChild?.textContent)).toEqual([
            'Old base',
            'New base (changes)',
            'Mine (changes)',
        ]);
        click(q('.maestro-m34-keep-mine'));
        await wait();
        click(q('.maestro-m34-take-new'));
        await wait();
        s.answer((content: HTMLElement) => {
            content.querySelector<HTMLTextAreaElement>('.maestro-m34-custom-text')!.value = 'merged text';
            return POPUP_RESULT.AFFIRMATIVE;
        });
        click(q('.maestro-m34-custom'));
        await wait();
        expect(s.layer.resolved).toEqual([
            { base: 'Marinara', identifier: 'style', choice: 'mine' },
            { base: 'Marinara', identifier: 'style', choice: 'newBase' },
            { base: 'Marinara', identifier: 'style', choice: { text: 'merged text' } },
        ]);
    });

    it('migrates with a preview that leaves connection keys out', async () => {
        await open();
        await tab('layer');
        let boxes: Record<string, boolean> = {};
        s.answer((content: HTMLElement) => {
            boxes = Object.fromEntries(
                [...content.querySelectorAll<HTMLInputElement>('.maestro-m34-migration-key')].map((box) => [
                    box.dataset.key,
                    box.checked,
                ]),
            );
            return POPUP_RESULT.AFFIRMATIVE;
        });
        input(q<HTMLSelectElement>('.maestro-m34-reference'), 'Yablochny');
        click(q('.maestro-m34-migrate'));
        await wait();
        expect(boxes).toEqual({ temperature: true, openrouter_model: false });
        expect(s.layer.migrations[0]?.base).toBe('Marinara');
        const keys = (s.layer.get('Marinara')?.ops ?? [])
            .filter((op) => op.op === 'key')
            .map((op) => (op.op === 'key' ? op.key : ''));
        expect(keys).toEqual(['temperature']);
        expect(q('.maestro-m34-report')?.textContent).toContain('Moved into the layer: 3');
        expect(q('.maestro-m34-mode')?.textContent).toBe('Edits → your layer');
    });

    it('lists, removes and transfers operations; reselects and prepares for disabling', async () => {
        withLayer();
        await open();
        await tab('layer');
        expect(q('.maestro-m34-op-text')?.textContent).toBe('«Main Prompt» on');
        click(q('.maestro-m34-op-remove'));
        await wait();
        expect(s.layer.removed).toEqual([{ base: 'Marinara', index: 0 }]);
        withLayer();
        studio.scheduleRefresh();
        await wait();
        input(q<HTMLSelectElement>('.maestro-m34-target'), 'Yablochny');
        click(q('.maestro-m34-transfer'));
        await wait();
        expect(s.layer.transfers).toEqual([{ from: 'Marinara', to: 'Yablochny' }]);
        click(q('.maestro-m34-reselect'));
        await wait();
        expect(s.layer.reselect).toHaveBeenCalled();
        s.answer('Marinara merged');
        click(q('.maestro-m34-prepare-merged'));
        await wait();
        expect(s.layer.prepareDisable).toHaveBeenCalledWith('saveMerged', 'Marinara merged');
        click(q('.maestro-m34-prepare-base'));
        await wait();
        expect(s.layer.prepareDisable).toHaveBeenLastCalledWith('reselectBase', undefined);
    });

    it('picks blocks of a foreign preset into the layer', async () => {
        await open();
        await tab('layer');
        click(q('.maestro-m34-foreign-import'));
        await wait();
        const picker = q<HTMLInputElement>('.maestro-m34-hidden-file')!;
        const foreign = presetBody({
            prompts: [
                { identifier: 'autonomy', name: 'Autonomy', content: 'Act on your own' },
                { identifier: 'style', name: 'Their style', content: 'x' },
            ],
        });
        Object.defineProperty(picker, 'files', { value: [new File([JSON.stringify(foreign)], 'Yablochny.json')] });
        picker.dispatchEvent(new Event('change'));
        await wait(100);
        expect(qa('.maestro-m34-foreign-item')).toHaveLength(2);
        for (const box of qa<HTMLInputElement>('.maestro-m34-foreign-box')) {
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            await wait();
        }
        click(q('.maestro-m34-foreign-add'));
        await wait(100);
        const added = s.layer.recorded.filter((item) => item.op.op === 'add');
        expect(added).toHaveLength(2);
        const ids = added.map((item) => (item.op.op === 'add' ? item.op.prompt.identifier : ''));
        expect(ids[0]).toBe('autonomy');
        // The clashing identifier got a new one.
        expect(ids[1]).not.toBe('style');
        expect(s.notices.at(-1)?.text).toContain('(switched off)');
    });
});

describe('parameters', () => {
    it('checks values against ST’s limits', async () => {
        await open();
        await tab('params');
        input(q<HTMLInputElement>('[data-key="temperature"]'), '5');
        await wait();
        expect(s.store.called('setKeys')).toEqual([]);
        expect(s.notices.at(-1)?.text).toContain('out of SillyTavern’s range');
        input(q<HTMLSelectElement>('[data-key="names_behavior"]'), '2');
        await wait();
        expect(s.store.called('setKeys')).toEqual([[{ names_behavior: 2 }]]);
    });

    it('edits scenario parameters through the scenarios API', async () => {
        const setParams = vi.fn();
        const api: ScenariosApi = {
            register: () => () => {},
            active: () => null,
            list: () => [
                {
                    id: 'impersonate',
                    titleKey: 'scn.impersonate.title',
                    types: ['impersonate'],
                    defaults: { enabled: false },
                    fields: ['enabled', 'max_tokens', 'stop', 'reasoning', 'messages'],
                },
            ],
            params: () => ({ enabled: false, max_tokens: 300, stop: ['\n{{char}}:'], reasoning: 'off', messages: [] }),
            setParams,
        };
        s.app.modules.expose('scenarios', api);
        await open();
        await tab('params');
        expect(q<HTMLTextAreaElement>('.maestro-m34-scn-stop')?.value).toBe('\\n{{char}}:');
        const enabled = q<HTMLInputElement>('.maestro-m34-scn-enabled')!;
        enabled.checked = true;
        enabled.dispatchEvent(new Event('change'));
        input(q<HTMLTextAreaElement>('.maestro-m34-scn-stop'), '\\n{{user}}:\nEND');
        input(q<HTMLSelectElement>('.maestro-m34-scn-reasoning'), 'keep');
        click(q('.maestro-m34-scn-add-history'));
        click(q('.maestro-m34-scn-reset'));
        expect(setParams.mock.calls).toEqual([
            ['impersonate', { enabled: true }],
            ['impersonate', { stop: ['\n{{user}}:', 'END'] }],
            ['impersonate', { reasoning: 'keep' }],
            ['impersonate', { messages: [{ role: 'user', content: '{{history}}' }] }],
            ['impersonate', null],
        ]);
    });
});
