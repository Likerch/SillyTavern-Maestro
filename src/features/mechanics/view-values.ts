// M25 «Механики», drawing what the player may see (plan-2 §6.А): one value in its view (number, bar, words, icon),
// the words of a value in the UI language, what is left of a status, one change of the change line («❤ 80 → 65»,
// «+ Отравлен (3 хода)»), a holder's values, statuses and items for a place (the dossier section, the status block).
// Everything reads the public MechanicsApi, so every surface follows the same visibility rules: hidden values only
// once revealed, secret ones never.
import { pluralForm } from '../../domain/plural';
import {
    changeMeaning,
    durationParts,
    formatNumber,
    listDelta,
    plainValue,
    sameWords,
    shownValue,
} from '../../domain/mechanics-view';
import type { DurationParts, ShownValue } from '../../domain/mechanics-view';
import type { I18n, Unsubscribe } from '../../shared/contracts';
import { clear, el, icon } from '../../ui/components/dom';
import type {
    AttributeDef,
    AttributeValue,
    ItemState,
    MechanicDef,
    MechanicsApi,
    StateChange,
    StatusState,
    Visibility,
    VisibilityPlace,
} from './api';

export const VALUES_CSS = `
.maestro-m25-v { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.maestro-m25-v-sign { font-size: 0.95em; }
.maestro-m25-v-name { opacity: 0.8; }
.maestro-m25-v-words { font-style: italic; }
.maestro-m25-v-dot { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 50%;
    background: var(--maestro-muted, #888); }
.maestro-m25-v-dot[data-band="high"] { background: var(--maestro-ok, #5a5); }
.maestro-m25-v-dot[data-band="mid"] { background: var(--maestro-warn, #da5); }
.maestro-m25-v-dot[data-band="low"] { background: var(--maestro-error, #d55); }
.maestro-m25-meter { display: inline-block; width: 56px; height: 6px; border-radius: 3px; overflow: hidden;
    background: rgba(127, 127, 127, 0.3); vertical-align: middle; }
.maestro-m25-meter-fill { display: block; height: 100%; background: var(--SmartThemeQuoteColor, #e0a84f); }
.maestro-m25-chip-status, .maestro-m25-chip-item { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px;
    border-radius: 10px; border: 1px solid var(--maestro-border, rgba(127,127,127,0.4)); font-size: 0.9em; white-space: nowrap; }
.maestro-m25-holder-view { display: flex; flex-direction: column; gap: 4px; }
.maestro-m25-holder-view .maestro-m25-hv-row { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.maestro-m25-holder-view .maestro-m25-hv-title { font-weight: 600; opacity: 0.85; }
`;

type T = (key: string, params?: Record<string, string | number>) => string;

export function translator(i18n: Pick<I18n, 't'>): T {
    return (key, params) => i18n.t(key, params);
}

function locale(i18n: Pick<I18n, 'locale'>): 'en' | 'ru' {
    try {
        return i18n.locale() === 'ru' ? 'ru' : 'en';
    } catch {
        return 'en';
    }
}

/** «3 хода» / "3 turns": `<key>.one|few|many` with {count}. */
export function counted(i18n: Pick<I18n, 't' | 'locale'>, key: string, count: number): string {
    return i18n.t(`${key}.${pluralForm(count, locale(i18n))}`, { count });
}

/** The words of a value for the player: the attribute's own words, a default band, else the label itself. */
export function wordsText(t: T, words: { label: string; display?: string; band?: number } | null): string {
    if (!words) return '';
    if (words.display) return words.display;
    if (words.band !== undefined) return t(`m25.words.default.${words.band}`);
    return words.label;
}

/** What is left of a status: «3 хода», «2 ч», «до дня 5, 18:00»; '' when it lasts until removed. */
export function durationText(i18n: Pick<I18n, 't' | 'locale'>, parts: DurationParts | null): string {
    if (!parts) return '';
    const out: string[] = [];
    if (parts.turns !== undefined) out.push(counted(i18n, 'm25.play.turns', parts.turns));
    if (parts.time) out.push(counted(i18n, `m25.play.time.${parts.time.unit}`, parts.time.count));
    if (parts.until) {
        out.push(
            parts.until.time
                ? i18n.t('m25.play.untilTime', { day: parts.until.day, time: parts.until.time })
                : i18n.t('m25.play.until', { day: parts.until.day }),
        );
    }
    return out.join(', ');
}

export function statusDuration(i18n: Pick<I18n, 't' | 'locale'>, status: Pick<StatusState, 'remaining' | 'until'>) {
    return durationText(i18n, durationParts(status.remaining, status.until ?? null));
}

