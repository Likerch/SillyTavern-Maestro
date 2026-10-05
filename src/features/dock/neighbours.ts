// What the dock knows about each neighbour's page — from the sources the bench runs (tools/stand/runtime/vendor/exports:
// Dooms-Enhancement-Suite@10ad241514, SillyTavern-Doom-Enhancement-Suite-RU@f32b711578, CarrotKernel@145c273768,
// SillyTavern-MessageSummarize@81b3326c1d, SillyTavern-LorebookLocalizer@de3dec4d84, SillyTavern-NAI-Studio 0.11–0.12):
// where its settings block is and how its own windows are opened. Shortcuts only click the neighbour's own buttons, run
// its own slash command or call its own public opener — never write its settings; a window whose opener is not on the
// page right now is simply not offered.
import { adaptersOf } from '../../adapters';
import type { CkAdapter } from '../../adapters';
import type { App, NeighbourAdapter } from '../../shared/contracts';
import { ST_EXTENSION_COLUMNS } from './dock';
import type { DockTarget } from './dock';
import type { DockNeighbourId } from './settings';

export interface DockNeighbour {
    id: DockNeighbourId;
    /** i18n key of the card title (the extension's name). */
    nameKey: string;
    adapter: NeighbourAdapter['id'];
    /** The outermost node the neighbour put into ST's extensions column. */
    block: DockTarget;
    /** i18n key of a note shown in the card (what does not work while the block is in the pult). */
    noteKey?: string;
    /** When the block must stay home right now: the i18n key of the reason (e.g. Qvink's settings are popped out). */
    busy?(page: Document): string | null;
}

export interface Shortcut {
    id: string;
    neighbour: DockNeighbourId;
    labelKey: string;
    icon: string;
    /**
     * `close`: the pult closes first (its blocks go home), then the opener runs — the neighbour's window must not open
     * under Maestro's modal dialog. `docked`: the window is drawn inside the neighbour's own block (CK), so it runs
     * while that block is in the pult, with the block's drawer opened.
     */
    mode: 'close' | 'docked';
    /** The opener available right now, or null. */
    find(app: App): (() => void | Promise<unknown>) | null;
}

const page = (): Document | null => (typeof document === 'undefined' ? null : document);

/** Hidden by the neighbour itself (`hidden`, jQuery's inline `display: none`): its button would do nothing. */
function shown(node: HTMLElement): boolean {
    for (let current: HTMLElement | null = node; current; current = current.parentElement) {
        if (current.hidden || current.style.display === 'none') return false;
    }
    return true;
}

/** A click on the neighbour's first usable button. */
function clickFirst(
    selectors: readonly string[],
    options: { visible?: boolean; enabled?: boolean } = {},
): (() => void) | null {
    const doc = page();
    if (!doc) return null;
    for (const selector of selectors) {
        const node = doc.querySelector<HTMLElement>(selector);
        if (!node) continue;
        if (options.visible && !shown(node)) continue;
        if (options.enabled && (node as HTMLButtonElement).disabled) continue;
        return () => node.click();
    }
    return null;
}

/** The neighbour's own slash command, when it is registered in this ST. */
function slash(app: App, name: string): (() => Promise<unknown>) | null {
    const ctx = app.host.ctx() as Partial<STContext>;
    if (!ctx.SlashCommandParser?.commands?.[name] || typeof ctx.executeSlashCommandsWithOptions !== 'function') {
        return null;
    }
    const run = ctx.executeSlashCommandsWithOptions.bind(ctx);
    return () => run(`/${name}`, { handleExecutionErrors: true });
}

/** A method of CK's public object `window.CarrotKernel` (index.js:6518), read live through the CK adapter. */
function ckMethod(app: App, method: string): (() => unknown) | null {
    let kernel: Record<string, unknown> | null = null;
    try {
        kernel = (adaptersOf(app).ck as Partial<Pick<CkAdapter, 'kernel'>>).kernel?.() ?? null;
    } catch {
        return null;
    }
    const fn = kernel?.[method];
    return typeof fn === 'function' ? () => (fn as () => unknown).call(kernel) : null;
}

/** The outer wrapper of a block found by an inner node: the drawer itself, or its parent when that is not a column. */
function outerOf(inner: Element | null): HTMLElement | null {
    const drawer = inner?.closest<HTMLElement>('.inline-drawer') ?? null;
    if (!drawer) return null;
    const parent = drawer.parentElement;
    if (!parent || parent.matches(ST_EXTENSION_COLUMNS.join(', '))) return drawer;
    return parent;
}

