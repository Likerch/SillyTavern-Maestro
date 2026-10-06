// M24 «Места», stage 3 (plan M24 п.1–4, §2.1, §4.4, §16; dev-plan 3.3): the chat's place registry — the owner of a
// place's identity (id, name, aliases with case forms, nesting, history) — filled from the DES location of each
// committed reply with the two-turn rule, look-alikes sent to the Inbox, exact rollback on swipe/edit/delete, the
// description entry of type 'place' in the chat canon, the pult tab and `globalThis.MAESTRO_PLACES` for NAI Studio.
// Exposed as app.modules.api<PlacesApi>('places'). The prompt part (pinning the current place's entry) is stage 7/8.
import type { MaestroModule, TargetSpec } from '../../shared/contracts';
import type { PlacesApi } from './api';
import { installPlacesBridge } from './bridge';
import { CURRENT_TARGET, PLACES_ID, PLACES_KEY, PLACE_TARGET, PlacesService, defaultPlacesSettings } from './service';
import type { PlacesSettings } from './service';
import { PLACES_STRINGS } from './strings';
import { PLACES_CSS, placesTab } from './view';

function readSettings(slice: Partial<PlacesSettings>): PlacesSettings {
    const defaults = defaultPlacesSettings();
    const turns = slice.bootstrapTurns;
    if (typeof turns !== 'number' || !Number.isFinite(turns) || turns < 0) {
        slice.bootstrapTurns = defaults.bootstrapTurns;
    }
    return slice as PlacesSettings;
}

/** The running service: journal rows name places instead of showing their ids (empty while the module is off). */
let active: PlacesService | null = null;

function placeName(value: unknown): string {
    return (typeof value === 'string' && active?.get(value)?.name) || '';
}

const TECHNICAL = { labelKey: 'm24.field.technical', hidden: true };

/** A place reads by its name, other names and the place it is part of; ids, case forms and visits are technical. */
export const PLACES_TARGETS: TargetSpec[] = [
    {
        target: PLACE_TARGET,
        fields: {
            name: { labelKey: 'm24.field.name' },
            aliases: { labelKey: 'm24.field.aliases' },
            parent: { labelKey: 'm24.field.parent', format: placeName },
            id: TECHNICAL,
            forms: TECHNICAL,
            visits: TECHNICAL,
            entry: TECHNICAL,
            passportId: TECHNICAL,
        },
    },
    // The current place: an id (or null) before and after.
    { target: CURRENT_TARGET, format: placeName },
];

export const placesModule: MaestroModule<PlacesSettings> = {
    id: PLACES_ID,
    key: PLACES_KEY,
    stage: 3,
    titleKey: 'm24.title',
    enabledByDefault: true,
    defaults: defaultPlacesSettings,
    i18n: PLACES_STRINGS,
    targets: PLACES_TARGETS,
    init({ app, log, own }) {
        const settings = () => readSettings(app.settings.module<Partial<PlacesSettings>>(PLACES_KEY));
        const service = new PlacesService(app, log.scope('places'), settings);
        for (const off of service.install()) own(off);
        own(() => service.dispose());
        active = service;
        own(() => {
            if (active === service) active = null;
        });
        app.modules.expose(PLACES_KEY, service satisfies PlacesApi);
        own(installPlacesBridge(service));
        own(app.ui.style('m24-places', PLACES_CSS));
        own(app.ui.addTab(placesTab(app, service)));
    },
};

export { PLACES_STRINGS } from './strings';
export { PlacesService, defaultPlacesSettings } from './service';
export type { PlacesSettings, MergePayload } from './service';
export { PLACES_GLOBAL, installPlacesBridge, createPlacesBridge } from './bridge';
export type { BridgePlace, MaestroPlacesBridge } from './bridge';
export type { Place, PlaceCandidate, PlaceVisit, PlacesApi } from './api';
