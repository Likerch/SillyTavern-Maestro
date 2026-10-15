// M25 «Механики», what the HUD shows (hud-place.ts says where, hud.ts draws it):
// - over the chat, one line per character: the user's character and the characters chosen for the HUD (those in the
//   scene; settings.hudHolders), the pinned values (settings.hudAttrs; none pinned: every value the HUD may show) in
//   their view, conditions with what is left, what is worn or in hand (hudHolders, holderParts);
// - beside the chat (the panel left or right of it, or the rail's flyout), in one of two views (setting `hudSideView`,
//   switched in the panel's header too):
//   · compact — exactly what the HUD over the chat shows, as a column: each character's name, then one value per line
//     (bars stretch), then the conditions and what is worn (compactHolder);
//   · full — every character of the scene (the user's character first, then the ones chosen for the HUD, then the
//     rest) with every value the HUD may show, one per line (sign, name, bar, number or words: view-values'
//     holderView), the conditions and the items; the fight's round and whose turn it is (sideHolder, sideFight).
//   Each character is a section that folds; what is folded and the widths the panel was dragged to are remembered per
//   device (localStorage `maestro.m25.hud.side`: loadSidePrefs / saveSidePrefs).
// The same visibility rules as everywhere: hidden values only once revealed, secret ones never.
import type { I18n } from '../../shared/contracts';
import { el, icon } from '../../ui/components/dom';
import type { CombatState, MechanicDef, MechanicsApi } from './api';
import { RAIL_WIDTH } from './hud-place';
import type { HudSide } from './hud-place';
import type { HudSideView } from './parts';
import {
    effectiveNumbers,
    holderView,
    holdersOf,
    itemChip,
    itemsOf,
    personaOf,
    sameName,
    shownIn,
    statusChip,
    statusesOf,
    translator,
    valueNode,
} from './view-values';
import type { ValueDecorator } from './view-values';

/** The panel beside the chat (on the HUD's node). */
export const SIDE_CLASS = 'maestro-m25-hud-side';
/** The rail: the HUD's node is the tab at the chat's edge and holds the flyout. */
export const RAIL_CLASS = 'maestro-m25-hud-rail';
/** The flyout of the rail: the panel's content over the chat's edge. */
export const FLYOUT_CLASS = 'maestro-m25-hud-flyout';

/* ------------------------------------------------------------------ who and what */

/** Characters of the HUD over the chat and of the compact view: the user's character, then the chosen ones present. */
export function hudHolders(api: MechanicsApi, defs: MechanicDef[], chosen: readonly string[]): string[] {
    const persona = personaOf(api);
    const present = new Set<string>();
    for (const def of defs) for (const holder of holdersOf(api, def)) present.add(holder);
    const out: string[] = persona ? [persona] : [];
    for (const name of chosen) {
        const found = [...present].find((holder) => sameName(holder, name));
        if (found && !out.some((item) => sameName(item, found))) out.push(found);
    }
    return out;
}

/** Characters of the full view: the user's character, the ones chosen for the HUD, then the rest of the scene. */
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

/** What the HUD shows of one character (over the chat and in the compact view). */
export interface HolderParts {
    values: HTMLElement[];
    statuses: HTMLElement[];
    worn: HTMLElement[];
}

/**
 * The pinned values of a character in their view (`pins` empty: every value the HUD may show), the conditions (over
 * the chat only the turns left, `shortStatus`) and what is worn or in hand. Null when nothing shows.
 */
export function holderParts(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    defs: MechanicDef[],
    holder: string,
    pins: readonly string[],
    options: { shortStatus?: boolean; decorate?: ValueDecorator } = {},
): HolderParts | null {
    const t = translator(i18n);
    const values: HTMLElement[] = [];
    for (const def of defs) {
        if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
        if (!holdersOf(api, def).some((name) => sameName(name, holder))) continue;
        const effective = effectiveNumbers(api, def, holder);
        for (const attribute of def.attributes) {
            if (pins.length && !pins.includes(`${def.id}.${attribute.id}`)) continue;
            const shown = shownIn(api, def, attribute, holder, 'hud', effective);
            if (!shown) continue;
            const node = valueNode(t, attribute, shown);
            options.decorate?.(def, attribute, node);
            values.push(node);
        }
    }
    const statuses = statusesOf(api, holder).map((status) => statusChip(i18n, status, options.shortStatus === true));
    const worn = itemsOf(api, holder)
        .filter((item) => item.equipped)
        .map((item) => itemChip(t, item));
    if (!values.length && !statuses.length && !worn.length) return null;
    return { values, statuses, worn };
}

/** The fold key of a character. */
export const foldKey = (holder: string) => holder.trim().toLowerCase();