/** The sign of an attribute (its icon) or nothing. */
export function signOf(attribute: Pick<AttributeDef, 'icon'>): string {
    return attribute.icon?.trim() ?? '';
}

/** «❤» when the attribute has a sign, else its name. */
export function shortLabel(attribute: Pick<AttributeDef, 'icon' | 'name'>): string {
    return signOf(attribute) || attribute.name;
}

/** A small meter for a bounded number (role meter, a fill as wide as the share). */
export function meter(value: number, min: number, max: number, label: string): HTMLElement {
    const share = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
    const fill = el('span', { class: 'maestro-m25-meter-fill' });
    fill.style.width = `${Math.round(share * 100)}%`;
    return el(
        'span',
        {
            class: 'maestro-m25-meter',
            attrs: {
                role: 'meter',
                'aria-label': label,
                'aria-valuemin': min,
                'aria-valuemax': max,
                'aria-valuenow': value,
            },
        },
        [fill],
    );
}

function band(share: number | undefined): 'low' | 'mid' | 'high' | 'none' {
    if (share === undefined) return 'none';
    if (share <= 0.25) return 'low';
    if (share <= 0.6) return 'mid';
    return 'high';
}

/**
 * One value drawn in its view; `withName` puts the attribute's name (or sign) before it; `full` puts both the sign and
 * the name, and the «icon» view keeps its coloured dot (the left panel of the HUD: one value per line).
 */
export function valueNode(
    t: T,
    attribute: Pick<AttributeDef, 'name' | 'icon'>,
    shown: ShownValue,
    options: { withName?: boolean; nameOnly?: boolean; full?: boolean } = {},
): HTMLElement {
    const sign = signOf(attribute);
    const words = wordsText(t, shown.words);
    const title = [attribute.name, shown.view === 'words' ? words : shown.text, shown.view === 'words' ? '' : words]
        .filter(Boolean)
        .join(' · ');
    const signNode = sign
        ? el('span', { class: 'maestro-m25-v-sign', text: sign, attrs: { 'aria-hidden': 'true' } })
        : null;
    const nameNode = () => el('span', { class: 'maestro-m25-v-name', text: attribute.name });
    const label =
        options.withName === false
            ? null
            : options.full
              ? el('span', { class: 'maestro-m25-v-label' }, [signNode, nameNode()])
              : (signNode ?? nameNode());
    const parts: (HTMLElement | null)[] = [label];
    switch (shown.view) {
        case 'bar':
            parts.push(
                meter(shown.value ?? 0, shown.min ?? 0, shown.max ?? 1, attribute.name),
                el('span', { class: 'maestro-m25-v-number', text: shown.text }),
            );
            break;
        case 'words':
            parts.push(el('span', { class: 'maestro-m25-v-words', text: words }));
            break;
        case 'icon':
            if (!sign || options.full) {
                parts.push(el('span', { class: 'maestro-m25-v-dot', data: { band: band(shown.share) } }));
            }
            break;
        default:
            parts.push(el('span', { class: 'maestro-m25-v-number', text: shown.text }));
    }
    return el(
        'span',
        {
            class: ['maestro-m25-v', `maestro-m25-v-${shown.view}`],
            title,
            attrs: { 'aria-label': title },
        },
        parts,
    );
}

/** A status chip: its sign, name and what is left («☠ Отравлен · 3 хода»). */
export function statusChip(i18n: Pick<I18n, 't' | 'locale'>, status: StatusState, compact = false): HTMLElement {
    const left = statusDuration(i18n, status);
    const name = status.stacks > 1 ? `${status.name} ×${status.stacks}` : status.name;
    const short = compact && status.remaining?.turns !== undefined ? String(status.remaining.turns) : left;
    return el(
        'span',
        {
            class: 'maestro-m25-chip-status',
            title: left ? `${name} · ${left}` : name,
            data: { status: status.statusId },
        },
        [
            status.icon ? el('span', { text: status.icon, attrs: { 'aria-hidden': 'true' } }) : icon('fa-certificate'),
            el('span', { text: name }),
            short ? el('span', { class: 'maestro-muted', text: short }) : null,
        ],
    );
}

