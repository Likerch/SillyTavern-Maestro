// Pult tab «Расширения» (M32 п.5, Q30): «Ярлыки» to the neighbours' own windows, then one card per present neighbour
// holding its real settings block while the tab is open («Держать в пульте», on by default), and — when asked — DES's
// portrait bar. Closing or re-rendering the tab, stopping the module and unloading the page put every node back.
import type { App, PultTab } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Dock, DockEvent } from './dock';
import { NEIGHBOURS, PORTRAIT_BAR, SHORTCUTS } from './neighbours';
import type { DockNeighbour, Shortcut } from './neighbours';
import { DOCK_KEY, DOCK_TAB, keeps } from './settings';
import type { DockSettings } from './settings';

/*
 * ST styles extension blocks only inside its columns (style.css:5403 `#extensions_settings .inline-drawer-header`,
 * extensions-panel.css:10 `.extensions_block input`): the same look in the dock. Neighbour nodes are styled here only
 * by the stylesheet. Buttons that would pull part of a docked block out into a body-level window (under our modal
 * dialog, so unusable) are hidden while the block is in the pult: Qvink's pop-out, CK's lorebook pop-out.
 */
export const DOCK_CSS = `
.maestro-m32d { display: flex; flex-direction: column; gap: var(--maestro-gap); }
.maestro-m32d-shortcuts { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m32d-state { display: flex; flex-direction: column; gap: 6px; }
.maestro-m32d-slot { display: flex; flex-direction: column; min-width: 0; }
.maestro-m32d-slot:empty { display: none; }
.maestro-m32d-slot > * { max-width: 100%; }
.maestro-m32d-slot .inline-drawer-toggle.inline-drawer-header {
    background-image: linear-gradient(348deg, var(--white30a) 2%, var(--grey30a) 10%, var(--black70a) 95%,
        var(--SmartThemeQuoteColor) 100%);
    margin-bottom: 5px; border-radius: 10px; padding: 2px 5px; border: 1px solid var(--SmartThemeBorderColor);
    transition: all var(--animation-duration-2x);
}
.maestro-m32d-slot .inline-drawer-toggle.inline-drawer-header:hover { filter: brightness(150%); }
.maestro-m32d-slot input[type="checkbox"], .maestro-m32d-slot input[type="radio"] { margin-left: 10px; margin-right: 10px; }
.maestro-m32d-slot #qvink_popout_button, .maestro-m32d-slot #carrot-main-lorebook-popout-btn { display: none !important; }
.maestro-m32d-slot > #dooms-portrait-bar-wrapper {
    position: relative !important; inset: auto !important; z-index: auto !important; transform: none !important;
    width: auto !important; max-width: 100%; height: auto !important; box-shadow: none !important;
}
@media screen and (max-width: 1000px) {
    .maestro-m32d-shortcuts .maestro-btn { flex: 1 1 100%; justify-content: flex-start; }
}
`;

export interface DockViewDeps {
    app: App;
    dock: Dock;
    settings: () => DockSettings;
    /** Things the owner did to a docked node (the view updates the card's note). */
    onDockEvent(listener: (id: string, event: DockEvent) => void): () => void;
}

/** A neighbour is shown when its adapter reports it or its block is on the page. */
export function neighbourPresent(app: App, dock: Dock, neighbour: DockNeighbour): boolean {
    try {
        if (app.adapters[neighbour.adapter]?.present()) return true;
    } catch {
        // A probe that throws counts as absent; the DOM check below still applies.
    }
    return dock.isDocked(neighbour.id) || dock.find(neighbour.block) !== null;
}

