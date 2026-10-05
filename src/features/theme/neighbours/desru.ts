// Skin of DES-RU. It has no chat UI of its own (it translates DES in place); what it shows is its settings block:
// the status card, the module list, the dictionary and name-merge sections (the merge list is where duplicate names
// are confirmed), the log. Its toasts are ST's toastr with an extra class and follow the ST part.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** DES-RU's settings block. */
export const DESRU_PROBES = ['#desru-settings'] as const;

const ROOT = ':is(#desru-settings, .desru-settings)';

const CSS = `
${ROOT} {
    font-family: ${T.fontUi};
}

${ROOT} :is(.desru-intro, .desru-des-name, .desru-notes, .desru-module-desc, .desru-option-desc, .desru-dict-stats, .desru-dict-hint, .desru-footer) {
    color: ${T.muted};
}

${ROOT} .desru-status {
    background: ${T.surface2};
    border-color: ${T.border};
    border-radius: ${T.radiusMd};
}

${ROOT} .desru-badge {
    background: color-mix(in srgb, currentColor 12%, transparent);
}

${ROOT} .desru-tone-on {
    color: ${V.readable(T.ok, 80)};
}

${ROOT} :is(.desru-tone-warn, .desru-tone-blocked, .desru-problems, .desru-note-warn) {
    color: ${V.readable(T.warn, 80)};
}

${ROOT} :is(.desru-tone-error, .desru-dict-error) {
    color: ${V.readable(T.error, 80)};
}

${ROOT} .desru-heading {
    color: ${T.text};
}

${ROOT} .desru-module {
    padding: ${T.space2};
    border-radius: ${T.radiusSm};
}

${ROOT} .desru-module:hover {
    background: ${T.surface2};
}

${ROOT} .desru-section {
    padding: ${T.space1} ${T.space2};
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
}

${ROOT} .desru-section[open] > summary {
    margin-bottom: ${T.space2};
    color: ${T.accent};
}

${ROOT} .desru-section > summary:focus-visible {
    outline: none;
    box-shadow: ${V.focusRing};
    border-radius: ${T.radiusSm};
}

${ROOT} .desru-merge-list > li {
    padding: ${T.space1} ${T.space2};
    border-radius: ${T.radiusSm};
}

${ROOT} .desru-merge-list > li:hover {
    background: ${T.surface3};
}

/* The dictionary editors are ST text fields (\`text_pole\`): the ST part styles them. */
${ROOT} .desru-log {
    background: ${T.well};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusSm};
    color: ${T.text};
    font-family: ${T.fontMono};
}

@media ${PHONE} {
    ${ROOT} :is(.desru-merge-list, .desru-log-actions) .menu_button,
    ${ROOT} .desru-recheck {
        min-height: ${TOUCH};
    }
}
`;

export const DESRU_SKIN: NeighbourSkin = {
    id: 'desru',
    titleKey: 'm32.skin.desru',
    css: scopeCss(skinScope('desru'), CSS),
    present: (app) => neighbourPresent(app, 'desru', DESRU_PROBES),
};