/** An item chip: «⚔ меч», «верёвка ×2». */
export function itemChip(t: T, item: ItemState): HTMLElement {
    const where = item.equipped ? t(`m25.play.item.${item.equipped}`) : '';
    return el(
        'span',
        { class: 'maestro-m25-chip-item', title: [item.name, where, item.desc ?? ''].filter(Boolean).join(' · ') },
        [
            item.equipped ? icon(item.equipped === 'hand' ? 'fa-hand-fist' : 'fa-shirt') : null,
            el('span', { text: item.qty > 1 ? `${item.name} ×${item.qty}` : item.name }),
        ],
    );
}

/* ------------------------------------------------------------------ reading through the API */

/** The effective visibility of an attribute (null when the mechanic or attribute is gone). */
export function visibilityOf(api: MechanicsApi, def: MechanicDef, attribute: AttributeDef): Visibility | null {
    try {
        return api.visibilityOf?.(def.id, attribute.id) ?? null;
    } catch {
        return null;
    }
}

/** The player may see the attribute of this holder in this place now. */
export function seen(
    api: MechanicsApi,
    def: MechanicDef,
    attribute: AttributeDef,
    place: VisibilityPlace,
    holder: string,
) {
    try {
        return api.shown?.(def.id, attribute.id, place, holder) ?? attribute.visible !== false;
    } catch {
        return false;
    }
}

/** The mechanic's statuses and items may show (not a hidden or secret mechanic). */
export function partsShown(api: MechanicsApi, mechanicId: string | undefined): boolean {
    if (!mechanicId) return true;
    try {
        const visibility = api.visibilityOf?.(mechanicId);
        return !visibility || (visibility.preset !== 'hidden' && visibility.preset !== 'secret');
    } catch {
        return true;
    }
}

/** A value as the player sees it: numbers with the modifiers of statuses and items, others as stored. */
export function currentValue(
    api: MechanicsApi,
    def: MechanicDef,
    holder: string,
    attribute: AttributeDef,
    effective?: Map<string, number>,
): AttributeValue | null {
    if (attribute.kind === 'number' && effective?.has(attribute.id)) return effective.get(attribute.id) ?? null;
    try {
        return api.value(def.id, holder, attribute.id);
    } catch {
        return null;
    }
}

/** Effective numbers of a holder in a mechanic (attribute id → value with modifiers). */
export function effectiveNumbers(api: MechanicsApi, def: MechanicDef, holder: string): Map<string, number> {
    const out = new Map<string, number>();
    try {
        for (const item of api.derived?.(def.id, holder) ?? []) out.set(item.attribute, item.value);
    } catch {
        // no modifiers: stored values
    }
    return out;
}

/** The value of an attribute in a place, ready to draw; null when it does not show there. */
export function shownIn(
    api: MechanicsApi,
    def: MechanicDef,
    attribute: AttributeDef,
    holder: string,
    place: VisibilityPlace,
    effective?: Map<string, number>,
): ShownValue | null {
    if (!seen(api, def, attribute, place, holder)) return null;
    const visibility = visibilityOf(api, def, attribute);
    if (!visibility) return null;
    return shownValue(attribute, visibility, currentValue(api, def, holder, attribute, effective));
}

/** Holders of a mechanic in the scene (the API's, else from the stored state). */
export function holdersOf(api: MechanicsApi, def: MechanicDef): string[] {
    try {
        if (api.holdersInScene) return api.holdersInScene(def.id);
        return [
            ...new Set(
                api
                    .state()
                    .filter((item) => item.mechanicId === def.id)
                    .map((item) => item.holder),
            ),
        ];
    } catch {
        return [];
    }
}

export function personaOf(api: MechanicsApi): string {
    try {
        return api.persona?.() ?? '';
    } catch {
        return '';
    }
}

export function sameName(a: string, b: string): boolean {
    return a.trim().toLowerCase().replace(/ё/g, 'е') === b.trim().toLowerCase().replace(/ё/g, 'е');
}

/** Statuses of a holder the player may see. */
export function statusesOf(api: MechanicsApi, holder: string): StatusState[] {
    try {
        const entry = (api.statuses?.(holder) ?? []).find((item) => sameName(item.holder, holder));
        return (entry?.statuses ?? []).filter((status) => partsShown(api, status.mechanicId));
    } catch {
        return [];
    }
}

