// Skin of Doom's Enhancement Suite 2.6.0 (DES). DES has its own theme variables (--rpg-*), so they are overridden
// first; then the most visible nodes are restyled with tokens. DES rewrites inline styles, so its nodes are styled
// only through this stylesheet. Three DES habits shape the rules:
// - its theme rules are often id-scoped (`#character-workshop-popup[data-theme] .rpg-settings-popup-content`): the
//   `SURFACES` group carries an id inside :is() to outweigh them;
// - its «custom» theme and the scene blocks write their variables inline on the root element: the variables are
//   redefined on the children (`X > *`, `X *`), and the root's own background and borders are set directly;
// - several colours are r, g, b triples (portrait bar, scene blocks) that a token cannot fill: those properties are
//   set directly.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** DES's settings block (Extensions panel), its tracker panel and its portrait bar. */
export const DES_PROBES = ['#rpg-extension-enabled', '.rpg-panel', '#dooms-portrait-bar-wrapper'] as const;

/** Every DES window and panel; the id inside gives each rule id weight (DES's own rules are id-scoped). */
const SURFACES = ':is(#rpg-settings-popup, .rpg-settings-popup, .rpg-lb-modal, .rpg-panel, #rpg-thought-panel)';
/** The settings, editor, log, Workshop, Roster and sheet windows share this frame. */
const POPUP = ':is(#rpg-settings-popup, .rpg-settings-popup)';
const LORE = ':is(#rpg-lorebook-modal, .rpg-lb-modal)';
/** The portrait bar laid out as a strip (above / below / top), not as a side panel. */
const STRIP = '#dooms-portrait-bar-wrapper:not(.dooms-pb-position-left, .dooms-pb-position-right)';
const SCENE_BLOCKS =
    ':is(.dooms-scene-header, .dooms-info-banner, .dooms-info-hud, .dooms-info-ticker-wrapper, .dooms-scene-transition)';

const RPG_VARIABLES = `
    --rpg-bg: ${T.surface1};
    --rpg-accent: ${T.surface2};
    --rpg-text: ${T.text};
    --rpg-highlight: ${T.accent};
    --rpg-border: ${T.border};
    --rpg-shadow: ${T.shadow};
    --rpg-text-muted: ${T.muted};
`;

