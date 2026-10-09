// M25 «Механики», what the HUD's left panel shows (hud-place.ts says when it is there): more room than the line over
// the chat, so more of the mechanics — every character of the scene (the user's character first, then the ones chosen
// for the HUD, then the rest), each a section that folds, with every value the HUD may show one per line (sign, name,
// bar, number or words: view-values' holderView), the conditions with what is left and the items; the fight's round
// and whose turn it is. The same visibility rules as everywhere: hidden values only once revealed, secret ones never.
import type { I18n } from '../../shared/contracts';
import { el, icon } from '../../ui/components/dom';
import type { CombatState, MechanicDef, MechanicsApi } from './api';
import { holderView, holdersOf, personaOf, sameName, translator } from './view-values';

export const SIDE_CLASS = 'maestro-m25-hud-side';

/** Styles of the left panel; scoped under the HUD's id and the side class. */
export function sideCss(id: string): string {
    const side = `#${id}.${SIDE_CLASS}`;
    return `
${side} { padding: 6px 8px; gap: 6px; overflow: hidden; }
${side} .maestro-m25-hud-side-head { display: flex; align-items: center; gap: 6px; flex: none; }
${side} .maestro-m25-hud-side-title { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
${side} .maestro-m25-hud-side-fight { flex: none; display: flex; align-items: center; gap: 6px; font-weight: 600; }
${side} .maestro-m25-hud-side-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
${side} .maestro-m25-hud-side-body:focus-visible { outline: 2px solid var(--SmartThemeQuoteColor, #e0a84f);
    outline-offset: 1px; }
${side} .maestro-m25-hud-side-holder { border-top: 1px solid var(--SmartThemeBorderColor, rgba(127,127,127,0.3));
    padding-top: 4px; }
${side} .maestro-m25-hud-side-holder:first-child { border-top: none; padding-top: 0; }
${side} .maestro-m25-hud-side-holder > details > summary { cursor: pointer; font-weight: 600; padding: 2px 0;
    list-style-position: inside; }
${side} .maestro-m25-hud-side-holder > details > summary:focus-visible {
    outline: 2px solid var(--SmartThemeQuoteColor, #e0a84f); outline-offset: 1px; }
${side} .maestro-m25-holder-view { gap: 6px; margin-top: 2px; }
${side} .maestro-m25-hv-row { display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
${side} .maestro-m25-hv-row.maestro-m25-hv-statuses, ${side} .maestro-m25-hv-row.maestro-m25-hv-items {
    flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px; }
${side} .maestro-m25-hv-statuses > .maestro-m25-hv-title, ${side} .maestro-m25-hv-items > .maestro-m25-hv-title {
    flex: 0 0 100%; }
${side} .maestro-m25-hv-title { font-size: 0.9em; }
${side} .maestro-m25-hv-row > .maestro-m25-v { display: flex; width: 100%; gap: 6px; }
${side} .maestro-m25-v-label { flex: 1 1 auto; min-width: 0; display: inline-flex; gap: 4px; overflow: hidden; }
${side} .maestro-m25-v-label .maestro-m25-v-name { overflow: hidden; text-overflow: ellipsis; }
${side} .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-meter { width: 80px; flex: none; }
${side} .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-v-number,
${side} .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-v-words { flex: 0 1 auto; min-width: 2.5em; text-align: right;
    white-space: normal; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
${side} .maestro-m25-chip-status, ${side} .maestro-m25-chip-item { white-space: normal; }
`;
}

/** Characters of the left panel: the user's character, the ones chosen for the HUD, then the rest of the scene. */
export function sideHolders(api: MechanicsApi, defs: MechanicDef[], chosen: readonly string[]): string[] {
    const present: string[] = [];
    for (const def of defs) {
        if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
        for (const holder of holdersOf(api, def)) {
            if (!present.some((name) => sameName(name, holder))) present.push(holder);
        }
    }
    const out: string[] = [];
    const add = (name: string) => {
        if (name && !out.some((item) => sameName(item, name))) out.push(name);
    };
    const persona = personaOf(api);
    if (persona) add(present.find((name) => sameName(name, persona)) ?? persona);
    for (const name of chosen) {
        const found = present.find((holder) => sameName(holder, name));
        if (found) add(found);
    }
    for (const name of present) add(name);
    return out;
}

/** One character's section: its name folds the values, conditions and items away (remembered while the page lives). */
export function sideHolder(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    holder: string,
    open: boolean,
    onToggle: (open: boolean) => void,
): HTMLElement | null {
    const view = holderView(i18n, api, holder, 'hud', { full: true });
    if (!view) return null;
    const summary = el('summary', { text: api.shownName?.(holder) ?? holder, data: { focusKey: `holder:${holder}` } });
    const details = el('details', { attrs: { open } }, [summary, view]);
    details.addEventListener('toggle', () => onToggle(details.open));
    // <details> is a group named by its <summary>: no landmark per character.
    return el('div', { class: 'maestro-m25-hud-side-holder', data: { holder } }, [details]);
}

/** «Бой · раунд 2 · ходит Кай» while a fight is on; null otherwise. */
export function sideFight(i18n: Pick<I18n, 't'>, api: MechanicsApi): HTMLElement | null {
    let fight: CombatState | null;
    try {
        fight = api.combat?.() ?? null;
    } catch {
        fight = null;
    }
    if (!fight?.active) return null;
    const t = translator(i18n);
    const now = fight.order[fight.current]?.holder;
    return el('div', { class: 'maestro-m25-hud-side-fight' }, [
        icon('fa-shield-halved'),
        el('span', {
            text: now
                ? t('m25.hud.side.fight', { round: fight.round, name: now })
                : t('m25.win.combat.round', { round: fight.round }),
        }),
    ]);
}
