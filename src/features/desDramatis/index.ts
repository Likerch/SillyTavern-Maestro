// M39 «Раздел Dramatis в листе персонажа DES», release 1.19: what Dramatis (our personality engine, 1.3+) knows about a
// character is a tab of DES's «Character Sheet» (the portrait card menu → «Character Sheet», or Maestro's own menu item
// «Dramatis» that opens the sheet on that tab) and a pane of DES's Workshop (the route on iOS: Roster → Workshop). Both
// read DRAMATIS_API.describe live; without Dramatis 1.3 nothing is added. The module's switch is the setting (on by
// default); turning it off, or Maestro stopping, takes every node, observer and menu item back (inject.ts). No
// `requires`: Dramatis and DES's modal template may both appear after Maestro starts.
import type { MaestroModule } from '../../shared/contracts';
import { DesDramatisUi } from './inject';
import { DES_DRAMATIS_STRINGS } from './strings';
import { DES_DRAMATIS_CSS } from './view';

export const DES_DRAMATIS_KEY = 'desDramatis';
export const DES_DRAMATIS_ID = 'M39';

/** The module has no settings of its own: its switch in «Модули» is «Раздел Dramatis в листе персонажа DES». */
export type DesDramatisSettings = Record<string, never>;

export const desDramatisModule: MaestroModule<DesDramatisSettings> = {
    id: DES_DRAMATIS_ID,
    key: DES_DRAMATIS_KEY,
    stage: 15,
    titleKey: 'm39.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: DES_DRAMATIS_STRINGS,
    init({ app, log, own }) {
        own(app.ui.style('maestro-m39', DES_DRAMATIS_CSS));
        const ui = new DesDramatisUi(app, log);
        own(() => ui.dispose());
        ui.install();
    },
};

export { DesDramatisUi, DESRU_SKIP, DRAMATIS_TAB, M39_NODES } from './inject';
export { DES_DRAMATIS_STRINGS } from './strings';
export { DES_DRAMATIS_CSS, renderDramatis } from './view';
export type { DramatisContent, DramatisHost } from './view';
