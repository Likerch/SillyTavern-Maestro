// The tabs modules register (PultTab, `ui.addTab`) and which window shows each of them (plan-2 §10). A window lists
// its sections by pult group (PultTab.group / the central map in pult-groups.ts) plus explicit tab ids; a tab that
// no window claims goes to the «Maestro» window. Tabs registered later join their window by group.
import type { Logger, MaestroWindowSpec, PultTab, Unsubscribe } from '../../shared/contracts';
import { groupOf, sortTabs } from '../views/pult-groups';

/** The window that takes every tab nobody else claims (and unknown window ids). */
export const MAESTRO_WINDOW = 'maestro';

export class TabRegistry {
    private readonly tabs = new Map<string, PultTab>();
    private readonly listeners = new Set<() => void>();

    constructor(private readonly log: Logger) {}

    add(tab: PultTab): Unsubscribe {
        if (this.tabs.has(tab.id)) this.log.warn(`pult tab "${tab.id}" replaced`);
        this.tabs.set(tab.id, tab);
        this.changed();
        return () => {
            if (this.tabs.get(tab.id) !== tab) return;
            this.tabs.delete(tab.id);
            this.changed();
        };
    }

    get(id: string): PultTab | undefined {
        return this.tabs.get(id);
    }

    has(id: string): boolean {
        return this.tabs.has(id);
    }

    /** Every tab in the old sidebar order (group, then order, then id). */
    all(): PultTab[] {
        return sortTabs(this.tabs.values());
    }

    badgeOf(tab: PultTab): number {
        if (!tab.badge) return 0;
        try {
            const value = tab.badge();
            return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        } catch (error) {
            this.log.warn(`badge of tab "${tab.id}" failed`, error);
            return 0;
        }
    }

    totalBadge(): number {
        let total = 0;
        for (const tab of this.tabs.values()) total += this.badgeOf(tab);
        return total;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    clear(): void {
        this.tabs.clear();
        this.listeners.clear();
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('tab registry listener failed', error);
            }
        }
    }
}

/** Specs in menu order (order, then id). */
export function sortSpecs(specs: Iterable<MaestroWindowSpec>): MaestroWindowSpec[] {
    return [...specs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The window that shows a tab: one listing it explicitly wins, then one holding its group, then «Maestro».
 * Works for tabs not registered yet (by the central group map), so `openPult(id)` can name the window early.
 */
export function windowForTab(
    specs: readonly MaestroWindowSpec[],
    tab: Pick<PultTab, 'id' | 'group'>,
): string | undefined {
    const ordered = sortSpecs(specs.filter((spec) => !spec.render));
    const explicit = ordered.find((spec) => spec.tabs?.includes(tab.id));
    if (explicit) return explicit.id;
    const group = groupOf(tab);
    const byGroup = ordered.find((spec) => spec.groups?.includes(group));
    if (byGroup) return byGroup.id;
    return ordered.some((spec) => spec.id === MAESTRO_WINDOW) ? MAESTRO_WINDOW : undefined;
}

/** The sections of a window: its explicit tabs in their order, then its group tabs in sidebar order. */
export function sectionsOf(
    specs: readonly MaestroWindowSpec[],
    spec: MaestroWindowSpec,
    tabs: readonly PultTab[],
): PultTab[] {
    if (spec.render) return [];
    const mine = tabs.filter((tab) => windowForTab(specs, tab) === spec.id);
    const explicit = (spec.tabs ?? [])
        .map((id) => mine.find((tab) => tab.id === id))
        .filter((tab): tab is PultTab => tab !== undefined);
    const rest = sortTabs(mine.filter((tab) => !explicit.includes(tab)));
    return [...explicit, ...rest];
}