/*
 * CK (index.js:7220): `#carrot_settings` in the LEFT column #extensions_settings. All lookups are document-wide by id;
 * its own popups (repository, templates, packs, tutorials) are fixed overlays inside the block's drawer content
 * (settings.html:822-900), so they show only while the block is expanded in a visible place.
 */
const CK: DockNeighbour = {
    id: 'ck',
    nameKey: 'm32.dock.n.ck',
    adapter: 'ck',
    block: { id: 'ck', selectors: ['#carrot_settings'] },
};

/*
 * Qvink (index.js:703): the OUTER block `#qvink_memory_settings` in #extensions_settings2 (the class
 * `qvink_memory_settings_content` is on the inner div too). Its pop-out moves the inner div into a body-level
 * `#qmExtensionPopout` and back on every Escape (index.js:4846-4920): docking the outer block keeps that working;
 * while the pop-out is open the block stays home.
 */
const QVINK: DockNeighbour = {
    id: 'qvink',
    nameKey: 'm32.dock.n.qvink',
    adapter: 'qvink',
    block: { id: 'qvink', selectors: ['#qvink_memory_settings'] },
    busy: (doc) => (doc.getElementById('qmExtensionPopout') ? 'm32.dock.qvinkPopout' : null),
};

/*
 * NAI Studio (src/index.ts:38-63): `#naist_panel` — the studio itself — in #extensions_settings2 (fallback
 * #extensions_settings); root-scoped native listeners. Its tag autocomplete is a body-level fixed list, which stays
 * under a modal dialog: it does not show while the panel is in the pult.
 */
const NAI: DockNeighbour = {
    id: 'nai',
    nameKey: 'm32.dock.n.nai',
    adapter: 'nai',
    block: { id: 'nai', selectors: ['#naist_panel'] },
    noteKey: 'm32.dock.naiNote',
};

/** DES-RU (panel.js:33): `#desru-settings`, inserted once into #extensions_settings2; it keeps a reference. */
const DESRU: DockNeighbour = {
    id: 'desru',
    nameKey: 'm32.dock.n.desru',
    adapter: 'desru',
    block: { id: 'desru', selectors: ['#desru-settings'] },
};

/** Localizer (src/ui.js:35-56): an id-less `.lorebook-localizer-settings` in #extensions_settings2. */
const LOCALIZER: DockNeighbour = {
    id: 'localizer',
    nameKey: 'm32.dock.n.localizer',
    adapter: 'localizer',
    block: { id: 'localizer', selectors: ['.lorebook-localizer-settings'] },
};

/*
 * DES (index.js:287): settings.html appended to #extensions_settings2 — an anonymous <div> around the `.inline-drawer`
 * holding #rpg-extension-enabled; handlers are bound to the nodes or delegated on document. DES-RU finds it the same
 * way (des-adapter.js:69).
 */
const DES: DockNeighbour = {
    id: 'des',
    nameKey: 'm32.dock.n.des',
    adapter: 'des',
    block: {
        id: 'des',
        selectors: [],
        locate: (doc) => [...doc.querySelectorAll('#rpg-extension-enabled')].map((node) => outerOf(node)),
    },
};

/** In the order of plan M32 п.5. */
export const NEIGHBOURS: readonly DockNeighbour[] = [CK, QVINK, NAI, DESRU, LOCALIZER, DES];

/*
 * DES's portrait bar (src/systems/ui/portraitBar.js:181): created once and placed by DES's `portraitPosition` (above or
 * below #send_form, before #chat, or fixed at the left/right of <body>); rendered by id, so it keeps working in the
 * pult. If its parent is gone it goes above #send_form, DES's default. DES's own repositionPortraitBar() (called by its
 * «Position» select) puts it back too.
 */
export const PORTRAIT_BAR: DockTarget = {
    id: 'desPortraits',
    selectors: ['#dooms-portrait-bar-wrapper'],
    fallback: (doc) => {
        const form = doc.getElementById('send_form');
        if (form?.parentNode) return { parent: form.parentNode, before: form };
        const sheld = doc.getElementById('sheld');
        return sheld ? { parent: sheld, before: null } : null;
    },
};