/** Items of a holder (inventories of hidden or secret mechanics stay out). */
export function itemsOf(api: MechanicsApi, holder: string): ItemState[] {
    try {
        const entry = (api.items?.(holder) ?? []).find((item) => sameName(item.holder, holder));
        if (!entry) return [];
        const inventories = api.active().filter((def) => def.inventory !== undefined);
        if (inventories.length && inventories.every((def) => !partsShown(api, def.id))) return [];
        return entry.items;
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ the change line */

/** The player may see the attribute at all (the mechanics window): never secret, hidden only once revealed. */
export function playerSees(api: MechanicsApi, def: MechanicDef, attribute: AttributeDef, holder: string): boolean {
    if (attribute.visible === false) return false;
    const visibility = visibilityOf(api, def, attribute);
    if (!visibility) return true;
    if (visibility.preset === 'secret' || visibility.view === 'hidden') return false;
    if (visibility.preset !== 'hidden') return true;
    try {
        return api.isRevealed?.(def.id, holder, attribute.id) ?? false;
    } catch {
        return false;
    }
}

/** Whether the player may see a logged change in this place (hidden-unrevealed and secret attributes never). */
export function changeSeen(api: MechanicsApi, change: StateChange, place: VisibilityPlace): boolean {
    switch (change.kind) {
        case 'combat':
            return true;
        case 'reveal': {
            // Revealing is how a hidden value becomes the player's: shown unless the mechanic is secret.
            try {
                return api.visibilityOf?.(change.mechanicId)?.preset !== 'secret' && change.to === 'shown';
            } catch {
                return false;
            }
        }
        case 'status':
            return partsShown(api, change.status?.mechanicId ?? change.mechanicId);
        case 'item':
            return partsShown(api, change.mechanicId);
        default: {
            const def = api.get(change.mechanicId);
            const attribute = def?.attributes.find((item) => item.id === change.attribute);
            if (!def || !attribute) return false;
            return seen(api, def, attribute, place, change.holder);
        }
    }
}

/**
 * One change as the line says it, without the holder: «❤ 80 → 65», «Мана: мало → почти на нуле», «+ огонь»,
 * «+ Отравлен (3 хода)», «− Отравлен», «+ верёвка ×2», «меч — в руках», «бой начался». Null when nothing visible
 * changed (a status tick, a change inside one band of words).
 */
export function changeSegment(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    change: StateChange,
    options: { raw?: boolean } = {},
): string | null {
    const t = translator(i18n);
    const meaning = changeMeaning(change);
    switch (meaning.kind) {
        case 'statusTick':
            return null;
        case 'statusOn': {
            const left = change.status ? statusDuration(i18n, change.status) : '';
            return left
                ? t('m25.play.statusOnFor', { name: meaning.name, left })
                : t('m25.play.statusOn', { name: meaning.name });
        }
        case 'statusOff':
            return t('m25.play.statusOff', { name: meaning.name });
        case 'itemGained':
            return meaning.qty > 1
                ? t('m25.play.itemGainedMany', { name: meaning.name, qty: meaning.qty })
                : t('m25.play.itemGained', { name: meaning.name });
        case 'itemLost':
            return meaning.qty > 1
                ? t('m25.play.itemLostMany', { name: meaning.name, qty: meaning.qty })
                : t('m25.play.itemLost', { name: meaning.name });
        case 'itemEquipped':
            return t('m25.play.itemEquipped', { name: meaning.name, slot: t(`m25.play.item.${meaning.slot}`) });
        case 'itemUnequipped':
            return t('m25.play.itemUnequipped', { name: meaning.name });
        case 'reveal': {
            const def = api.get(change.mechanicId);
            const name = def?.attributes.find((item) => item.id === change.attribute)?.name ?? change.attribute;
            return t(meaning.shown ? 'm25.play.revealed' : 'm25.play.hiddenAgain', { name });
        }
        case 'combatStart':
            return t('m25.play.combatStart');
        case 'combatEnd':
            return t('m25.play.combatEnd');
        case 'combatRound':
            return t('m25.play.combatRound', { round: meaning.round });
        case 'combatJoin':
            return t('m25.play.combatJoin', { holder: change.holder });
        default:
            return valueSegment(t, api, change, options.raw === true);
    }
}

function valueSegment(t: T, api: MechanicsApi, change: StateChange, raw: boolean): string | null {
    const def = api.get(change.mechanicId);
    const attribute = def?.attributes.find((item) => item.id === change.attribute);
    if (!def || !attribute) return null;
    // The mechanics window shows the numbers themselves (it is where values are edited).
    const visibility = raw ? { view: 'number' as const } : visibilityOf(api, def, attribute);
    if (!visibility) return null;
    const label = shortLabel(attribute);
    if (attribute.kind === 'list') {
        const { added, removed } = listDelta(change.from, change.to);
        const parts = [...added.map((item) => `+ ${item}`), ...removed.map((item) => `− ${item}`)];
        return parts.length ? `${label}: ${parts.join(', ')}` : null;
    }
    if (attribute.kind === 'text') {
        const text = plainValue(change.to);
        return t('m25.play.textChanged', { name: label, text: text.length > 40 ? `${text.slice(0, 39)}…` : text });
    }
    const before = shownValue(attribute, visibility, change.from);
    const after = shownValue(attribute, visibility, change.to);
    if (!after) return null;
    if (after.view === 'words') {
        if (before && sameWords(before.words, after.words)) return null;
        const from = before ? wordsText(t, before.words) : '';
        const to = wordsText(t, after.words);
        return from ? `${attribute.name}: ${from} → ${to}` : `${attribute.name}: ${to}`;
    }
    if (after.view === 'icon') {
        const up = typeof change.to === 'number' && typeof change.from === 'number' ? change.to > change.from : true;
        return `${label} ${up ? '↑' : '↓'}`;
    }
    if (attribute.kind === 'number') {
        const from = typeof change.from === 'number' ? formatNumber(change.from) : null;
        const to = typeof change.to === 'number' ? formatNumber(change.to) : plainValue(change.to);
        return from === null ? `${label} ${to}` : `${label} ${from} → ${to}`;
    }
    const from = plainValue(change.from);
    return from ? `${label}: ${from} → ${plainValue(change.to)}` : `${label}: ${plainValue(change.to)}`;
}

/* ------------------------------------------------------------------ a holder for a place */

/**
 * A holder's mechanics as the player may see them in a place: per mechanic the values in their view, then the
 * statuses and items. Null when nothing shows. `full`: each value with its sign and name (the HUD's left panel).
 */
export function holderView(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    holder: string,
    place: VisibilityPlace,
    options: { full?: boolean } = {},
): HTMLElement | null {
    const t = translator(i18n);
    const rows: HTMLElement[] = [];
    let defs: MechanicDef[];
    try {
        defs = api.active();
    } catch {
        defs = [];
    }
    for (const def of defs) {
        if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
        const holders = holdersOf(api, def);
        const stored = (() => {
            try {
                return api.state(holder).some((item) => item.mechanicId === def.id);
            } catch {
                return false;
            }
        })();
        if (!stored && !holders.some((name) => sameName(name, holder))) continue;
        const effective = effectiveNumbers(api, def, holder);
        const values = def.attributes
            .map((attribute) => {
                const shown = shownIn(api, def, attribute, holder, place, effective);
                return shown ? valueNode(t, attribute, shown, { full: options.full === true }) : null;
            })
            .filter((node): node is HTMLElement => node !== null);
        if (!values.length) continue;
        rows.push(
            el('div', { class: 'maestro-m25-hv-row', data: { mechanic: def.id } }, [
                el('span', { class: 'maestro-m25-hv-title', text: def.name }),
                ...values,
            ]),
        );
    }
    const statuses = statusesOf(api, holder);
    if (statuses.length) {
        rows.push(
            el('div', { class: 'maestro-m25-hv-row maestro-m25-hv-statuses' }, [
                el('span', { class: 'maestro-m25-hv-title', text: t('m25.play.statuses') }),
                ...statuses.map((status) => statusChip(i18n, status)),
            ]),
        );
    }
    const items = itemsOf(api, holder);
    if (items.length) {
        rows.push(
            el('div', { class: 'maestro-m25-hv-row maestro-m25-hv-items' }, [
                el('span', { class: 'maestro-m25-hv-title', text: t('m25.play.items') }),
                ...items.map((item) => itemChip(t, item)),
            ]),
        );
    }
    return rows.length ? el('div', { class: 'maestro-m25-holder-view', data: { holder } }, rows) : null;
}

/** Draws a holder for a place into a container and follows the changes until released (the dossier section). */
export function renderHolderInto(
    i18n: Pick<I18n, 't' | 'locale'>,
    api: MechanicsApi,
    container: HTMLElement,
    holder: string,
    place: VisibilityPlace,
): Unsubscribe | null {
    const first = holderView(i18n, api, holder, place);
    if (!first) return null;
    container.appendChild(first);
    let node: HTMLElement | null = first;
    let alive = true;
    const off = api.onChange(() => {
        if (!alive) return;
        queueMicrotask(() => {
            if (!alive) return;
            const next = holderView(i18n, api, holder, place);
            if (node) node.remove();
            node = next;
            if (next) container.appendChild(next);
        });
    });
    return () => {
        alive = false;
        off();
        if (node) node.remove();
        clear(container);
    };
}
