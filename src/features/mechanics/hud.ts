// M25 «Механики», the HUD (plan-2 §6.А п.4): the mechanics of the scene at hand while a mechanic is on.
// - What it shows (hud-side.ts): the user's character and the characters chosen in the mechanics window
//   (settings.hudHolders, those in the scene), with the attributes pinned there (settings.hudAttrs; none pinned: every
//   attribute whose visibility lets it into the HUD) in their view — bars, numbers, words, icons; status signs with
//   what is left (even in the «book» set: «в HUD — только значки состояний»), the money and what is worn or in hand.
//   Hidden-unrevealed and secret values never. Next to each value the latest story reply changed, a chip of the change
//   (hud-marks.ts: «−15», «→ ранен»; «· свайп отменит» while that reply is not committed yet).
// - Quick buttons «Бросок» (the user's character's checks, one tap rolls, with advantage or disadvantage),
//   «Инвентарь» (his items; the mechanics window for the rest) and ⚠ when values may not follow the story now
//   (MechanicsApi.trackingHealth: what is wrong and «Открыть механики»).
// - Where (setting `hudPlacement`; on a desktop also the HUD's own placement button and its menu «Над чатом / Слева от
//   чата / Справа от чата»; hud-place.ts decides with the page):
//   · over the chat: a fixed overlay at the top or the bottom edge of ST's chat column (#sheld, above #form_sheld),
//     under ST's top bar and drawers and under Maestro's side panels (z-index below theirs) and never wider than the
//     free part of the chat column between the side panels. Dragged by its grip; dropped in the upper half it sticks
//     to the top, else to the bottom; the edge and distance are remembered per device (localStorage). Phones (ST's
//     1000px breakpoint): always here, one line that scrolls sideways; a tap expands it;
//   · beside the chat, left or right: a panel in the free space between the chat and the page's edge (or what stands
//     there), in the compact or the full view (setting `hudSideView`, switched in its header too); its outer edge drags
//     its width (remembered per device, side and view). Without the room (ST's drawer pinned on that side, a chat too
//     wide) a rail: a slim tab at the chat's edge whose flyout shows the same over the chat's edge, headed by why and a
//     way out; a click elsewhere, Escape or the tab again closes it. While beside the chat the page's layout is watched
//     (#sheld, <body>, <html>'s style — ST's chat width —, ST's drawers; ST's movable UI), the rest by a cheap poll.
// - Off with the setting, without a chat or when no mechanic is on. Everything is removed on dispose.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { button, clear, el, icon } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { CheckDef, MechanicDef, MechanicsApi, TrackingProblem } from './api';
import { rollNoticeKey } from './checks';
import {
    DeltaFreshness,
    deltaChip,
    deltaKey,
    latestReplyIndex,
    marksCss,
    provisionalReply,
    replyDeltas,
    trackingProblems,
} from './hud-marks';
import {
    PHONE_QUERY,
    RAIL_WIDTH,
    clampWidth,
    layoutKey,
    measureSideRoom,
    otherSide,
    phone,
    resolveHudLayout,
} from './hud-place';
import type { HudLayout, HudSide } from './hud-place';
import {
    FLYOUT_CLASS,
    RAIL_CLASS,
    SIDE_CLASS,
    compactHolder,
    foldKey,
    holderParts,
    hudHolders,
    loadSidePrefs,
    saveSidePrefs,
    sideCss,
    sideFight,
    sideHolder,
    sideHolders,
    widthKey,
} from './hud-side';
import { rollLine } from './play-strip';
import { MECHANICS_KEY } from './parts';
import type { HudPlacement, HudSideView, MechanicsSettings } from './parts';
import { holdersOf, itemChip, itemsOf, personaOf, sameName, translator } from './view-values';
import type { ValueDecorator } from './view-values';

