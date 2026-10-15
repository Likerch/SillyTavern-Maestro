// M25 «Механики», where the HUD goes (setting `hudPlacement`): over ST's chat column (the top or the bottom edge,
// dragged, hud.ts) or BESIDE it — a panel in the free space left or right of the chat column (#sheld), else a rail.
// - Phones (ST's 1000px breakpoint): always over the chat, one line (hud.ts); the setting stays as it is.
// - The panel needs at least the view's narrowest width (SIDE_VIEWS: compact 150, full 220) of free space between what
//   already stands on that side of the page and the chat; it is as wide as the width the user dragged it to (else the
//   view's default), never wider than that space, and hugs the chat's edge. No window-width gate: the room decides.
// - What already stands at the left: a Maestro window docked to the left side (.maestro-window-side-left), DES's
//   portrait panel in its own «left» mode (fixed at the left of <body>, z-index 900; not while Maestro's dock holds the
//   bar in its tab), Top Info Bar's side bar (#extensionSideBar) when it sits in the left gap. At the right: Maestro's
//   right side and DES's portraits in «right» mode. The panel stands between them and the chat.
// - ST's drawer (#left-nav-panel / #right-nav-panel, fixed over the whole gap, z-index 3000) PINNED open holds the gap
//   for good: no room on that side. Merely OPEN it covers the gap for a while (the user is in ST's settings): the panel
//   stays where it is, under the drawer, and comes back into view when the drawer closes.
// - Without the room: a rail — a slim tab at the chat's edge on that side (outside the chat when the gap holds it, else
//   over the chat's edge) that opens the same content as a flyout over the chat's edge, headed by why and what to do
//   (`reason`; `other`: the other side has the room). The saved setting never changes by itself.
// The HUD sits under ST's drawers (3000), top bar (3005), its moving popups (4000) and Maestro's windows (2900+),
// above the chat column (30), DES's side panel (900) and ST's expression sprites (2): the HUD's own z-index.

import type { HudPlacement, HudSideView } from './parts';

/** ST's phone breakpoint (its own media query): never beside the chat, the HUD is one line there. */
export const PHONE_QUERY = '(max-width: 1000px)';
/** Space kept between the panel, the chat column and the edges. */
export const SIDE_GAP = 8;
/** Per view: the narrowest panel worth showing and the default width (CSS px). */
export const SIDE_VIEWS: Readonly<Record<HudSideView, { min: number; width: number }>> = {
    compact: { min: 150, width: 240 },
    full: { min: 220, width: 320 },
};
/** The rail's tab: its width and the space between it and the chat (or the flyout). */
export const RAIL_WIDTH = 28;
export const RAIL_GAP = 4;

export type HudSide = 'left' | 'right';

/** ST's drawer on a side: pinned open (holds the gap), only open for now, or closed. */
export type DrawerState = 'pinned' | 'open' | 'closed';

/** What the sides of the page look like now. */
export interface SideRoom {
    viewportWidth: number;
    viewportHeight: number;
    phone: boolean;
    /** ST's chat column (#sheld); null when it is not on the page. */
    chat: { left: number; right: number; top: number; bottom: number } | null;
    drawers: Record<HudSide, DrawerState>;
    /**
     * Where the panels already standing beside the chat end: `left` — the right edge of those at the left (0: none);
     * `right` — the left edge of those at the right (the window's width: none).
     */
    taken: Record<HudSide, number>;
}

/** Why the mechanics show over the chat: the setting, a phone, no chat column on the page. */
export type ChatReason = 'setting' | 'phone' | 'room';
/** Why the rail instead of the panel: ST's drawer pinned on that side, too little room. */
export type RailReason = 'drawer' | 'room';

export interface HudBox {
    left: number;
    top: number;
    width: number;
    maxHeight: number;
}

export type HudLayout =
    | { mode: 'chat'; reason: ChatReason }
    | (HudBox & {
          mode: 'side';
          side: HudSide;
          /** The width the user may drag it between. */
          min: number;
          max: number;
          /** Standing beside a neighbour's panel (a Maestro window, DES's portraits). */
          beside: boolean;
      })
    | {
          mode: 'rail';
          side: HudSide;
          reason: RailReason;
          /** The tab stands outside the chat column (else over its edge). */
          outside: boolean;
          /** The tab's place (its width is RAIL_WIDTH). */
          left: number;
          top: number;
          /** The flyout's box when it is open. */
          flyout: HudBox;
          /** The other side has the room for the panel. */
          other: boolean;
      };

export interface SideOptions {
    view?: HudSideView;
    /** Widths the user dragged the panel to, per side (this view). */
    widths?: Partial<Record<HudSide, number>>;
}

