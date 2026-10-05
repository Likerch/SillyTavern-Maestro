// The dock's mover (plan M32 п.5, Q30): takes a neighbour's own DOM node (a settings block, DES's portrait bar) into a
// slot of the pult and puts it back exactly where it was. The node itself moves — never a clone: it keeps its event
// handlers and ids, and there is never a duplicate id on the page. A comment placeholder marks the original position;
// the parent and next sibling are remembered too, in case the placeholder disappears with a re-render of the parent.
//
// Neighbours own their nodes, so the dock gives way to them:
// - the owner re-rendered its block (a fresh node appeared at home): the stale copy in the dock is dropped and the
//   fresh one is docked instead (a few times at most, then the fresh one simply stays home);
// - the owner moved or removed the docked node itself: it is left where the owner put it;
// - the original parent is gone: the node goes back to ST's extensions column (or the target's own fallback).
import type { Logger } from '../../shared/contracts';

/** ST's extension settings columns (public/index.html), right one first: most neighbours mount there. */
export const ST_EXTENSION_COLUMNS = ['#extensions_settings2', '#extensions_settings'] as const;

/** A fresh node at home this many times during one docking: the owner keeps redrawing it, let it stay home. */
export const MAX_ADOPTIONS = 3;

export interface DockTarget {
    /** Unique id (a neighbour id, 'desPortraits'). */
    id: string;
    /** Candidate selectors of the node, tried in order; the first match outside the dock wins. */
    selectors: readonly string[];
    /** Finds candidates a selector cannot express (an anonymous wrapper around a known node); tried after them. */
    locate?(doc: Document): (HTMLElement | null | undefined)[];
    /**
     * Where the node goes when its original parent is gone. Default: ST's extensions column it was in, else the first
     * column on the page. Return null to leave the node out of the page (the owner will redraw it).
     */
    fallback?(doc: Document): { parent: Node; before: Node | null } | null;
}

export type DockResult = 'docked' | 'already' | 'missing';

/** What happened to a docked node outside the dock's own calls (the view redraws its note). */
export type DockEvent = 'adopted' | 'taken' | 'redrawn';

export interface DockOptions {
    log: Logger;
    doc?: () => Document;
    onEvent?(id: string, event: DockEvent): void;
}

interface Entry {
    target: DockTarget;
    node: HTMLElement;
    slot: HTMLElement;
    placeholder: Comment;
    parent: Node;
    next: Node | null;
    column: Element | null;
    observer: MutationObserver | null;
    adoptions: number;
}

export class Dock {
    private readonly entries = new Map<string, Entry>();
    private readonly doc: () => Document;

    constructor(private readonly options: DockOptions) {
        this.doc = options.doc ?? (() => document);
    }

    /** Ids of the targets docked now. */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    isDocked(id: string): boolean {
        const entry = this.entries.get(id);
        return !!entry && entry.node.parentNode === entry.slot;
    }

    /** The target's node outside the dock (on its home position), if the page has it. */
    find(target: DockTarget): HTMLElement | null {
        const doc = this.doc();
        for (const selector of target.selectors) {
            let nodes: HTMLElement[];
            try {
                nodes = [...doc.querySelectorAll<HTMLElement>(selector)];
            } catch {
                continue;
            }
            const node = nodes.find((candidate) => !this.inDock(candidate));
            if (node) return node;
        }
        let located: (HTMLElement | null | undefined)[] = [];
        try {
            located = target.locate?.(doc) ?? [];
        } catch (error) {
            this.options.log.debug(`dock: locating "${target.id}" failed`, error);
        }
        return located.find((node): node is HTMLElement => !!node && node.isConnected && !this.inDock(node)) ?? null;
    }

    /** Moves the target's node into `slot` (appended). */
    dock(target: DockTarget, slot: HTMLElement): DockResult {
        const existing = this.entries.get(target.id);
        if (existing && existing.slot === slot && existing.node.parentNode === slot) return 'already';
        if (existing) this.undock(target.id);
        const node = this.find(target);
        const parent = node?.parentNode;
        if (!node || !parent) return 'missing';
        const entry: Entry = {
            target,
            node,
            slot,
            placeholder: this.doc().createComment(` maestro-dock: ${target.id} `),
            parent,
            next: node.nextSibling,
            column: this.columnOf(node),
            observer: null,
            adoptions: 0,
        };
        parent.insertBefore(entry.placeholder, node);
        slot.appendChild(node);
        this.entries.set(target.id, entry);
        this.watch(entry);
        return 'docked';
    }