export function dockTab(deps: DockViewDeps): PultTab {
    const { app, dock, settings } = deps;
    const t = app.i18n.t.bind(app.i18n);

    const commit = (path: string) => {
        app.settings.notify(`modules.${DOCK_KEY}.${path}`);
        app.settings.save();
    };

    const failed = (shortcut: Shortcut, error?: unknown) => {
        if (error !== undefined) app.log.warn(`dock: opener "${shortcut.id}" failed`, error);
        app.ui.notice(t('m32.dock.shortcutMissing', { name: t(shortcut.labelKey) }), { level: 'warn', urgent: true });
    };

    const run = async (shortcut: Shortcut) => {
        const open = shortcut.find(app);
        if (!open) {
            failed(shortcut);
            return;
        }
        try {
            await open();
        } catch (error) {
            failed(shortcut, error);
        }
    };

    /** `close` shortcuts: the pult closes first (the blocks go home — some openers live in them), then the opener. */
    const openOutside = async (shortcut: Shortcut) => {
        app.ui.closePult?.();
        await run(shortcut);
    };

    /** CK draws its windows inside its block: open the block's drawer (ST's own toggle), then call the opener. */
    const openDocked = async (shortcut: Shortcut, slot: HTMLElement) => {
        const drawer = slot.querySelector<HTMLElement>('.inline-drawer');
        const header = [...(drawer?.children ?? [])].find((child) => child.classList.contains('inline-drawer-toggle'));
        const icon = header?.querySelector('.inline-drawer-icon');
        if (header instanceof HTMLElement && icon && !icon.classList.contains('up')) header.click();
        drawer?.scrollIntoView({ block: 'start' });
        await run(shortcut);
    };

    const shortcutButton = (shortcut: Shortcut, onClick: () => Promise<void>) =>
        button({ label: t(shortcut.labelKey), icon: shortcut.icon, onClick });

    const shortcutsBlock = (present: Set<string>): HTMLElement | null => {
        const available = SHORTCUTS.filter(
            (shortcut) => shortcut.mode === 'close' && present.has(shortcut.neighbour) && shortcut.find(app),
        );
        if (!available.length) return null;
        return section(t('m32.dock.shortcuts'), [
            el('div', { class: 'maestro-hint', text: t('m32.dock.shortcutsHint') }),
            el(
                'div',
                { class: 'maestro-m32d-shortcuts' },
                available.map((shortcut) => shortcutButton(shortcut, () => openOutside(shortcut))),
            ),
        ]);
    };

    return {
        id: DOCK_TAB,
        titleKey: 'm32.dock.tab',
        icon: 'fa-puzzle-piece',
        order: 85,
        group: 'extensions',
        render(container) {
            const notes = new Map<string, HTMLElement>();
            const slots = new Map<string, HTMLElement>();
            const inBlock = new Map<string, HTMLElement>();
            let closed = false;

            /** The line under a card's toggle: where the block is now. */
            const note = (id: string, text: string | null, level: 'info' | 'warn' = 'info') => {
                const holder = notes.get(id);
                if (!holder) return;
                clear(holder);
                if (text) holder.appendChild(banner(text, level, level === 'warn' ? 'fa-circle-info' : 'fa-house'));
            };

            /** Shortcuts drawn inside the neighbour's block are offered only while the block is here. */
            const syncInBlock = (id: string) => {
                const holder = inBlock.get(id);
                if (holder) holder.hidden = !dock.isDocked(id);
            };

            const place = (neighbour: DockNeighbour) => {
                const slot = slots.get(neighbour.id);
                if (!slot) return;
                const busy = neighbour.busy?.(document) ?? null;
                if (!keeps(settings(), neighbour.id) || busy) {
                    dock.undock(neighbour.id);
                    note(neighbour.id, busy ? t(busy) : t('m32.dock.atHome'), busy ? 'warn' : 'info');
                } else {
                    const result = dock.dock(neighbour.block, slot);
                    note(neighbour.id, result === 'missing' ? t('m32.dock.missing') : null, 'warn');
                }
                syncInBlock(neighbour.id);
            };

            const placeBar = () => {
                const slot = slots.get(PORTRAIT_BAR.id);
                if (!slot) return;
                if (!settings().portraitBar) {
                    dock.undock(PORTRAIT_BAR.id);
                    note(PORTRAIT_BAR.id, null);
                    return;
                }
                const result = dock.dock(PORTRAIT_BAR, slot);
                note(PORTRAIT_BAR.id, result === 'missing' ? t('m32.dock.portraitsMissing') : null, 'warn');
            };

            const neighbourCard = (neighbour: DockNeighbour): HTMLElement => {
                const holder = el('div', { class: 'maestro-m32d-note' });
                const slot = el('div', { class: 'maestro-m32d-slot', data: { dock: neighbour.id } });
                notes.set(neighbour.id, holder);
                slots.set(neighbour.id, slot);
                const own = SHORTCUTS.filter(
                    (shortcut) =>
                        shortcut.mode === 'docked' && shortcut.neighbour === neighbour.id && shortcut.find(app),
                );
                let actions: HTMLElement | null = null;
                if (own.length) {
                    actions = el(
                        'div',
                        { class: 'maestro-m32d-shortcuts', data: { shortcuts: neighbour.id } },
                        own.map((shortcut) => shortcutButton(shortcut, () => openDocked(shortcut, slot))),
                    );
                    inBlock.set(neighbour.id, actions);
                }
                return section(t(neighbour.nameKey), [
                    el('div', { class: 'maestro-m32d-state' }, [
                        toggle({
                            label: t('m32.dock.keep'),
                            hint: t('m32.dock.keepHint'),
                            checked: keeps(settings(), neighbour.id),
                            onChange: (checked) => {
                                settings().keep[neighbour.id] = checked;
                                commit(`keep.${neighbour.id}`);
                                place(neighbour);
                            },
                        }),
                        neighbour.noteKey ? el('div', { class: 'maestro-hint', text: t(neighbour.noteKey) }) : null,
                        holder,
                        actions,
                    ]),
                    slot,
                ]);
            };

            const barCard = (): HTMLElement => {
                const holder = el('div', { class: 'maestro-m32d-note' });
                const slot = el('div', { class: 'maestro-m32d-slot', data: { dock: PORTRAIT_BAR.id } });
                notes.set(PORTRAIT_BAR.id, holder);
                slots.set(PORTRAIT_BAR.id, slot);
                return section(t('m32.dock.portraits'), [
                    el('div', { class: 'maestro-m32d-state' }, [
                        toggle({
                            label: t('m32.dock.portraitsToggle'),
                            checked: settings().portraitBar,
                            onChange: (checked) => {
                                settings().portraitBar = checked;
                                commit('portraitBar');
                                placeBar();
                            },
                        }),
                        el('div', { class: 'maestro-hint', text: t('m32.dock.portraitsHint') }),
                        holder,
                    ]),
                    slot,
                ]);
            };

            const present = NEIGHBOURS.filter((neighbour) => neighbourPresent(app, dock, neighbour));
            const presentIds = new Set<string>(present.map((neighbour) => neighbour.id));
            const view = el('div', { class: 'maestro-view maestro-m32d' }, [
                el('div', { class: 'maestro-hint', text: t('m32.dock.intro') }),
            ]);
            container.appendChild(view);
            if (!present.length) {
                view.appendChild(emptyState(t('m32.dock.none'), 'fa-puzzle-piece'));
                return;
            }
            const shortcuts = shortcutsBlock(presentIds);
            if (shortcuts) view.appendChild(shortcuts);
            for (const neighbour of present) view.appendChild(neighbourCard(neighbour));
            const withBar = presentIds.has('des');
            if (withBar) view.appendChild(barCard());
            for (const neighbour of present) place(neighbour);
            if (withBar) placeBar();

            const offEvents = deps.onDockEvent((id, event) => {
                if (closed) return;
                syncInBlock(id);
                if (event === 'adopted') return;
                note(id, t(event === 'taken' ? 'm32.dock.taken' : 'm32.dock.redrawn'), 'warn');
            });

            return () => {
                closed = true;
                offEvents();
                dock.undockAll();
            };
        },
    };
}
