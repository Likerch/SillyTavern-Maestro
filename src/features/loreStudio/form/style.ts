// Stylesheet of the entry form (added through app.ui.style while a form is open). Phone first: one column, labels
// above controls, 44px tap targets; two columns from 700px. Colours come from the --maestro-* tokens (ST theme).
export const ENTRY_FORM_CSS = `
.maestro-m23f {
    display: flex;
    flex-direction: column;
    gap: var(--maestro-gap, 12px);
    color: var(--maestro-text);
    min-width: 0;
}
.maestro-m23f [hidden] {
    display: none !important;
}
.maestro-m23f-head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0;
    background: var(--maestro-surface);
    border-bottom: 1px solid var(--maestro-border);
}
.maestro-m23f-is-dirty .maestro-m23f-head {
    box-shadow: inset 0 -2px 0 var(--maestro-warn);
}
.maestro-m23f-head-row,
.maestro-m23f-toolbar,
.maestro-m23f-actions,
.maestro-m23f-row-inline,
.maestro-m23f-quick {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}
.maestro-m23f-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 1.1em;
    overflow-wrap: anywhere;
}
.maestro-m23f-dirty {
    color: var(--maestro-warn);
    font-size: 0.85em;
}
.maestro-m23f-head-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    color: var(--maestro-muted);
    font-size: 0.9em;
}
.maestro-m23f-book {
    overflow-wrap: anywhere;
}
.maestro-m23f-badges,
.maestro-m23f-chips,
.maestro-m23f-suggest {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}
.maestro-m23f-status {
    font-size: 0.9em;
}
.maestro-m23f-status-ok {
    color: var(--maestro-ok);
}
.maestro-m23f-status-warn {
    color: var(--maestro-warn);
}
.maestro-m23f-status-error {
    color: var(--maestro-error);
}
.maestro-m23f-edit {
    display: flex;
    flex-direction: column;
    gap: var(--maestro-gap, 12px);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
}
.maestro-m23f-section > .maestro-m23f-summary {
    display: flex;
    align-items: center;
    min-height: var(--maestro-tap, 44px);
    cursor: pointer;
}
.maestro-m23f-section > .maestro-m23f-summary::before {
    content: '▸';
    margin-right: 8px;
    transition: transform var(--maestro-duration, 125ms);
}
.maestro-m23f-section[open] > .maestro-m23f-summary::before {
    transform: rotate(90deg);
}
.maestro-m23f-section > .maestro-m23f-summary::-webkit-details-marker {
    display: none;
}
.maestro-m23f-body {
    gap: 10px;
}
.maestro-m23f-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}
.maestro-m23f-label {
    font-weight: 600;
}
.maestro-m23f-control {
    min-width: 0;
}
.maestro-m23f-control > .text_pole,
.maestro-m23f-control > div > .text_pole,
.maestro-m23f-control > textarea,
.maestro-m23f-control > select {
    width: 100%;
    margin: 0;
    box-sizing: border-box;
}
.maestro-m23f-control > .maestro-m23f-number {
    max-width: 12em;
}
.maestro-m23f-textarea {
    resize: vertical;
}
.maestro-m23f-content {
    min-height: 10em;
}
.maestro-m23f-content-big {
    min-height: 60vh;
}
.maestro-m23f-keys {
    font-family: var(--monoFontFamily, monospace);
}
.maestro-m23f-hint {
    color: var(--maestro-muted);
    font-size: 0.88em;
}
.maestro-m23f-error {
    color: var(--maestro-error);
    font-size: 0.88em;
}
.maestro-m23f-notes {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.maestro-m23f-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 0.9em;
    border-left: 3px solid var(--maestro-level, var(--maestro-accent));
    border-radius: var(--maestro-radius-sm, 6px);
    background: color-mix(in srgb, var(--maestro-level, var(--maestro-accent)) 10%, transparent);
}
.maestro-m23f-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--maestro-raised-strong);
    font-size: 0.9em;
    overflow-wrap: anywhere;
}
.maestro-m23f-chip-regex {
    font-family: var(--monoFontFamily, monospace);
}
.maestro-m23f-chip-icon {
    color: var(--maestro-accent);
}
.maestro-m23f-chip-warn {
    outline: 1px solid var(--maestro-warn);
}
.maestro-m23f-chip-badge,
.maestro-m23f-tag {
    padding: 0 4px;
    border-radius: 4px;
    font-size: 0.75em;
    background: var(--maestro-accent-soft);
}
.maestro-m23f-tag {
    margin-left: 6px;
    background: color-mix(in srgb, var(--maestro-warn) 25%, transparent);
}
.maestro-m23f-chip-hit {
    background: color-mix(in srgb, var(--maestro-ok) 22%, transparent);
}
.maestro-m23f-chip-miss {
    opacity: 0.7;
}
.maestro-m23f-chip-btn {
    min-height: 32px;
    border: 1px dashed var(--maestro-border);
    color: inherit;
    cursor: pointer;
}
.maestro-m23f-chip-x {
    min-width: 28px;
    min-height: 28px;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
}
.maestro-m23f-counter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    color: var(--maestro-muted);
    font-size: 0.9em;
}
.maestro-m23f-check .checkbox_label,
.maestro-m23f-pick {
    min-height: 36px;
    margin: 0;
}
.maestro-m23f-picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 16em;
    overflow: auto;
    padding: 4px 8px;
    border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm, 6px);
}
.maestro-m23f-picker-inline {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px 14px;
    max-height: none;
    padding: 0;
    border: 0;
}
.maestro-m23f-filter,
.maestro-m23f-triggers,
.maestro-m23f-typed,
.maestro-m23f-typed-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.maestro-m23f-sides {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
}
.maestro-m23f-side {
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm, 6px);
}
.maestro-m23f-side-title {
    font-weight: 600;
}
.maestro-m23f-side-keys {
    color: var(--maestro-muted);
    font-size: 0.88em;
    overflow-wrap: anywhere;
}
.maestro-m23f-side-text {
    max-height: 20em;
    margin: 0;
    overflow: auto;
    font-family: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.maestro-m23f-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding-left: 1.2em;
}
.maestro-m23f-hist-list {
    padding: 0;
    list-style: none;
}
.maestro-m23f-hist-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--maestro-border);
}
.maestro-m23f-hist-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
.maestro-m23f-hist-by {
    color: var(--maestro-muted);
}
.maestro-m23f-test-result {
    padding: 6px 10px;
    border-left: 3px solid var(--maestro-level, var(--maestro-accent));
    border-radius: var(--maestro-radius-sm, 6px);
    background: color-mix(in srgb, var(--maestro-level, var(--maestro-accent)) 12%, transparent);
}
.maestro-m23f-test-out,
.maestro-m23f-stats,
.maestro-m23f-findings,
.maestro-m23f-canon,
.maestro-m23f-hist {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.maestro-m23f-help > summary {
    cursor: pointer;
    color: var(--maestro-muted);
    font-size: 0.9em;
}
.maestro-m23f-readonly .maestro-m23f-edit {
    opacity: 0.85;
}
@media (min-width: 700px) {
    .maestro-m23f-row {
        display: grid;
        grid-template-columns: minmax(150px, 1fr) minmax(220px, 2fr);
        align-items: start;
        column-gap: var(--maestro-gap, 12px);
    }
    .maestro-m23f-row > .maestro-m23f-label {
        padding-top: 6px;
    }
    .maestro-m23f-row > .maestro-m23f-hint,
    .maestro-m23f-row > .maestro-m23f-error {
        grid-column: 2;
    }
    .maestro-m23f-sides {
        grid-template-columns: 1fr 1fr;
    }
}
`;
