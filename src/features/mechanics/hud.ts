// M25 «Механики», the HUD (plan-2 §6.А п.4): a compact panel over the chat while a mechanic is on.
// - What it shows: the user's character and the characters chosen in the mechanics window (settings.hudHolders, those
//   in the scene), with the attributes pinned there (settings.hudAttrs; none pinned: every attribute whose visibility
//   lets it into the HUD) in their view — bars, numbers, words, icons; status signs with what is left (even in the
//   «book» set: «в HUD — только значки состояний»), the money and what is worn or in hand. Hidden-unrevealed and
//   secret values never.
// - Quick buttons «Бросок» (the user's character's checks, one tap rolls, with advantage or disadvantage) and
//   «Инвентарь» (his items; the mechanics window for the rest).
// - Where: a fixed overlay at the top or the bottom edge of ST's chat column (#sheld, above #form_sheld), under ST's
//   top bar and drawers and under Maestro's side panels (z-index below theirs) and never wider than the free part of
//   the chat column between the side panels. Dragged by its grip; dropped in the upper half it sticks to the top,
//   else to the bottom; the edge and distance are remembered per device (localStorage). Phones (ST's 1000px
//   breakpoint): one line that scrolls sideways; a tap expands it.
// - Off with the setting, without a chat or when no mechanic is on. Everything is removed on dispose.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { button, clear, el, icon } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { AttributeDef, CheckDef, MechanicDef, MechanicsApi } from './api';
import { rollLine } from './play-strip';
import type { MechanicsSettings } from './parts';
import {
    effectiveNumbers,
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

export const HUD_ID = 'maestro-m25-hud';
export const HUD_STORAGE_KEY = 'maestro.m25.hud';
const PHONE_QUERY = '(max-width: 1000px)';
const PLACE_POLL_MS = 1500;
const EDGE_GAP = 4;

export const HUD_CSS = `
#${HUD_ID} { position: fixed; z-index: 2890; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px;
    padding: 4px 6px; border-radius: 8px; font-size: 0.85em; color: var(--SmartThemeBodyColor, inherit);
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.55)); backdrop-filter: blur(6px);
    border: 1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35)); box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
#${HUD_ID}[hidden] { display: none; }
#${HUD_ID} .maestro-m25-hud-bar { display: flex; align-items: center; gap: 6px; min-width: 0; }
#${HUD_ID} .maestro-m25-hud-grip { flex: none; cursor: grab; touch-action: none; background: none; border: none;
    color: inherit; opacity: 0.6; min-width: 24px; min-height: 28px; padding: 0; }
#${HUD_ID} .maestro-m25-hud-rows { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; gap: 2px 14px; }
#${HUD_ID} .maestro-m25-hud-holder { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
#${HUD_ID} .maestro-m25-hud-name { font-weight: 600; }
#${HUD_ID} .maestro-m25-hud-actions { flex: none; display: flex; gap: 2px; }
#${HUD_ID} .maestro-m25-hud-actions .maestro-btn { min-width: 30px; min-height: 28px; margin: 0; padding: 2px 6px; }
#${HUD_ID} .maestro-m25-hud-panel { display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(127,127,127,0.3)); padding-top: 4px; }
#${HUD_ID} .maestro-m25-hud-panel[hidden] { display: none; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-rows { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none; white-space: nowrap; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-rows::-webkit-scrollbar { display: none; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-holder { flex: none; flex-wrap: nowrap; }
#${HUD_ID}.maestro-m25-hud-dragging { opacity: 0.85; cursor: grabbing; }
`;

export type HudEdge = 'top' | 'bottom';

export interface HudPlace {
    edge: HudEdge;
    /** Distance from that edge of the chat area, px. */
    offset: number;
}

/** The remembered place (per device); a broken or missing record gives the top edge. */
export function loadHudPlace(storage: Pick<Storage, 'getItem'> | null): HudPlace {
    try {
        const raw = storage?.getItem(HUD_STORAGE_KEY);
        const value = raw ? (JSON.parse(raw) as Partial<HudPlace>) : null;
        const edge: HudEdge = value?.edge === 'bottom' ? 'bottom' : 'top';
        const offset =
            typeof value?.offset === 'number' && Number.isFinite(value.offset) ? Math.max(0, value.offset) : 0;
        return { edge, offset: Math.round(offset) };
    } catch {
        return { edge: 'top', offset: 0 };
    }
}

export function saveHudPlace(storage: Pick<Storage, 'setItem'> | null, place: HudPlace): void {
    try {
        storage?.setItem(HUD_STORAGE_KEY, JSON.stringify(place));
    } catch {
        // private mode / full storage: the place is only for this page
    }
}

/** The chat area the HUD may use: between ST's top bar and the input, between Maestro's side panels. */
export interface HudArea {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/** Where the HUD's top goes in an area for a remembered place (kept inside the area). */
export function hudTop(area: HudArea, place: HudPlace, height: number): number {
    const room = Math.max(0, area.bottom - area.top - height);
    const offset = Math.min(Math.max(0, place.offset), room);
    return Math.round(place.edge === 'top' ? area.top + offset : area.bottom - height - offset);
}

/** The place a drop at `top` means: the nearer edge and the distance from it. */
export function placeFromDrop(area: HudArea, top: number, height: number): HudPlace {
    const room = Math.max(0, area.bottom - area.top - height);
    const fromTop = Math.min(Math.max(0, top - area.top), room);
    return fromTop + height / 2 <= (area.bottom - area.top) / 2
        ? { edge: 'top', offset: Math.round(fromTop) }
        : { edge: 'bottom', offset: Math.round(room - fromTop) };
}

function rect(selector: string): DOMRect | null {
    const node = document.querySelector(selector);
    if (!node || (node as HTMLElement).hidden) return null;
    const box = node.getBoundingClientRect();
    return box.width > 0 || box.height > 0 ? box : null;
}

/** The chat area of the page now (the window when ST's blocks are missing, e.g. in tests). */
export function chatArea(): HudArea {
    const width = globalThis.innerWidth || document.documentElement.clientWidth || 800;
    const height = globalThis.innerHeight || document.documentElement.clientHeight || 600;
    const sheld = rect('#sheld');
    const form = rect('#form_sheld');
    const area: HudArea = {
        top: sheld?.top ?? 0,
        bottom: form?.top ?? sheld?.bottom ?? height,
        left: sheld?.left ?? 0,
        right: sheld?.right ?? width,
    };
    // Maestro's side panels cover the chat's edges: the HUD stays in between.
    const left = rect('.maestro-window-side-left:not([hidden])');
    const right = rect('.maestro-window-side-right:not([hidden])');
    if (left && left.right > area.left && left.right < area.right) area.left = left.right;
    if (right && right.left < area.right && right.left > area.left) area.right = right.left;
    if (area.bottom - area.top < 40) area.bottom = area.top + 40;
    return area;
}

function storage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function phone(): boolean {
    try {
        return globalThis.matchMedia?.(PHONE_QUERY).matches ?? false;
    } catch {
        return false;
    }
}

export interface HudDeps {
    app: App;
    log: Logger;
    settings: () => MechanicsSettings;
}

type Panel = 'roll' | 'items' | null;

export class MechanicsHud {
    private node: HTMLElement | null = null;
    private place: HudPlace = loadHudPlace(storage());
    private panel: Panel = null;
    private expanded = false;
    private mode: 'adv' | 'dis' | null = null;
    private poll: ReturnType<typeof setInterval> | null = null;
    private readonly offs: Unsubscribe[] = [];
    private disposed = false;
    private readonly redraw = coalesce(() => this.render(), 80);
    private drag: { startY: number; startTop: number; pointer: number } | null = null;
    /** Removes the document listeners of a drag in progress. */
    private dragOff: (() => void) | null = null;

    constructor(
        private readonly deps: HudDeps,
        private readonly api: MechanicsApi,
    ) {}

    private get t() {
        return translator(this.deps.app.i18n);
    }

    install(): void {
        const { app } = this.deps;
        this.offs.push(app.ui.style('maestro-m25-hud', HUD_CSS));
        this.offs.push(this.api.onChange(() => this.redraw()));
        this.offs.push(app.bus.on('chat:changed', () => this.redraw()));
        this.offs.push(app.bus.on('reply:ready', () => this.redraw()));
        this.offs.push(
            app.settings.onChange((path) => {
                if (path.startsWith('modules.mechanics')) this.redraw();
            }),
        );
        const resize = () => this.position();
        globalThis.addEventListener?.('resize', resize);
        this.offs.push(() => globalThis.removeEventListener?.('resize', resize));
        this.render();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.redraw.cancel();
        this.stopPolling();
        this.dragOff?.();
        this.node?.remove();
        this.node = null;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics HUD: release failed', error);
            }
        }
    }

    /** The HUD element while it shows (tests). */
    element(): HTMLElement | null {
        return this.node?.isConnected && !this.node.hidden ? this.node : null;
    }

    /* ---------------------------------------------------------------- what it shows */

    private active(): MechanicDef[] {
        try {
            return this.api.active();
        } catch {
            return [];
        }
    }

    /** The user's character, then the chosen characters present in the scene. */
    holders(): string[] {
        const persona = personaOf(this.api);
        const chosen = this.deps.settings().hudHolders ?? [];
        const present = new Set<string>();
        for (const def of this.active()) for (const holder of holdersOf(this.api, def)) present.add(holder);
        const out: string[] = persona ? [persona] : [];
        for (const name of chosen) {
            const found = [...present].find((holder) => sameName(holder, name));
            if (found && !out.some((item) => sameName(item, found))) out.push(found);
        }
        return out;
    }

    private pinned(def: MechanicDef, attribute: AttributeDef): boolean {
        const pins = this.deps.settings().hudAttrs ?? [];
        return !pins.length || pins.includes(`${def.id}.${attribute.id}`);
    }

    private holderRow(holder: string): HTMLElement | null {
        const t = this.t;
        const values: HTMLElement[] = [];
        for (const def of this.active()) {
            if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
            if (!holdersOf(this.api, def).some((name) => sameName(name, holder))) continue;
            const effective = effectiveNumbers(this.api, def, holder);
            for (const attribute of def.attributes) {
                if (!this.pinned(def, attribute)) continue;
                const shown = shownIn(this.api, def, attribute, holder, 'hud', effective);
                if (shown) values.push(valueNode(t, attribute, shown));
            }
        }
        const statuses = statusesOf(this.api, holder).map((status) => statusChip(this.deps.app.i18n, status, true));
        const worn = itemsOf(this.api, holder)
            .filter((item) => item.equipped)
            .map((item) => itemChip(t, item));
        if (!values.length && !statuses.length && !worn.length) return null;
        return el('span', { class: 'maestro-m25-hud-holder', data: { holder } }, [
            el('span', { class: 'maestro-m25-hud-name', text: holder }),
            ...values,
            ...statuses,
            ...worn,
        ]);
    }

    /** Checks the user's character may roll now. */
    private checks(): { def: MechanicDef; check: CheckDef }[] {
        const persona = personaOf(this.api);
        if (!persona) return [];
        const out: { def: MechanicDef; check: CheckDef }[] = [];
        for (const def of this.active()) {
            if (!def.checks.length) continue;
            const visibility = (() => {
                try {
                    return this.api.visibilityOf?.(def.id) ?? null;
                } catch {
                    return null;
                }
            })();
            if (visibility?.preset === 'secret' || visibility?.preset === 'hidden') continue;
            if (!holdersOf(this.api, def).some((name) => sameName(name, persona))) continue;
            for (const check of def.checks) out.push({ def, check });
        }
        return out;
    }

    private wanted(): boolean {
        const { app } = this.deps;
        return !this.disposed && this.deps.settings().hud !== false && !!app.host.chatId() && this.active().length > 0;
    }

    /* ---------------------------------------------------------------- drawing */

    render(): void {
        if (this.disposed || typeof document === 'undefined') return;
        if (!this.wanted()) {
            this.hide();
            return;
        }
        const rows = this.holders()
            .map((holder) => this.holderRow(holder))
            .filter((row): row is HTMLElement => row !== null);
        const checks = this.checks();
        const persona = personaOf(this.api);
        const hasItems = !!persona && itemsOf(this.api, persona).length > 0;
        if (!rows.length && !checks.length && !hasItems) {
            this.hide();
            return;
        }
        const node = this.node ?? this.create();
        if (!node.isConnected) document.body.appendChild(node);
        node.hidden = false;
        const line = phone() && !this.expanded;
        node.classList.toggle('maestro-m25-hud-line', line);
        clear(node);
        const t = this.t;
        const grip = el(
            'button',
            {
                class: 'maestro-m25-hud-grip',
                title: t('m25.hud.drag'),
                attrs: { type: 'button', 'aria-label': t('m25.hud.drag') },
            },
            [icon('fa-grip-vertical')],
        );
        grip.addEventListener('pointerdown', (event) => this.startDrag(event));
        const rowsBox = el('div', { class: 'maestro-m25-hud-rows' }, rows);
        rowsBox.addEventListener('click', () => {
            if (!phone()) return;
            this.expanded = !this.expanded;
            this.render();
        });
        const actions = el('div', { class: 'maestro-m25-hud-actions' }, [
            checks.length
                ? button({
                      icon: 'fa-dice-d20',
                      title: t('m25.hud.roll'),
                      kind: this.panel === 'roll' ? 'primary' : 'ghost',
                      className: 'maestro-m25-hud-roll',
                      onClick: () => this.toggle('roll'),
                  })
                : null,
            hasItems
                ? button({
                      icon: 'fa-sack-dollar',
                      title: t('m25.hud.items'),
                      kind: this.panel === 'items' ? 'primary' : 'ghost',
                      className: 'maestro-m25-hud-items',
                      onClick: () => this.toggle('items'),
                  })
                : null,
            button({
                icon: 'fa-up-right-from-square',
                title: t('m25.hud.window'),
                kind: 'ghost',
                className: 'maestro-m25-hud-open',
                onClick: () => this.openWindow(),
            }),
        ]);
        node.append(el('div', { class: 'maestro-m25-hud-bar' }, [grip, rowsBox, actions]));
        const panel = this.panelNode(checks);
        if (panel) node.append(panel);
        this.position();
        this.startPolling();
    }

    private create(): HTMLElement {
        this.node = el('div', {
            attrs: { id: HUD_ID, role: 'region', 'aria-label': this.t('m25.hud.title') },
        });
        return this.node;
    }

    private hide(): void {
        this.stopPolling();
        if (this.node) {
            this.node.hidden = true;
            this.node.remove();
        }
    }

    private toggle(panel: Exclude<Panel, null>): void {
        this.panel = this.panel === panel ? null : panel;
        this.render();
    }

    private openWindow(): void {
        const { ui } = this.deps.app;
        if (ui.openWindow) ui.openWindow('mechanics', { tab: 'mechanics' });
        else ui.openPult('mechanics');
    }

    private panelNode(checks: { def: MechanicDef; check: CheckDef }[]): HTMLElement | null {
        const t = this.t;
        if (this.panel === 'roll' && checks.length) {
            const modes = (['adv', 'dis'] as const).map((mode) =>
                button({
                    label: t(`m25.hud.mode.${mode}`),
                    kind: this.mode === mode ? 'primary' : 'ghost',
                    className: `maestro-m25-hud-mode-${mode}`,
                    onClick: () => {
                        this.mode = this.mode === mode ? null : mode;
                        this.render();
                    },
                }),
            );
            return el('div', { class: 'maestro-m25-hud-panel maestro-m25-hud-checks' }, [
                ...checks.map(({ def, check }) =>
                    button({
                        label: check.name,
                        icon: 'fa-dice',
                        className: 'maestro-m25-hud-check',
                        title: def.name,
                        onClick: () => this.roll(def, check),
                    }),
                ),
                ...modes,
            ]);
        }
        if (this.panel === 'items') {
            const persona = personaOf(this.api);
            const items = persona ? itemsOf(this.api, persona) : [];
            return el('div', { class: 'maestro-m25-hud-panel maestro-m25-hud-inventory' }, [
                ...items.map((item) => itemChip(t, item)),
                button({
                    label: t('m25.hud.more'),
                    kind: 'ghost',
                    className: 'maestro-m25-hud-more',
                    onClick: () => this.openWindow(),
                }),
            ]);
        }
        return null;
    }

    private async roll(def: MechanicDef, check: CheckDef): Promise<void> {
        const { app } = this.deps;
        const persona = personaOf(this.api);
        try {
            const result = await this.api.roll(def.id, check.id, persona, this.mode ? { mode: this.mode } : {});
            app.ui.notice(this.t('m25.check.rolled', { line: rollLine(app.i18n, this.api, result) }), { urgent: true });
        } catch (error) {
            app.ui.notice(error instanceof Error ? error.message : String(error), { urgent: true, level: 'warn' });
        }
    }

    /* ---------------------------------------------------------------- placing and dragging */

    position(): void {
        const node = this.node;
        if (!node?.isConnected || node.hidden) return;
        const area = chatArea();
        node.style.left = `${Math.round(area.left + EDGE_GAP)}px`;
        node.style.width = `${Math.max(120, Math.round(area.right - area.left - EDGE_GAP * 2))}px`;
        if (this.drag) return;
        const height = node.getBoundingClientRect().height || 32;
        node.style.top = `${hudTop({ ...area, top: area.top + EDGE_GAP, bottom: area.bottom - EDGE_GAP }, this.place, height)}px`;
    }

    private startPolling(): void {
        if (this.poll !== null || this.disposed) return;
        // ST's panels and Maestro's windows open and close without telling: a cheap look keeps the HUD in the gap.
        this.poll = setInterval(() => this.position(), PLACE_POLL_MS);
    }

    private stopPolling(): void {
        if (this.poll === null) return;
        clearInterval(this.poll);
        this.poll = null;
    }

    private startDrag(event: PointerEvent): void {
        const node = this.node;
        if (!node) return;
        event.preventDefault();
        this.drag = {
            startY: event.clientY,
            startTop: node.getBoundingClientRect().top,
            pointer: event.pointerId,
        };
        node.classList.add('maestro-m25-hud-dragging');
        const move = (moved: PointerEvent) => {
            if (!this.drag || moved.pointerId !== this.drag.pointer) return;
            node.style.top = `${Math.round(this.drag.startTop + moved.clientY - this.drag.startY)}px`;
        };
        const release = () => {
            this.drag = null;
            this.dragOff = null;
            node.classList.remove('maestro-m25-hud-dragging');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', up);
        };
        const up = (ended: PointerEvent) => {
            if (!this.drag || ended.pointerId !== this.drag.pointer) return;
            const top = this.drag.startTop + ended.clientY - this.drag.startY;
            release();
            const area = chatArea();
            const height = node.getBoundingClientRect().height || 32;
            this.place = placeFromDrop(
                { ...area, top: area.top + EDGE_GAP, bottom: area.bottom - EDGE_GAP },
                top,
                height,
            );
            saveHudPlace(storage(), this.place);
            this.position();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
        this.dragOff = release;
    }

    /** The remembered place (tests, the window). */
    placeNow(): HudPlace {
        return { ...this.place };
    }
}