const overChat = (reason: ChatReason): HudLayout => ({ mode: 'chat', reason });

export const otherSide = (side: HudSide): HudSide => (side === 'left' ? 'right' : 'left');

/** A width kept between `min` and `max` (a missing or broken one: `fallback`). */
export function clampWidth(width: number | undefined, min: number, max: number, fallback: number): number {
    const wanted = typeof width === 'number' && Number.isFinite(width) ? width : fallback;
    return Math.round(Math.max(min, Math.min(max, wanted)));
}

/** The gap between the chat's edge and what stands on that side (or the window's edge). */
function gapOf(room: SideRoom, side: HudSide): number {
    const chat = room.chat;
    if (!chat) return 0;
    if (side === 'left') return chat.left - Math.max(0, room.taken.left);
    return Math.min(room.viewportWidth || chat.right, room.taken.right) - chat.right;
}

/** The width a panel may take on a side (gaps kept); -1 without the chat or with ST's drawer pinned there. */
export function freeRoom(room: SideRoom, side: HudSide): number {
    if (!room.chat || room.drawers[side] === 'pinned') return -1;
    return gapOf(room, side) - SIDE_GAP * 2;
}

/** The panel of a view fits on a side. */
export function sideFits(room: SideRoom, side: HudSide, view: HudSideView = 'compact'): boolean {
    return !room.phone && freeRoom(room, side) >= SIDE_VIEWS[view].min;
}

/** From under ST's top bar down to the chat's bottom (or the window's), the gaps kept. */
function span(room: SideRoom, chat: NonNullable<SideRoom['chat']>): { top: number; maxHeight: number } {
    const top = Math.round(Math.max(0, chat.top) + SIDE_GAP);
    const bottom = Math.min(room.viewportHeight || chat.bottom, chat.bottom) - SIDE_GAP;
    return { top, maxHeight: Math.max(120, Math.round(bottom - top)) };
}

/** Where the mechanics go for a placement in a room (pure: the tests give the room). */
export function resolveHudLayout(
    placement: HudPlacement | undefined,
    room: SideRoom,
    options: SideOptions = {},
): HudLayout {
    if (placement !== 'left' && placement !== 'right') return overChat('setting');
    if (room.phone) return overChat('phone');
    const chat = room.chat;
    if (!chat) return overChat('room');
    const side = placement;
    const view = SIDE_VIEWS[options.view ?? 'compact'];
    const { top, maxHeight } = span(room, chat);
    const free = Math.floor(freeRoom(room, side));
    if (free >= view.min) {
        const width = clampWidth(options.widths?.[side], view.min, free, view.width);
        return {
            mode: 'side',
            side,
            left: Math.round(side === 'left' ? chat.left - SIDE_GAP - width : chat.right + SIDE_GAP),
            top,
            width,
            maxHeight,
            min: view.min,
            max: free,
            beside: side === 'left' ? room.taken.left > 0 : room.taken.right < (room.viewportWidth || Infinity),
        };
    }
    return railLayout(room, chat, side, options, top, maxHeight);
}

function railLayout(
    room: SideRoom,
    chat: NonNullable<SideRoom['chat']>,
    side: HudSide,
    options: SideOptions,
    top: number,
    maxHeight: number,
): HudLayout {
    const view = SIDE_VIEWS[options.view ?? 'compact'];
    const pinned = room.drawers[side] === 'pinned';
    // A pinned drawer (z 3000) covers the whole gap: a tab there would be under it.
    const outside = !pinned && gapOf(room, side) >= RAIL_WIDTH + RAIL_GAP * 2;
    const left = Math.round(
        side === 'left'
            ? outside
                ? chat.left - RAIL_GAP - RAIL_WIDTH
                : chat.left
            : outside
              ? chat.right + RAIL_GAP
              : chat.right - RAIL_WIDTH,
    );
    // The flyout opens beside the tab, over the chat's edge, never wider than the chat or the window allows.
    const viewport = room.viewportWidth || chat.right;
    const space = side === 'left' ? viewport - SIDE_GAP - (left + RAIL_WIDTH + RAIL_GAP) : left - RAIL_GAP - SIDE_GAP;
    const most = Math.max(0, Math.min(space, chat.right - chat.left));
    const wanted = clampWidth(options.widths?.[side], view.min, Number.POSITIVE_INFINITY, view.width);
    const width = Math.round(Math.min(most, wanted));
    return {
        mode: 'rail',
        side,
        reason: pinned ? 'drawer' : 'room',
        outside,
        left,
        top,
        flyout: {
            left: Math.round(side === 'left' ? left + RAIL_WIDTH + RAIL_GAP : left - RAIL_GAP - width),
            top,
            width,
            maxHeight,
        },
        other: sideFits(room, otherSide(side), options.view ?? 'compact'),
    };
}

