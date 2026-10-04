// Scene hint for NAI Studio (plan §16; NAI Studio 0.10.0+ `registerSceneProvider`): for the message a picture is about,
// the Maestro place (stable id → NAI Studio's location continuity) and the canonical names of the characters present.
// Registered only while the place registry or the world model is on; re-registered when NAI Studio publishes its API
// again (it drops registrations when it is disabled). The registration belongs to the director and goes with it.
import { adaptersOf } from '../../adapters';
import type { NaiSceneHint, NaiSceneHintContext, NaiStudioApi } from '../../adapters';
import { presentNames } from '../../domain/director-scene';
import type { App, Logger } from '../../shared/contracts';
import type { PlacesApi } from '../places/api';
import type { WorldModelApi } from '../world/api';

export const SCENE_PROVIDER_ID = 'maestro-director';
export const SCENE_PROVIDER_PRIORITY = 50;

export class SceneHints {
    private registered: { api: NaiStudioApi; off: () => void } | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private places(): PlacesApi | undefined {
        return this.app.modules.api<PlacesApi>('places');
    }

    private world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }

    /** Registers (or re-registers, or drops) the provider to match what is on now. Cheap: called on every turn. */
    sync(): void {
        let api: NaiStudioApi | undefined;
        try {
            api = adaptersOf(this.app).nai.api();
        } catch {
            api = undefined;
        }
        const wanted = !!api && (!!this.places() || !!this.world());
        if (this.registered && (!wanted || this.registered.api !== api)) this.dispose();
        if (!wanted || this.registered || !api) return;
        try {
            const off = api.registerSceneProvider({
                id: SCENE_PROVIDER_ID,
                priority: SCENE_PROVIDER_PRIORITY,
                describe: (context) => this.describe(context),
            });
            this.registered = { api, off: typeof off === 'function' ? off : () => {} };
        } catch (error) {
            this.log.warn('NAI Studio scene provider was not registered', error);
        }
    }

    dispose(): void {
        const registered = this.registered;
        this.registered = null;
        if (!registered) return;
        try {
            registered.off();
        } catch (error) {
            this.log.debug('scene provider unregistration failed', error);
        }
    }

    isRegistered(): boolean {
        return this.registered !== null;
    }

    /** The hint for one message: its DES location as a registry place, and who is present (null: nothing known). */
    describe(context: NaiSceneHintContext): NaiSceneHint | null {
        try {
            const index = typeof context?.messageIndex === 'number' ? context.messageIndex : -1;
            const tracker = index >= 0 ? adaptersOf(this.app).des.trackerFor(index) : null;
            const hint: NaiSceneHint = {};
            const places = this.places();
            const label = tracker?.infoBox?.location;
            let place = label ? places?.resolve(label) : undefined;
            if (!place && index >= this.app.turn.lastAssistantIndex()) place = places?.current() ?? undefined;
            if (place) {
                hint.locationId = place.id;
                hint.locationName = place.name;
            } else if (label) {
                hint.locationName = label;
            }
            const world = this.world();
            const names = presentNames(tracker).map((name) => world?.resolve(name)?.name ?? name);
            if (names.length) hint.characters = [...new Set(names)];
            return Object.keys(hint).length ? hint : null;
        } catch (error) {
            this.log.debug('scene hint failed', error);
            return null;
        }
    }
}
