// Styles of the BunnyMo mode views (mobile first: one column, wrapping chips and buttons, tap-sized controls).
export const BUNNYMO_MODE_CSS = `
.maestro-m35b { display: flex; flex-direction: column; gap: var(--maestro-gap); min-width: 0; }
.maestro-m35b-nav .maestro-segment { flex: 1 1 auto; min-width: 7em; }
.maestro-m35b-body { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); min-width: 0; }
.maestro-m35b-controls { display: flex; flex-wrap: wrap; gap: var(--maestro-gap-sm); }
.maestro-m35b-controls .maestro-m35b-search { flex: 2 1 12em; min-width: 0; }
.maestro-m35b-controls .maestro-select { flex: 1 1 10em; min-width: 0; }
.maestro-m35b-tags { display: flex; flex-direction: column; gap: 4px; }
.maestro-m35b-tag { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 4px 8px; }
.maestro-m35b-tag > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; cursor: pointer; min-height: 32px; }
.maestro-m35b-code { font-family: var(--monoFontFamily, monospace); overflow-wrap: anywhere; }
.maestro-m35b-counts { margin-left: auto; font-size: 0.85em; }
.maestro-m35b-card { display: flex; flex-direction: column; gap: 4px; padding: 6px 0 2px; }
.maestro-m35b-label { font-weight: 600; font-size: 0.9em; margin-top: 4px; }
.maestro-m35b-strong { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m35b-list { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
.maestro-m35b-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m35b-chip { display: inline-flex; align-items: stretch; border: 1px solid var(--maestro-border); border-radius: 999px; background: var(--maestro-raised); overflow: hidden; max-width: 100%; }
.maestro-m35b-chip.maestro-on { border-color: var(--maestro-accent); background: var(--maestro-accent-soft); }
.maestro-m35b-chip-warn { border-color: var(--maestro-warn); }
.maestro-m35b-chip-bad { border-color: var(--maestro-error); }
.maestro-m35b-chip button { background: none; border: 0; color: inherit; cursor: pointer; padding: 4px 8px; min-height: 32px; font: inherit; }
.maestro-m35b-chip-text { font-family: var(--monoFontFamily, monospace); overflow-wrap: anywhere; text-align: left; }
.maestro-m35b-chip-remove { border-left: 1px solid var(--maestro-border) !important; padding: 4px 10px !important; }
.maestro-m35b-addrow, .maestro-m35b-mbti, .maestro-m35b-actions, .maestro-m35b-toolbar { display: flex; flex-wrap: wrap; gap: var(--maestro-gap-sm); align-items: center; margin-top: var(--maestro-gap-sm); }
.maestro-m35b-addrow .maestro-select { flex: 1 1 9em; min-width: 0; }
.maestro-m35b-value { flex: 2 1 10em; min-width: 0; }
.maestro-m35b-variant { flex: 1 1 14em; }
.maestro-m35b-problems { display: flex; flex-direction: column; gap: 4px; }
.maestro-m35b-problem { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.maestro-m35b-text { width: 100%; min-height: 5em; resize: vertical; box-sizing: border-box; }
.maestro-m35b-field { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--maestro-gap-sm); }
.maestro-m35b-sheet-head { display: flex; flex-direction: column; gap: 2px; }
.maestro-m35b-name { font-size: 1.15em; font-weight: 600; overflow-wrap: anywhere; }
.maestro-m35b-archives { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m35b-archive { max-width: 100%; }
.maestro-m35b-packs { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m35b-pack { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.maestro-m35b-pack.maestro-m35b-focus { border-color: var(--maestro-accent); }
.maestro-m35b-pack-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m35b-book { font-size: 0.85em; overflow-wrap: anywhere; }
.maestro-m35b-file { position: relative; }
.maestro-m35b-core { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m35b-selection { display: flex; flex-direction: column; gap: 4px; }
.maestro-m35b-diff-item { margin: 4px 0 4px 1em; }
.maestro-m35b-findings, .maestro-m35b-rules { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m35b-rule { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; }
.maestro-m35b-rule-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m35b-save { position: sticky; bottom: 0; background: var(--maestro-surface); padding: var(--maestro-gap-sm) 0; }
@media (min-width: 1000px) {
    .maestro-m35b-packs { display: grid; grid-template-columns: repeat(auto-fill, minmax(22em, 1fr)); }
}
`;