const CSS = `
/* ---------------------------------------------------------------- variables */

/* Anything outside DES's own variable holders (thoughts and tracker data in the chat, side portrait panel) reads them
   from body; the chat bubbles and the portrait cards take Maestro's accent and radius. */
& body {
    ${RPG_VARIABLES}
    --cb-accent: ${T.accent};
    --cb-border-radius: ${T.radiusMd};
    --dooms-pb-card-radius: ${T.radiusMd};
}

/* DES's holders (default theme, [data-theme] themes) and their children (the «custom» theme writes inline). */
.rpg-panel,
.rpg-panel > *,
#rpg-thought-panel,
#rpg-thought-panel > *,
#rpg-thought-icon,
#rpg-thought-icon > *,
.rpg-mobile-toggle,
.rpg-mobile-toggle > *,
#dooms-settings-fab,
#dooms-settings-fab > *,
${LORE},
${LORE} > *,
${POPUP} .rpg-settings-popup-content,
${POPUP} .rpg-settings-popup-content > * {
    ${RPG_VARIABLES}
}

/* ---------------------------------------------------------------- tracker panel and floating parts */

.rpg-panel {
    background: ${T.surface1};
    color: ${T.text};
    font-family: ${T.fontUi};
    box-shadow: ${T.elevation2};
}

#rpg-thought-panel,
.rpg-mobile-toggle {
    color: ${T.text};
    font-family: ${T.fontUi};
}

${SURFACES} .rpg-panel-header {
    border-bottom: 1px solid ${T.divider};
}

${SURFACES} .rpg-panel-header h3 {
    color: ${T.text};
    text-shadow: none;
}

${SURFACES} .rpg-panel-header h3 i {
    color: ${T.accent};
}

${SURFACES} .rpg-content-box {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: none;
}

${SURFACES} .rpg-tab-btn:hover {
    background: ${T.accentSoft};
}

${SURFACES} .rpg-tab-btn.active {
    color: ${T.text};
    border-bottom-color: ${T.accent};
}

/* ---------------------------------------------------------------- windows: frame, header, footer */

/* The backdrops: a pseudo-element of the settings-style windows, the overlay itself for the Lore Library. */
${POPUP}::before,
${LORE} {
    backdrop-filter: blur(${T.blur});
}

${POPUP} .rpg-settings-popup-content,
${LORE} .rpg-lb-modal-content {
    background: ${T.surface1};
    color: ${T.text};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusLg};
    box-shadow: ${T.elevation2};
    font-family: ${T.fontUi};
}

${POPUP} .rpg-settings-popup-header {
    background: transparent;
    border-bottom: 1px solid ${T.divider};
}

${LORE} .rpg-lb-modal-header {
    background: ${T.surface2};
    border-bottom: 1px solid ${T.divider};
}

${POPUP} .rpg-settings-popup-header h3,
${LORE} .rpg-lb-modal-header h3 {
    color: ${T.text};
    font-weight: 600;
}

${POPUP} .rpg-settings-popup-header h3 i,
${LORE} .rpg-lb-modal-header h3 i {
    color: ${T.accent};
}

${POPUP} .rpg-settings-popup-footer,
${LORE} .rpg-lb-modal-footer {
    background: transparent;
    border-top: 1px solid ${T.divider};
}

${POPUP} .rpg-popup-close,
${LORE} .rpg-lb-close {
    color: ${T.muted};
    border-radius: ${T.radiusSm};
}

${POPUP} .rpg-popup-close:hover,
${POPUP} .rpg-popup-close:focus-visible,
${LORE} .rpg-lb-close:hover,
${LORE} .rpg-lb-close:focus-visible {
    background: ${T.surface3};
    color: ${T.text};
}

/* ---------------------------------------------------------------- buttons */

${SURFACES} :is(.rpg-btn, .rpg-btn-secondary, .rpg-lb-btn, .rpg-accordion-action-btn, .rpg-lb-close-editor-btn) {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
    box-shadow: none;
}

${SURFACES} :is(.rpg-btn, .rpg-btn-secondary, .rpg-lb-btn, .rpg-accordion-action-btn, .rpg-lb-close-editor-btn):hover {
    background: ${T.surface3};
    border-color: ${V.accentLine};
    color: ${T.text};
}

${SURFACES} .rpg-btn-primary {
    background: ${V.primaryBg};
    border: 1px solid ${V.primaryBorder};
    border-radius: ${T.radiusSm};
    color: ${T.text};
    box-shadow: none;
}

${SURFACES} .rpg-btn-primary:hover {
    background: ${V.primaryBgHover};
    border-color: ${T.accent};
    color: ${T.text};
    box-shadow: none;
}

${SURFACES} .rpg-btn-ghost {
    background: transparent;
    border-color: transparent;
}

${SURFACES} .rpg-btn-ghost:hover {
    background: ${T.surface3};
    border-color: ${T.border};
}

${SURFACES} :is(.rpg-btn, .rpg-btn-primary, .rpg-btn-secondary, .rpg-lb-btn):focus-visible {
    outline: none;
    box-shadow: ${V.focusRing};
}

/* ---------------------------------------------------------------- inputs, toggles, accordions */

${SURFACES} :is(.rpg-input, .rpg-select, .rpg-textarea, .rpg-prompt-textarea, .rpg-accordion-input, .rpg-accordion-select, .rpg-inline-input),
${SURFACES} .rpg-setting-row input[type="number"] {
    background: ${T.well};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
}

${SURFACES} :is(.rpg-input, .rpg-select, .rpg-textarea, .rpg-prompt-textarea, .rpg-accordion-input, .rpg-accordion-select, .rpg-inline-input):focus,
${SURFACES} .rpg-setting-row input[type="number"]:focus {
    outline: none;
    border-color: ${T.accent};
    box-shadow: ${V.focusRing};
}

${SURFACES} .rpg-toggle-slider {
    background: ${T.surface3};
}

${SURFACES} .rpg-toggle-slider::before {
    background: ${T.muted};
}

${SURFACES} .rpg-toggle-switch input:checked + .rpg-toggle-slider {
    background: ${V.primaryBg};
}

${SURFACES} .rpg-toggle-switch input:checked + .rpg-toggle-slider::before {
    background: ${T.accent};
}

${SURFACES} .rpg-toggle-switch input:focus-visible + .rpg-toggle-slider {
    box-shadow: ${V.focusRing};
}

${SURFACES} .rpg-accordion-section {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
}

${SURFACES} .rpg-accordion-header {
    background: transparent;
}

${SURFACES} .rpg-accordion-header:hover {
    background: ${T.accentSoft};
}

${SURFACES} .rpg-accordion-title {
    color: ${T.text};
}

${SURFACES} .rpg-accordion-body {
    background: transparent;
    border-top: 1px solid ${T.divider};
}

${SURFACES} .rpg-accordion-body .rpg-setting-row + .rpg-setting-row {
    border-top-color: ${T.divider};
}

${SURFACES} :is(.rpg-setting-hint, .rpg-prompt-hint, .rpg-subsection-label),
${SURFACES} .rpg-setting-row small {
    color: ${T.muted};
}

${SURFACES} .rpg-subsection-label {
    border-top-color: ${T.divider};
}

/* ---------------------------------------------------------------- Workshop, Roster, editor and library tabs */

${SURFACES} :is(.cr-mode-pill, .cr-scope-pill) {
    border-color: ${T.border};
    color: ${T.muted};
}

${SURFACES} :is(.cr-mode-pill, .cr-scope-pill):hover {
    border-color: ${V.accentLine};
    color: ${T.text};
}

${SURFACES} :is(.cr-mode-pill, .cr-scope-pill).is-active {
    background: ${T.accentSoft};
    border-color: ${T.accent};
    color: ${T.text};
}

${SURFACES} .cr-tile {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${SURFACES} .cr-tile:is(:hover, :focus-visible) {
    border-color: ${T.accent};
    box-shadow: 0 6px 18px ${T.accentSoft};
}

${SURFACES} .rpg-editor-tab {
    background: transparent;
    color: ${T.muted};
}

${SURFACES} .rpg-editor-tab:hover {
    background: ${T.surface2};
    color: ${T.text};
}

${SURFACES} .rpg-editor-tab.active {
    background: ${T.accentSoft};
    border-bottom-color: ${T.accent};
    color: ${T.text};
}

${SURFACES} .rpg-lb-tab {
    color: ${T.muted};
}

${SURFACES} .rpg-lb-tab:hover {
    color: ${T.text};
}

${SURFACES} .rpg-lb-tab.active {
    background: ${T.accentSoft};
    border-bottom-color: ${T.accent};
    color: ${T.text};
}

${SURFACES} .workshop-nav {
    border-bottom-color: ${T.divider};
}

${SURFACES} .workshop-nav button:not(.active) {
    color: ${T.muted};
}

${SURFACES} .workshop-nav button:not(.active):hover {
    background: ${T.surface2};
    color: ${T.text};
}

/* Greys DES hard-codes for dark themes only (#555 … #aaa) become the muted text colour; active states keep DES's
   meaning (a green «on» toolbar button stays green), white-on-red ones move to the accent. */
${SURFACES} :is(.rpg-accordion-chevron, .rpg-accordion-mini-btn, .rpg-lb-toolbar-btn, .rpg-lb-fpill, .rpg-cs-tab, .rpg-inspector-tab):not(.active) {
    color: ${T.muted};
}

${SURFACES} :is(.rpg-accordion-mini-btn, .rpg-lb-fpill, .rpg-cs-tab, .rpg-inspector-tab):not(.active):hover {
    color: ${T.text};
}

${SURFACES} .rpg-lb-toolbar-btn:not(.active):hover {
    color: ${T.accent};
}

${SURFACES} :is(.rpg-cs-tab, .rpg-inspector-tab).active {
    color: ${T.text};
    border-bottom-color: ${T.accent};
}

${SURFACES} .rpg-lb-fpill.active {
    background: ${T.accent};
    border-color: ${T.accent};
    color: ${T.onAccent};
}

/* ---------------------------------------------------------------- settings block in the Extensions panel */

.dooms-github-star-btn {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
}

.dooms-github-star-btn:hover {
    background: ${T.surface3};
    box-shadow: none;
}

.dooms-github-star-btn:focus-visible {
    box-shadow: ${V.focusRing};
}

.dooms-github-star-btn .dooms-github-star-label {
    color: ${T.text};
}

.dooms-github-star-btn .dooms-github-star-icon {
    color: ${T.muted};
}

/* ---------------------------------------------------------------- portrait bar */

${STRIP} .dooms-portrait-bar,
${STRIP} .dooms-pb-toggle {
    background: ${T.surface2};
}

#dooms-portrait-bar-wrapper:is(.dooms-pb-position-left, .dooms-pb-position-right) {
    border-color: ${T.border};
    box-shadow: 0 0 18px ${T.shadow};
}

#dooms-portrait-bar-wrapper .dooms-pb-toggle:hover {
    background: ${T.accentSoft};
}

#dooms-portrait-bar-wrapper .dooms-pb-toggle-dot {
    background: ${V.accentLine};
}

#dooms-portrait-bar-wrapper .dooms-pb-toggle:hover .dooms-pb-toggle-dot {
    background: ${T.accent};
}

#dooms-portrait-bar-wrapper :is(.dooms-pb-toggle-label, .dooms-pb-toggle-chevron, .dooms-pb-count, .dooms-pb-empty) {
    color: ${T.muted};
}

#dooms-portrait-bar-wrapper .dooms-pb-toggle:hover :is(.dooms-pb-toggle-label, .dooms-pb-toggle-chevron) {
    color: ${T.text};
}

#dooms-portrait-bar-wrapper .dooms-pb-title {
    color: ${T.accent};
    font-family: ${T.fontUi};
}

#dooms-portrait-bar-wrapper .dooms-pb-count {
    background: ${T.surface2};
    border-radius: ${T.radiusPill};
}

#dooms-portrait-bar-wrapper .dooms-pb-header {
    border-bottom-color: ${T.divider};
}

#dooms-portrait-bar-wrapper .dooms-pb-restore-btn {
    border-color: ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.muted};
}

#dooms-portrait-bar-wrapper .dooms-pb-restore-btn:hover {
    background: ${T.accentSoft};
    border-color: ${T.accent};
    color: ${T.text};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card {
    background: ${T.surface2};
    border-color: ${T.border};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card:hover {
    border-color: ${T.accent};
    box-shadow: 0 4px 12px ${T.accentSoft};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card.dooms-pb-speaking {
    border-color: ${T.accent};
    box-shadow: 0 0 8px ${V.accentLine};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card.dooms-pb-speaking::before {
    background: ${T.accent};
}

#dooms-portrait-bar-wrapper :is(.dooms-pb-you-badge, .dooms-pb-new-badge) {
    background: ${T.accent};
    color: ${T.onAccent};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card.dooms-pb-user {
    box-shadow: 0 0 0 2px ${V.accentLine};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card-name {
    font-family: ${T.fontUi};
}

#dooms-portrait-bar-wrapper .dooms-portrait-card-emoji {
    background: ${T.surface2};
}

#dooms-portrait-bar-wrapper .dooms-pb-back-header {
    border-bottom-color: ${V.accentLine};
}

#dooms-portrait-bar-wrapper :is(.dooms-pb-back-name, .dooms-pb-back-label) {
    color: ${T.accent};
}

#dooms-portrait-bar-wrapper .dooms-pb-arrow {
    background: ${T.surface1};
    border-color: ${T.border};
    color: ${T.text};
}

#dooms-portrait-bar-wrapper .dooms-pb-arrow:hover {
    background: ${T.accentSoft};
    border-color: ${T.accent};
    color: ${T.text};
}

#dooms-portrait-bar-wrapper .dooms-pb-scroll::-webkit-scrollbar-thumb {
    background: ${T.scrollThumb};
}

.dooms-pb-context-menu {
    background: ${T.surfaceSolid};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: ${T.elevation2};
    font-family: ${T.fontUi};
}

.dooms-pb-context-menu .dooms-pb-ctx-item {
    color: ${T.text};
}

.dooms-pb-context-menu .dooms-pb-ctx-item:hover {
    background: ${T.accentSoft};
    color: ${T.text};
}

.dooms-pb-context-menu .dooms-pb-ctx-danger {
    color: ${V.readable(T.error, 80)};
}

.dooms-pb-context-menu .dooms-pb-ctx-divider {
    background: ${T.divider};
}

/* ---------------------------------------------------------------- chat: scene header, info box, transitions */

${SCENE_BLOCKS} * {
    --st-accent: ${T.accent};
    --st-border-color: ${T.border};
    --st-label-color: ${T.muted};
    --st-text-color: ${T.text};
    --st-quest-icon: ${T.accent};
    --st-quest-text: ${T.text};
    --st-events-text: ${T.muted};
    --st-border-radius: ${T.radiusMd};
}

:is(.dooms-scene-header, .dooms-info-banner) {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-left: 3px solid ${T.accent};
    border-radius: ${T.radiusMd};
    font-family: ${T.fontUi};
}

.dooms-scene-characters {
    border-top-color: ${T.divider};
}

.dooms-scene-char-badge {
    background: ${T.accentSoft};
    border-color: ${V.accentLine};
    color: ${T.text};
}

.dooms-info-hud {
    background: ${T.surface1};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: ${T.elevation2};
    font-family: ${T.fontUi};
    color: ${T.text};
}

.dooms-info-ticker-wrapper {
    background: ${T.surface1};
    border-color: ${T.border};
    border-radius: 0 0 ${T.radiusMd} ${T.radiusMd};
    box-shadow: ${T.elevation1};
    font-family: ${T.fontUi};
    color: ${T.text};
}

.dooms-info-ticker:hover {
    background: ${T.accentSoft};
}

.dooms-scene-transition {
    font-family: ${T.fontUi};
}

.dooms-transition-cinematic {
    background: ${T.surface2};
    border-top-color: ${T.border};
    border-bottom-color: ${T.border};
}

.dooms-transition-hybrid {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusLg};
}

/* ---------------------------------------------------------------- chat: thoughts and tracker data */

.dooms-inline-thought {
    background: ${T.surface2};
    border-left-color: ${T.accent};
    border-radius: ${T.radiusSm};
}

.dooms-inline-thought[open] {
    background: color-mix(in srgb, ${T.accent} 8%, transparent);
}

.dooms-inline-thought-summary {
    color: ${T.text};
    font-family: ${T.fontUi};
}

.dooms-inline-thought-content {
    color: ${T.text};
    font-family: ${T.fontChat};
    border-top-color: ${T.divider};
}

.dooms-thought-tts:hover {
    background: ${T.accentSoft};
    color: ${T.accent};
}

.dooms-tracker-json {
    background: ${T.surface2};
    border-left-color: ${T.border};
    border-radius: ${T.radiusSm};
    font-family: ${T.fontUi};
}

.dooms-tracker-json[open] {
    background: ${T.surface3};
}

/* ---------------------------------------------------------------- phones: touch targets */

/* DES makes the Lore Library header sticky on narrow screens: it must not be see-through. */
@media (max-width: 600px) {
    ${LORE} .rpg-lb-modal-header {
        background: ${T.surfaceSolid};
    }
}

@media ${PHONE} {
    ${SURFACES} :is(.rpg-btn, .rpg-btn-primary, .rpg-btn-secondary, .rpg-lb-btn, .rpg-accordion-action-btn) {
        min-height: ${TOUCH};
    }

    #dooms-portrait-bar-wrapper .dooms-pb-restore-btn {
        min-width: ${TOUCH};
        min-height: ${TOUCH};
    }

    .dooms-pb-context-menu .dooms-pb-ctx-item {
        min-height: ${TOUCH};
    }
}
`;

export const DES_SKIN: NeighbourSkin = {
    id: 'des',
    titleKey: 'm32.skin.des',
    css: scopeCss(skinScope('des'), CSS),
    present: (app) => neighbourPresent(app, 'des', DES_PROBES),
};