export const SHORTCUTS: readonly Shortcut[] = [
    {
        // CK's windows are drawn in its block: the global API (index.js:6518) opens them where the block is.
        id: 'ckRepository',
        neighbour: 'ck',
        labelKey: 'm32.dock.open.ckRepository',
        icon: 'fa-box-archive',
        mode: 'docked',
        find: (app) =>
            ckMethod(app, 'openRepositoryManager') ?? clickFirst(['#carrot_settings .carrot-status-repository']),
    },
    {
        id: 'ckTemplates',
        neighbour: 'ck',
        labelKey: 'm32.dock.open.ckTemplates',
        icon: 'fa-file-pen',
        mode: 'docked',
        find: (app) =>
            ckMethod(app, 'openTemplateManager') ?? clickFirst(['#carrot_settings .carrot-status-templates']),
    },
    {
        id: 'ckPacks',
        neighbour: 'ck',
        labelKey: 'm32.dock.open.ckPacks',
        icon: 'fa-boxes-stacked',
        mode: 'docked',
        find: (app) => ckMethod(app, 'openPackManager') ?? clickFirst(['#carrot_settings .carrot-status-packs']),
    },
    {
        // index.js:4575: «/qm-toggle-edit-interface» only shows the editor (an ST popup); the button is disabled while
        // memory is off for the chat.
        id: 'qvinkMemory',
        neighbour: 'qvink',
        labelKey: 'm32.dock.open.qvinkMemory',
        icon: 'fa-brain',
        mode: 'close',
        find: (app) => slash(app, 'qm-toggle-edit-interface') ?? clickFirst(['#edit_memory_state'], { enabled: true }),
    },
    {
        // The Images tab's button (tab-images.ts:49), else «/nai-gallery».
        id: 'naiGallery',
        neighbour: 'nai',
        labelKey: 'm32.dock.open.naiGallery',
        icon: 'fa-images',
        mode: 'close',
        find: (app) => clickFirst(['#naist_img_open_gallery']) ?? slash(app, 'nai-gallery'),
    },
    {
        // Scene composer: delegated on document (scene-setup.ts:255), else «/nai-scene».
        id: 'naiScene',
        neighbour: 'nai',
        labelKey: 'm32.dock.open.naiScene',
        icon: 'fa-clapperboard',
        mode: 'close',
        find: (app) => clickFirst(['#naist_open_composer']) ?? slash(app, 'nai-scene'),
    },
    {
        // The World Info toolbar button or the settings block's «Open» (both call onOpen, index.js:15-32).
        id: 'localizer',
        neighbour: 'localizer',
        labelKey: 'm32.dock.open.localizer',
        icon: 'fa-language',
        mode: 'close',
        find: () => clickFirst(['#lorebook_localizer_button', '.lorebook-localizer-settings .lbl-open']),
    },
    {
        // index.js:316: loads DES's windows on first use (ensureSettingsUI) and opens its settings.
        id: 'desSettings',
        neighbour: 'des',
        labelKey: 'm32.dock.open.desSettings',
        icon: 'fa-sliders',
        mode: 'close',
        find: () => clickFirst(['#dooms-open-settings-btn']),
    },
    {
        // The roster («Workshop» in DES's menu): from DES's settings window once it was loaded (delegated,
        // characterRoster.js:111), else the bar's own button, which loads the windows itself (portraitBar.js:421).
        id: 'desRoster',
        neighbour: 'des',
        labelKey: 'm32.dock.open.desRoster',
        icon: 'fa-users-rectangle',
        mode: 'close',
        find: () =>
            clickFirst(['#rpg-open-character-roster']) ?? clickFirst(['#dooms-pb-open-roster'], { visible: true }),
    },
    {
        // Lore Library: the button exists once DES's windows were loaded (template.html:1570, index.js:1788).
        id: 'desLore',
        neighbour: 'des',
        labelKey: 'm32.dock.open.desLore',
        icon: 'fa-book-atlas',
        mode: 'close',
        find: () => clickFirst(['#rpg-open-lorebook']),
    },
    {
        // Tracker editor: delegated on document (trackerEditor.js:111), button in DES's settings window.
        id: 'desTracker',
        neighbour: 'des',
        labelKey: 'm32.dock.open.desTracker',
        icon: 'fa-table-list',
        mode: 'close',
        find: () => clickFirst(['#rpg-open-tracker-editor']),
    },
];