/** A character's section: its name folds what is under it (remembered per device by the caller). */
function section(
    api: MechanicsApi,
    holder: string,
    body: HTMLElement[],
    open: boolean,
    onToggle: (open: boolean) => void,
    extra?: string,
): HTMLElement {
    const summary = el('summary', { text: api.shownName?.(holder) ?? holder, data: { focusKey: `holder:${holder}` } });
    const details = el('details', { attrs: { open } }, [summary, ...body]);
    details.addEventListener('toggle', () => onToggle(details.open));
    // <details> is a group named by its <summary>: no landmark per character.
    return el('div', { class: ['maestro-m25-hud-side-holder', extra], data: { holder } }, [details]);
}

/** One character of the compact view: the name, the values one per line, the conditions and what is worn. */
export function compactHolder(
    parts: HolderParts,
    api: MechanicsApi,
    holder: string,
    open: boolean,
    onToggle: (open: boolean) => void,
): HTMLElement {
    const body: HTMLElement[] = [];
    if (parts.values.length) body.push(el('div', { class: 'maestro-m25-hud-crow-values' }, parts.values));
    if (parts.statuses.length || parts.worn.length) {
        body.push(el('div', { class: 'maestro-m25-hud-crow-chips' }, [...parts.statuses, ...parts.worn]));
    }
    return section(api, holder, body, open, onToggle, 'maestro-m25-hud-compact');
}