/** What makes the HUD draw itself again (a change of only the numbers just moves it). */
export function layoutKey(layout: HudLayout): string {
    switch (layout.mode) {
        case 'side':
            return `side:${layout.side}`;
        case 'rail':
            return `rail:${layout.side}:${layout.reason}:${layout.other}`;
        default:
            return layout.reason === 'phone' ? 'chat:phone' : 'chat';
    }
}

/* ------------------------------------------------------------------ reading the page */

export function phone(): boolean {
    try {
        return globalThis.matchMedia?.(PHONE_QUERY).matches ?? false;
    } catch {
        return false;
    }
}

const DRAWERS: Record<HudSide, string> = { left: 'left-nav-panel', right: 'right-nav-panel' };

/**
 * ST's drawer on a side (RossAscends-mods.js: LPanelPin / RPanelPin): pinned and not closed by its icon — it holds
 * the gap; open — it only covers it for now.
 */
export function drawerState(doc: Document, side: HudSide): DrawerState {
    const drawer = doc.getElementById(DRAWERS[side]);
    if (!drawer) return 'closed';
    const classes = drawer.classList;
    if (classes.contains('pinnedOpen') && !classes.contains('closedDrawer')) return 'pinned';
    return classes.contains('openDrawer') ? 'open' : 'closed';
}

/**
 * Panels of others at the left of the page: Maestro's left window side, DES's portrait panel in its «left» mode, Top
 * Info Bar's side bar (only when it sits in the gap: measured).
 */
export const LEFT_NEIGHBOURS = [
    '.maestro-window-side-left:not([hidden])',
    '#dooms-portrait-bar-wrapper.dooms-pb-position-left',
    '#extensionSideBar',
] as const;

/** Panels of others at the right of the page: Maestro's right window side, DES's portraits in «right» mode. */
export const RIGHT_NEIGHBOURS = [
    '.maestro-window-side-right:not([hidden])',
    '#dooms-portrait-bar-wrapper.dooms-pb-position-right',
] as const;

/** The boxes of a side's neighbours on the page (shown, sized, not held in a Maestro window, not in the chat). */
function neighbourBoxes(doc: Document, selectors: readonly string[]): { node: HTMLElement; box: DOMRect }[] {
    const out: { node: HTMLElement; box: DOMRect }[] = [];
    for (const selector of selectors) {
        for (const node of doc.querySelectorAll<HTMLElement>(selector)) {
            // DES's bar held in the dock's tab is inside a Maestro window, not beside the chat.
            if (node.hidden || node.closest('.maestro-m32d-slot') || node.closest('#sheld')) continue;
            const box = node.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) continue;
            out.push({ node, box });
        }
    }
    return out;
}

/** The right edge of the neighbours' panels standing left of the chat column (0: none). */
export function takenLeft(doc: Document, chatLeft: number): number {
    let right = 0;
    for (const { node, box } of neighbourBoxes(doc, LEFT_NEIGHBOURS)) {
        if (box.left >= chatLeft) continue;
        // Top Info Bar's side bar counts only standing in the gap (over the chat it is not in the way of the panel).
        if (node.id === 'extensionSideBar' && box.right > chatLeft + 1) continue;
        right = Math.max(right, box.right);
    }
    return right;
}

/** The left edge of the neighbours' panels standing right of the chat column (`viewportWidth`: none). */
export function takenRight(doc: Document, chatRight: number, viewportWidth: number): number {
    let left = viewportWidth;
    for (const { box } of neighbourBoxes(doc, RIGHT_NEIGHBOURS)) {
        if (box.right <= chatRight) continue;
        left = Math.min(left, box.left);
    }
    return left;
}

/** Both sides of the page now. */
export function measureSideRoom(doc: Document = document): SideRoom {
    const viewportWidth = globalThis.innerWidth || doc.documentElement.clientWidth || 0;
    const viewportHeight = globalThis.innerHeight || doc.documentElement.clientHeight || 0;
    const sheld = doc.getElementById('sheld');
    const box = sheld && !sheld.hidden ? sheld.getBoundingClientRect() : null;
    const chat =
        box && box.width > 0 && box.height > 0
            ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
            : null;
    return {
        viewportWidth,
        viewportHeight,
        phone: phone(),
        chat,
        drawers: { left: drawerState(doc, 'left'), right: drawerState(doc, 'right') },
        taken: {
            left: chat ? takenLeft(doc, chat.left) : 0,
            right: chat ? takenRight(doc, chat.right, viewportWidth) : viewportWidth,
        },
    };
}
