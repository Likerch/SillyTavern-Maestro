// Settings slice of the dock (`extensionSettings.maestro.modules.dock`): which neighbours' settings blocks stay in the
// pult while its «Расширения» tab is open, and whether DES's portrait bar moves there too. Only Maestro's own choices:
// the dock never writes a neighbour's settings.

export const DOCK_KEY = 'dock';
export const DOCK_ID = 'M32d';
export const DOCK_TAB = 'extensions';

/** Neighbours whose settings block the dock can hold, in the order of plan M32 п.5. */
export const DOCK_NEIGHBOURS = ['ck', 'qvink', 'nai', 'desru', 'localizer', 'des'] as const;
export type DockNeighbourId = (typeof DOCK_NEIGHBOURS)[number];

export interface DockSettings {
    /** «Держать в пульте» per neighbour (missing = on). */
    keep: Partial<Record<DockNeighbourId, boolean>>;
    /** Move DES's portrait bar into the tab as well (off by default). */
    portraitBar: boolean;
}

export function defaultDockSettings(): DockSettings {
    return { keep: {}, portraitBar: false };
}

/** The live slice, repaired in place (it is the object the tab edits). */
export function readDockSettings(slice: Partial<DockSettings>): DockSettings {
    if (!slice.keep || typeof slice.keep !== 'object' || Array.isArray(slice.keep)) slice.keep = {};
    for (const [key, value] of Object.entries(slice.keep)) {
        if (typeof value !== 'boolean') delete (slice.keep as Record<string, unknown>)[key];
    }
    if (typeof slice.portraitBar !== 'boolean') slice.portraitBar = false;
    return slice as DockSettings;
}

export function keeps(settings: DockSettings, id: DockNeighbourId): boolean {
    return settings.keep[id] !== false;
}
