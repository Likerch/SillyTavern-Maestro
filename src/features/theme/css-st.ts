// M32 part «st»: SillyTavern itself in Maestro's shape language — top bar and drawer icons, drawers and settings
// panels (inline drawers, the extensions column), popups and menus, buttons, inputs, checkboxes, scrollbars, toasts,
// the send form and the character list. Colours, blur and shadows stay ST's (through the tokens).
//
// How it stays safe:
// - every rule is gated by `:where(html.maestro-theme.maestro-theme-st)`: remove the class and nothing applies;
// - `:where()` adds no specificity, so each rule mirrors ST's own selector exactly, ties with it and wins only by
//   source order; ST's more specific modifiers (toggled buttons, the red OK button, the API button) keep working,
//   and the user's custom CSS (moved after Maestro's sheets by the layer) still wins over ours;
// - only visual properties change (radius, border colour, background, shadow, focus ring; padding
//   only at the compact density); never display, position, width or margins;
// - Maestro's own buttons (`.maestro-btn`) keep their colours and their 44px phone size (src/ui/style.css).
import type { Density } from '../../domain/theme-tokens';
import { THEME_CLASS, partClass } from './api';

/** Gate of every rule of this part. */
export const ST_GATE = `:where(html.${THEME_CLASS}.${partClass('st')})`;
const G = ST_GATE;
const T = 'var(--animation-duration, 125ms)';

const COMPACT = `
/* ---------------------------------------------------------------- compact density */
${G} .menu_button {
    padding: var(--maestro-control-py) var(--maestro-control-px);
}

${G} .text_pole {
    padding: var(--maestro-control-py) var(--maestro-control-px);
}
`;

