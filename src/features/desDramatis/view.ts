// What the Dramatis tab of DES's character sheet and the Dramatis pane of DES's Workshop show (M39): Dramatis'
// display-ready summary of the character (DRAMATIS_API.describe, Dramatis 1.3) — the name (DES hides the sheet's hero
// name on phones), the headline, the detail («эскиз / набросок / портрет»), the sections as titled blocks; lines marked
// secret are blurred until clicked when Dramatis' setting is «spoiler», shown with a mark when «open», left out when
// «known». Nothing known yet: an empty state with «Открыть Dramatis»; the player's own character: a neutral note.
// Built from DES's own visual classes (`.rpg-cs-stat-section`, `.rpg-cs-empty`, `.rpg-btn`; the Workshop's
// `.rpg-editor-section`) plus Maestro's, coloured with DES's theme variables over Maestro's tokens. Text goes in as text
// nodes only (names and lines come from a model).
import type { DramatisCharacterView } from '../../adapters';
import { el, icon } from '../../ui/components/dom';

/** Where the content lives: the sheet's tab or the Workshop's pane. */
export type DramatisHost = 'sheet' | 'workshop';

export type DramatisContent =
    | { kind: 'view'; name: string; view: DramatisCharacterView }
    | { kind: 'empty'; name: string }
    | { kind: 'persona'; name: string };

export interface RenderDeps {
    t(key: string, params?: Record<string, string | number>): string;
    host: DramatisHost;
    /** Dramatis can open its «Лист замысла». */
    canOpen: boolean;
    /** Opens it, on that character when named. */
    open(name?: string): void;
    /** Keys of the secret lines the user revealed (kept across redraws). */
    revealed: Set<string>;
}

/** The class every node Maestro puts into DES's windows carries (and the root of its stylesheet). */
export const M39_CLASS = 'maestro-m39';

function openButton(deps: RenderDeps, label: string, name?: string): HTMLButtonElement {
    const node = el('button', { class: ['rpg-btn', 'rpg-btn-ghost', 'maestro-m39-open'], attrs: { type: 'button' } }, [
        icon('fa-masks-theater'),
        ' ',
        el('span', { text: label }),
    ]);
    node.addEventListener('click', (event) => {
        event.preventDefault();
        deps.open(name);
    });
    return node;
}

function secretLine(deps: RenderDeps, text: string, key: string): HTMLElement {
    const line = el(
        'li',
        {
            class: ['maestro-m39-line', 'maestro-m39-secret'],
            title: deps.t('m39.secret'),
            attrs: { role: 'button', tabindex: 0, 'aria-expanded': 'false', 'aria-label': deps.t('m39.secret') },
        },
        [icon('fa-user-secret', 'maestro-m39-secret-icon'), el('span', { class: 'maestro-m39-secret-text', text })],
    );
    const reveal = (open: boolean) => {
        line.classList.toggle('maestro-m39-revealed', open);
        line.setAttribute('aria-expanded', String(open));
        if (open) {
            line.removeAttribute('aria-label');
            line.removeAttribute('title');
            deps.revealed.add(key);
        } else {
            line.setAttribute('aria-label', deps.t('m39.secret'));
            line.setAttribute('title', deps.t('m39.secret'));
            deps.revealed.delete(key);
        }
    };
    line.addEventListener('click', () => reveal(!line.classList.contains('maestro-m39-revealed')));
    line.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        reveal(!line.classList.contains('maestro-m39-revealed'));
    });
    if (deps.revealed.has(key)) reveal(true);
    return line;
}

function sectionsOf(deps: RenderDeps, view: DramatisCharacterView): HTMLElement[] {
    const sheet = deps.host === 'sheet';
    const out: HTMLElement[] = [];
    for (const section of view.sections) {
        const lines: HTMLElement[] = [];
        section.lines.forEach((line, index) => {
            if (!line.secret) {
                lines.push(el('li', { class: 'maestro-m39-line', text: line.text }));
                return;
            }
            if (view.secrets === 'known') return;
            if (view.secrets === 'open') {
                lines.push(
                    el(
                        'li',
                        { class: ['maestro-m39-line', 'maestro-m39-secret-open'], title: deps.t('m39.secretOpen') },
                        [icon('fa-user-secret', 'maestro-m39-secret-icon'), el('span', { text: line.text })],
                    ),
                );
                return;
            }
            lines.push(secretLine(deps, line.text, `${view.name}\u0000${section.id}\u0000${index}`));
        });
        if (!lines.length) continue;
        const title = section.title
            ? el(sheet ? 'div' : 'h4', {
                  class: [sheet ? 'rpg-cs-stat-section-title' : null, 'maestro-m39-section-title'],
                  text: section.title,
              })
            : null;
        out.push(
            el(
                'div',
                {
                    class: [sheet ? 'rpg-cs-stat-section' : 'rpg-editor-section', 'maestro-m39-section'],
                    data: { section: section.id },
                },
                [title, el('ul', { class: 'maestro-m39-lines' }, lines)],
            ),
        );
    }
    return out;
}

