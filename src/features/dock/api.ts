// Public API of the dock (M32 п.5), app.modules.api<DockApi>('dock'): what is in the pult now, and a way to put
// everything back at once (e.g. before «Подготовить к отключению» or an export of the page state).
export interface DockApi {
    /** Ids of the neighbours' nodes held in the pult right now ('ck', 'des', 'desPortraits', …). */
    docked(): string[];
    /** Puts every docked node back where it was. */
    returnAll(): void;
}
