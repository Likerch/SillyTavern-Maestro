// Skin of NAI Studio. It already builds on ST's variables (every class is `naist-*`), so little changes: its settings
// panel, the studio windows (gallery, composer, lightbox, tool dialogs; their ST popup frame is the ST part's), the
// progress card and tag hints, and in the chat the inline images (frame, caption, placeholders) and the image
// markers. The per-image corner radius and size NAI writes inline are the user's choice and stay.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** NAI Studio's settings panel. */
export const NAI_PROBES = ['#naist_panel'] as const;

const PANEL = ':is(#naist_panel, .naist-panel)';
/** Studio content shown in ST popups. */
const STUDIO = ':is(.naist-dialog, .naist-gallery, .naist-lightbox, .naist-inspector, .naist-refine)';

const CSS = `
/* ---------------------------------------------------------------- settings panel */

${PANEL} {
    font-family: ${T.fontUi};
}

${PANEL} .naist-tabs {
    border-bottom-color: ${T.divider};
}

${PANEL} .naist-tab {
    border-radius: ${T.radiusSm};
}

${PANEL} .naist-tab-active {
    background: ${T.accentSoft};
    border-color: ${T.accent};
}

${PANEL} .naist-section {
    border-bottom: 1px solid ${T.divider};
}

${PANEL} .naist-character {
    border-top: 1px solid ${T.divider};
}

${PANEL} .naist-banner {
    background: color-mix(in srgb, ${T.warn} 10%, transparent);
    border-color: ${T.warn};
    border-left-width: 3px;
    border-radius: ${T.radiusSm};
}

${PANEL} :is(.naist-account, .naist-hint, .naist-feature-hint, .naist-muted) {
    color: ${T.muted};
}

:is(${PANEL}, ${STUDIO}) .naist-block {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

:is(${PANEL}, ${STUDIO}) .naist-badge {
    border-color: ${T.border};
    border-radius: ${T.radiusPill};
}

:is(${PANEL}, ${STUDIO}) .naist-message {
    background: ${T.surface2};
    border-radius: ${T.radiusSm};
}

:is(${PANEL}, ${STUDIO}) :is(.naist-json, .naist-pre, .naist-composer-preview) {
    background: ${T.well};
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
    font-family: ${T.fontMono};
}

/* ---------------------------------------------------------------- studio windows */

${STUDIO} {
    font-family: ${T.fontUi};
}

${STUDIO} .naist-g-card,
${STUDIO} .naist-vibe-card {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${STUDIO} .naist-g-card:hover,
${STUDIO} .naist-vibe-card:hover {
    border-color: ${V.accentLine};
}

${STUDIO} .naist-g-selected {
    outline-color: ${T.accent};
}

${STUDIO} .naist-g-card-text {
    color: ${T.muted};
}

${STUDIO} .naist-slot {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${STUDIO} .naist-canvas {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${STUDIO} .naist-comic-layout {
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
}

${STUDIO} .naist-comic-layout.naist-tab-active {
    background: ${T.accentSoft};
    border-color: ${T.accent};
}

${STUDIO} .naist-meta-table th {
    color: ${T.muted};
}

${STUDIO} .naist-lightbox-image img,
${STUDIO} .naist-compare-images img,
${STUDIO} .naist-persona-avatar-preview {
    border-radius: ${T.radiusMd};
}

.naist-wand-sep {
    border-top-color: ${T.divider};
}

/* ---------------------------------------------------------------- progress card, tag hints, token meter */

/* Floats over the chat without a backdrop blur: opaque. */
.naist-progress {
    background: ${T.surfaceSolid};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: ${T.elevation2};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.naist-progress-bar,
.naist-tokens-bar {
    background: ${T.surface3};
}

.naist-progress-bar span {
    background: ${T.accent};
}

.naist-ac {
    background: ${T.surfaceSolid};
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
    box-shadow: ${T.elevation2};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.naist-ac :is(.naist-ac-item:hover, .naist-ac-active) {
    background: ${T.accentSoft};
}

/* ---------------------------------------------------------------- chat: inline images */

.naist-inline-frame.naist-inline-border {
    outline-color: ${T.border};
}

.naist-inline-img {
    background: ${T.surface2};
}

.naist-inline-toolbar {
    border-radius: ${T.radiusSm};
}

.naist-inline-caption {
    color: ${T.muted};
    font-family: ${T.fontUi};
}

.naist-inline-missing {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.muted};
    font-family: ${T.fontUi};
}

.naist-inline-chip {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusPill};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.naist-inline-chip:hover {
    background: ${T.accentSoft};
    border-color: ${T.accent};
}

.naist-inline-drop {
    outline-color: ${T.accent};
}

.naist-media-tools-float {
    border-radius: ${T.radiusSm};
}

/* ---------------------------------------------------------------- chat: image markers */

.naist-marker-box {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.naist-inline-marker-error .naist-marker-box {
    border-color: ${T.error};
}

.naist-marker-prompt {
    color: ${T.muted};
}

img.naist-marker-stream,
img.custom-naist-marker-stream {
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

img.naist-marker-failed {
    outline-color: ${T.error};
}

/* ---------------------------------------------------------------- phones: touch targets */

@media ${PHONE} {
    ${PANEL} .naist-tab,
    :is(${PANEL}, ${STUDIO}) :is(.naist-slot, .naist-assist, .naist-gallery-actions, .naist-lightbox-actions) .menu_button,
    .naist-marker-actions .menu_button {
        min-height: ${TOUCH};
    }

    .naist-inline-chip {
        min-height: ${TOUCH};
    }
}
`;

export const NAI_SKIN: NeighbourSkin = {
    id: 'nai',
    titleKey: 'm32.skin.nai',
    css: scopeCss(skinScope('nai'), CSS),
    present: (app) => neighbourPresent(app, 'nai', NAI_PROBES),
};