const BASE = `
/* ---------------------------------------------------------------- page */
${G} {
    accent-color: var(--maestro-accent);
}

${G} ::selection {
    background-color: var(--maestro-accent-soft);
}

/* ---------------------------------------------------------------- scrollbars */
${G} ::-webkit-scrollbar-thumb:vertical,
${G} ::-webkit-scrollbar-thumb:horizontal {
    background-color: var(--maestro-scroll-thumb);
    box-shadow: none;
    border-radius: var(--maestro-radius-pill);
}

${G} ::-webkit-scrollbar-thumb:hover {
    background-color: var(--maestro-text-muted);
}

@supports not selector(::-webkit-scrollbar) {
    ${G} {
        scrollbar-color: var(--maestro-scroll-thumb) transparent;
    }
}

/* ---------------------------------------------------------------- top bar and drawer icons */
${G} #top-bar {
    box-shadow: var(--maestro-elevation-2);
    border-bottom: 1px solid var(--maestro-divider);
}

${G} .drawer-icon {
    border-radius: var(--maestro-radius-sm);
    transition:
        opacity ${T},
        color ${T},
        background-color ${T};
}

${G} .drawer-icon.closedIcon {
    opacity: 0.45;
}

${G} .drawer-icon.closedIcon:hover {
    opacity: 1;
    background-color: var(--maestro-surface-3);
}

${G} .drawer-icon.openIcon {
    color: var(--maestro-accent);
}

${G} .drawer-toggle:focus-visible,
${G} .drawer-icon:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- drawers and settings panels */
${G} .drawer-content {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .inline-drawer-header {
    border-radius: var(--maestro-radius-sm);
    transition: background-color ${T};
}

${G} .inline-drawer-toggle.inline-drawer-header:hover {
    background-color: var(--maestro-surface-2);
}

${G} .inline-drawer-icon {
    transition:
        filter ${T},
        transform ${T};
}

${G} .inline-drawer-header:hover .inline-drawer-icon {
    filter: brightness(110%);
}

${G} #extensions_settings .inline-drawer-toggle.inline-drawer-header,
${G} #extensions_settings2 .inline-drawer-toggle.inline-drawer-header,
${G} #user-settings-block h4,
${G} .standoutHeader {
    background-image: none;
    background-color: var(--maestro-surface-2);
    border: 1px solid var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    box-shadow: inset 3px 0 0 var(--maestro-accent);
}

${G} #extensions_settings .inline-drawer-toggle.inline-drawer-header:hover,
${G} #extensions_settings2 .inline-drawer-toggle.inline-drawer-header:hover,
${G} .standoutHeader.inline-drawer-header:hover {
    filter: none;
    background-color: var(--maestro-surface-3);
}

${G} .standoutHeader~.inline-drawer-content {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    background-color: var(--maestro-well);
}

${G} .settingsSectionWrap {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
}

/* ---------------------------------------------------------------- popups and menus */
/* Same specificity as ST's .popup: Maestro's full-screen phone dialogs (.popup.maestro-*-dialog, radius 0) still win. */
${G} .popup {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .popup .popup-button-close {
    border-radius: var(--maestro-radius-pill);
}

${G} #options,
${G} #extensionsMenu,
${G} .popup .popper-modal {
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .options-content,
${G} .list-group {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-md);
}

${G} .options-content a,
${G} #extensionsMenu>.extension_container>div,
${G} #extensionsMenu>div:not(.extension_container),
${G} .list-group>div,
${G} .list-group .list-group-item {
    border-radius: var(--maestro-radius-sm);
    transition:
        opacity ${T},
        background-color ${T};
}

${G} #extensionsMenu>.extension_container>div:hover,
${G} #extensionsMenu>div:not(.extension_container):hover,
${G} .options-content a:hover,
${G} .list-group-item:hover {
    background-color: var(--maestro-surface-3);
}

/* ---------------------------------------------------------------- buttons */
${G} .menu_button {
    border-radius: var(--maestro-radius-sm);
    transition:
        background-color ${T},
        border-color ${T},
        box-shadow ${T},
        filter ${T};
}

${G} .menu_button:where(:not(.maestro-btn)) {
    border-color: var(--maestro-border);
}

${G} .menu_button:not(.disabled):not([disabled]):hover,
${G} .menu_button:not(.disabled):not([disabled]).active {
    background-color: var(--maestro-surface-3);
}

${G} .menu_button:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- inputs */
${G} .text_pole {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
    background-color: var(--maestro-well);
    transition:
        border-color ${T},
        box-shadow ${T};
}

${G} select {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
}

${G} textarea {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
}

${G} select:focus-visible,
${G} input:focus-visible,
${G} textarea:focus-visible {
    outline: 2px solid var(--maestro-accent-soft);
    outline-offset: 0;
    border-color: var(--maestro-accent);
}

${G} input[type='checkbox'] {
    border-radius: var(--maestro-radius-xs);
    transition:
        box-shadow ${T},
        outline-color ${T};
}

${G} input[type='checkbox']:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- send form */
${G} #send_form {
    border-color: var(--maestro-border);
    border-radius: 0 0 var(--maestro-radius-lg) var(--maestro-radius-lg);
}

${G} #send_form:has(#send_textarea:focus-visible) {
    border-color: var(--maestro-accent);
    outline: 1px solid var(--maestro-accent-soft);
}

${G} #rightSendForm>div,
${G} #leftSendForm>div {
    border-radius: var(--maestro-radius-sm);
}

${G} #rightSendForm>div:hover,
${G} #leftSendForm>div:hover {
    background-color: var(--maestro-surface-3);
}

/* ---------------------------------------------------------------- character and persona lists */
${G} .bogus_folder_select,
${G} .character_select,
${G} .group_select,
${G} .avatar-container {
    border-radius: var(--maestro-radius-md);
    transition: background-color ${T};
}

${G} .bogus_folder_select:hover,
${G} .character_select:hover,
${G} .group_select:hover,
${G} .avatar-container:hover {
    background-color: var(--maestro-surface-3);
}

/* ---------------------------------------------------------------- toasts */
${G} body #toast-container>div {
    border-radius: var(--maestro-radius-md);
    box-shadow: var(--maestro-elevation-2);
}

/* ---------------------------------------------------------------- phones (ST's breakpoint) */
@media screen and (max-width: 1000px) {
    ${G} .menu_button:where(:not(.maestro-btn)) {
        min-height: var(--maestro-touch);
    }

    ${G} .menu_button:where(.fa-solid, .fa-regular, .fa-fw):where(:not(.maestro-btn)) {
        min-width: var(--maestro-touch);
    }

    ${G} .text_pole,
    ${G} select {
        min-height: var(--maestro-touch);
    }

    ${G} input[type='checkbox'] {
        width: calc(var(--mainFontSize) * 1.3);
        height: calc(var(--mainFontSize) * 1.3);
    }

    ${G} .inline-drawer-header {
        min-height: var(--maestro-touch);
    }

    ${G} .options-content a,
    ${G} #extensionsMenu>.extension_container>div,
    ${G} #extensionsMenu>div:not(.extension_container),
    ${G} .list-group .list-group-item {
        padding-top: var(--maestro-space-2);
        padding-bottom: var(--maestro-space-2);
    }

    ${G} #right-nav-panel,
    ${G} #left-nav-panel {
        border-radius: 0 0 var(--maestro-radius-lg) var(--maestro-radius-lg);
    }
}

/* ---------------------------------------------------------------- touch screens: no sticky hovers */
@media (hover: none) {
    ${G} .drawer-icon.closedIcon:hover,
    ${G} .bogus_folder_select:hover,
    ${G} .character_select:hover,
    ${G} .group_select:hover,
    ${G} .avatar-container:hover {
        background-color: transparent;
    }
}
`;

/** The «st» stylesheet; the compact density adds tighter control padding (comfortable keeps ST's own). */
export function stCss(density: Density): string {
    return density === 'compact' ? `${BASE}${COMPACT}` : BASE;
}
