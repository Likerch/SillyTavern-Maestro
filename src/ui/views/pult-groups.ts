// Pult groups (plan §7): the sidebar is a short list of sections — Ход, Входящие, Канон, Досье, Мир, Механики,
// Здоровье, Журнал, Ассистент, Расширения, Настройки — each holding the tabs of its modules. A tab names its group
// with `PultTab.group`; tabs registered before grouping existed are placed by the central map below, so features do
// not have to change. Unknown tabs land in «Ещё».
import type { PultTab } from '../../shared/contracts';

/** Tabs shown above every group, without a heading (Overview). */
export const TOP_GROUP = 'top';
/** Where tabs without a known group go. */
export const MORE_GROUP = 'more';

/** Groups in sidebar order; the label is `ui.group.<id>` (the top group has none). */
export const PULT_GROUPS: readonly string[] = [
    TOP_GROUP,
    'turn',
    'inbox',
    'canon',
    'dossier',
    'world',
    'mechanics',
    'health',
    'journal',
    'assistant',
    'extensions',
    MORE_GROUP,
    'settings',
];

/** Group of the tabs that existed before `PultTab.group` (tab id → group id). */
export const TAB_GROUPS: Readonly<Record<string, string>> = {
    overview: TOP_GROUP,
    // Ход: the turn and how it was assembled, directed and paid for.
    turn: 'turn',
    prompt: 'turn',
    director: 'turn',
    voices: 'turn',
    quality: 'turn',
    architect: 'turn',
    treasurer: 'turn',
    inbox: 'inbox',
    // Канон: overrides, living canon, chronicle, lore (the studios open as big windows from here).
    canon: 'canon',
    living: 'canon',
    revision: 'canon',
    signals: 'canon',
    chronicle: 'canon',
    lorePassports: 'canon',
    loreStudio: 'canon',
    presetStudio: 'canon',
    dossier: 'dossier',
    wardrobe: 'dossier',
    bunnymo: 'dossier',
    world: 'world',
    places: 'world',
    relations: 'world',
    calendar: 'world',
    offscreen: 'world',
    knowledge: 'world',
    backgrounds: 'world',
    mechanics: 'mechanics',
    health: 'health',
    doctor: 'health',
    guardian: 'health',
    rules: 'health',
    tasks: 'health',
    metrics: 'health',
    journal: 'journal',
    assistant: 'assistant',
    extensions: 'extensions',
    settings: 'settings',
    theme: 'settings',
};

/** The group a tab is shown in: its own `group` when known, then the central map, then «Ещё». */
export function groupOf(tab: Pick<PultTab, 'id' | 'group'>): string {
    if (tab.group && PULT_GROUPS.includes(tab.group)) return tab.group;
    return TAB_GROUPS[tab.id] ?? MORE_GROUP;
}

/** i18n key of a group's heading (`null` for the top group, which has none). */
export function groupLabelKey(group: string): string | null {
    return group === TOP_GROUP ? null : `ui.group.${group}`;
}

/** Tabs in sidebar order: by group, then by the tab's own order (then id, for a stable order). */
export function sortTabs<T extends Pick<PultTab, 'id' | 'group' | 'order'>>(tabs: Iterable<T>): T[] {
    const rank = (tab: T) => PULT_GROUPS.indexOf(groupOf(tab));
    return [...tabs].sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id));
}