    /** Puts the node back where it was. Returns true when the node went back to the page by this call. */
    undock(id: string): boolean {
        const entry = this.entries.get(id);
        if (!entry) return false;
        this.entries.delete(id);
        entry.observer?.disconnect();
        entry.observer = null;
        let returned = false;
        try {
            if (entry.node.parentNode === entry.slot) {
                const fresh = this.find(entry.target);
                if (fresh && fresh !== entry.node) {
                    // The owner drew a new block meanwhile: the docked one is stale, a second copy would duplicate ids.
                    entry.node.remove();
                } else {
                    returned = this.putBack(entry);
                }
            }
        } catch (error) {
            this.options.log.warn(`dock: cannot return "${id}"`, error);
        } finally {
            entry.placeholder.remove();
        }
        return returned;
    }

    undockAll(): void {
        for (const id of [...this.entries.keys()]) this.undock(id);
    }

    private inDock(node: Node): boolean {
        for (const entry of this.entries.values()) {
            if (entry.slot.contains(node)) return true;
        }
        return false;
    }

    private columnOf(node: HTMLElement): Element | null {
        const parent = node.parentElement;
        return parent?.closest(ST_EXTENSION_COLUMNS.join(', ')) ?? null;
    }

    private putBack(entry: Entry): boolean {
        const { node, placeholder, parent, next } = entry;
        if (placeholder.isConnected && placeholder.parentNode) {
            placeholder.parentNode.replaceChild(node, placeholder);
            return true;
        }
        if (parent.isConnected) {
            parent.insertBefore(node, next && next.parentNode === parent ? next : null);
            return true;
        }
        const doc = this.doc();
        if (entry.target.fallback) {
            const place = entry.target.fallback(doc);
            if (!place) {
                node.remove();
                return false;
            }
            place.parent.insertBefore(node, place.before);
            return true;
        }
        const column =
            entry.column?.isConnected === true
                ? entry.column
                : ST_EXTENSION_COLUMNS.map((selector) => doc.querySelector(selector)).find((found) => !!found);
        if (!column) {
            this.options.log.warn(`dock: no place to return "${entry.target.id}" to`);
            node.remove();
            return false;
        }
        column.appendChild(node);
        return true;
    }

    /** Watches the home of a docked node for the owner redrawing it (childList of the parent and the columns). */
    private watch(entry: Entry): void {
        const Observer = (this.doc().defaultView as (Window & typeof globalThis) | null)?.MutationObserver;
        if (typeof Observer !== 'function') return;
        const observer = new Observer(() => this.check(entry));
        const roots = new Set<Node>([entry.parent]);
        if (entry.column) roots.add(entry.column);
        for (const selector of ST_EXTENSION_COLUMNS) {
            const column = this.doc().querySelector(selector);
            if (column) roots.add(column);
        }
        for (const root of roots) observer.observe(root, { childList: true });
        entry.observer = observer;
    }

    private check(entry: Entry): void {
        if (this.entries.get(entry.target.id) !== entry) return;
        const id = entry.target.id;
        if (entry.node.parentNode !== entry.slot) {
            // The owner moved or removed the docked node: it is the owner's again.
            this.release(entry);
            this.options.onEvent?.(id, 'taken');
            return;
        }
        const fresh = this.find(entry.target);
        if (!fresh || fresh === entry.node) return;
        entry.node.remove();
        entry.placeholder.remove();
        if (entry.adoptions >= MAX_ADOPTIONS || !fresh.parentNode) {
            this.options.log.info(`dock: "${id}" keeps redrawing its block, leaving it in place`);
            this.release(entry);
            this.options.onEvent?.(id, 'redrawn');
            return;
        }
        const parent = fresh.parentNode;
        entry.observer?.disconnect();
        entry.node = fresh;
        entry.parent = parent;
        entry.next = fresh.nextSibling;
        entry.column = this.columnOf(fresh);
        entry.adoptions++;
        parent.insertBefore(entry.placeholder, fresh);
        entry.slot.appendChild(fresh);
        this.watch(entry);
        this.options.onEvent?.(id, 'adopted');
    }

    private release(entry: Entry): void {
        entry.observer?.disconnect();
        entry.observer = null;
        entry.placeholder.remove();
        this.entries.delete(entry.target.id);
    }
}
