// M25 «Механики», where the HUD goes (setting `hudPlacement`): over ST's chat column (the top or the bottom edge,
// dragged, hud.ts) or, on a wide screen, as a fuller panel in the free space LEFT of the chat column (#sheld).
// - The left panel needs a window at least SIDE_MIN_VIEWPORT wide, never a phone (ST's 1000px breakpoint), and at
//   least SIDE_MIN_WIDTH of free space between what already stands at the left of the page and the chat; it is as wide
//   as that space allows, up to SIDE_MAX_WIDTH, and hugs the chat's left edge.
// - What already stands at the left: a Maestro window docked to the left side (.maestro-window-side-left) and DES's
//   portrait panel in its own «left» mode (fixed at the left of <body>, z-index 900; not while Maestro's dock holds
//   the bar in its tab). The panel stands to the right of them; when that leaves too little room it is not shown.
// - ST's left drawer (#left-nav-panel, «AI Response Configuration», fixed over the whole left gap) open or pinned open:
//   the left gap is ST's.
// In every case without the room the mechanics show over the chat as usual; the saved setting does not change.
// The panel sits under ST's drawers (3000), top bar (3005), its moving popups (4000) and Maestro's windows (2900+),
// above the chat column (30), DES's side panel (900) and ST's expression sprites (2): the HUD's own z-index.

import type { HudPlacement } from './parts';

/** ST's phone breakpoint (its own media query): never the left panel, the HUD is one line there. */
export const PHONE_QUERY = '(max-width: 1000px)';
/** The left panel needs a window at least this wide (CSS px). */
export const SIDE_MIN_VIEWPORT = 1200;
/** The narrowest left panel worth showing (CSS px of free space). */
export const SIDE_MIN_WIDTH = 220;
/** The widest left panel. */
export const SIDE_MAX_WIDTH = 360;
/** Space kept between the panel, the chat column and the edges. */
export const SIDE_GAP = 8;

/** What the left side of the page looks like now. */
export interface SideRoom {
    viewportWidth: number;
    viewportHeight: number;
    phone: boolean;
    /** ST's chat column (#sheld); null when it is not on the page. */
    chat: { left: number; top: number; bottom: number } | null;
    /** ST's left drawer is open or pinned open. */
    drawer: boolean;
    /** The right edge of what already stands at the left of the chat (0: nothing). */
    taken: number;
}

/** Why the mechanics show over the chat. */
export type ChatReason = 'setting' | 'phone' | 'narrow' | 'drawer' | 'room';

export type HudLayout =
    | { mode: 'chat'; reason: ChatReason }
    | {
          mode: 'side';
          left: number;
          top: number;
          width: number;
          maxHeight: number;
          /** Standing to the right of a neighbour's panel (a Maestro window, DES's portraits). */
          beside: boolean;
      };

const overChat = (reason: ChatReason): HudLayout => ({ mode: 'chat', reason });

/** Where the mechanics go for a placement in a room (pure: the tests give the room). */
export function resolveHudLayout(placement: HudPlacement | undefined, room: SideRoom): HudLayout {
    if (placement !== 'left') return overChat('setting');
    if (room.phone) return overChat('phone');
    if (room.viewportWidth < SIDE_MIN_VIEWPORT) return overChat('narrow');
    if (room.drawer) return overChat('drawer');
    if (!room.chat) return overChat('room');
    const start = Math.max(0, room.taken);
    const free = room.chat.left - start - SIDE_GAP * 2;
    if (free < SIDE_MIN_WIDTH) return overChat('room');
    const width = Math.min(SIDE_MAX_WIDTH, Math.floor(free));
    const top = Math.round(Math.max(0, room.chat.top) + SIDE_GAP);
    const bottom = Math.min(room.viewportHeight || room.chat.bottom, room.chat.bottom) - SIDE_GAP;
    return {
        mode: 'side',
        left: Math.round(room.chat.left - SIDE_GAP - width),
        top,
        width,
        maxHeight: Math.max(120, Math.round(bottom - top)),
        beside: start > 0,
    };
}

/* ------------------------------------------------------------------ reading the page */

export function phone(): boolean {
    try {
        return globalThis.matchMedia?.(PHONE_QUERY).matches ?? false;
    } catch {
        return false;
    }
}

/** ST's left drawer covers the left gap: open, or pinned and not closed (RossAscends-mods.js: LPanelPin). */
export function leftDrawerOpen(doc: Document): boolean {
    const drawer = doc.getElementById('left-nav-panel');
    if (!drawer) return false;
    if (drawer.classList.contains('openDrawer')) return true;
    return drawer.classList.contains('pinnedOpen') && !drawer.classList.contains('closedDrawer');
}

/** Panels of others at the left of the page: Maestro's left window side, DES's portrait panel in its «left» mode. */
export const LEFT_NEIGHBOURS = [
    '.maestro-window-side-left:not([hidden])',
    '#dooms-portrait-bar-wrapper.dooms-pb-position-left',
] as const;

/** The right edge of the neighbours' panels standing left of the chat column (0: none). */
export function takenLeft(doc: Document, chatLeft: number): number {
    let right = 0;
    for (const selector of LEFT_NEIGHBOURS) {
        for (const node of doc.querySelectorAll<HTMLElement>(selector)) {
            // DES's bar held in the dock's tab is inside a Maestro window, not at the left of the page.
            if (node.hidden || node.closest('.maestro-m32d-slot')) continue;
            const box = node.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0 || box.left >= chatLeft) continue;
            right = Math.max(right, box.right);
        }
    }
    return right;
}

/** The left side of the page now. */
export function measureSideRoom(doc: Document = document): SideRoom {
    const viewportWidth = globalThis.innerWidth || doc.documentElement.clientWidth || 0;
    const viewportHeight = globalThis.innerHeight || doc.documentElement.clientHeight || 0;
    const sheld = doc.getElementById('sheld');
    const box = sheld && !sheld.hidden ? sheld.getBoundingClientRect() : null;
    const chat = box && box.width > 0 && box.height > 0 ? { left: box.left, top: box.top, bottom: box.bottom } : null;
    return {
        viewportWidth,
        viewportHeight,
        phone: phone(),
        chat,
        drawer: leftDrawerOpen(doc),
        taken: chat ? takenLeft(doc, chat.left) : 0,
    };
}