/** One character of the full view: every value the HUD may show, the conditions and the items. */
export function sideHolder(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    holder: string,
    open: boolean,
    onToggle: (open: boolean) => void,
    decorate?: ValueDecorator,
): HTMLElement | null {
    const view = holderView(i18n, api, holder, 'hud', { full: true, decorate });
    if (!view) return null;
    return section(api, holder, [view], open, onToggle);
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

/* ------------------------------------------------------------------ remembered per device */

export const HUD_SIDE_STORAGE_KEY = 'maestro.m25.hud.side';
/** Folded characters remembered at most (the latest ones). */
const FOLDED_LIMIT = 60;

export interface SidePrefs {
    /** Widths the panel was dragged to, by `side.view` («left.compact», «right.full»). */
    widths: Record<string, number>;
    /** Characters whose section is folded (foldKey). */
    folded: string[];
}

export const widthKey = (side: HudSide, view: HudSideView) => `${side}.${view}`;

/** What this device remembers; a broken or missing record gives nothing remembered. */
export function loadSidePrefs(storage: Pick<Storage, 'getItem'> | null): SidePrefs {
    try {
        const raw = storage?.getItem(HUD_SIDE_STORAGE_KEY);
        const value = raw ? (JSON.parse(raw) as Partial<SidePrefs> | null) : null;
        const widths: Record<string, number> = {};
        if (value?.widths && typeof value.widths === 'object') {
            for (const [key, width] of Object.entries(value.widths)) {
                if (!/^(left|right)\.(compact|full)$/.test(key)) continue;
                if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[key] = Math.round(width);
            }
        }
        const folded = Array.isArray(value?.folded)
            ? [
                  ...new Set(
                      value.folded
                          .filter((item): item is string => typeof item === 'string' && !!item.trim())
                          .map(foldKey),
                  ),
              ].slice(-FOLDED_LIMIT)
            : [];
        return { widths, folded };
    } catch {
        return { widths: {}, folded: [] };
    }
}

export function saveSidePrefs(storage: Pick<Storage, 'setItem'> | null, prefs: SidePrefs): void {
    try {
        storage?.setItem(
            HUD_SIDE_STORAGE_KEY,
            JSON.stringify({ widths: prefs.widths, folded: prefs.folded.slice(-FOLDED_LIMIT) }),
        );
    } catch {
        // private mode / full storage: remembered only for this page
    }
}

/* ------------------------------------------------------------------ styles */

/** Styles of the panel, the rail and its flyout; scoped under the HUD's id. */
export function sideCss(id: string): string {
    const hud = `#${id}`;
    const side = `${hud}.${SIDE_CLASS}`;
    const rail = `${hud}.${RAIL_CLASS}`;
    const fly = `${hud} .${FLYOUT_CLASS}`;
    /** One rule for the panel and the flyout alike. */
    const both = (rest: string) => `${side}${rest}, ${fly}${rest}`;
    return `
${side} { padding: 6px 8px; gap: 6px; overflow: hidden; }
${fly} { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 6px 8px;
    overflow: hidden; border-radius: 8px; background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(6px); border: 1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35));
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); }
${both(' .maestro-m25-hud-side-head')} { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; flex: none; }
${both(' .maestro-m25-hud-side-title')} { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
${both(' .maestro-m25-hud-actions')} { flex-wrap: wrap; }
${both(' .maestro-m25-hud-actions .maestro-btn')} { min-width: 26px; padding: 2px 4px; }
${both(' .maestro-m25-hud-panel')} { flex: none; }
${both(' .maestro-m25-hud-side-fight')} { flex: none; display: flex; align-items: center; gap: 6px; font-weight: 600; }
${both(' .maestro-m25-hud-side-body')} { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
${both(' .maestro-m25-hud-side-body:focus-visible')} { outline: 2px solid var(--SmartThemeQuoteColor, #e0a84f);
    outline-offset: 1px; }
${both(' .maestro-m25-hud-side-holder')} { border-top: 1px solid var(--SmartThemeBorderColor, rgba(127,127,127,0.3));
    padding-top: 4px; }
${both(' .maestro-m25-hud-side-holder:first-child')} { border-top: none; padding-top: 0; }
${both(' .maestro-m25-hud-side-holder > details > summary')} { cursor: pointer; font-weight: 600; padding: 2px 0;
    list-style-position: inside; overflow-wrap: anywhere; }
${both(' .maestro-m25-hud-side-holder > details > summary:focus-visible')} {
    outline: 2px solid var(--SmartThemeQuoteColor, #e0a84f); outline-offset: 1px; }
${both(' .maestro-m25-holder-view')} { gap: 6px; margin-top: 2px; }
${both(' .maestro-m25-hv-row')} { display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
${both(' .maestro-m25-hv-row.maestro-m25-hv-statuses')}, ${both(' .maestro-m25-hv-row.maestro-m25-hv-items')} {
    flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px; }
${both(' .maestro-m25-hv-statuses > .maestro-m25-hv-title')}, ${both(' .maestro-m25-hv-items > .maestro-m25-hv-title')} {
    flex: 0 0 100%; }
${both(' .maestro-m25-hv-title')} { font-size: 0.9em; }
${both(' .maestro-m25-hv-row > .maestro-m25-v')} { display: flex; width: 100%; gap: 6px; }
${both(' .maestro-m25-v-label')} { flex: 1 1 auto; min-width: 0; display: inline-flex; gap: 4px; overflow: hidden; }
${both(' .maestro-m25-v-label .maestro-m25-v-name')} { overflow: hidden; text-overflow: ellipsis; }
${both(' .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-meter')} { width: 80px; flex: none; }
${both(' .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-v-number')},
${both(' .maestro-m25-hv-row > .maestro-m25-v .maestro-m25-v-words')} { flex: 0 1 auto; min-width: 2.5em;
    text-align: right; white-space: normal; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
${both(' .maestro-m25-hud-crow-values')} { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
${both(' .maestro-m25-hud-crow-values > .maestro-m25-v')} { display: flex; width: 100%; gap: 6px; }
${both(' .maestro-m25-hud-crow-values > .maestro-m25-v .maestro-m25-meter')} { flex: 1 1 auto; width: auto;
    min-width: 24px; }
${both(' .maestro-m25-hud-crow-values > .maestro-m25-v .maestro-m25-v-number')},
${both(' .maestro-m25-hud-crow-values > .maestro-m25-v .maestro-m25-v-words')} { margin-left: auto; text-align: right;
    white-space: normal; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
${both(' .maestro-m25-hud-crow-chips')} { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
${both(' .maestro-m25-chip-status')}, ${both(' .maestro-m25-chip-item')} { white-space: normal; }
${both(' .maestro-m25-hud-reason')} { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
    padding: 4px 6px; border-radius: 6px; font-size: 0.85em; background: rgba(127, 127, 127, 0.15); }
${both(' .maestro-m25-hud-reason .maestro-btn')} { margin: 0; min-height: 26px; padding: 2px 6px; }
${side} .maestro-m25-hud-resize { position: absolute; top: 0; height: 100%; width: 6px; cursor: ew-resize;
    touch-action: none; z-index: 1; }
${side}[data-side="left"] .maestro-m25-hud-resize { left: 0; }
${side}[data-side="right"] .maestro-m25-hud-resize { left: calc(100% - 6px); }
${side} .maestro-m25-hud-resize:hover, ${side} .maestro-m25-hud-resize:focus-visible,
${side}.maestro-m25-hud-resizing .maestro-m25-hud-resize { background: var(--SmartThemeQuoteColor, #e0a84f);
    opacity: 0.5; outline: none; }
${rail} { padding: 0; gap: 0; width: ${RAIL_WIDTH}px; overflow: visible; background: none; border: none;
    box-shadow: none; backdrop-filter: none; }
${rail} .maestro-m25-hud-rail-tab { box-sizing: border-box; width: ${RAIL_WIDTH}px; min-height: 96px; margin: 0;
    padding: 8px 0; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer;
    color: inherit; font: inherit; background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(6px); border: 1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35));
    border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
${rail} .maestro-m25-hud-rail-tab:focus-visible { outline: 2px solid var(--SmartThemeQuoteColor, #e0a84f);
    outline-offset: 1px; }
${rail} .maestro-m25-hud-rail-tab[aria-expanded="true"] { border-color: var(--SmartThemeQuoteColor, #e0a84f); }
${rail} .maestro-m25-hud-rail-label { writing-mode: vertical-rl; font-weight: 600; letter-spacing: 0.04em;
    white-space: nowrap; }
${rail}[data-side="left"] .maestro-m25-hud-rail-label { transform: rotate(180deg); }
${rail} .maestro-m25-hud-rail-warn { color: var(--maestro-warn, #da5); }
`;
}