/** Draws the content into a container (its previous content goes). */
export function renderDramatis(container: HTMLElement, content: DramatisContent, deps: RenderDeps): void {
    container.replaceChildren();
    const root = el('div', { class: [M39_CLASS, `maestro-m39-${deps.host}`], data: { kind: content.kind } });
    container.appendChild(root);
    if (content.kind === 'persona' || content.kind === 'empty') {
        const persona = content.kind === 'persona';
        root.appendChild(
            el('div', { class: ['rpg-cs-empty', 'maestro-m39-empty'] }, [
                icon(persona ? 'fa-user' : 'fa-masks-theater', 'maestro-m39-empty-icon'),
                el('p', { text: deps.t(persona ? 'm39.persona' : 'm39.empty') }),
                deps.canOpen
                    ? el('div', { class: 'maestro-m39-actions' }, [openButton(deps, deps.t('m39.openDramatis'))])
                    : null,
            ]),
        );
        return;
    }
    const { view } = content;
    root.appendChild(
        el('div', { class: 'maestro-m39-head' }, [
            el('div', { class: 'maestro-m39-name', text: view.name }),
            view.headline ? el('div', { class: 'maestro-m39-headline', text: view.headline }) : null,
            view.detail ? el('div', { class: 'maestro-m39-detail', text: view.detail }) : null,
        ]),
    );
    for (const block of sectionsOf(deps, view)) root.appendChild(block);
    if (deps.canOpen) {
        root.appendChild(
            el('div', { class: 'maestro-m39-actions' }, [openButton(deps, deps.t('m39.openSheet'), content.name)]),
        );
    }
}

/**
 * Maestro's stylesheet for what it adds to DES's windows. Colours come from DES's theme variables (Maestro's theme sets
 * them when its DES skin is on), falling back to Maestro's tokens. DES hides the sheet's hero on phones, so the name is
 * shown there only; the Workshop's header names the character. On phones the sheet's tab row wraps (only while the
 * Dramatis tab is in it) and the tab keeps its icon on the narrowest screens.
 */
export const DES_DRAMATIS_CSS = `
.maestro-m39 {
    display: flex; flex-direction: column; gap: 14px; padding: 4px 0 14px;
    color: var(--rpg-text, var(--maestro-text)); overflow-wrap: anywhere;
}
.maestro-m39-head { display: flex; flex-direction: column; gap: 4px; padding: 0 16px; }
.maestro-m39-name { font-size: 1.2em; font-weight: 700; }
.maestro-m39-headline { font-style: italic; opacity: 0.9; }
.maestro-m39-detail {
    align-self: flex-start; padding: 1px 8px; border-radius: 999px; font-size: 0.8em;
    border: 1px solid var(--rpg-border, var(--maestro-border));
    color: var(--rpg-text-muted, var(--maestro-muted));
}
.maestro-m39 .maestro-m39-section { margin-bottom: 0; }
.maestro-m39 .maestro-m39-section-title { color: var(--rpg-highlight, var(--maestro-accent)); opacity: 0.9; }
.maestro-m39-lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.maestro-m39-line { position: relative; padding-left: 14px; line-height: 1.45; white-space: pre-line; }
.maestro-m39-line::before { content: '•'; position: absolute; left: 2px; opacity: 0.5; }
.maestro-m39-secret-icon { margin-right: 6px; opacity: 0.7; }
.maestro-m39-secret { cursor: pointer; border-radius: 4px; }
.maestro-m39-secret .maestro-m39-secret-text {
    filter: blur(5px); user-select: none; transition: filter var(--maestro-duration, 125ms);
}
.maestro-m39-secret.maestro-m39-revealed { cursor: auto; }
.maestro-m39-secret.maestro-m39-revealed .maestro-m39-secret-text { filter: none; user-select: text; }
.maestro-m39-secret:focus-visible { outline: 2px solid var(--rpg-highlight, var(--maestro-accent)); outline-offset: 2px; }
.maestro-m39-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px; }
.maestro-m39-empty .maestro-m39-actions { justify-content: center; padding: 0; margin-top: 8px; }
.maestro-m39-empty-icon { font-size: 2em; opacity: 0.3; margin-bottom: 12px; }
.maestro-m39-workshop .maestro-m39-name { display: none; }
.maestro-m39-workshop .maestro-m39-head, .maestro-m39-workshop .maestro-m39-actions { padding: 0; }
.maestro-m39-workshop .maestro-m39-empty { padding: 32px 16px; }
/* DES's row is sized for its own two tabs: with ours the toggle would leave the narrow column of a 769–900px sheet. */
#rpg-character-sheet-popup .rpg-cs-tabs:has(.maestro-m39-tab) { flex-wrap: wrap; }
@media (min-width: 769px) {
    #rpg-character-sheet-popup .maestro-m39-name { display: none; }
}
@media (max-width: 768px) {
    #rpg-character-sheet-popup .rpg-cs-tabs:has(.maestro-m39-tab) { padding: 0 8px; }
    #rpg-character-sheet-popup .rpg-cs-tabs:has(.maestro-m39-tab) .rpg-cs-tab { padding: 8px 12px; }
    .maestro-m39-head, .maestro-m39-actions { padding: 0 4px; }
}
@media (max-width: 480px) {
    #rpg-character-sheet-popup .maestro-m39-tab .maestro-m39-tab-label { display: none; }
}
@media (hover: none) {
    .maestro-m39-actions .rpg-btn { min-height: var(--maestro-tap, 44px); }
}
@media (prefers-reduced-motion: reduce) {
    .maestro-m39-secret .maestro-m39-secret-text { transition: none; }
}
`;
