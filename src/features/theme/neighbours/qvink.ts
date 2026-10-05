// Skin of Qvink Memory (MessageSummarize). In the chat: the memory line under each message (click to edit) and its
// edit field; its colours keep Qvink's meaning (short-term green, long-term blue, remembered but out of context red,
// excluded grey) but are mixed with ST's text colour so they read on light and dark themes. Elsewhere: the outer
// settings block, the memory editor and prompt editor popups, the progress bar.
import type { NeighbourSkin } from '../api';
import { PHONE, T, TOUCH, V, neighbourPresent, scopeCss, skinScope } from './common';

/** Qvink's settings block. */
export const QVINK_PROBES = ['#qvink_memory_settings'] as const;

const SETTINGS = ':is(#qvink_memory_settings, #qmExtensionPopout)';
const EDITORS = ':is(#qvink_memory_state_interface, #qvink_summary_prompt_interface)';
/** A memory line with text: Qvink also adds an empty line under messages without a memory (to keep spacing). */
const MEMORY = '#chat div.qvink_memory_text:has(> span:not(:empty))';

const CSS = `
/* ---------------------------------------------------------------- variables (Qvink defines them on :root) */

& body {
    --qm-default: ${T.muted};
    --qm-short: ${V.readable('#2e8b57')};
    --qm-long: ${V.readable('#4682b4')};
    --qm-old: ${V.readable('#b22222')};
    --qm-excluded: color-mix(in srgb, ${T.muted} 75%, transparent);
    --qm-message-removed: ${T.muted};
}

/* ---------------------------------------------------------------- chat: memory lines */

${MEMORY} {
    margin: ${T.space1} 0 ${T.space2};
    padding: 2px ${T.space2};
    background: ${T.surface2};
    border-left: 2px solid ${T.divider};
    border-radius: 0 ${T.radiusSm} ${T.radiusSm} 0;
    font-family: ${T.fontUi};
    line-height: 1.45;
    cursor: pointer;
}

${MEMORY}:hover {
    background: ${T.surface3};
}

${MEMORY}:has(> .qvink_short_memory) {
    border-left-color: var(--qm-short);
}

${MEMORY}:has(> .qvink_long_memory) {
    border-left-color: var(--qm-long);
}

${MEMORY}:has(> .qvink_old_memory) {
    border-left-color: var(--qm-old);
}

${MEMORY}:has(> .qvink_exclude_memory) {
    border-left-color: var(--qm-excluded);
}

${MEMORY} .qvink_memory_reasoning {
    color: ${T.muted};
}

#chat textarea.qvink_memory_edit_textarea {
    padding: 2px ${T.space2};
    background: ${T.well};
    border: 1px solid ${T.accent};
    border-radius: ${T.radiusSm};
    color: ${T.text};
    font-family: ${T.fontUi};
    box-shadow: ${V.focusRing};
}

/* ---------------------------------------------------------------- settings block and popout */

${SETTINGS} .qvink_interface_card {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: none;
}

${SETTINGS} .button_highlight {
    color: ${T.accent};
}

/* ---------------------------------------------------------------- memory editor and prompt editor */

${EDITORS} .qvink_interface_card {
    background: ${T.surface2};
    border: 1px solid ${T.border};
    border-radius: ${T.radiusMd};
    box-shadow: none;
}

/* Sticky (Qvink's own rule): opaque, so rows do not show through. */
#qvink_memory_state_interface table thead {
    background: ${T.surfaceSolid};
}

#qvink_memory_state_interface table tbody tr:hover {
    background-color: ${T.surface2};
}

#qvink_memory_state_interface table tr:has(input.interface_message_select:checked, textarea:focus) {
    background-color: ${T.accentSoft};
}

#qvink_memory_state_interface table td.interface_summary i {
    color: ${T.muted};
}

#qvink_memory_state_interface #selected_count {
    color: ${T.accent};
}

#qvink_memory_state_interface :is(#bulk_regex, #bulk_delete, #bulk_summarize) {
    color: ${V.readable(T.error, 80)};
}

/* ---------------------------------------------------------------- progress bar, group members */

#sheld .qvink_progress_bar {
    background-color: ${T.surface1};
    border-bottom: 1px solid ${T.divider};
    color: ${T.text};
    font-family: ${T.fontUi};
}

.qvink_memory_group_member_enable.qvink_memory_group_member_enabled,
.qvink_memory_group_member_enable:hover {
    filter: drop-shadow(0 0 5px ${T.accent});
}

@media ${PHONE} {
    ${SETTINGS} .menu_button,
    ${EDITORS} .menu_button {
        min-height: ${TOUCH};
    }
}
`;

export const QVINK_SKIN: NeighbourSkin = {
    id: 'qvink',
    titleKey: 'm32.skin.qvink',
    css: scopeCss(skinScope('qvink'), CSS),
    present: (app) => neighbourPresent(app, 'qvink', QVINK_PROBES),
};
