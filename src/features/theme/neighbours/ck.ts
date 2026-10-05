// Skin of CarrotKernel. CK paints almost everything with colours written into its code (orange gradients, #e0e0e0
// text that vanishes on light themes) and uses ST's green `--active` as its highlight; its injected stylesheets lean
// on `!important`. The most visible parts are restyled: the settings block, the popups, the lorebook tracker, the RAG
// viewer, and the BunnyMo blocks it puts into messages. `!important` appears only where CK's own rule has it.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** CK's settings block. */
export const CK_PROBES = ['#carrot_settings'] as const;

/** CK's own surfaces: inside them ST's `--active` (CK's highlight) becomes Maestro's accent. */
const ROOTS =
    ':is(#carrot_settings, .carrot-extension-settings, .carrot-popup-overlay, .carrot-popup-container, .baby-bunny-overlay, .carrot-tutorial-overlay, .carrot-rag-overlay, .ck-panel, .bmt-template-interface)';
const SETTINGS = ':is(#carrot_settings, .carrot-extension-settings)';

const CSS = `
/* ---------------------------------------------------------------- variables */

${ROOTS} {
    --active: ${T.accent};
}

/* The lorebook tracker's palette (CK defines it on :root). */
& body {
    --ck-primary: ${T.accent};
    --ck-primary-light: ${T.accent};
    --ck-primary-dark: ${T.accent};
    --ck-primary-gradient: ${T.accent};
    --ck-primary-alpha: ${T.accentSoft};
    --ck-primary-alpha-heavy: color-mix(in srgb, ${T.accent} 30%, transparent);
    --ck-glass-light: ${T.surface2};
    --ck-glass-medium: ${T.surface2};
    --ck-glass-heavy: ${T.surface3};
    --ck-radius-xs: ${T.radiusSm};
    --ck-radius-sm: ${T.radiusSm};
    --ck-radius-md: ${T.radiusMd};
    --ck-radius-lg: ${T.radiusLg};
    --ck-radius-xl: ${T.radiusLg};
    --ck-shadow-glow: 0 0 16px ${T.accentSoft};
}

/* ---------------------------------------------------------------- settings block */

${SETTINGS} {
    font-family: ${T.fontUi};
}

${SETTINGS} .carrot-card {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: none;
}

${SETTINGS} .carrot-card:hover {
    border-color: ${V.accentLine};
    box-shadow: none;
    transform: none;
}

${SETTINGS} .carrot-card-header {
    background: transparent;
    border-bottom: 1px solid ${T.divider};
}

${SETTINGS} .carrot-card-header h3 {
    color: ${T.text};
}

${SETTINGS} .carrot-card-body {
    background: transparent;
}

${SETTINGS} :is(.carrot-card-subtitle, .carrot-help-text, .carrot-status-detail, .carrot-lorebook-status, .carrot-slider-hint) {
    color: ${T.muted};
}

${SETTINGS} :is(.carrot-toggle-label, .carrot-slider-title, .carrot-status-value, .carrot-lorebook-item, .carrot-lorebook-name) {
    color: ${T.text};
}

${SETTINGS} :is(.carrot-select, .carrot-input) {
    background: ${T.well};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
}

${SETTINGS} :is(.carrot-select, .carrot-input):hover {
    border-color: ${V.accentLine};
}

${SETTINGS} :is(.carrot-select, .carrot-input):focus {
    border-color: ${T.accent};
    box-shadow: ${V.focusRing};
}

${SETTINGS} .carrot-toggle {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
}

${SETTINGS} .carrot-toggle:hover {
    background: ${T.accentSoft};
    border-color: ${V.accentLine};
}

${SETTINGS} .carrot-toggle-slider {
    background: ${T.surface3};
    box-shadow: none;
}

${SETTINGS} .carrot-toggle input:checked + .carrot-toggle-slider {
    background: ${T.accent};
    box-shadow: none;
}

${SETTINGS} .carrot-slider-container {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
}

${SETTINGS} .carrot-slider-container:hover {
    background: ${T.accentSoft};
    border-color: ${V.accentLine};
    box-shadow: none;
}

${SETTINGS} .carrot-slider {
    background: ${T.well};
    border-color: ${T.border};
}

${SETTINGS} .carrot-slider::-webkit-slider-thumb {
    background: ${T.accent};
    border-color: ${T.surface1};
}

${SETTINGS} .carrot-slider::-moz-range-thumb {
    background: ${T.accent};
    border-color: ${T.surface1};
}

${SETTINGS} .carrot-status-section {
    background: transparent;
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: none;
}

${SETTINGS} .carrot-status-panel {
    background: ${T.surface2};
    border-color: ${T.border};
    border-left: 3px solid ${T.accent};
    border-radius: ${T.radiusMd};
}

${SETTINGS} .carrot-status-panel:hover {
    background: ${T.surface3};
    border-color: ${V.accentLine};
    box-shadow: none;
    transform: none;
}

${SETTINGS} .carrot-status-panel.active {
    background: ${T.accentSoft} !important;
    box-shadow: none !important;
    transform: none !important;
}

${SETTINGS} .carrot-status-icon {
    background: ${T.accentSoft};
    border-color: ${V.accentLine};
    border-radius: ${T.radiusSm};
    color: ${T.accent};
}

${SETTINGS} .carrot-status-title {
    color: ${T.accent};
}

${SETTINGS} .carrot-lorebook-container {
    background: transparent;
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${SETTINGS} .carrot-lorebook-item {
    border-bottom-color: ${T.divider};
}

${SETTINGS} .carrot-lorebook-item:hover {
    background: ${T.surface2};
    transform: none;
}

/* ---------------------------------------------------------------- buttons (settings and popups) */

${ROOTS} .carrot-primary-btn {
    background: ${V.primaryBg};
    border: 1px solid ${V.primaryBorder};
    border-radius: ${T.radiusSm};
    color: ${T.text};
    box-shadow: none;
}

${ROOTS} .carrot-primary-btn:hover {
    background: ${V.primaryBgHover};
    border-color: ${T.accent};
    box-shadow: none;
    transform: none;
}

${ROOTS} .carrot-secondary-btn {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
}

${ROOTS} .carrot-secondary-btn:hover {
    background: ${T.surface3};
    border-color: ${V.accentLine};
    transform: none;
}

${ROOTS} :is(.carrot-primary-btn, .carrot-secondary-btn):focus-visible {
    outline: none;
    box-shadow: ${V.focusRing};
}

/* ---------------------------------------------------------------- popups, tutorial, RAG viewer */

.carrot-popup-overlay {
    backdrop-filter: blur(${T.blur});
}

.carrot-popup-container,
.chunk-modal {
    background: ${T.surface1};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusLg};
    box-shadow: ${T.elevation2};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.carrot-popup-content {
    background: transparent;
}

.carrot-popup-header {
    background: transparent;
    border-bottom: 1px solid ${T.divider};
    color: ${T.text};
}

.carrot-popup-header :is(h3, h4) {
    color: ${T.text};
}

.carrot-popup-close {
    color: ${T.muted};
    border-radius: ${T.radiusSm};
}

.carrot-popup-close:hover {
    background: ${T.surface3};
    color: ${T.text};
}

.carrot-popup-body {
    color: ${T.text};
}

/* The tutorial floats over the settings without a backdrop: opaque. */
.carrot-tutorial-popup {
    background: ${T.surfaceSolid};
    border-radius: ${T.radiusLg};
    box-shadow: ${T.elevation2};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.carrot-rag-overlay {
    backdrop-filter: blur(${T.blur});
}

/* ---------------------------------------------------------------- lorebook tracker */

.ck-panel {
    background: ${T.surface1};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusLg};
    box-shadow: ${T.elevation2};
    font-family: ${T.fontUi};
}

.ck-panel .ck-header {
    background: ${T.surface2};
    border-bottom-color: ${T.divider};
}

.ck-panel .ck-header__title {
    text-shadow: none;
}

.ck-panel :is(.ck-header__badge, .ck-world-header__badge) {
    background: ${T.accentSoft};
    border-color: ${V.accentLine};
    color: ${T.text};
    box-shadow: none;
    text-shadow: none;
}

.ck-panel .ck-world-header {
    background: ${T.surface2};
    border-bottom-color: ${T.divider};
}

.ck-panel .ck-content {
    background: transparent;
}

.ck-panel .ck-entry {
    border-left-color: ${T.accent};
    border-radius: ${T.radiusSm};
}

.ck-panel .ck-empty {
    background: transparent;
}

/* ---------------------------------------------------------------- BunnyMo blocks in messages */

.mes .carrot-thinking-details {
    margin: ${T.space2} 0;
    padding: ${T.space1} ${T.space2};
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-left: 3px solid ${T.accent};
    border-radius: ${T.radiusMd};
    font-family: ${T.fontUi};
}

.mes .carrot-thinking-summary {
    cursor: pointer;
}

.mes .bmt-tracker-card.horizontal-layout {
    border: 1px solid ${T.border} !important;
    border-radius: ${T.radiusLg} !important;
    box-shadow: ${T.elevation1} !important;
}

/* ---------------------------------------------------------------- phones: touch targets */

@media ${PHONE} {
    .carrot-popup-close {
        min-width: ${TOUCH};
        min-height: ${TOUCH};
    }

    ${ROOTS} :is(.carrot-primary-btn, .carrot-secondary-btn) {
        min-height: ${TOUCH};
    }
}
`;

export const CK_SKIN: NeighbourSkin = {
    id: 'ck',
    titleKey: 'm32.skin.ck',
    css: scopeCss(skinScope('ck'), CSS),
    present: (app) => neighbourPresent(app, 'ck', CK_PROBES),
};
