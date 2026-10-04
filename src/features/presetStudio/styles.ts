// Stylesheet of the Preset Studio (M34). Includes the only rule that hides ST's Prompt Manager (P-013: hidden by a
// body class, never removed — it keeps rendering), the launcher in ST's drawer, and the studio window: header, tabs,
// the current tab and the block editor as a side panel. Phones and narrow windows (≤1000px, ST's breakpoint): a
// full-screen dialog, the editor as an overlay, 44px tap targets, ↑/↓ instead of dragging (P-017, P10).
export const M34_CSS = `
body.maestro-pm-replaced #completion_prompt_manager { display: none !important; }
.maestro-m34-launcher {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
    background: var(--maestro-raised);
    color: var(--maestro-text);
    text-align: start;
}
.maestro-m34-launcher-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m34-launcher-head .fa-solid { color: var(--maestro-accent); }
.maestro-m34-launcher-preset { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m34-launcher-stats { color: var(--maestro-muted); font-size: 0.9em; font-variant-numeric: tabular-nums; }
.maestro-m34-launcher-error { color: var(--maestro-error); display: flex; gap: 6px; align-items: flex-start; }
.maestro-m34-launcher-error[hidden], .maestro-m34-launcher-unsaved[hidden] { display: none; }
.maestro-m34-launcher-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m34-launcher-actions .maestro-btn { margin: 0; }

.popup.maestro-m34-dialog {
    width: min(1500px, 98dvw);
    height: min(940px, 94dvh);
    max-height: 94dvh;
    padding: 0;
    overflow: hidden;
}
.popup.maestro-m34-dialog .popup-content {
    margin: 0;
    padding: 0;
    display: flex;
    min-height: 0;
    height: 100%;
    text-align: start;
}
.popup.maestro-m34-dialog .popup-body { height: 100%; }
.popup.maestro-m34-dialog .popup-button-close { display: none !important; }
.maestro-m34 {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    color: var(--maestro-text);
    font-size: var(--maestro-font-size);
}
.maestro-m34-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--maestro-gap-sm) var(--maestro-gap);
    padding: 8px 12px;
    border-bottom: 1px solid var(--maestro-border);
}
.maestro-m34-brand { display: flex; align-items: center; gap: var(--maestro-gap-sm); color: var(--maestro-accent); }
.maestro-m34-brand h3 { margin: 0; color: var(--maestro-text); font-size: 1.1em; }
.maestro-m34-preset { width: auto; min-width: 180px; max-width: 360px; margin: 0; }
.maestro-m34-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.maestro-m34-actions .maestro-btn { margin: 0; }
.maestro-m34-nav { border-bottom: 1px solid var(--maestro-border); padding: 0 8px; }
.maestro-m34-nav .maestro-tabs {
    flex-direction: row;
    width: auto;
    padding: 0;
    gap: 2px;
    overflow-x: auto;
}
.maestro-m34-nav .maestro-tab { width: auto; white-space: nowrap; }
.maestro-m34-nav .maestro-tab.maestro-on { box-shadow: inset 0 -3px 0 var(--maestro-accent); }
.maestro-m34-layout {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    position: relative;
}
.maestro-m34-layout.maestro-m34-with-editor { grid-template-columns: minmax(0, 1fr) minmax(380px, 42%); }
.maestro-m34-pane, .maestro-m34-side { min-height: 0; min-width: 0; overflow: auto; padding: var(--maestro-gap-sm) var(--maestro-gap); }
.maestro-m34-side { border-left: 1px solid var(--maestro-border); }
.maestro-m34-side[hidden] { display: none; }
.maestro-m34-toolbar, .maestro-m34-summary-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--maestro-gap-sm);
    margin-bottom: var(--maestro-gap-sm);
}
.maestro-m34-toolbar .maestro-btn { margin: 0; }
.maestro-m34-search { flex: 1 1 200px; min-width: 0; margin: 0; }
.maestro-m34-inline { display: inline-flex; align-items: center; gap: 6px; }
.maestro-m34-map-type { width: auto; margin: 0; }
.maestro-m34-finding-links { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m34-slot-note { margin-top: 2px; }
.maestro-m34-insert { display: inline-flex; gap: 2px; align-items: center; }
.maestro-m34-insert-select { width: auto; max-width: 220px; margin: 0; }
.maestro-m34-count { font-weight: 600; font-variant-numeric: tabular-nums; }
.maestro-m34-h { margin: var(--maestro-gap) 0 var(--maestro-gap-sm); }
.maestro-m34-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 0.78em;
    background: var(--maestro-raised-strong);
    color: var(--maestro-muted);
    white-space: nowrap;
}
.maestro-m34-badge-layer { color: var(--maestro-accent); }
.maestro-m34-badge-warn { color: var(--maestro-warn); }
.maestro-m34-badge-conflict { color: var(--maestro-error); font-weight: 600; }
.maestro-m34-chip {
    padding: 0 6px;
    border-radius: var(--maestro-radius-sm);
    background: var(--maestro-raised);
    color: var(--maestro-muted);
    font-size: 0.82em;
    white-space: nowrap;
}
.maestro-m34-bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    padding: 4px 6px;
    margin-bottom: var(--maestro-gap-sm);
    border-radius: var(--maestro-radius-sm);
    background: var(--maestro-accent-soft);
}
.maestro-m34-bulk[hidden] { display: none; }
.maestro-m34-bulk .maestro-btn { margin: 0; }
.maestro-m34-bulk-count { font-weight: 600; margin-right: auto; }
.maestro-m34-block { border-bottom: 1px solid var(--maestro-border); padding: 2px 0; }
.maestro-m34-block.maestro-on { background: var(--maestro-accent-soft); }
.maestro-m34-block.maestro-m34-off .maestro-m34-block-name { opacity: 0.5; }
.maestro-m34-block.maestro-m34-missing .maestro-m34-block-title { text-decoration: line-through; }
.maestro-m34-block.maestro-m34-dragging { opacity: 0.5; }
.maestro-m34-block.maestro-m34-flash { outline: 2px solid var(--maestro-accent); outline-offset: -2px; }
.maestro-m34-block-main { display: flex; align-items: center; gap: 4px; min-height: 36px; }
.maestro-m34-block-main .maestro-btn { margin: 0; min-height: 30px; padding: 0 6px; }
.maestro-m34-handle { cursor: grab; color: var(--maestro-muted); padding: 0 4px; user-select: none; }
.maestro-m34-kind { display: inline-flex; gap: 1px; color: var(--maestro-muted); }
.maestro-m34-kind-important { color: var(--maestro-warn); }
.maestro-m34-kind-inChat { color: var(--maestro-accent); }
.maestro-m34-block-name, .maestro-m34-slot-name, .maestro-m34-version-pick {
    all: unset;
    cursor: pointer;
    min-width: 0;
}
.maestro-m34-block-name { flex: 1 1 auto; display: flex; flex-direction: column; }
.maestro-m34-block-name:focus-visible, .maestro-m34-slot-name:focus-visible, .maestro-m34-version-pick:focus-visible {
    outline: 2px solid var(--maestro-accent);
}
.maestro-m34-block-name[disabled] { cursor: default; }
.maestro-m34-block-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m34-block-meta { color: var(--maestro-muted); font-size: 0.8em; }
.maestro-m34-block-badges { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; }
.maestro-m34-tokens { min-width: 3.5em; text-align: right; color: var(--maestro-muted); font-variant-numeric: tabular-nums; font-size: 0.85em; }
.maestro-m34-block-actions { display: flex; }
.maestro-m34-preview { padding: 4px 8px 8px 36px; font-size: 0.9em; }
.maestro-m34-preview .maestro-btn { margin: 4px 0 0; }
.maestro-m34-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--monoFontFamily, ui-monospace, monospace);
    font-size: 0.92em;
    max-height: 360px;
    overflow: auto;
    padding: 4px 6px;
    border-radius: var(--maestro-radius-sm);
    background: var(--maestro-raised);
}
.maestro-m34-substituted { margin-top: 6px; }
.maestro-m34-hl { border-radius: 3px; padding: 0 1px; }
.maestro-m34-hl-macro { color: var(--maestro-accent); }
.maestro-m34-hl-variable { color: var(--maestro-info); background: var(--maestro-accent-soft); }
.maestro-m34-hl-condition { color: var(--maestro-warn); font-weight: 600; }
.maestro-m34-hl-flag { color: var(--maestro-ok); font-weight: 600; background: color-mix(in srgb, var(--maestro-ok) 15%, transparent); }
.maestro-m34-hl-comment { color: var(--maestro-muted); font-style: italic; }
.maestro-m34-editor { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m34-editor-head { display: flex; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m34-editor-head h4 { margin: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
.maestro-m34-editor-head .maestro-btn { margin: 0; }
.maestro-m34-editor-id { font-size: 0.8em; overflow-wrap: anywhere; }
.maestro-m34-field { display: flex; flex-direction: column; gap: 2px; }
.maestro-m34-field[hidden] { display: none; }
.maestro-m34-label { font-size: 0.85em; color: var(--maestro-muted); }
.maestro-m34-label-row { display: flex; justify-content: space-between; gap: var(--maestro-gap-sm); }
.maestro-m34-token-count { font-size: 0.85em; color: var(--maestro-muted); font-variant-numeric: tabular-nums; }
.maestro-m34-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--maestro-gap-sm); }
.maestro-m34-grid .text_pole, .maestro-m34-field .text_pole { margin: 0; }
.maestro-m34-triggers { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 4px 8px; display: flex; flex-wrap: wrap; gap: 2px 12px; }
.maestro-m34-triggers legend { padding: 0 4px; }
.maestro-m34-triggers .maestro-field-hint { flex-basis: 100%; }
.maestro-m34-f-content { min-height: 200px; resize: vertical; font-family: var(--monoFontFamily, ui-monospace, monospace); }
.maestro-m34-highlight > summary { cursor: pointer; min-height: 28px; }
.maestro-m34-source { font-size: 0.9em; color: var(--maestro-muted); }
.maestro-m34-editor-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; position: sticky; bottom: 0; padding: 6px 0; background: var(--maestro-surface); }
.maestro-m34-editor-actions .maestro-btn { margin: 0; }
.maestro-m34-stale[hidden] { display: none; }
.maestro-m34-slots { list-style: none; margin: 0; padding: 0; }
.maestro-m34-slot { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--maestro-border); }
.maestro-m34-slot.maestro-m34-off, .maestro-m34-slot.maestro-m34-dropped { opacity: 0.6; }
.maestro-m34-slot-depth { border-left: 3px solid var(--maestro-accent); padding-left: 6px; }
.maestro-m34-slot-marker .maestro-m34-slot-name { font-style: italic; }
.maestro-m34-slot-index { min-width: 2em; text-align: right; color: var(--maestro-muted); font-variant-numeric: tabular-nums; }
.maestro-m34-slot-role { color: var(--maestro-muted); }
.maestro-m34-slot-body { flex: 1 1 auto; min-width: 0; }
.maestro-m34-slot-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m34-slot-head .maestro-m34-tokens { margin-left: auto; }
.maestro-m34-bar { height: 4px; border-radius: 2px; background: var(--maestro-raised); margin-top: 4px; overflow: hidden; }
.maestro-m34-bar-fill { display: block; height: 100%; background: var(--maestro-accent); }
.maestro-m34-injections { margin: 4px 0 0; padding-left: 18px; font-size: 0.85em; color: var(--maestro-muted); }
.maestro-m34-findings, .maestro-m34-hints, .maestro-m34-version-list, .maestro-m34-op-list, .maestro-m34-foreign-list, .maestro-m34-orphaned {
    list-style: none;
    margin: 0;
    padding: 0;
}
.maestro-m34-finding { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--maestro-border); }
.maestro-m34-sev-warn > .fa-solid { color: var(--maestro-warn); }
.maestro-m34-sev-info > .fa-solid { color: var(--maestro-info); }
.maestro-m34-finding-body { flex: 1 1 auto; min-width: 0; }
.maestro-m34-finding-kind { font-weight: 600; }
.maestro-m34-finding .maestro-btn { margin: 0; }
.maestro-m34-hints li { padding: 4px 0; }
.maestro-m34-version { border-bottom: 1px solid var(--maestro-border); padding: 4px 0; }
.maestro-m34-version.maestro-on { background: var(--maestro-raised); }
.maestro-m34-version-pick { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; min-height: 32px; }
.maestro-m34-version-time { font-variant-numeric: tabular-nums; }
.maestro-m34-version-summary { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.maestro-m34-version-detail { padding: 6px 4px 8px 12px; }
.maestro-m34-diff h5 { margin: 8px 0 4px; }
.maestro-m34-diff-block { padding: 4px 0; border-bottom: 1px dashed var(--maestro-border); }
.maestro-m34-diff-field { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); gap: 6px; padding: 2px 0; }
.maestro-m34-diff-key { color: var(--maestro-muted); font-family: var(--monoFontFamily, ui-monospace, monospace); font-size: 0.85em; overflow-wrap: anywhere; }
.maestro-m34-diff-line { padding: 2px 0; }
.maestro-m34-layer section { margin-bottom: var(--maestro-gap); }
.maestro-m34-op { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--maestro-border); }
.maestro-m34-op-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.maestro-m34-op .maestro-btn { margin: 0; }
.maestro-m34-conflict { border: 1px solid var(--maestro-error); border-radius: var(--maestro-radius-sm); padding: 6px 8px; margin-bottom: var(--maestro-gap-sm); }
.maestro-m34-conflict-head { display: flex; align-items: center; gap: 6px; }
.maestro-m34-conflict-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 6px 0; }
.maestro-m34-conflict .maestro-btn, .maestro-m34-layer .maestro-row .maestro-btn { margin: 0; }
.maestro-m34-reference, .maestro-m34-target { width: auto; max-width: 280px; margin: 0; }
.maestro-m34-report { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.maestro-m34-foreign-item { padding: 4px 0; border-bottom: 1px solid var(--maestro-border); }
.maestro-m34-foreign-text { font-size: 0.85em; white-space: pre-wrap; overflow-wrap: anywhere; }
.maestro-m34-param-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--maestro-gap-sm) var(--maestro-gap); }
.maestro-m34-param { display: flex; flex-direction: column; gap: 2px; }
.maestro-m34-param-textarea { grid-column: 1 / -1; }
.maestro-m34-param .text_pole { margin: 0; }
.maestro-m34-param .maestro-m34-label { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.maestro-m34-param-key { font-size: 0.75em; color: var(--maestro-muted); }
.maestro-m34-invalid { outline: 2px solid var(--maestro-error); }
.maestro-m34-hidden-file { display: none; }
.maestro-m34-dialog-body h3 { margin-top: 0; }
.maestro-m34-form-dialog { text-align: start; }
.maestro-m34-custom-text { width: 100%; min-height: 240px; }
@media screen and (max-width: 1000px) {
    .popup.maestro-m34-dialog,
    .popup.maestro-m34-dialog.large_dialogue_popup {
        width: 100dvw !important;
        min-width: 100dvw !important;
        max-width: 100dvw !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        margin: 0;
        border: 0;
        border-radius: 0;
    }
    .maestro-m34-header { padding: 6px; padding-top: max(6px, env(safe-area-inset-top)); gap: 6px; }
    .maestro-m34-actions { margin-left: 0; }
    .maestro-m34-actions .maestro-btn span, .maestro-m34-brand h3 { display: none; }
    .maestro-m34-preset { flex: 1 1 140px; min-width: 0; max-width: none; }
    .maestro-m34-nav { padding: 4px 6px; }
    .maestro-m34-layout.maestro-m34-with-editor { grid-template-columns: minmax(0, 1fr); }
    .maestro-m34-side {
        position: absolute;
        inset: 0;
        z-index: 2;
        border: 0;
        background: var(--maestro-surface);
        padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
    .maestro-m34-handle { display: none; }
    .maestro-btn, .maestro-m34-block-name, .maestro-m34-slot-name, .maestro-m34-version-pick { min-height: var(--maestro-tap); }
    .maestro-m34-block-main { flex-wrap: wrap; }
    .maestro-m34-block-name { flex-basis: 50%; }
    .maestro-m34-conflict-cols { grid-template-columns: minmax(0, 1fr); }
    .maestro-m34-diff-field { grid-template-columns: minmax(0, 1fr); }
    .maestro-m34-text { max-height: 240px; }
}
`;
