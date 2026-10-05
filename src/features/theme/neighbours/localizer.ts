// Skin of Lorebook Localizer. Its UI is small: a settings block in the Extensions panel, a language button in the
// World Info panel (an ST button, styled by the ST part) and one dialog (`.lbl-dialog` inside an ST popup) with the
// book list, options, progress and the review of proposed keys.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** Localizer's settings block and its World Info button. */
export const LOCALIZER_PROBES = ['.lorebook-localizer-settings', '#lorebook_localizer_button'] as const;

const SETTINGS = '.lorebook-localizer-settings';
const DIALOG = '.lbl-dialog';

const CSS = `
${SETTINGS},
${DIALOG} {
    font-family: ${T.fontUi};
}

:is(${SETTINGS}, ${DIALOG}) :is(.lbl-hint, .lbl-counter, .lbl-source, .lbl-progress-status, .lbl-field-label) {
    color: ${T.muted};
}

${DIALOG} .lbl-warning {
    color: ${V.readable(T.warn, 80)};
}

${DIALOG} :is(.lbl-book-list, .lbl-details) {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${DIALOG} .lbl-details[open] > summary {
    color: ${T.accent};
}

${DIALOG} .lbl-details > summary:focus-visible {
    outline: none;
    box-shadow: ${V.focusRing};
    border-radius: ${T.radiusSm};
}

${DIALOG} .lbl-book {
    border-radius: ${T.radiusSm};
}

${DIALOG} .lbl-book:hover {
    background: ${T.surface3};
}

${DIALOG} .lbl-badge {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusPill};
}

${DIALOG} .lbl-preview-book-title {
    border-bottom-color: ${T.divider};
}

${DIALOG} .lbl-preview-entry {
    border-left: 2px solid ${T.divider};
}

${DIALOG} .lbl-preview-entry-title {
    color: ${T.accent};
}

${DIALOG} .lbl-proposal {
    padding: 2px ${T.space1};
    border-radius: ${T.radiusSm};
}

${DIALOG} .lbl-proposal:hover {
    background: ${T.surface2};
}

${DIALOG} .lbl-arrow {
    color: ${T.accent};
}

${DIALOG} .lbl-key-input.lbl-invalid {
    outline-color: ${T.error};
}

${DIALOG} .lbl-progress-bar {
    accent-color: ${T.accent};
}

@media ${PHONE} {
    ${SETTINGS} .menu_button,
    ${DIALOG} .lbl-toolbar .menu_button {
        min-height: ${TOUCH};
    }
}
`;

export const LOCALIZER_SKIN: NeighbourSkin = {
    id: 'localizer',
    titleKey: 'm32.skin.localizer',
    css: scopeCss(skinScope('localizer'), CSS),
    present: (app) => neighbourPresent(app, 'localizer', LOCALIZER_PROBES),
};
