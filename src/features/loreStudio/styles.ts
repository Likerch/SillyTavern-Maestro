// Stylesheet of the Lore Studio (M23). Desktop: books | entries | form in one large popup. Phones and narrow
// windows (≤1000px, ST's breakpoint): a full-screen dialog showing one pane at a time (books → entries → form),
// 44px tap targets, no hover-only controls (P10, L-017).
export const M23_CSS = `
.popup.maestro-m23-dialog {
    width: min(1500px, 98dvw);
    height: min(940px, 94dvh);
    max-height: 94dvh;
    padding: 0;
    overflow: hidden;
}
.popup.maestro-m23-dialog .popup-content {
    margin: 0;
    padding: 0;
    display: flex;
    min-height: 0;
    height: 100%;
    text-align: start;
}
.popup.maestro-m23-dialog .popup-body { height: 100%; }
.popup.maestro-m23-dialog .popup-button-close { display: none !important; }
.maestro-m23 {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    color: var(--maestro-text);
    font-size: var(--maestro-font-size);
}
.maestro-m23-header {
    display: flex;
    align-items: center;
    gap: var(--maestro-gap);
    padding: 8px 12px;
    border-bottom: 1px solid var(--maestro-border);
    flex-wrap: wrap;
}
.maestro-m23-brand { display: flex; align-items: center; gap: var(--maestro-gap-sm); color: var(--maestro-accent); }
.maestro-m23-brand h3 { margin: 0; color: var(--maestro-text); font-size: 1.1em; }
.maestro-m23-header .maestro-segmented { flex: 1 1 auto; }
.maestro-m23-main { flex: 1 1 auto; min-height: 0; overflow: auto; }
.maestro-m23-layout {
    display: grid;
    grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
    height: 100%;
    min-height: 0;
}
.maestro-m23-layout.maestro-m23-with-form {
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(360px, 44%);
}
/* Not enough room for three columns: the open form hides the book list (the entry list keeps its width). */
@media screen and (min-width: 1001px) and (max-width: 1599px) {
    .maestro-m23-layout.maestro-m23-with-form { grid-template-columns: minmax(0, 1fr) minmax(400px, 55%); }
    .maestro-m23-layout.maestro-m23-with-form .maestro-m23-col-books { display: none; }
}
.maestro-m23-col { min-height: 0; min-width: 0; overflow: auto; padding: var(--maestro-gap-sm) var(--maestro-gap); }
.maestro-m23-col-books { border-right: 1px solid var(--maestro-border); }
.maestro-m23-col-form { border-left: 1px solid var(--maestro-border); }
.maestro-m23-col[hidden] { display: none; }
.maestro-m23-books-tools, .maestro-m23-entries-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--maestro-gap-sm);
    align-items: center;
    margin-bottom: var(--maestro-gap-sm);
}
.maestro-m23-book-search, .maestro-m23-entry-search { flex: 1 1 180px; min-width: 0; margin: 0; }
.maestro-m23-hidden-file { display: none; }
.maestro-m23-section { margin-bottom: var(--maestro-gap-sm); }
.maestro-m23-section-title {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--maestro-gap-sm);
    min-height: 32px;
    font-weight: 600;
}
.maestro-m23-count {
    margin-left: auto;
    color: var(--maestro-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
}
.maestro-m23-book {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px var(--maestro-gap-sm);
    padding: 4px 6px;
    border-radius: var(--maestro-radius-sm);
}
.maestro-m23-book:hover { background: var(--maestro-raised); }
.maestro-m23-book.maestro-on { background: var(--maestro-accent-soft); }
.maestro-m23-book-name {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 28px;
}
.maestro-m23-book-name:focus-visible, .maestro-m23-entry-title:focus-visible, .maestro-m23-campaign-name:focus-visible,
.maestro-m23-book-link:focus-visible, .maestro-m23-status:focus-visible { outline: 2px solid var(--maestro-accent); }
.maestro-m23-book-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m23-book-badges { grid-column: 1 / 2; display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m23-global { grid-column: 2 / 3; grid-row: 1 / 3; display: flex; align-items: center; gap: 4px; cursor: pointer; }
.maestro-m23-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--maestro-border); }
.maestro-m23-dot-on { background: var(--maestro-ok); }
.maestro-m23-badge {
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
.maestro-m23-badge-lock { color: var(--maestro-warn); }
.maestro-m23-badge-campaign { color: var(--maestro-accent); }
.maestro-m23-badge-canon { color: var(--maestro-accent); }
.maestro-m23-badge-doctor { color: var(--maestro-warn); }
.maestro-m23-badge-active { color: var(--maestro-ok); font-weight: 600; }
.maestro-m23-bindings { margin-top: var(--maestro-gap); border-top: 1px solid var(--maestro-border); padding-top: var(--maestro-gap-sm); }
.maestro-m23-bindings > summary { cursor: pointer; display: flex; gap: var(--maestro-gap-sm); align-items: center; min-height: 32px; font-weight: 600; }
.maestro-m23-binding-group { margin: var(--maestro-gap-sm) 0; display: flex; flex-direction: column; gap: 4px; }
.maestro-m23-binding { display: flex; flex-direction: column; gap: 2px; margin: var(--maestro-gap-sm) 0; }
.maestro-m23-binding-label { font-size: 0.85em; color: var(--maestro-muted); }
.maestro-m23-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m23-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 0 0 8px;
    border-radius: 999px;
    background: var(--maestro-raised-strong);
}
.maestro-m23-chip .maestro-btn { min-height: 24px; padding: 0 6px; margin: 0; }
.maestro-m23-extra-list { max-height: 240px; overflow: auto; }
.maestro-m23-entries-head { display: flex; align-items: flex-start; gap: var(--maestro-gap-sm); margin-bottom: var(--maestro-gap-sm); }
.maestro-m23-back { display: none; }
.maestro-m23-book-heading { flex: 1 1 auto; min-width: 0; }
.maestro-m23-book-heading-title { margin: 0; overflow-wrap: anywhere; }
.maestro-m23-book-heading-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.85em; }
.maestro-m23-book-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m23-sort, .maestro-m23-page-size { width: auto; margin: 0; }
.maestro-m23-bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    padding: 4px 6px;
    margin-bottom: var(--maestro-gap-sm);
    border-radius: var(--maestro-radius-sm);
    background: var(--maestro-accent-soft);
}
.maestro-m23-bulk[hidden] { display: none; }
.maestro-m23-bulk-count { font-weight: 600; margin-right: auto; }
.maestro-m23-pager { display: flex; align-items: center; gap: var(--maestro-gap-sm); justify-content: flex-end; }
.maestro-m23-pager-text { font-variant-numeric: tabular-nums; color: var(--maestro-muted); }
.maestro-m23-entry { border-bottom: 1px solid var(--maestro-border); padding: 2px 0; }
.maestro-m23-entry.maestro-on { background: var(--maestro-accent-soft); }
.maestro-m23-entry.maestro-m23-disabled .maestro-m23-entry-title { opacity: 0.55; }
.maestro-m23-entry.maestro-m23-dragging { opacity: 0.5; }
.maestro-m23-entry.maestro-m23-flash { outline: 2px solid var(--maestro-accent); outline-offset: -2px; }
.maestro-m23-entry-main { display: flex; align-items: center; gap: 4px; min-height: 36px; }
.maestro-m23-entry-main .maestro-btn { margin: 0; min-height: 30px; padding: 0 6px; }
.maestro-m23-handle { cursor: grab; color: var(--maestro-muted); padding: 0 4px; user-select: none; }
.maestro-m23-status { all: unset; cursor: pointer; padding: 0 2px; line-height: 1; }
.maestro-m23-entry-title {
    all: unset;
    cursor: pointer;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.maestro-m23-entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m23-entry-meta { color: var(--maestro-muted); font-size: 0.8em; font-variant-numeric: tabular-nums; }
.maestro-m23-entry-badges { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; }
.maestro-m23-entry-actions { display: flex; gap: 0; }
.maestro-m23-entry-preview { padding: 4px 8px 8px 32px; font-size: 0.9em; }
.maestro-m23-preview-keys { color: var(--maestro-muted); overflow-wrap: anywhere; }
.maestro-m23-preview-content { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; }
.maestro-m23-pick { margin-top: 20%; }
.maestro-m23-settings { padding: var(--maestro-gap); max-width: 980px; }
.maestro-m23-settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--maestro-gap); }
.maestro-m23-setting { padding: var(--maestro-gap-sm); border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); }
.maestro-m23-campaigns { padding: var(--maestro-gap); max-width: 1100px; }
.maestro-m23-campaigns-head { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); margin-bottom: var(--maestro-gap); }
.maestro-m23-active-campaign { font-weight: 600; }
.maestro-m23-campaign {
    --maestro-m23-campaign-color: var(--maestro-accent);
    border: 1px solid var(--maestro-border);
    border-left: 4px solid var(--maestro-m23-campaign-color);
    border-radius: var(--maestro-radius-sm);
    padding: 4px 8px;
    margin-bottom: var(--maestro-gap-sm);
}
.maestro-m23-campaign.maestro-on { background: var(--maestro-accent-soft); }
.maestro-m23-campaign-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.maestro-m23-campaign-head .maestro-btn { margin: 0; }
.maestro-m23-campaign-name { all: unset; cursor: pointer; font-weight: 600; flex: 1 1 auto; min-height: 32px; display: flex; align-items: center; }
.maestro-m23-icon-picker > summary { cursor: pointer; list-style: none; color: var(--maestro-m23-campaign-color); padding: 4px; }
.maestro-m23-icon-grid { display: grid; grid-template-columns: repeat(8, 36px); gap: 2px; margin: 4px 0; }
.maestro-m23-icon-grid .maestro-btn { margin: 0; min-width: 0; padding: 0; }
.maestro-m23-color-row { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m23-swatch { --maestro-m23-swatch: transparent; background: var(--maestro-m23-swatch) !important; min-width: 28px; }
.maestro-m23-campaign-books, .maestro-m23-unfiled { padding-left: 8px; }
.maestro-m23-campaign-book { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 2px 0; }
.maestro-m23-campaign-book .maestro-btn { margin: 0; }
.maestro-m23-book-link { all: unset; cursor: pointer; flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.maestro-m23-move-book { width: auto; max-width: 200px; margin: 0; }
.maestro-m23-unfiled > summary, .maestro-m23-workshop > summary { cursor: pointer; min-height: 32px; font-weight: 600; }
.maestro-m23-dialog-body h3 { margin-top: 0; }
.maestro-m23-form-dialog { text-align: start; }
.maestro-m23-bulk-grid { display: grid; grid-template-columns: 1fr; gap: 2px; max-height: 60dvh; overflow: auto; }
.maestro-m23-bulk-row {
    display: grid;
    grid-template-columns: auto minmax(140px, 1fr) auto minmax(120px, 1fr);
    align-items: center;
    gap: 6px;
}
.maestro-m23-bulk-row .text_pole { margin: 0; }
.maestro-m23-order-form { display: flex; flex-direction: column; gap: 4px; }
@media screen and (max-width: 1000px) {
    .popup.maestro-m23-dialog,
    .popup.maestro-m23-dialog.large_dialogue_popup {
        width: 100dvw !important;
        min-width: 100dvw !important;
        max-width: 100dvw !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        margin: 0;
        border: 0;
        border-radius: 0;
    }
    .maestro-m23-header { padding: 6px; padding-top: max(6px, env(safe-area-inset-top)); gap: 6px; }
    .maestro-m23-classic span { display: none; }
    .maestro-m23-layout, .maestro-m23-layout.maestro-m23-with-form { grid-template-columns: minmax(0, 1fr); }
    .maestro-m23-layout .maestro-m23-col { display: none; border: 0; }
    .maestro-m23-layout[data-pane='books'] .maestro-m23-col-books,
    .maestro-m23-layout[data-pane='entries'] .maestro-m23-col-entries,
    .maestro-m23-layout[data-pane='form'] .maestro-m23-col-form { display: block; }
    .maestro-m23-back { display: inline-flex; }
    .maestro-btn, .maestro-m23-book-name, .maestro-m23-entry-title, .maestro-m23-campaign-name { min-height: var(--maestro-tap); }
    .maestro-m23-entry-main { flex-wrap: wrap; }
    .maestro-m23-entry-title { flex-basis: 60%; }
    .maestro-m23-bulk-row { grid-template-columns: auto 1fr; }
    .maestro-m23-bulk-row > :nth-child(3) { display: none; }
    .maestro-m23-bulk-row > :nth-child(4) { grid-column: 1 / -1; }
}
`;
