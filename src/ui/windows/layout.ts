// Where windows sit, remembered per device (plan-2 §10): open or not, docked left/right or floating, size and
// position, collapsed, last section; plus the width of each side panel. localStorage may be missing or throw
// (private mode, blocked site data): then the layout simply is not remembered.
import type { WindowDock } from '../../shared/contracts';

export const WINDOWS_STORAGE_KEY = 'maestro.windows';

/** ST's phone breakpoint (style.css `@media screen and (max-width: 1000px)`). */
export const SHEET_BREAKPOINT = 1000;
export const MIN_SIDE_WIDTH = 280;
export const MIN_FLOAT_WIDTH = 280;
export const MIN_FLOAT_HEIGHT = 160;
export const DEFAULT_SIDE_WIDTH = 420;
export const DEFAULT_FLOAT_WIDTH = 480;
export const DEFAULT_FLOAT_HEIGHT = 600;
/** Part of a floating window that must stay on screen (its header can always be grabbed). */
const KEEP_VISIBLE = 80;
const HEADER_HEIGHT = 44;

export type Side = 'left' | 'right';

export interface WindowPlace {
    open: boolean;
    dock: WindowDock;
    /** The side a floating window goes back to on «attach». */
    side: Side;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    collapsed: boolean;
    tab?: string;
}

export interface LayoutState {
    windows: Record<string, WindowPlace>;
    sides: Partial<Record<Side, number>>;
    /** The window in front last (the one a phone shows after reload). */
    front?: string;
}

export function emptyLayout(): LayoutState {
    return { windows: {}, sides: {} };
}

const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;

function readPlace(raw: unknown): WindowPlace | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const dock: WindowDock = value.dock === 'left' || value.dock === 'float' ? value.dock : 'right';
    const side: Side =
        value.side === 'left' ? 'left' : value.side === 'right' ? 'right' : dock === 'left' ? 'left' : 'right';
    return {
        open: value.open === true,
        dock,
        side,
        x: num(value.x),
        y: num(value.y),
        width: num(value.width),
        height: num(value.height),
        collapsed: value.collapsed === true,
        tab: typeof value.tab === 'string' ? value.tab : undefined,
    };
}

export function loadLayout(): LayoutState {
    try {
        const raw = globalThis.localStorage?.getItem(WINDOWS_STORAGE_KEY);
        if (!raw) return emptyLayout();
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const state = emptyLayout();
        const windows = parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {};
        for (const [id, value] of Object.entries(windows as Record<string, unknown>)) {
            const place = readPlace(value);
            if (place) state.windows[id] = place;
        }
        const sides = (parsed.sides && typeof parsed.sides === 'object' ? parsed.sides : {}) as Record<string, unknown>;
        const left = num(sides.left);
        const right = num(sides.right);
        if (left !== undefined) state.sides.left = left;
        if (right !== undefined) state.sides.right = right;
        if (typeof parsed.front === 'string') state.front = parsed.front;
        return state;
    } catch {
        return emptyLayout();
    }
}

export function saveLayout(state: LayoutState): void {
    try {
        globalThis.localStorage?.setItem(WINDOWS_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Not remembered this time (quota, private mode).
    }
}

export interface Viewport {
    width: number;
    height: number;
}

export function viewport(): Viewport {
    const width = globalThis.innerWidth || document.documentElement?.clientWidth || 1280;
    const height = globalThis.innerHeight || document.documentElement?.clientHeight || 800;
    return { width, height };
}

/** Phones and narrow windows: one full-screen window at a time. */
export function isSheetViewport(): boolean {
    try {
        const query = globalThis.matchMedia?.(`(max-width: ${SHEET_BREAKPOINT}px)`);
        if (query) return query.matches;
    } catch {
        // fall through to the width
    }
    return viewport().width <= SHEET_BREAKPOINT;
}

/** A side panel never takes more than ~45 % of the screen: the chat stays usable. */
export function clampSideWidth(width: number, view: Viewport = viewport()): number {
    const max = Math.max(MIN_SIDE_WIDTH, Math.floor(view.width * 0.45));
    return Math.max(MIN_SIDE_WIDTH, Math.min(max, Math.round(width)));
}

/**
 * The free gap beside ST's chat column (#sheld), which ST's own side drawers fill; null when the page has no chat
 * column (tests, an unusual theme).
 */
export function chatGap(side: Side): number | null {
    const sheld = document.getElementById('sheld');
    if (!sheld) return null;
    const rect = sheld.getBoundingClientRect();
    if (!rect.width) return null;
    const gap = side === 'left' ? rect.left : viewport().width - rect.right;
    return gap > 0 ? Math.floor(gap) : null;
}

export function defaultSideWidth(side: Side, wanted: number | undefined): number {
    if (wanted) return clampSideWidth(wanted);
    const gap = chatGap(side);
    return clampSideWidth(gap && gap >= 320 ? gap : DEFAULT_SIDE_WIDTH);
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Keeps a floating window grabbable: inside the viewport, its header always reachable. */
export function clampFloat(rect: Rect, view: Viewport = viewport()): Rect {
    const width = Math.max(
        MIN_FLOAT_WIDTH,
        Math.min(Math.round(rect.width), Math.max(MIN_FLOAT_WIDTH, view.width - 16)),
    );
    const height = Math.max(
        MIN_FLOAT_HEIGHT,
        Math.min(Math.round(rect.height), Math.max(MIN_FLOAT_HEIGHT, view.height - 16)),
    );
    const x = Math.max(KEEP_VISIBLE - width, Math.min(Math.round(rect.x), view.width - KEEP_VISIBLE));
    const y = Math.max(0, Math.min(Math.round(rect.y), view.height - HEADER_HEIGHT));
    return { x, y, width, height };
}

/** The first place of a floating window: centred, cascaded a little per window already floating. */
export function defaultFloat(
    width: number | undefined,
    height: number | undefined,
    cascade: number,
    view: Viewport = viewport(),
): Rect {
    const w = Math.min(width ?? DEFAULT_FLOAT_WIDTH, view.width - 40);
    const h = Math.min(height ?? DEFAULT_FLOAT_HEIGHT, view.height - 60);
    const step = (cascade % 6) * 24;
    return clampFloat(
        {
            x: Math.round((view.width - w) / 2) + step,
            y: Math.max(20, Math.round((view.height - h) / 2)) + step,
            width: w,
            height: h,
        },
        view,
    );
}
