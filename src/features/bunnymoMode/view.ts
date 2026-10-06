// Pult tab «BunnyMo» (M35 п. 4–9): one tab with five sections — tag dictionary, packs, integrity, sheets, runtime
// fixes. open(target) from the API or the command picks the section: a tag → dictionary, an archive → sheet editor,
// a pack → packs.
import { parseTagKey } from '../../domain/bunnymo-mode-tags';
import type { App, PultTab } from '../../shared/contracts';
import { segmented } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { BunnyMoModeService, ViewTarget } from './service';
import { SECTIONS, errorText, loading } from './view-common';
import type { Section, ViewContext, ViewState } from './view-common';
import { renderDictionary } from './view-dictionary';
import { renderPacks } from './view-packs';
import { renderSheets } from './view-sheets';
import { renderEdits, renderIntegrity } from './view-status';

export const BUNNYMO_TAB = 'bunnymo';

const RENDERERS: Record<Section, (ctx: ViewContext, body: HTMLElement) => Promise<void>> = {
    dictionary: renderDictionary,
    packs: renderPacks,
    integrity: renderIntegrity,
    sheets: renderSheets,
    edits: renderEdits,
};

/** Moves the view to what open() asked for (async: the kind of a book is looked up). */
export async function applyTarget(service: BunnyMoModeService, state: ViewState, target: ViewTarget): Promise<void> {
    if (target.section) state.section = target.section;
    if (target.tag) {
        const raw = target.tag.trim();
        const tag = parseTagKey(raw.startsWith('<') ? raw : `<${raw}>`)?.tag ?? raw;
        state.section = 'dictionary';
        state.dict.search = tag;
        state.dict.category = '';
        state.dict.open = tag;
        return;
    }
    if (!target.book) return;
    const archives = await service.archiveBooks();
    if (archives.includes(target.book)) {
        state.section = 'sheets';
        state.sheets.editor = null;
        state.sheets.pending = target.uid !== undefined ? { book: target.book, uid: target.uid } : null;
        return;
    }
    const { core, packs } = await service.bunnyBooks();
    if (packs.includes(target.book) || core.includes(target.book)) {
        state.section = 'packs';
        state.packs.focus = target.book;
    }
}

export function bunnymoTab(app: App, service: BunnyMoModeService, state: ViewState): PultTab {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    return {
        id: BUNNYMO_TAB,
        titleKey: 'm35b.tab',
        icon: 'fa-carrot',
        order: 41,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m35b' });
            const nav = el('div', { class: 'maestro-m35b-nav' });
            let body = el('div', { class: 'maestro-m35b-body' });
            root.append(nav, body);
            container.appendChild(root);

            const drawNav = () => {
                nav.replaceChildren(
                    segmented<Section>({
                        value: state.section,
                        label: t('m35b.nav'),
                        options: SECTIONS.map((id) => ({ value: id, label: t(`m35b.view.${id}`) })),
                        onChange: (section) => ctx.go(section),
                    }),
                );
            };

            const draw = () => {
                if (!alive) return;
                drawNav();
                const next = el('div', { class: 'maestro-m35b-body', data: { section: state.section } });
                body.replaceWith(next);
                body = next;
                void RENDERERS[state.section](ctx, next).catch((error: unknown) => {
                    app.log.error('BunnyMo view failed', error);
                });
            };

            const ctx: ViewContext = {
                app,
                service,
                state,
                t,
                redraw: () => draw(),
                go: (section) => {
                    state.section = section;
                    draw();
                },
                run: async (job) => {
                    try {
                        await job();
                    } catch (error) {
                        // A failed action of the user's own: shown at every notification level.
                        app.ui.notice(errorText(error), { level: 'error', urgent: true });
                        if (alive) draw();
                    }
                },
                alive: () => alive,
            };

            // A change elsewhere (books saved, chat switched, roles) redraws, except an open sheet editor.
            const later = coalesce(() => {
                if (state.section === 'sheets' && state.sheets.editor) return;
                // Never eat what the user is typing (search box).
                const focused = document.activeElement;
                if (focused instanceof HTMLElement && root.contains(focused) && focused.matches('input, textarea')) {
                    return;
                }
                draw();
            }, 150);
            const off = service.onChange(() => later());

            const target = service.target;
            service.target = null;
            if (target) {
                drawNav();
                body.appendChild(loading(t));
                void applyTarget(service, state, target)
                    .catch((error: unknown) => app.log.warn('BunnyMo target failed', error))
                    .then(() => draw());
            } else {
                draw();
            }
            return () => {
                alive = false;
                later.cancel();
                off();
            };
        },
    };
}
