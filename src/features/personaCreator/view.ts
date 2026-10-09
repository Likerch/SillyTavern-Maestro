// Styles of M41: the persona window (an ST popup) and the busy mark of the editor button.
export const PERSONA_CREATOR_CSS = `
.maestro-m41-dialog { display: flex; flex-direction: column; gap: 8px; text-align: left; overflow-wrap: anywhere; }
.maestro-m41-dialog .maestro-m41-heading { margin: 0 0 4px; }
.maestro-m41-intro { margin: 0; }
.maestro-m41-label { display: block; font-weight: 600; margin-top: 4px; }
.maestro-m41-hint, .maestro-m41-note { color: var(--maestro-muted); font-size: 0.88em; }
.maestro-m41-note { border-left: 3px solid var(--maestro-warn); padding-left: 8px; }
.maestro-m41-error { color: var(--maestro-error); }
.maestro-m41-dialog .text_pole { margin: 0; width: 100%; box-sizing: border-box; }
.maestro-m41-dialog textarea { resize: vertical; }
.maestro-m41-description { min-height: 12em; }
.maestro-m41-options { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.maestro-m41-option { display: flex; align-items: center; gap: 8px; }
.maestro-m41-row { display: flex; flex-wrap: wrap; gap: var(--maestro-gap); }
.maestro-m41-col { flex: 1 1 14em; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.maestro-m41-outfits { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m41-outfit {
    display: flex; flex-direction: column; gap: 4px; padding: 6px 8px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); background: var(--maestro-raised);
}
.maestro-m41-outfit-head { display: flex; align-items: center; gap: 6px; }
.maestro-m41-outfit-head .text_pole { flex: 1 1 auto; font-weight: 600; }
.maestro-m41-outfit-head .maestro-btn { margin: 0; flex: none; }
.maestro-m41-outfit input[data-field="outfit-tags"] { font-size: 0.85em; color: var(--maestro-muted); }
.maestro-m41-buttons { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.maestro-m41-buttons .maestro-btn { margin: 0; }
.maestro-m41-phase { display: flex; align-items: center; gap: 8px; font-size: 1.05em; padding: 10px 0; }
.maestro-m41-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.maestro-m41-step { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.maestro-m41-step-detail { color: var(--maestro-muted); font-size: 0.9em; }
.maestro-m41-step.maestro-m41-done > i { color: var(--maestro-ok); }
.maestro-m41-step.maestro-m41-failed > i { color: var(--maestro-error); }
.maestro-m41-step.maestro-m41-skipped > i, .maestro-m41-step.maestro-m41-pending > i { color: var(--maestro-muted); }
.maestro-m41-result { display: flex; flex-wrap: wrap; gap: var(--maestro-gap); align-items: flex-start; }
.maestro-m41-result-text { flex: 1 1 16em; min-width: 0; }
.maestro-m41-preview {
    width: 128px; height: 128px; object-fit: cover; flex: none;
    border-radius: var(--maestro-radius); border: 1px solid var(--maestro-border);
}
@keyframes maestro-m41-pulse { 50% { opacity: 0.45; } }
#maestro_m41_persona_button.maestro-m41-busy { animation: maestro-m41-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
    #maestro_m41_persona_button.maestro-m41-busy { animation: none; opacity: 0.6; }
}
`;
