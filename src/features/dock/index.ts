// M32 п.5 «Док» (plan M32, Q30; stage 12): the pult tab «Расширения» gathers the neighbours' settings blocks — CK,
// Qvink (outer block), NAI Studio, DES-RU, Localizer, DES — and, on request, DES's portrait bar, and offers shortcuts
// to their own windows. Their real nodes move in while the tab is open and go back to the exact place when it closes,
// when the module stops and when the page unloads (plan M32 п.6: Maestro off — everything where it was). Neighbours'
// settings are never changed, their nodes are never cloned. Exposed as app.modules.api<DockApi>('dock').
import type { MaestroModule } from '../../shared/contracts';
import type { DockApi } from './api';
import { Dock } from './dock';
import type { DockEvent } from './dock';
import { DOCK_ID, DOCK_KEY, defaultDockSettings, readDockSettings } from './settings';
import type { DockSettings } from './settings';
import { DOCK_STRINGS } from './strings';
import { DOCK_CSS, dockTab } from './view';

export const dockModule: MaestroModule<DockSettings> = {
    id: DOCK_ID,
    key: DOCK_KEY,
    stage: 12,
    titleKey: 'm32.dock.title',
    enabledByDefault: true,
    defaults: defaultDockSettings,
    i18n: DOCK_STRINGS,
    init({ app, log, own }) {
        const settings = () => readDockSettings(app.settings.module<Partial<DockSettings>>(DOCK_KEY));
        const listeners = new Set<(id: string, event: DockEvent) => void>();
        const dock = new Dock({
            log: log.scope('dock'),
            onEvent: (id, event) => {
                for (const listener of [...listeners]) listener(id, event);
            },
        });
        // Registered first so it runs last: the tab's own cleanup returns the nodes, this catches anything left.
        own(() => dock.undockAll());
        const onUnload = () => dock.undockAll();
        globalThis.addEventListener?.('pagehide', onUnload);
        own(() => globalThis.removeEventListener?.('pagehide', onUnload));
        own(app.ui.style('maestro-m32d', DOCK_CSS));
        own(
            app.ui.addTab(
                dockTab({
                    app,
                    dock,
                    settings,
                    onDockEvent: (listener) => {
                        listeners.add(listener);
                        return () => listeners.delete(listener);
                    },
                }),
            ),
        );
        const api: DockApi = {
            docked: () => dock.ids().filter((id) => dock.isDocked(id)),
            returnAll: () => dock.undockAll(),
        };
        app.modules.expose(DOCK_KEY, api);
    },
};

export type { DockApi } from './api';
export { Dock, MAX_ADOPTIONS, ST_EXTENSION_COLUMNS } from './dock';
export type { DockEvent, DockOptions, DockResult, DockTarget } from './dock';
export { NEIGHBOURS, PORTRAIT_BAR, SHORTCUTS } from './neighbours';
export type { DockNeighbour, Shortcut } from './neighbours';
export { DOCK_ID, DOCK_KEY, DOCK_NEIGHBOURS, DOCK_TAB, defaultDockSettings, keeps, readDockSettings } from './settings';
export type { DockNeighbourId, DockSettings } from './settings';
export { DOCK_STRINGS } from './strings';
export { DOCK_CSS, dockTab, neighbourPresent } from './view';
export type { DockViewDeps } from './view';