export const HUD_ID = 'maestro-m25-hud';
export const HUD_STORAGE_KEY = 'maestro.m25.hud';
const PLACE_POLL_MS = 1500;
const EDGE_GAP = 4;
/** The side panel follows layout changes this soon (ResizeObserver / MutationObserver bursts are merged). */
const LAYOUT_NUDGE_MS = 50;
/** A step of the side panel's width by the keyboard (its edge focused, the arrow keys). */
const RESIZE_STEP = 16;
/** The placements of the HUD's own menu, in its order, with their signs. */
const PLACEMENTS: readonly { value: HudPlacement; icon: string }[] = [
    { value: 'chat', icon: 'fa-comment' },
    { value: 'left', icon: 'fa-arrow-left' },
    { value: 'right', icon: 'fa-arrow-right' },
];

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
#${HUD_ID} .maestro-m25-hud-place-menu .maestro-btn { margin: 0; min-height: 28px; padding: 2px 8px; }
#${HUD_ID} .maestro-m25-hud-place-menu .maestro-btn[aria-checked="true"] { font-weight: 600; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-rows { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none; white-space: nowrap; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-rows::-webkit-scrollbar { display: none; }
#${HUD_ID}.maestro-m25-hud-line .maestro-m25-hud-holder { flex: none; flex-wrap: nowrap; }
#${HUD_ID}.maestro-m25-hud-dragging { opacity: 0.85; cursor: grabbing; }
/* Beside the chat is for a desktop: phones keep the HUD over the chat, without the switch. */
@media ${PHONE_QUERY} { #${HUD_ID} .maestro-m25-hud-place { display: none; } }
${sideCss(HUD_ID)}${marksCss(HUD_ID)}`;

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

export interface HudDeps {
    app: App;
    log: Logger;
    settings: () => MechanicsSettings;
}

/** The HUD's panels under its header: the checks, the inventory, the placement menu, the tracking problems. */
type Panel = 'roll' | 'items' | 'place' | 'health' | null;
type Check = { def: MechanicDef; check: CheckDef };
type SideLayout = Extract<HudLayout, { mode: 'side' }>;
type RailLayout = Extract<HudLayout, { mode: 'rail' }>;

/** The latest reply's changes for the chips (hud-marks.ts). */
interface Marks {
    index: number;
    deltas: Map<string, string>;
    /** That reply is not committed yet: a swipe takes its changes back. */
    provisional: boolean;
}

/** What one drawing has to show. */
interface Drawing {
    content: HTMLElement[];
    checks: Check[];
    hasItems: boolean;
    health: { warn: TrackingProblem[]; info: TrackingProblem[] };
    view: HudSideView;
}

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
    /** Where it is drawn now: over the chat, the panel beside it or the rail (and why). */
    private layout: HudLayout = { mode: 'chat', reason: 'setting' };
    /** Widths the side panel was dragged to and the folded characters (per device). */
    private readonly prefs = loadSidePrefs(storage());
    /** Characters whose section beside the chat is folded (foldKey). */
    private readonly folded = new Set<string>(this.prefs.folded);
    /** The rail's flyout is open. */
    private flyout = false;
    /** The document listeners closing the menu, the problems and the flyout (a click elsewhere, Escape). */
    private transientOff: (() => void) | null = null;
    /** A drag of the side panel's edge in progress, and its release. */
    private resizing: { pointer: number; startX: number; startWidth: number } | null = null;
    private resizeOff: (() => void) | null = null;
    /** When each change chip first showed (its highlight through redraws). */
    private readonly fresh = new DeltaFreshness();
    /** The control to focus after the next drawing (a menu opened or closed by the keyboard). */
    private focusNext: string | null = null;
    /** Observers of the page's layout while the HUD is wanted beside the chat. */
    private watchers: { disconnect(): void }[] = [];
    private readonly nudge = coalesce(() => this.position(), LAYOUT_NUDGE_MS);

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
        this.nudge.cancel();
        this.stopPolling();
        this.dragOff?.();
        this.resizeOff?.();
        this.releaseTransient();
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

    private view(): HudSideView {
        return this.deps.settings().hudSideView === 'full' ? 'full' : 'compact';
    }

    /** The user's character, then the chosen characters present in the scene. */
    holders(): string[] {
        return hudHolders(this.api, this.active(), this.deps.settings().hudHolders ?? []);
    }

    /** The latest story reply's value changes, for the chips next to the values. */
    private marks(): Marks {
        let chat: STChatMessage[];
        try {
            chat = this.deps.app.host.ctx().chat ?? [];
        } catch {
            chat = [];
        }
        const index = latestReplyIndex(chat);
        if (index < 0) return { index, deltas: new Map(), provisional: false };
        return {
            index,
            deltas: replyDeltas(this.deps.app.i18n, this.api, index),
            provisional: provisionalReply(this.api) === index,
        };
    }

    /** Puts the chip of the latest reply's change next to a value of a holder. */
    private decorator(marks: Marks, holder: string): ValueDecorator | undefined {
        if (!marks.deltas.size) return undefined;
        return (def, attribute, node) => {
            const key = deltaKey(def.id, attribute.id, holder);
            const text = marks.deltas.get(key);
            if (!text) return;
            node.append(deltaChip(this.t, text, marks.provisional, this.fresh.age(marks.index, key, text)));
        };
    }

    /** Over the chat: a line per character (the pinned values, the conditions' turns, what is worn). */
    private chatRows(marks: Marks): HTMLElement[] {
        const i18n = this.deps.app.i18n;
        const defs = this.active();
        const pins = this.deps.settings().hudAttrs ?? [];
        return this.holders()
            .map((holder) => {
                const parts = holderParts(i18n, this.api, defs, holder, pins, {
                    shortStatus: true,
                    decorate: this.decorator(marks, holder),
                });
                if (!parts) return null;
                return el('span', { class: 'maestro-m25-hud-holder', data: { holder } }, [
                    el('span', { class: 'maestro-m25-hud-name', text: this.api.shownName?.(holder) ?? holder }),
                    ...parts.values,
                    ...parts.statuses,
                    ...parts.worn,
                ]);
            })
            .filter((row): row is HTMLElement => row !== null);
    }

    /** Beside the chat: the characters of the view, each a section that folds. */
    private sideSections(view: HudSideView, marks: Marks): HTMLElement[] {
        const i18n = this.deps.app.i18n;
        const defs = this.active();
        const settings = this.deps.settings();
        const fold = (holder: string) => (open: boolean) => this.setFolded(holder, !open);
        const open = (holder: string) => !this.folded.has(foldKey(holder));
        const sections =
            view === 'full'
                ? sideHolders(this.api, defs, settings.hudHolders ?? []).map((holder) =>
                      sideHolder(i18n, this.api, holder, open(holder), fold(holder), this.decorator(marks, holder)),
                  )
                : this.holders().map((holder) => {
                      const parts = holderParts(i18n, this.api, defs, holder, settings.hudAttrs ?? [], {
                          decorate: this.decorator(marks, holder),
                      });
                      return parts ? compactHolder(parts, this.api, holder, open(holder), fold(holder)) : null;
                  });
        return sections.filter((node): node is HTMLElement => node !== null);
    }

    /** Checks the user's character may roll now. */
    private checks(): Check[] {
        const persona = personaOf(this.api);
        if (!persona) return [];
        const out: Check[] = [];
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

    /* ---------------------------------------------------------------- the settings it changes itself */

    private commit<K extends keyof MechanicsSettings>(key: K, value: MechanicsSettings[K]): void {
        const { app } = this.deps;
        this.deps.settings()[key] = value;
        try {
            app.settings.notify(`modules.${MECHANICS_KEY}.${key}`);
            app.settings.save();
        } catch (error) {
            this.deps.log.debug('mechanics HUD: settings save failed', error);
        }
    }

    /** The placement menu (or the flyout's way out) chose where the HUD goes. */
    private setPlacement(value: HudPlacement): void {
        this.panel = null;
        this.flyout = false;
        this.focusNext = 'place';
        if (this.deps.settings().hudPlacement !== value) this.commit('hudPlacement', value);
        this.render();
    }

    private setView(view: HudSideView): void {
        this.focusNext = 'view';
        this.commit('hudSideView', view);
        this.render();
    }

    private setFolded(holder: string, folded: boolean): void {
        const key = foldKey(holder);
        // Folding again puts the character last: the latest ones are kept when the record is cut.
        this.folded.delete(key);
        if (folded) this.folded.add(key);
        this.prefs.folded = [...this.folded];
        saveSidePrefs(storage(), this.prefs);
    }

    private widths(view: HudSideView): Partial<Record<HudSide, number>> {
        return {
            left: this.prefs.widths[widthKey('left', view)],
            right: this.prefs.widths[widthKey('right', view)],
        };
    }

    private saveWidth(side: HudSide, width: number): void {
        this.prefs.widths[widthKey(side, this.view())] = Math.round(width);
        saveSidePrefs(storage(), this.prefs);
    }

    /* ---------------------------------------------------------------- drawing */

    /** Where it goes now: the setting, and beside the chat what the page leaves (hud-place.ts). */
    private resolveLayout(): HudLayout {
        const placement = this.deps.settings().hudPlacement;
        if ((placement !== 'left' && placement !== 'right') || typeof document === 'undefined') {
            return { mode: 'chat', reason: 'setting' };
        }
        const view = this.view();
        return resolveHudLayout(placement, measureSideRoom(document), { view, widths: this.widths(view) });
    }

    render(): void {
        if (this.disposed || typeof document === 'undefined') return;
        if (!this.wanted()) {
            this.hide();
            return;
        }
        const layout = this.resolveLayout();
        this.layout = layout;
        if (layout.mode !== 'rail') this.flyout = false;
        // A menu or the problems left open when the panel became a closed rail would wait unseen behind the tab.
        if (layout.mode === 'rail' && !this.flyout && (this.panel === 'place' || this.panel === 'health')) {
            this.panel = null;
        }
        const view = this.view();
        const marks = this.marks();
        const content = layout.mode === 'chat' ? this.chatRows(marks) : this.sideSections(view, marks);
        const checks = this.checks();
        const persona = personaOf(this.api);
        const hasItems = !!persona && itemsOf(this.api, persona).length > 0;
        if (!content.length && !checks.length && !hasItems) {
            // Beside the chat the full view shows more characters than the line over the chat (a phone); when the room
            // comes back it may have something to show, so the page stays watched.
            this.hide(this.deps.settings().hudPlacement !== 'chat');
            return;
        }
        const health = trackingProblems(this.api);
        if (this.panel === 'health' && !health.warn.length) this.panel = null;
        const node = this.node ?? this.create();
        if (!node.isConnected) document.body.appendChild(node);
        node.hidden = false;
        const focus = this.focusNext ?? focusKeyIn(node);
        this.focusNext = null;
        const scroll = node.querySelector('.maestro-m25-hud-side-body')?.scrollTop ?? 0;
        clear(node);
        node.dataset.layout = layout.mode;
        if (layout.mode === 'chat') delete node.dataset.side;
        else node.dataset.side = layout.side;
        node.classList.toggle(SIDE_CLASS, layout.mode === 'side');
        node.classList.toggle(RAIL_CLASS, layout.mode === 'rail');
        node.classList.toggle('maestro-m25-hud-line', layout.mode === 'chat' && phone() && !this.expanded);
        const drawing: Drawing = { content, checks, hasItems, health, view };
        if (layout.mode === 'side') this.drawSide(node, layout, drawing);
        else if (layout.mode === 'rail') this.drawRail(node, layout, drawing);
        else this.drawChat(node, drawing);
        this.position(true);
        restoreIn(node, focus, scroll);
        this.startPolling();
        this.syncTransient();
    }

    /** Over the chat: the grip, the characters in one wrapping line, the quick buttons. */
    private drawChat(node: HTMLElement, drawing: Drawing): void {
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
        const rowsBox = el('div', { class: 'maestro-m25-hud-rows' }, drawing.content);
        rowsBox.addEventListener('click', () => {
            if (!phone()) return;
            this.expanded = !this.expanded;
            this.render();
        });
        const actions = this.actions(drawing, { items: drawing.hasItems, view: false });
        node.append(el('div', { class: 'maestro-m25-hud-bar' }, [grip, rowsBox, actions]));
        const panel = this.panelNode(drawing);
        if (panel) node.append(panel);
    }

    /** Beside the chat: the header with the buttons, the panels, the fight, the characters (scrolls), its edge. */
    private drawSide(node: HTMLElement, layout: SideLayout, drawing: Drawing): void {
        node.append(this.sideHead(drawing));
        this.sideBody(node, drawing);
        const t = this.t;
        const edge = el('div', {
            class: 'maestro-m25-hud-resize',
            title: t('m25.hud.resize'),
            data: { focusKey: 'resize' },
            attrs: {
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': t('m25.hud.resize'),
                'aria-valuemin': layout.min,
                'aria-valuemax': layout.max,
                'aria-valuenow': layout.width,
                tabindex: 0,
            },
        });
        edge.addEventListener('pointerdown', (event) => this.startResize(event));
        edge.addEventListener('keydown', (event) => this.keyResize(event));
        node.append(edge);
    }

    /** No room beside the chat: the tab at the chat's edge and, while open, its flyout with the panel's content. */
    private drawRail(node: HTMLElement, layout: RailLayout, drawing: Drawing): void {
        const t = this.t;
        const tab = el(
            'button',
            {
                class: 'maestro-m25-hud-rail-tab',
                title: t('m25.hud.rail'),
                data: { focusKey: 'rail' },
                attrs: { type: 'button', 'aria-expanded': String(this.flyout), 'aria-label': t('m25.hud.rail') },
            },
            [
                icon('fa-dice-d20'),
                el('span', { class: 'maestro-m25-hud-rail-label', text: t('m25.hud.title') }),
                drawing.health.warn.length
                    ? el('span', { class: 'maestro-m25-hud-rail-warn', text: '⚠', attrs: { 'aria-hidden': 'true' } })
                    : null,
            ],
        );
        tab.addEventListener('click', () => {
            this.flyout = !this.flyout;
            if (!this.flyout && (this.panel === 'place' || this.panel === 'health')) this.panel = null;
            this.render();
        });
        node.append(tab);
        if (!this.flyout) return;
        const flyout = el('div', { class: FLYOUT_CLASS, attrs: { role: 'group', 'aria-label': t('m25.hud.title') } }, [
            this.reasonLine(layout),
            this.sideHead(drawing),
        ]);
        this.sideBody(flyout, drawing);
        node.append(flyout);
    }

    /** Why the rail and not the panel, and the other side when it has the room. */
    private reasonLine(layout: RailLayout): HTMLElement {
        const t = this.t;
        const other = otherSide(layout.side);
        const way = layout.other
            ? button({
                  label: t(`m25.hud.reason.to.${other}`),
                  icon: other === 'left' ? 'fa-arrow-left' : 'fa-arrow-right',
                  kind: 'ghost',
                  className: 'maestro-m25-hud-switch',
                  onClick: () => this.setPlacement(other),
              })
            : null;
        if (way) way.dataset.focusKey = 'switch';
        return el('div', { class: 'maestro-m25-hud-reason', data: { reason: layout.reason } }, [
            el('span', {
                text: layout.reason === 'drawer' ? t(`m25.hud.reason.drawer.${layout.side}`) : t('m25.hud.reason.room'),
            }),
            way,
        ]);
    }

    /** The header beside the chat: the title and the quick buttons (no inventory in the full view: it is in there). */
    private sideHead(drawing: Drawing): HTMLElement {
        if (drawing.view === 'full' && this.panel === 'items') this.panel = null;
        return el('div', { class: 'maestro-m25-hud-side-head' }, [
            el('span', { class: 'maestro-m25-hud-side-title', text: this.t('m25.hud.title') }),
            this.actions(drawing, { items: drawing.view === 'compact' && drawing.hasItems, view: true }),
        ]);
    }

    /** Under the header beside the chat: the open panel, the fight (full view), the characters, the quiet problems. */
    private sideBody(container: HTMLElement, drawing: Drawing): void {
        const t = this.t;
        const panel = this.panelNode(drawing);
        if (panel) container.append(panel);
        const fight = drawing.view === 'full' ? sideFight(this.deps.app.i18n, this.api) : null;
        if (fight) container.append(fight);
        if (drawing.content.length) {
            container.append(
                el(
                    'div',
                    {
                        class: 'maestro-m25-hud-side-body',
                        data: { focusKey: 'body' },
                        attrs: { tabindex: 0, role: 'group', 'aria-label': t('m25.hud.side.body') },
                    },
                    drawing.content,
                ),
            );
        }
        if (drawing.health.info.length) {
            container.append(
                el('div', {
                    class: 'maestro-m25-hud-foot',
                    text: drawing.health.info.map((problem) => problem.text).join(' · '),
                }),
            );
        }
    }

    /** ⚠, «Бросок», «Инвентарь» (when he has items), the view, the placement and the mechanics window. */
    private actions(drawing: Drawing, show: { items: boolean; view: boolean }): HTMLElement {
        const t = this.t;
        const keyed = (node: HTMLButtonElement, key: string, attrs: Record<string, string> = {}) => {
            node.dataset.focusKey = key;
            for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
            return node;
        };
        const full = drawing.view === 'full';
        return el('div', { class: 'maestro-m25-hud-actions' }, [
            drawing.health.warn.length
                ? keyed(
                      button({
                          icon: 'fa-triangle-exclamation',
                          title: t('m25.hud.health'),
                          kind: this.panel === 'health' ? 'primary' : 'ghost',
                          className: 'maestro-m25-hud-warn',
                          onClick: () => this.toggle('health'),
                      }),
                      'warn',
                      { 'aria-expanded': String(this.panel === 'health') },
                  )
                : null,
            drawing.checks.length
                ? keyed(
                      button({
                          icon: 'fa-dice-d20',
                          title: t('m25.hud.roll'),
                          kind: this.panel === 'roll' ? 'primary' : 'ghost',
                          className: 'maestro-m25-hud-roll',
                          onClick: () => this.toggle('roll'),
                      }),
                      'roll',
                  )
                : null,
            show.items
                ? keyed(
                      button({
                          icon: 'fa-sack-dollar',
                          title: t('m25.hud.items'),
                          kind: this.panel === 'items' ? 'primary' : 'ghost',
                          className: 'maestro-m25-hud-items',
                          onClick: () => this.toggle('items'),
                      }),
                      'items',
                  )
                : null,
            show.view
                ? keyed(
                      button({
                          icon: full ? 'fa-list' : 'fa-table-list',
                          title: t('m25.hud.view.full'),
                          kind: full ? 'primary' : 'ghost',
                          className: 'maestro-m25-hud-view',
                          onClick: () => this.setView(full ? 'compact' : 'full'),
                      }),
                      'view',
                      { 'aria-pressed': String(full) },
                  )
                : null,
            phone()
                ? null
                : keyed(
                      button({
                          icon: 'fa-table-columns',
                          title: t('m25.hud.place'),
                          kind: this.panel === 'place' ? 'primary' : 'ghost',
                          className: 'maestro-m25-hud-place',
                          onClick: () => this.toggle('place'),
                      }),
                      'place',
                      { 'aria-haspopup': 'menu', 'aria-expanded': String(this.panel === 'place') },
                  ),
            keyed(
                button({
                    icon: 'fa-up-right-from-square',
                    title: t('m25.hud.window'),
                    kind: 'ghost',
                    className: 'maestro-m25-hud-open',
                    onClick: () => this.openWindow(),
                }),
                'window',
            ),
        ]);
    }

    private create(): HTMLElement {
        this.node = el('div', {
            attrs: { id: HUD_ID, role: 'region', 'aria-label': this.t('m25.hud.title') },
        });
        return this.node;
    }

    /** Takes it off the page; `watch`: the layout is still followed (it may show again in the other place). */
    private hide(watch = false): void {
        if (watch) this.startPolling();
        else this.stopPolling();
        this.releaseTransient();
        if (this.node) {
            this.node.hidden = true;
            this.node.remove();
        }
    }

    private toggle(panel: Exclude<Panel, null>): void {
        this.panel = this.panel === panel ? null : panel;
        // The menu takes the keyboard to the placement now chosen.
        if (this.panel === 'place') this.focusNext = `place:${this.deps.settings().hudPlacement}`;
        this.render();
    }

    private openWindow(): void {
        const { ui } = this.deps.app;
        if (ui.openWindow) ui.openWindow('mechanics', { tab: 'mechanics' });
        else ui.openPult('mechanics');
    }

    private panelNode(drawing: Drawing): HTMLElement | null {
        const t = this.t;
        const { checks } = drawing;
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
        if (this.panel === 'place') return this.placeMenu();
        if (this.panel === 'health' && drawing.health.warn.length) {
            return el(
                'div',
                {
                    class: 'maestro-m25-hud-panel maestro-m25-hud-health',
                    attrs: { role: 'group', 'aria-label': t('m25.hud.health') },
                },
                [
                    ...drawing.health.warn.map((problem) =>
                        el('div', { class: 'maestro-m25-hud-health-item', data: { code: problem.code } }, [
                            el('span', { text: problem.text }),
                            problem.detail ? el('span', { class: 'maestro-muted', text: problem.detail }) : null,
                        ]),
                    ),
                    button({
                        label: t('m25.hud.health.open'),
                        icon: 'fa-gears',
                        className: 'maestro-m25-hud-health-open',
                        onClick: () => {
                            this.panel = null;
                            this.openWindow();
                            this.render();
                        },
                    }),
                ],
            );
        }
        return null;
    }

    /** «Над чатом / Слева от чата / Справа от чата»: the chosen one marked; the arrow keys move between them. */
    private placeMenu(): HTMLElement {
        const t = this.t;
        const current = this.deps.settings().hudPlacement;
        const items = PLACEMENTS.map(({ value, icon: sign }) => {
            const item = button({
                label: t(`m25.hud.place.${value}`),
                icon: sign,
                kind: value === current ? 'primary' : 'ghost',
                className: 'maestro-m25-hud-place-item',
                onClick: () => this.setPlacement(value),
            });
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(value === current));
            item.dataset.placement = value;
            item.dataset.focusKey = `place:${value}`;
            return item;
        });
        const menu = el(
            'div',
            {
                class: 'maestro-m25-hud-panel maestro-m25-hud-place-menu',
                attrs: { role: 'menu', 'aria-label': t('m25.hud.place') },
            },
            items,
        );
        menu.addEventListener('keydown', (event) => {
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const to =
                event.key === 'ArrowDown' || event.key === 'ArrowRight'
                    ? at + 1
                    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                      ? at - 1
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : null;
            if (to === null) return;
            event.preventDefault();
            items[(to + items.length) % items.length]?.focus();
        });
        return menu;
    }

    private async roll(def: MechanicDef, check: CheckDef): Promise<void> {
        const { app } = this.deps;
        const persona = personaOf(this.api);
        try {
            const result = await this.api.roll(def.id, check.id, persona, this.mode ? { mode: this.mode } : {});
            app.ui.notice(this.t(rollNoticeKey(result), { line: rollLine(app.i18n, this.api, result) }), {
                urgent: true,
            });
        } catch (error) {
            app.ui.notice(error instanceof Error ? error.message : String(error), { urgent: true, level: 'warn' });
        }
    }

    /* ---------------------------------------------------------------- the menu, the problems, the flyout */

    /** While the placement menu, the problems or the rail's flyout are open, a click elsewhere or Escape closes them. */
    private syncTransient(): void {
        const open = this.flyout || this.panel === 'place' || this.panel === 'health';
        if (!open || this.disposed) {
            this.releaseTransient();
            return;
        }
        if (this.transientOff) return;
        const outside = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Node) || this.node?.contains(target)) return;
            this.closeTransient(true, false);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const inside = !!this.node && this.node.contains(document.activeElement);
            if (!this.closeTransient(false, inside) || !inside) return;
            event.preventDefault();
            event.stopPropagation();
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', key, true);
        this.transientOff = () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', key, true);
        };
    }

    private releaseTransient(): void {
        this.transientOff?.();
        this.transientOff = null;
    }

    /**
     * Closes the menu or the problems, then the flyout (`all`: both at once — a click elsewhere; else one step —
     * Escape); `refocus`: the keyboard goes back to the button that opened it. Whether anything closed.
     */
    private closeTransient(all: boolean, refocus: boolean): boolean {
        let back: string | null = null;
        if (this.panel === 'place' || this.panel === 'health') {
            back = this.panel === 'place' ? 'place' : 'warn';
            this.panel = null;
            if (all && this.flyout) {
                this.flyout = false;
                back = 'rail';
            }
        } else if (this.flyout) {
            this.flyout = false;
            back = 'rail';
        }
        if (!back) return false;
        if (refocus) this.focusNext = back;
        this.render();
        return true;
    }

    /* ---------------------------------------------------------------- placing and dragging */

    /** Places it; a change between over the chat, the panel and the rail (or of their side) draws it again. */
    position(fromRender = false): void {
        if (this.disposed) return;
        if (!fromRender && this.deps.settings().hudPlacement !== 'chat' && this.wanted()) {
            const layout = this.resolveLayout();
            if (layoutKey(layout) !== layoutKey(this.layout)) {
                this.render();
                return;
            }
            this.layout = layout;
        }
        const node = this.node;
        if (!node?.isConnected || node.hidden) return;
        const layout = this.layout;
        if (layout.mode === 'side') {
            if (this.resizing) return;
            node.style.left = `${layout.left}px`;
            node.style.top = `${layout.top}px`;
            node.style.width = `${layout.width}px`;
            node.style.maxHeight = `${layout.maxHeight}px`;
            const edge = node.querySelector('.maestro-m25-hud-resize');
            edge?.setAttribute('aria-valuenow', String(layout.width));
            edge?.setAttribute('aria-valuemax', String(layout.max));
            return;
        }
        if (layout.mode === 'rail') {
            node.style.left = `${layout.left}px`;
            node.style.top = `${layout.top}px`;
            node.style.width = `${RAIL_WIDTH}px`;
            node.style.maxHeight = '';
            // The flyout hangs off the tab: its place relative to the HUD's node.
            const flyout = node.querySelector<HTMLElement>(`.${FLYOUT_CLASS}`);
            if (flyout) {
                flyout.style.left = `${layout.flyout.left - layout.left}px`;
                flyout.style.top = `${layout.flyout.top - layout.top}px`;
                flyout.style.width = `${layout.flyout.width}px`;
                flyout.style.maxHeight = `${layout.flyout.maxHeight}px`;
            }
            return;
        }
        node.style.maxHeight = '';
        const area = chatArea();
        node.style.left = `${Math.round(area.left + EDGE_GAP)}px`;
        node.style.width = `${Math.max(120, Math.round(area.right - area.left - EDGE_GAP * 2))}px`;
        if (this.drag) return;
        const height = node.getBoundingClientRect().height || 32;
        node.style.top = `${hudTop({ ...area, top: area.top + EDGE_GAP, bottom: area.bottom - EDGE_GAP }, this.place, height)}px`;
    }

    private startPolling(): void {
        if (this.disposed) return;
        // ST's panels and Maestro's windows open and close without telling: a cheap look keeps the HUD in the gap.
        if (this.poll === null) this.poll = setInterval(() => this.position(), PLACE_POLL_MS);
        if (this.deps.settings().hudPlacement !== 'chat') this.watchLayout();
        else this.unwatchLayout();
    }

    private stopPolling(): void {
        this.unwatchLayout();
        if (this.poll === null) return;
        clearInterval(this.poll);
        this.poll = null;
    }

    /**
     * Beside the chat it follows the page at once: the chat column resized or moved (ST's chat width — a style on
     * <html> —, its movable UI), <body> resized, ST's drawers opened, pinned or closed. The poll catches the rest
     * (DES's portrait panel, Maestro's windows docked to a side, Top Info Bar's side bar).
     */
    private watchLayout(): void {
        if (this.watchers.length || this.disposed || typeof document === 'undefined') return;
        const nudge = () => this.nudge();
        const sheld = document.getElementById('sheld');
        const drawers = ['left-nav-panel', 'right-nav-panel']
            .map((id) => document.getElementById(id))
            .filter((node): node is HTMLElement => node !== null);
        if (typeof ResizeObserver === 'function') {
            const resized = new ResizeObserver(nudge);
            if (sheld) resized.observe(sheld);
            resized.observe(document.body);
            this.watchers.push(resized);
        }
        if (typeof MutationObserver === 'function') {
            const changed = new MutationObserver(nudge);
            const attributes = { attributes: true, attributeFilter: ['class', 'style'] };
            if (sheld) changed.observe(sheld, attributes);
            for (const drawer of drawers) changed.observe(drawer, attributes);
            changed.observe(document.body, attributes);
            changed.observe(document.documentElement, attributes);
            this.watchers.push(changed);
        }
    }

    private unwatchLayout(): void {
        this.nudge.cancel();
        for (const watcher of this.watchers.splice(0)) {
            try {
                watcher.disconnect();
            } catch (error) {
                this.deps.log.debug('mechanics HUD: observer release failed', error);
            }
        }
    }

    /** Drags the side panel's outer edge: the inner one stays at the chat; the width is remembered on release. */
    private startResize(event: PointerEvent): void {
        const node = this.node;
        const layout = this.layout;
        if (!node || layout.mode !== 'side') return;
        event.preventDefault();
        const side = layout.side;
        const inner = side === 'left' ? layout.left + layout.width : layout.left;
        this.resizing = { pointer: event.pointerId, startX: event.clientX, startWidth: layout.width };
        node.classList.add('maestro-m25-hud-resizing');
        let width = layout.width;
        const move = (moved: PointerEvent) => {
            if (!this.resizing || moved.pointerId !== this.resizing.pointer) return;
            const delta = moved.clientX - this.resizing.startX;
            width = clampWidth(
                this.resizing.startWidth + (side === 'left' ? -delta : delta),
                layout.min,
                layout.max,
                layout.width,
            );
            node.style.width = `${width}px`;
            if (side === 'left') node.style.left = `${inner - width}px`;
        };
        const release = () => {
            this.resizing = null;
            this.resizeOff = null;
            node.classList.remove('maestro-m25-hud-resizing');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', up);
        };
        const up = (ended: PointerEvent) => {
            if (!this.resizing || ended.pointerId !== this.resizing.pointer) return;
            move(ended);
            release();
            this.saveWidth(side, width);
            this.position();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
        this.resizeOff = release;
    }

    /** The arrow keys on the focused edge: wider towards the page's edge, narrower towards the chat. */
    private keyResize(event: KeyboardEvent): void {
        const layout = this.layout;
        if (layout.mode !== 'side' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        const wider = (event.key === 'ArrowLeft') === (layout.side === 'left');
        const width = clampWidth(
            layout.width + (wider ? RESIZE_STEP : -RESIZE_STEP),
            layout.min,
            layout.max,
            layout.width,
        );
        this.saveWidth(layout.side, width);
        this.position();
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

    /** Where it is drawn now (tests). */
    layoutNow(): HudLayout {
        return { ...this.layout };
    }
}

/** What has the keyboard focus inside the HUD (a `data-focus-key`), to give it back after a redraw. */
function focusKeyIn(node: HTMLElement): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !node.contains(active)) return null;
    return active.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey ?? null;
}

/** Gives back the focus and the scroll of the side panel's characters after a redraw. */
function restoreIn(node: HTMLElement, focus: string | null, scroll: number): void {
    const body = node.querySelector<HTMLElement>('.maestro-m25-hud-side-body');
    if (body && scroll > 0) body.scrollTop = scroll;
    if (!focus) return;
    for (const item of node.querySelectorAll<HTMLElement>('[data-focus-key]')) {
        if (item.dataset.focusKey !== focus) continue;
        item.focus({ preventScroll: true });
        return;
    }
}
